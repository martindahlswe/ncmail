import { useEffect, useState } from "react";
import type { AccountSummary } from "@ncmail/shared";
import { api } from "./api.ts";
import { Icon } from "./icons.tsx";
import { theme } from "./theme.ts";
import { clearPersisted } from "./cache.ts";
import { AccountForm } from "./AccountForm.tsx";
import { IdentityEditor } from "./IdentityEditor.tsx";
import { IndexSettings } from "./IndexSettings.tsx";
import { SecuritySettings } from "./SecuritySettings.tsx";
import { CalendarSettings } from "./CalendarSettings.tsx";
import { NextcloudSettings } from "./NextcloudSettings.tsx";
import { LabelSettings } from "./LabelSettings.tsx";
import { FilterSettings } from "./FilterSettings.tsx";
import { useNc } from "./nc.ts";
import { usePref } from "./prefs.ts";
import { setReadReceipts, stopImagesFrom, useReaderPrefs } from "./readerPrefs.ts";
import { useDialog } from "./ui.tsx";

export type AccountTab = "details" | "servers" | "senders" | "security" | "calendar" | "labels" | "filters" | "search";
export type SettingsPage = { kind: "general" } | { kind: "nextcloud" } | { kind: "add" } | { kind: "account"; id: string; tab: AccountTab };

const TABS: { id: AccountTab; label: string; blurb: string }[] = [
  { id: "details", label: "Account", blurb: "How this account is labelled, and its main address." },
  { id: "servers", label: "Servers", blurb: "Where mail is read from and sent through." },
  { id: "senders", label: "Sender addresses", blurb: "The names and addresses you send from, and their signatures." },
  { id: "security", label: "Security", blurb: "PGP keys and S/MIME certificates for signing and encrypting mail." },
  { id: "calendar", label: "Calendar", blurb: "Put invitations from your mail into your Nextcloud calendar." },
  { id: "filters", label: "Filters and vacation", blurb: "Rules that sort incoming mail, and an automatic out-of-office reply. They run on your mail server." },
  { id: "labels", label: "Labels and searches", blurb: "Tags for your messages, and searches you want to keep." },
  { id: "search", label: "Sync and search", blurb: "How much mail is kept in sync, and searching inside message text." },
];

function SignedIn() {
  const [me, setMe] = useState<{ authRequired: boolean; user: string | null } | null>(null);
  useEffect(() => { fetch("/api/auth/me").then((r) => r.json()).then(setMe).catch(() => {}); }, []);
  if (!me?.authRequired || !me.user) return null;
  return (
    <section className="card">
      <h3>Nextcloud user</h3>
      <p className="hint" style={{ margin: 0 }}>Signed in as <b>{me.user}</b>. The mail accounts you add belong to this user and are not visible to anyone else.</p>
      <p className="hint" style={{ margin: 0 }}>Mail signs out when you sign out of Nextcloud.</p>
    </section>
  );
}

/** New mail as Nextcloud notifications (only when Mail runs inside Nextcloud). Kept on the server, so it holds on every device. */
function Notifications() {
  const [me, setMe] = useState<{ authRequired: boolean } | null>(null);
  const [on, setOn] = useState<boolean | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then(setMe).catch(() => {});
    api<{ notifyNewMail: boolean }>("/prefs").then((p) => setOn(p.notifyNewMail)).catch(() => {});
  }, []);
  if (!me?.authRequired || on === null) return null;
  const change = async (v: boolean) => {
    setOn(v); setErr("");
    try { await api("/prefs", { method: "PATCH", body: JSON.stringify({ notifyNewMail: v }) }); }
    catch (e: any) { setOn(!v); setErr(e.message); }
  };
  return (
    <section className="card">
      <h3>Notifications</h3>
      <label className="check-row">
        <input type="checkbox" checked={on} onChange={(e) => change(e.target.checked)} />
        <span><b>Notify me in Nextcloud about new mail</b>
          <span className="field-hint">New unread mail in your inboxes appears in Nextcloud's notifications, with the sender and subject. It goes away once you read the message.</span></span>
      </label>
      {err && <div className="note error">{err}</div>}
    </section>
  );
}

