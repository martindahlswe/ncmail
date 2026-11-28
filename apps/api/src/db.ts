import pg from "pg";

/** A Postgres statement_timeout in milliseconds from the environment (0 turns it off). */
export function timeoutMs(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Requests: a runaway query (an expensive search, say) is cancelled instead of holding a connection for minutes. */
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  statement_timeout: timeoutMs(process.env.NCMAIL_STATEMENT_TIMEOUT_MS, 30_000),
});

/**
 * Background work that may legitimately run long: big syncs, the body indexer, migrations, index backfills and removing
 * a whole account. Its own small pool with its own (by default no) statement_timeout, so the request limit does not break it.
 */
export const bgPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  statement_timeout: timeoutMs(process.env.NCMAIL_BACKGROUND_STATEMENT_TIMEOUT_MS, 0),
});

/**
 * Run a database operation again if Postgres aborts it as a deadlock victim (40P01) or serialization failure (40001).
 * Needed for operations that touch many rows while sync/indexing writes to the same ones, e.g. deleting an account.
 */
export async function retryOnDeadlock<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e: any) {
      if ((e?.code !== "40P01" && e?.code !== "40001") || i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 50 * i + Math.random() * 100));
    }
  }
}

export async function migrate() {
  // Advisory lock: concurrent starts (e.g. watch-mode restarts) must not run DDL at the same time.
  const client = await bgPool.connect(); // DDL on a big table (a new index) can take longer than the request limit
  try {
    await client.query("select pg_advisory_lock(727001)");
    await client.query(SCHEMA);
  } finally {
    await client.query("select pg_advisory_unlock(727001)").catch(() => {});
    client.release();
  }
}

import { KEYS_SCHEMA } from "./secure/schema.ts";

