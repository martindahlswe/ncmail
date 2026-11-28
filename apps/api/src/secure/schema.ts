/** Table for PGP keys and S/MIME certificates. */
export const KEYS_SCHEMA = `
  create table if not exists crypto_keys (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references accounts(id) on delete cascade,
    kind text not null,
    has_private boolean not null default false,
    emails text[] not null default '{}',
    name text not null default '',
    fingerprint text not null,
    key_ids text[] not null default '{}',
    not_before timestamptz, not_after timestamptz,
    can_sign boolean not null default true, can_encrypt boolean not null default true,
    public_data text not null,
    private_enc text,
    info jsonb not null default '{}',
    created_at timestamptz not null default now()
  );
  create unique index if not exists crypto_keys_unique on crypto_keys (account_id, kind, fingerprint);
  create index if not exists crypto_keys_emails on crypto_keys using gin (emails);
  create index if not exists crypto_keys_ids on crypto_keys using gin (key_ids);
  -- kept from a signed message (trust on first use), rather than imported on purpose
  alter table crypto_keys add column if not exists from_message boolean not null default false;
`;