/** Templates: made from the composer ("Save this message as a template"), renamed or removed here. */
function Templates() {
  const dialog = useDialog();
  const [list, setList] = useState<{ id: string; name: string; subject: string }[] | null>(null);
  const [err, setErr] = useState("");
  const load = () => api<{ id: string; name: string; subject: string }[]>("/templates").then(setList).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const run = async (fn: () => Promise<unknown>) => { setErr(""); try { await fn(); load(); } catch (e: any) { setErr(e.message); } };
  return (
    <section className="card">
      <h3>Templates</h3>
      <p className="hint" style={{ margin: 0 }}>Messages you send often. Insert one with <b>Templates</b> in the composer, where you can also save the message you are writing as a new one.</p>
      {list && list.length === 0 && <p className="hint" style={{ margin: 0 }}>No templates yet.</p>}
      {list && list.length > 0 && (
        <div className="list">
          {list.map((t) => (
            <div key={t.id} className="list-row">
              <div className="list-row-main">
                <div className="list-row-title"><b>{t.name}</b>{t.subject && <span className="hint"> {t.subject}</span>}</div>
                <div className="row list-row-actions">
                  <button className="btn sm" onClick={async () => { const name = await dialog.prompt({ title: "Rename template", label: "Name", initial: t.name, confirmLabel: "Rename" }); if (name && name !== t.name) run(() => api(`/templates/${t.id}`, { method: "PATCH", body: JSON.stringify({ name }) })); }}>Rename</button>
                  <button className="btn sm danger" onClick={async () => { if (await dialog.confirm({ title: `Remove the template "${t.name}"?`, confirmLabel: "Remove", danger: true })) run(() => api(`/templates/${t.id}`, { method: "DELETE" })); }}>Remove</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {err && <div className="note error">{err}</div>}
    </section>
  );
}

/** Read receipts: asked about in each message that requests one, or never sent. */
function ReadReceipts() {
  const { readReceipts } = useReaderPrefs();
  const [err, setErr] = useState("");
  if (!readReceipts) return null;
  const change = (v: "ask" | "never") => { setErr(""); setReadReceipts(v).catch((e) => setErr(e.message)); };
  return (
    <div className="field">
      <span className="field-label">Read receipts</span>
      <select aria-label="Read receipts" value={readReceipts} onChange={(e) => change(e.target.value as "ask" | "never")} style={{ maxWidth: 220 }}>
        <option value="ask">Ask each time</option>
        <option value="never">Never send</option>
      </select>
      <span className="field-hint">Some senders ask to be told when you have read their message. Mail never tells them without asking you first.</span>
      {err && <div className="note error">{err}</div>}
    </div>
  );
}

/** Senders whose remote images load without asking ("Always from ..." under a message), removable here. */
function ImageSenders() {
  const { imageSenders } = useReaderPrefs();
  const [err, setErr] = useState("");
  if (!imageSenders) return null;
  return (
    <div className="field">
      <span className="field-label">Images that load automatically</span>
      {imageSenders.length === 0
        ? <span className="field-hint">None yet. Under a message with blocked images, choose "Always from ..." to load them for that sender every time.</span>
        : (
          <div className="list">
            {imageSenders.map((s) => (
              <div key={s} className="list-row">
                <div className="list-row-main">
                  <div className="list-row-title">{s.startsWith("@") ? <>Everyone at <b>{s.slice(1)}</b></> : <b>{s}</b>}</div>
                  <div className="row list-row-actions">
                    <button className="btn sm" onClick={() => { setErr(""); stopImagesFrom(s).catch((e) => setErr(e.message)); }}>Remove</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      <span className="field-hint">Never in Junk, and never for a message that failed the sender checks.</span>
      {err && <div className="note error">{err}</div>}
    </div>
  );
}

function General() {
  const [threads, setThreads] = usePref("threads");
  const [remember, setRemember] = usePref("persist");
  const [density, setDensity] = usePref("density");
  const [undoSend, setUndoSend] = usePref("undoSend");
  const [readReceipt, setReadReceipt] = usePref("readReceipt");
  return (
    <div className="stack">
      <SignedIn />
      <Notifications />
      <section className="card">
        <h3>Reading</h3>
        <label className="check-row">
          <input type="checkbox" checked={threads} onChange={(e) => setThreads(e.target.checked)} />
          <span><b>Group messages into conversations</b><span className="field-hint">Replies are shown together as one row. You can switch this from the list header too.</span></span>
        </label>
        <div className="field">
          <span className="field-label">List density</span>
          <div className="seg" role="group" aria-label="List density" style={{ justifySelf: "start" }}>
            <button className={density === "comfortable" ? "on" : ""} onClick={() => setDensity("comfortable")}>Comfortable</button>
            <button className={density === "compact" ? "on" : ""} onClick={() => setDensity("compact")}>Compact</button>
          </div>
          <span className="field-hint">Compact shows more messages at once and hides the sender pictures.</span>
        </div>
        <ReadReceipts />
      </section>
      <section className="card">
        <h3>Writing</h3>
        <div className="field">
          <span className="field-label">Undo send</span>
          <select aria-label="Undo send" value={undoSend} onChange={(e) => setUndoSend(Number(e.target.value))} style={{ maxWidth: 220 }}>
            <option value={0}>Off: send immediately</option>
            <option value={5}>5 seconds</option><option value={10}>10 seconds</option><option value={20}>20 seconds</option><option value={30}>30 seconds</option>
          </select>
          <span className="field-hint">After you press Send the message waits this long, so you can still take it back. It is kept safely on the server, so closing the tab does not lose it.</span>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={readReceipt} onChange={(e) => setReadReceipt(e.target.checked)} />
          <span><b>Ask for a read receipt by default</b><span className="field-hint">New messages ask the recipient's mail program to confirm when the message is opened. You can change it per message under Options in the composer. Many people and programs never send one.</span></span>
        </label>
      </section>
      <Templates />
      <section className="card">
        <h3>Speed and privacy</h3>
        <label className="check-row">
          <input type="checkbox" checked={remember} onChange={(e) => {
            if (!e.target.checked) { clearPersisted(); localStorage.removeItem("ncmail.last"); }
            setRemember(e.target.checked);
          }} />
          <span><b>Remember my last view so the app starts instantly</b>
            <span className="field-hint">Keeps the senders and subjects of recently viewed lists in this browser. Turn it off on a shared computer; this also clears what was stored.</span></span>
        </label>
        <ImageSenders />
      </section>
      <section className="card">
        <h3>Appearance</h3>
        <p className="hint" style={{ margin: 0 }}>
          {theme.enabled
            ? <>Accent colour, logo and dark mode follow your Nextcloud instance{theme.name ? <> (<b>{theme.name}</b>)</> : null}.</>
            : <>Not connected to a Nextcloud instance, so a built-in blue accent is used (and your system's light or dark setting). Set <code>NEXTCLOUD_URL</code> in <code>.env</code> to follow your instance's theme.</>}
        </p>
      </section>
      <section className="card">
        <h3>Keyboard</h3>
        <p className="hint" style={{ margin: 0 }}>Press <kbd>?</kbd> anywhere to see every shortcut. The essentials:</p>
        <dl className="shortcuts">
          <dt><kbd>c</kbd></dt><dd>Write a message</dd>
          <dt><kbd>j</kbd> <kbd>k</kbd></dt><dd>Next / previous message</dd>
          <dt><kbd>e</kbd> <kbd>#</kbd> <kbd>!</kbd></dt><dd>Archive, delete, report spam</dd>
          <dt><kbd>z</kbd></dt><dd>Undo</dd>
          <dt><kbd>/</kbd></dt><dd>Search</dd>
        </dl>
      </section>
    </div>
  );
}

function RemoveAccount({ account, onRemoved }: { account: AccountSummary; onRemoved: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const remove = async () => {
    setBusy(true); setErr("");
    try { await api(`/accounts/${account.id}`, { method: "DELETE" }); onRemoved(); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <section className="card danger-zone">
      <h3>Remove account</h3>
      <p className="hint" style={{ margin: 0 }}>Removes this account, its sender addresses and its local mail index from this app. Mail on the server is not touched.</p>
      {confirming ? (
        <div className="note error">
          <b>Remove {account.name}?</b> This cannot be undone here, but you can add the account again.
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn danger" style={{ flex: "0 0 auto" }} disabled={busy} onClick={remove}>{busy ? "Removing…" : "Yes, remove"}</button>
            <button className="btn" style={{ flex: "0 0 auto" }} disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      ) : <div><button className="btn danger" onClick={() => setConfirming(true)}>Remove account…</button></div>}
      {err && <div className="note error">{err}</div>}
    </section>
  );
}

export function Settings({ accounts, page, onPage, onChanged, onAdded, onRemoved }: {
  accounts: AccountSummary[]; page: SettingsPage; onPage: (p: SettingsPage) => void;
  onChanged: () => void; onAdded: (a: AccountSummary) => void; onRemoved: () => void;
}) {
  const ncState = useNc();
  const account = page.kind === "account" ? accounts.find((a) => a.id === page.id) : undefined;
  const nav = (active: boolean, onClick: () => void, label: React.ReactNode, sub?: string, depth = 0, open = false) => (
    <button className={`snav-item${active ? " active" : ""}${open ? " open" : ""}`} style={{ paddingLeft: 12 + depth * 14 }} onClick={onClick}>
      <span className="snav-label">{label}</span>{sub && <span className="snav-sub">{sub}</span>}
    </button>
  );

  let title = "General", blurb = "Preferences for this app.", panel: React.ReactNode = <General />;
  if (page.kind === "nextcloud") { title = "Nextcloud"; blurb = "Contacts and Files from your Nextcloud."; panel = <NextcloudSettings />; }
  if (page.kind === "add") {
    title = "Add an account"; blurb = "Connect a mail account using its IMAP and SMTP servers. Passwords are stored encrypted.";
    panel = <AccountForm mode="add" onDone={onAdded} onCancel={accounts.length ? () => onPage({ kind: "general" }) : undefined} />;
  } else if (page.kind === "account" && account) {
    const tab = TABS.find((t) => t.id === page.tab)!;
    title = `${account.name} · ${tab.label}`; blurb = tab.blurb;
    panel = page.tab === "details" ? (
      <div className="stack">
        <AccountForm key={`d-${account.id}`} mode="details" account={account} onDone={() => onChanged()} />
        <RemoveAccount account={account} onRemoved={onRemoved} />
      </div>
    ) : page.tab === "servers" ? <AccountForm key={`s-${account.id}`} mode="servers" account={account} onDone={() => onChanged()} />
      : page.tab === "senders" ? <IdentityEditor key={account.id} account={account} onChanged={onChanged} />
      : page.tab === "filters" ? <FilterSettings key={account.id} account={account} />
      : page.tab === "labels" ? <LabelSettings key={account.id} account={account} />
      : page.tab === "calendar" ? <CalendarSettings key={account.id} account={account} />
      : page.tab === "security" ? <SecuritySettings key={account.id} account={account} />
      : <IndexSettings key={account.id} account={account} onChanged={onChanged} />;
  }

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings">
        <h2>Settings</h2>
        {nav(page.kind === "general", () => onPage({ kind: "general" }), "General")}
        {ncState.available && nav(page.kind === "nextcloud", () => onPage({ kind: "nextcloud" }), "Nextcloud", ncState.connected ? `Connected as ${ncState.user}` : "Not connected")}
        <div className="snav-group">Accounts</div>
        {accounts.map((a) => {
          const open = page.kind === "account" && page.id === a.id;
          return (
            <div key={a.id}>
              {nav(false, () => onPage({ kind: "account", id: a.id, tab: open ? page.tab : "details" }), a.name, a.email, 0, open)}
              {open && TABS.map((t) => nav(page.kind === "account" && page.tab === t.id, () => onPage({ kind: "account", id: a.id, tab: t.id }), t.label, undefined, 1))}
            </div>
          );
        })}
        {nav(page.kind === "add", () => onPage({ kind: "add" }), <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><Icon name="plus" size={14} /> Add account</span>)}
      </nav>
      <section className="settings-panel">
        <header className="settings-head"><h2>{title}</h2><p className="hint">{blurb}</p></header>
        {panel}
      </section>
    </div>
  );
}