const SCHEMA = `
    create table if not exists accounts (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      email text not null,
      imap_host text not null, imap_port int not null, imap_security text not null,
      imap_username text not null, imap_password_enc text not null,
      smtp_host text not null, smtp_port int not null, smtp_security text not null,
      smtp_username text not null, smtp_password_enc text not null,
      created_at timestamptz not null default now()
    );

    create table if not exists identities (
      id uuid primary key default gen_random_uuid(),
      account_id uuid not null references accounts(id) on delete cascade,
      name text not null,
      email text not null,
      is_default boolean not null default false,
      created_at timestamptz not null default now()
    );
    create unique index if not exists identities_one_default on identities (account_id) where is_default;
    create unique index if not exists identities_account_email on identities (account_id, lower(email));
    alter table identities add column if not exists signature_html text not null default '';
    alter table identities add column if not exists signature_is_html boolean not null default false;
    alter table identities add column if not exists signature_text text not null default '';
    alter table identities add column if not exists reply_to text not null default '';
    -- every account has at least its login address as an identity
    insert into identities (account_id, name, email, is_default)
      select a.id, a.name, a.email, true from accounts a
      where not exists (select 1 from identities i where i.account_id = a.id);

    create table if not exists folders (
      id bigserial primary key,
      account_id uuid not null references accounts(id) on delete cascade,
      path text not null,
      name text not null,
      delimiter text,
      special_use text,
      selectable boolean not null default true,
      uidvalidity bigint,
      uidnext bigint,
      highestmodseq bigint,
      total int not null default 0,
      unseen int not null default 0,
      last_synced_at timestamptz,
      status_checked_at timestamptz,
      sync_error text,
      unique (account_id, path)
    );

    create table if not exists messages (
      id bigserial primary key,
      folder_id bigint not null references folders(id) on delete cascade,
      uid bigint not null,
      message_id text,
      in_reply_to text,
      refs text[] not null default '{}',
      subject text not null default '',
      from_name text not null default '',
      from_addr text not null default '',
      to_addrs jsonb not null default '[]',
      cc_addrs jsonb not null default '[]',
      date timestamptz not null,
      flags text[] not null default '{}',
      size int not null default 0,
      has_attachments boolean not null default false,
      unique (folder_id, uid)
    );
    -- keyset pagination: folder + newest first
    create index if not exists messages_folder_date on messages (folder_id, date desc, id desc);

    -- conversations: messages sharing a thread_id belong together (account-wide, so Sent replies join Inbox threads)
    create sequence if not exists thread_seq;
    alter table messages add column if not exists thread_id bigint;
    create index if not exists messages_thread on messages (thread_id);
    -- the subject without reply prefixes, kept only for mail without reply headers: conversations by subject (threads.ts)
    alter table messages add column if not exists base_subject text;
    create index if not exists messages_base_subject on messages (base_subject) where base_subject is not null;
    create index if not exists messages_folder_thread on messages (folder_id, thread_id, date desc, id desc);
    -- every Message-ID / In-Reply-To / References value seen, pointing at its thread (lets siblings of a missing parent join)
    create table if not exists thread_keys (
      account_id uuid not null references accounts(id) on delete cascade,
      msgid text not null,
      thread_id bigint not null,
      primary key (account_id, msgid)
    );
    create index if not exists thread_keys_thread on thread_keys (thread_id);

    alter table folders add column if not exists status_checked_at timestamptz;

    -- search: lower-cased subject + sender + recipients, matched by substring via a trigram index
    create extension if not exists pg_trgm;
    alter table messages add column if not exists search_text text;
    create index if not exists messages_search_trgm on messages using gin (search_text gin_trgm_ops);

    -- optional full-text index of message bodies (per account switch: accounts.index_bodies)
    alter table accounts add column if not exists index_bodies boolean not null default false;
    create table if not exists message_text (
      message_id bigint primary key references messages(id) on delete cascade,
      tsv tsvector not null,
      preview text not null default ''
    );
    create index if not exists message_text_tsv on message_text using gin (tsv);

    -- unread counts: a small partial index instead of scanning the whole folder (47 ms at 66k messages)
    create index if not exists messages_unseen on messages (folder_id) where not ('\\Seen' = any(flags));

    -- keep planner statistics fresh on tables that grow in big bursts (a stale plan once cost 100x on the first minute after a big sync)
    alter table messages set (autovacuum_analyze_scale_factor = 0.01, autovacuum_analyze_threshold = 500);
    alter table thread_keys set (autovacuum_analyze_scale_factor = 0.01, autovacuum_analyze_threshold = 500);

    -- recipient suggestions (people who wrote to you, and people you wrote to)
    create table if not exists contacts (
      account_id uuid not null references accounts(id) on delete cascade,
      email text not null,
      name text not null default '',
      from_count int not null default 0,
      to_count int not null default 0,
      last_date timestamptz,
      primary key (account_id, email)
    );
    create index if not exists contacts_search on contacts using gin ((lower(name || ' ' || email)) gin_trgm_ops);

    -- list sorting (keyset pagination needs an index per order)
    create index if not exists messages_sort_from on messages (folder_id, (lower(coalesce(nullif(from_name, ''), from_addr))), id);
    create index if not exists messages_sort_subject on messages (folder_id, (lower(subject)), id);
    create index if not exists messages_sort_size on messages (folder_id, size desc, id desc);

    -- messages waiting to be sent (the "undo send" window), and failed ones
    create table if not exists outbox (
      id bigserial primary key,
      account_id uuid not null references accounts(id) on delete cascade,
      from_addr text not null,
      to_addrs text[] not null,
      subject text not null default '',
      raw bytea,
      send_at timestamptz not null,
      status text not null default 'pending',
      error text,
      draft_uid int,
      created_at timestamptz not null default now()
    );
    create index if not exists outbox_due on outbox (status, send_at);
    -- separately encrypted Bcc copies: [{ to, raw (base64) }]
    alter table outbox add column if not exists copies jsonb;
    alter table outbox add column if not exists claimed_at timestamptz; -- when delivery started (status 'sending')

    create table if not exists message_bodies (
      message_id bigint primary key references messages(id) on delete cascade,
      html text,
      text text,
      attachments jsonb not null default '[]',
      headers jsonb not null default '{}',
      fetched_at timestamptz not null default now()
    );
    -- whose account this is (a Nextcloud user id; '' when the app runs single-user)
    alter table accounts add column if not exists owner text not null default '';
    create index if not exists accounts_owner on accounts (owner);
    -- the user's connection to their Nextcloud (contacts, files); owner is '' when single-user
    create table if not exists nextcloud_links (
      owner text primary key, base_url text not null, username text not null, password_enc text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists nc_contacts (
      owner text not null, href text not null, name text not null default '', emails text[] not null default '{}', org text not null default '',
      primary key (owner, href)
    );
    create index if not exists nc_contacts_search on nc_contacts using gin ((lower(name || ' ' || org)) gin_trgm_ops);
    -- labels (names and colours; the label itself is an IMAP keyword on each message), saved searches, snoozed messages
    create table if not exists labels (
      account_id uuid not null references accounts(id) on delete cascade,
      slug text not null, name text not null, color text not null default '#2563eb',
      primary key (account_id, slug)
    );
    create table if not exists saved_searches (
      id bigserial primary key, account_id uuid not null references accounts(id) on delete cascade,
      name text not null, query text not null, created_at timestamptz not null default now()
    );
    create table if not exists snoozes (
      id bigserial primary key, account_id uuid not null references accounts(id) on delete cascade,
      dest_folder_id bigint not null, dest_path text not null, dest_uid bigint not null, return_path text not null, until timestamptz not null
    );
    create index if not exists snoozes_due on snoozes (until);
    -- where an account's ManageSieve server is, when it is not the IMAP host on the standard port
    create table if not exists sieve_settings (
      account_id uuid primary key references accounts(id) on delete cascade, host text not null default '', port int not null default 4190, security text not null default 'starttls'
    );
    alter table sieve_settings add column if not exists username text not null default '';
    alter table sieve_settings add column if not exists password_enc text;
    -- first sync keeps only recent mail (accounts.sync_months; null = the server default, 0 = everything); the rest can be loaded on demand
    alter table accounts add column if not exists sync_months int;
    alter table folders add column if not exists floor_uid bigint; -- (unused; kept so older databases keep working)
    alter table folders add column if not exists window_start timestamptz; -- mail older than this is not mirrored yet
    alter table folders add column if not exists unsynced_older int not null default 0;
    -- sign-in sessions (the cookie holds a random id; ending a session deletes the row)
    create table if not exists sessions (
      id text primary key, owner text not null, created_at timestamptz not null default now(), expires_at timestamptz not null
    );
    create index if not exists sessions_owner on sessions (owner);
    alter table sessions add column if not exists name text not null default '';
    alter table sessions add column if not exists email text not null default '';
    alter table sessions add column if not exists lang text not null default '';
    -- one-time sign-in tokens and signed requests already seen from Nextcloud
    create table if not exists handoff_used (jti text primary key, exp timestamptz not null);
    -- bodies cached by an older parser are fetched again (v3: protected mail, v4: List-Unsubscribe, v5: DKIM coverage of it,
    -- v6: List-Post and read-receipt requests)
    delete from message_bodies where coalesce((headers->>'v')::int, 0) < 6;
    ${KEYS_SCHEMA}

    -- reusable messages ("templates"), per person
    create table if not exists templates (
      id uuid primary key default gen_random_uuid(),
      owner text not null,
      name text not null,
      subject text not null default '',
      html text not null default '',
      created_at timestamptz not null default now()
    );
    create index if not exists templates_owner on templates (owner, lower(name));
    -- shared folders (IMAP namespaces and ACLs): whose folder it is, and what you may do there (null: everything)
    alter table folders add column if not exists namespace text not null default 'personal';
    alter table folders add column if not exists shared_owner text;
    alter table folders add column if not exists rights text;
    -- someone else's folder the server lists but will not open (a leftover share): hidden while it holds no mirrored mail
    alter table folders add column if not exists unavailable_at timestamptz;
    alter table accounts add column if not exists supports_acl boolean not null default false;
    -- per-user choices that are not tied to one account
    create table if not exists user_prefs (
      owner text primary key,
      notify_new_mail boolean not null default true
    );
    alter table user_prefs add column if not exists read_receipts text not null default 'ask';
    -- senders (an address, or "@domain" for everyone there) whose remote images load without asking, per person
    create table if not exists image_senders (
      owner text not null,
      sender text not null,
      created_at timestamptz not null default now(),
      primary key (owner, sender)
    );
    -- running service instances (a heartbeat each): one instance per database is the supported setup, so a second one is reported
    create table if not exists service_instances (
      id text primary key,
      host text not null default '',
      version text not null default '',
      started_at timestamptz not null default now(),
      seen_at timestamptz not null default now()
    );
    -- mail servers set up by a Nextcloud administrator in Nextcloud's admin settings (one row; NCMAIL_MAIL_CONFIG is merged with it)
    create table if not exists mail_server_config (
      id int primary key default 1 check (id = 1),
      config jsonb not null,
      updated_at timestamptz not null default now(),
      updated_by text not null default ''
    );
    -- the last connection check of each mail server set up for everybody (by its id), for the admin page
    create table if not exists mail_server_status (
      server_id text primary key,
      result jsonb not null,
      checked_at timestamptz not null default now()
    );
    -- new mail Nextcloud has yet to announce (or has announced and may take back once it is read).
    -- No foreign key: a message deleted after it was announced must still be reported, so its notification goes away.
    create table if not exists new_mail (
      message_id bigint primary key,
      owner text not null,
      created_at timestamptz not null default now(),
      delivered_at timestamptz
    );
    create index if not exists new_mail_pending on new_mail (message_id) where delivered_at is null;

    -- Nextcloud calendar to put invitations into, and what has been put there
    create table if not exists calendar_links (
      account_id uuid primary key references accounts(id) on delete cascade,
      base_url text not null, username text not null, password_enc text not null,
      calendar_href text not null, calendar_name text not null default '',
      auto_import boolean not null default true,
      created_at timestamptz not null default now()
    );
    create table if not exists calendar_imports (
      account_id uuid not null references accounts(id) on delete cascade,
      uid text not null, recurrence_id text not null default '',
      sequence int not null default 0, href text not null, status text not null default '', message_id bigint,
      imported_at timestamptz not null default now(),
      primary key (account_id, uid, recurrence_id)
    );
    alter table calendar_imports add column if not exists answer text not null default '';
  `;
