import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { AccountSummary } from "@ncmail/shared";
import { api, type Folder } from "./api.ts";
import { load as cload, peek, lastView, rememberView } from "./cache.ts";
import { setDark } from "./theme.ts";
import type { SettingsPage } from "./Settings.tsx";
import { MailView } from "./MailView.tsx";
import type { ComposeInit, SentInfo } from "./Compose.tsx";
import { FolderTree } from "./FolderTree.tsx";
import { SearchBox } from "./SearchBox.tsx";
import { Help } from "./Help.tsx";
import { Icon } from "./icons.tsx";
import { IconButton, useToast } from "./ui.tsx";
import { runLastUndo } from "./undoStack.ts";
import { usePref } from "./prefs.ts";
import { Resizer } from "./Resizer.tsx";
import { askParentToLink, handshake, inFrame, keepSession, onParent, setParentOrigin, tellParentReady } from "./embed.ts";
import { refreshNc } from "./nc.ts";
import { Scheduled, type ScheduledItem } from "./Scheduled.tsx";
import { useContextMenu } from "./ContextMenu.tsx";
import { refreshLabels, useLabels } from "./labels.ts";
import { clearPersisted } from "./cache.ts";

// The rich-text editor (ProseMirror) is most of the bundle but is not needed to show the inbox, so these load on demand.
// They are fetched in the background right after the first paint, so opening the composer or settings is still instant.
const loadCompose = () => import("./Compose.tsx");
const loadSettings = () => import("./Settings.tsx");
const Compose = lazy(() => loadCompose().then((m) => ({ default: m.Compose })));
const Settings = lazy(() => loadSettings().then((m) => ({ default: m.Settings })));
const idle = (fn: () => void) => ("requestIdleCallback" in window ? (window as any).requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(fn, 1500));

/** Keep the old array (and so skip re-rendering a long folder tree) when nothing visible changed. */
const sameFolders = (a: Folder[], b: Folder[]) =>
  a.length === b.length && a.every((x, i) => { const y = b[i]!; return x.id === y.id && x.path === y.path && x.name === y.name && x.rights === y.rights && x.total === y.total && x.unseen === y.unseen && x.syncing === y.syncing && x.syncError === y.syncError && x.selectable === y.selectable; });

const typing = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable); };
const GO: Record<string, string> = { i: "\\Inbox", s: "\\Sent", d: "\\Drafts", a: "\\Archive", t: "\\Trash", j: "\\Junk" };

/**
 * Mail only runs inside Nextcloud. Nextcloud (the page around this frame) vouches for the user with a signed token, which the server turns
 * into a session; the session is renewed the same way, so it lasts as long as the Nextcloud session. Opened any other way there is nothing to sign in with.
 */
type Gate = "checking" | "ok" | "blocked" | "ended";
export function App() {
  const [gate, setGate] = useState<Gate>("checking");
  const stop = useRef<(() => void) | null>(null);
  const started = useRef(false);
  const start = useCallback(async () => {
    const m = await fetch("/api/auth/me").then((r) => r.json()).catch(() => null);
    if (!m || !m.authRequired) { setGate("ok"); return; } // single-user mode: nothing to check
    setParentOrigin(m.nextcloudOrigin);
    onParent("ncmail:theme", (t) => setDark(!!t.dark));
    let user: string | null = m.user;
    if (!user) {
      if (!inFrame) { setGate(m.standalone ? "ended" : "blocked"); return; }
      if (!(await handshake(true))) { setGate("ended"); return; }
      user = (await fetch("/api/auth/me").then((r) => r.json()).catch(() => ({}))).user ?? null;
      if (!user) { setGate("ended"); return; }
    } else if (inFrame) handshake(true).catch(() => {}); // learn the theme and get a fresh session in the background
    const known = localStorage.getItem("ncmail.user");
    if (known !== null && known !== user) { clearPersisted(); localStorage.removeItem("ncmail.last"); } // a different person on this browser
    localStorage.setItem("ncmail.user", user!);
    started.current = true;
    setGate("ok");
    if (inFrame) stop.current = keepSession(m.sessionSeconds ?? 900, () => setGate("ended"));
  }, []);
  useEffect(() => {
    start();
    // A request was refused because the session ran out: ask Nextcloud for a new one, and show the page again. (Not before we have started, and not in a loop.)
    const lost = async () => {
      if (!started.current) return;
      const again = Date.now() - Number(sessionStorage.getItem("ncmail.reauth") ?? 0) < 20_000;
      if (inFrame && !again && (await handshake())) { sessionStorage.setItem("ncmail.reauth", String(Date.now())); location.reload(); }
      else setGate("ended");
    };
    window.addEventListener("ncmail:auth-required", lost);
    return () => { window.removeEventListener("ncmail:auth-required", lost); stop.current?.(); };
  }, [start]);
  if (gate === "checking") return null;
  if (gate === "blocked") return <Notice title="Open Mail from Nextcloud" text="This mail app runs inside Nextcloud. Sign in to Nextcloud and choose Mail in its menu." />;
  if (gate === "ended") return <Notice title="Your session has ended" text="Mail follows your Nextcloud session. Reload the page, or sign in to Nextcloud again." action={inFrame ? { label: "Reload", run: () => location.reload() } : undefined} />;
  return <MailApp />;
}

function Notice({ title, text, action }: { title: string; text: string; action?: { label: string; run: () => void } }) {
  return (
    <div className="login">
      <div className="card login-card">
        <div className="brand" style={{ minWidth: 0 }}><img className="brand-icon" src="/brand/icon.svg" alt="" /><span>Mail</span></div>
        <h2>{title}</h2>
        <p className="hint" style={{ margin: 0 }}>{text}</p>
        {action && <button className="btn primary" onClick={action.run}>{action.label}</button>}
      </div>
    </div>
  );
}

function MailApp() {
  // Start from what we saw last time (instant), then refresh in the background.
  const [boot] = useState(() => {
    const l = lastView();
    const accs = peek<AccountSummary[]>("/accounts");
    const aid = accs?.some((a) => a.id === l.accountId) ? l.accountId! : accs?.[0]?.id ?? null;
    const fl = (aid ? peek<Folder[]>(`/accounts/${aid}/folders`) : undefined) ?? [];
    const fid = l.folderId === "unified" || fl.some((f) => f.id === l.folderId) ? l.folderId! : fl.find((f) => f.specialUse === "\\Inbox")?.id ?? null;
    return { accs: accs ?? [], aid, fl, fid, known: !!accs };
  });
  const toast = useToast();
  const ctxMenu = useContextMenu();
  const [density] = usePref("density");
  const [undoSend] = usePref("undoSend");
  const [accounts, setAccounts] = useState<AccountSummary[]>(boot.accs);
  const [loaded, setLoaded] = useState(boot.known);
  const [accountId, setAccountId] = useState<string | null>(boot.aid);
  const [folders, setFolders] = useState<Folder[]>(boot.fl);
  const [folderId, setFolderId] = useState<string | null>(boot.fid);
  const [view, setView] = useState<"mail" | "settings">("mail");
  const [settingsPage, setSettingsPage] = useState<SettingsPage>({ kind: "general" });
  const [compose, setCompose] = useState<ComposeInit | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [allFolders, setAllFolders] = useState<Folder[]>([]); // every account's folders, for the unified inbox
  const [scheduled, setScheduled] = useState<ScheduledItem[]>([]);
  const [schedOpen, setSchedOpen] = useState(false);

  // ---- search: typed text is applied after a short pause; picking a folder ends the search ----
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"all" | "folder">("all");
  const [textMode, setTextMode] = useState(false);
  useEffect(() => { const t = setTimeout(() => setQ(typed.trim()), 300); return () => clearTimeout(t); }, [typed]);
  useEffect(() => { setTyped(""); setQ(""); }, [accountId]);

  useEffect(() => { idle(() => { loadCompose(); loadSettings(); }); }, []);

  const loadAccounts = useCallback(async () => {
    const list = await cload<AccountSummary[]>("/accounts").catch(() => null);
    if (!list) return; // could not load (for example not signed in yet): say nothing rather than "no accounts"
    setAccounts(list); setLoaded(true);
    setAccountId((cur) => (cur && list.some((a) => a.id === cur) ? cur : list[0]?.id ?? null));
    if (list.length === 0) { setView("settings"); setSettingsPage({ kind: "add" }); }
  }, []);
  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const wantFolder = useRef<string | null>(null); // a link asked for this folder: select it as soon as the folder list is there
  const [focus, setFocus] = useState<any>(null);
  const loadFolders = useCallback(async () => {
    if (!accountId) { setFolders([]); return; }
    const f = await cload<Folder[]>(`/accounts/${accountId}/folders`).catch(() => [] as Folder[]);
    setFolders((prev) => (sameFolders(prev, f) ? prev : f));
    const want = wantFolder.current && f.some((x) => x.id === wantFolder.current) ? wantFolder.current : null;
    if (want) wantFolder.current = null;
    setFolderId((cur) => want ?? (cur === "unified" || (cur && f.some((x) => x.id === cur)) ? cur : f.find((x) => x.specialUse === "\\Inbox")?.id ?? f[0]?.id ?? null));
  }, [accountId]);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) firstRun.current = false; // keep the restored folder on the first run
    else { setFolderId(null); if (accountId) setFolders(peek<Folder[]>(`/accounts/${accountId}/folders`) ?? []); }
    loadFolders();
  }, [loadFolders]);
  useEffect(() => { rememberView({ accountId, folderId }); }, [accountId, folderId]);
  // While the very first sync is still discovering folders, poll until they appear.
  useEffect(() => {
    if (!accountId || folders.length > 0) return;
    api(`/accounts/${accountId}/sync`, { method: "POST" }).catch(() => {}); // first sync was never started (or failed)
    const t = setInterval(loadFolders, 1500);
    return () => clearInterval(t);
  }, [accountId, folders.length, loadFolders]);

  // ---- Nextcloud tells us what to open (a search result, a link from Contacts) and that we are ready ----
  useEffect(() => {
    const off = onParent("ncmail:navigate", async ({ open }) => {
      const files = Array.isArray(open?.attach) ? open.attach.filter((p: unknown): p is string => typeof p === "string").slice(0, 20) : [];
      if (files.length) {
        // the files come from Nextcloud through the app password; the first time, Nextcloud has to create it first
        const nc = await api<{ available: boolean; connected: boolean }>("/nextcloud").catch(() => null);
        if (nc?.available && !nc.connected) { await askParentToLink().catch(() => {}); refreshNc(); }
        const names = files.map((p: string) => p.split("/").pop() || p);
        setCompose({ to: open.compose ? String(open.compose) : "", subject: open.subject ?? (names.length === 1 ? names[0] : `${names.length} files`), body: open.body ?? "", ncFiles: files });
      } else if (open?.compose) setCompose({ to: String(open.compose), subject: open.subject ?? "", body: open.body ?? "" });
      if (open?.message) {
        const m = await api<any>(`/messages/${encodeURIComponent(open.message)}`).catch(() => null);
        if (!m) { toast({ kind: "error", message: "That message could not be found." }); return; }
        wantFolder.current = String(m.folderId);
        setAccountId(m.accountId); setFolderId(String(m.folderId)); setView("mail"); setFocus(m);
      }
    });
    tellParentReady();
    return off;
  }, [toast]);
  // The first time, Nextcloud creates the app password for Files and Contacts by itself (no separate sign-in)
  useEffect(() => {
    if (!inFrame) return;
    api<{ available: boolean; connected: boolean }>("/nextcloud").then(async (n) => { if (n.available && !n.connected) { await askParentToLink(); refreshNc(); } }).catch(() => {});
  }, []);

  // ---- messages waiting to be sent (undo-send) and ones that failed: a failure is never silent ----
  const reported = useRef(new Set<string>());
  const checkOutbox = useCallback(async () => {
    const list = await api<{ id: string; subject: string; status: string; error: string | null; to: string[]; sendAt: string; scheduled?: boolean }[]>("/outbox").catch(() => []);
    setScheduled(list.filter((o) => o.status === "pending" && o.scheduled));
    for (const o of list) {
      if (o.status !== "failed" || reported.current.has(o.id)) continue;
      reported.current.add(o.id);
      toast({ kind: "error", ttl: 20000, message: `"${o.subject || "(no subject)"}" to ${o.to[0] ?? "?"} could not be sent: ${o.error ?? "unknown error"}`,
        action: { label: "Dismiss", run: () => api(`/outbox/${o.id}`, { method: "DELETE" }).catch(() => {}) } });
    }
  }, [toast]);
  useEffect(() => { checkOutbox(); }, [checkOutbox]);

  // ---- live updates: the server pushes an event whenever a sync finished (IMAP IDLE, polling, actions) ----
  const sseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loadAll = useCallback(async () => {
    if (accounts.length < 2) { setAllFolders([]); return; }
    const lists = await Promise.all(accounts.map((a) => cload<Folder[]>(`/accounts/${a.id}/folders`).catch(() => [] as Folder[])));
    setAllFolders((prev) => { const next = lists.flat(); return sameFolders(prev, next) ? prev : next; });
  }, [accounts]);
  useEffect(() => { loadAll(); }, [loadAll]);
  const live = useRef({ accountId, folderId, loadFolders, checkOutbox, loadAll });
  live.current = { accountId, folderId, loadFolders, checkOutbox, loadAll };
  useEffect(() => {
    let es: EventSource, retry: ReturnType<typeof setTimeout> | undefined, wasDown = false;
    const connect = () => {
      es = new EventSource("/api/events");
      es.onmessage = (m) => {
        const e = JSON.parse(m.data) as { type?: string; accountId: string; folderId?: string };
        const cur = live.current;
        if (e.type === "outbox") { cur.checkOutbox(); return; }
        if (cur.folderId === "unified") { clearTimeout(sseTimer.current); sseTimer.current = setTimeout(() => { live.current.loadFolders(); live.current.loadAll(); }, 300); window.dispatchEvent(new Event("ncmail:refresh")); return; }
        if (e.accountId === cur.accountId) {
          clearTimeout(sseTimer.current); sseTimer.current = setTimeout(() => live.current.loadFolders(), 300); // counts / folder list (bursts coalesce)
          if (!e.folderId || e.folderId === cur.folderId) window.dispatchEvent(new Event("ncmail:refresh"));
        }
      };
      es.onerror = () => {
        wasDown = true;
        // The browser gives up on a refused stream (for example 429: too many open windows); try again later ourselves.
        if (es.readyState === EventSource.CLOSED) { clearTimeout(retry); retry = setTimeout(connect, 60_000); }
      };
      es.onopen = () => { if (wasDown) { wasDown = false; live.current.loadFolders(); window.dispatchEvent(new Event("ncmail:refresh")); } };
    };
    connect();
    return () => { clearTimeout(retry); es.close(); };
  }, []);

  // Unread count in the tab title.
  const baseTitle = useRef(document.title);
  const inboxUnseen = folders.find((f) => f.specialUse === "\\Inbox")?.unseen ?? 0;
  useEffect(() => { document.title = (inboxUnseen > 0 ? `(${inboxUnseen}) ` : "") + baseTitle.current; }, [inboxUnseen]);

  const { labels, saved } = useLabels(accountId);
  const inboxes = allFolders.filter((f) => f.specialUse === "\\Inbox");
  const unifiedFolder: Folder = { id: "unified", accountId: accountId ?? accounts[0]?.id ?? "", path: "", delimiter: null, name: "All inboxes", specialUse: "\\Inbox", selectable: true, syncing: false, syncError: null,
    total: inboxes.reduce((n, f) => n + f.total, 0), unseen: inboxes.reduce((n, f) => n + f.unseen, 0) };
  const unifiedOn = folderId === "unified" && accounts.length > 1;
  useEffect(() => { if (folderId === "unified" && loaded && accounts.length < 2) setFolderId(folders.find((f) => f.specialUse === "\\Inbox")?.id ?? null); }, [folderId, accounts.length, loaded, folders]);
  const folder = unifiedOn ? unifiedFolder : folders.find((f) => f.id === folderId);
  const account = accounts.find((a) => a.id === accountId);

  // "Find messages from this sender" and similar ask the search box to run a query
  useEffect(() => { const h = (e: Event) => { setTyped(String((e as CustomEvent).detail ?? "")); setView("mail"); }; window.addEventListener("ncmail:search", h); return () => window.removeEventListener("ncmail:search", h); }, []);
  const openFolder = useCallback((id: string) => { setFolderId(id); setView("mail"); setTyped(""); setQ(""); setNavOpen(false); }, []);
  const openCompose = useCallback((i: ComposeInit) => setCompose(i), []);

  // ---- sent: with "undo send" the message waits in the outbox for a few seconds ----
  const onSent = (s: SentInfo) => {
    loadFolders();
    if (!s.outboxId) { toast({ message: "Message sent", kind: "success", ttl: 3500 }); return; }
    checkOutbox();
    toast({
      message: s.scheduledFor ? `Scheduled for ${s.scheduledFor}` : "Sending…", kind: "success", ttl: s.scheduledFor ? 8000 : Math.max(3, s.delay) * 1000,
      action: { label: "Undo", run: async () => {
        try { await api(`/outbox/${s.outboxId}/cancel`, { method: "POST" }); setCompose(s.snapshot); toast({ message: "Sending cancelled. Your message is open again.", ttl: 4000 }); }
        catch { toast({ message: "Too late: the message was already sent.", kind: "error" }); }
      } },
    });
  };

  // ---- keyboard shortcuts that work everywhere (list and message ones live in MailView / Reader) ----
  useEffect(() => {
    if (view !== "settings") return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) setView("mail"); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [view]);
  const goPending = useRef(false);
  const goTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || document.querySelector(".modal-backdrop")) return;
      if (goPending.current) {
        goPending.current = false; clearTimeout(goTimer.current);
        const su = GO[e.key.toLowerCase()];
        const f = su && live.current.accountId ? folderBySpecial(su) : undefined;
        if (f) { e.preventDefault(); openFolder(f.id); }
        return;
      }
      if (e.key === "g") { goPending.current = true; goTimer.current = setTimeout(() => { goPending.current = false; }, 1200); }
      else if (e.key === "c") { e.preventDefault(); setCompose({ accountId: live.current.accountId ?? undefined }); }
      else if (e.key === "?") { e.preventDefault(); setHelp(true); }
      else if (e.key === "z") { if (runLastUndo()) e.preventDefault(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [openFolder]);
  const foldersRef = useRef(folders); foldersRef.current = folders;
  const folderBySpecial = (su: string) => foldersRef.current.find((f) => f.specialUse === su);

  return (
    <div className={`app${density === "compact" ? " compact-rows" : ""}${window.self !== window.top ? " embedded" : ""}`}>
      {/* first in the tab order, shown when focused: past the search tips and the folders, straight to the list */}
      <button type="button" className="skip-link" onClick={() => {
        const list = document.querySelector<HTMLElement>('[aria-label="Messages"]');
        (list?.querySelector<HTMLElement>("button.msg.active") ?? list?.querySelector<HTMLElement>("button.msg"))?.focus();
      }}>Skip to messages</button>
      <header className="header">
        <IconButton icon="menu" label="Menu" className="menu-btn" onClick={() => setNavOpen((o) => !o)} />
        <div className="brand">
          <img className="brand-icon" src="/brand/icon.svg" alt="" />
          <span>Mail</span>
        </div>
        {accounts.length > 0 && <SearchBox value={typed} onChange={(v) => { setTyped(v); if (view !== "mail") setView("mail"); }} />}
        <div className="header-actions">
          <IconButton icon="help" label="Keyboard shortcuts" hint="?" onClick={() => setHelp(true)} size={17} />
        </div>
      </header>
      <div className={`layout${navOpen ? " nav-open" : ""}`}>
        <nav className="nav" aria-label="Folders">
          <button className="btn primary new" disabled={!accounts.length} onClick={() => { setCompose({ accountId: accountId ?? undefined }); setNavOpen(false); }}>
            <Icon name="compose" size={16} /> New message
          </button>
          {(accounts.length > 1 || scheduled.length > 0) && (
            <div className="nav-views" aria-label="Across all accounts">
              {accounts.length > 1 && <button className={`nav-item${unifiedOn ? " active" : ""}`} onClick={() => openFolder("unified")}><Icon name="inbox" size={16} /><span className="nav-name">All inboxes</span>{unifiedFolder.unseen > 0 && <span className="nav-count">{unifiedFolder.unseen.toLocaleString()}</span>}</button>}
              {scheduled.length > 0 && <button className="nav-item" onClick={() => { setSchedOpen(true); setNavOpen(false); }}><Icon name="clock" size={16} /><span className="nav-name">Scheduled</span><span className="nav-count">{scheduled.length}</span></button>}
            </div>
          )}
          {accounts.length > 1 && (
            <select aria-label="Account" value={accountId ?? ""} onChange={(e) => { setAccountId(e.target.value); setView("mail"); }}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          <div className="nav-scroll">
            {accountId && <FolderTree folders={folders} accountId={accountId} activeId={folderId} onSelect={openFolder} onMoved={loadFolders} canShare={accounts.find((x) => x.id === accountId)?.supportsAcl}
              heading={account ? account.name || account.email : undefined} headingTitle={account?.email} />}
                        {labels.length > 0 && <div className="nav-heading">Labels</div>}
            {labels.map((l) => <button key={l.slug} className="nav-item" onContextMenu={(e) => ctxMenu(e, [{ label: "Show messages", icon: "search", onClick: () => { setTyped(`label:${l.slug}`); setView("mail"); } }, { label: "Edit labels…", icon: "tag", onClick: () => { setSettingsPage({ kind: "account", id: accountId!, tab: "labels" }); setView("settings"); } }])} onClick={() => { setTyped(`label:${l.slug}`); setView("mail"); setNavOpen(false); }}><span className="dot" style={{ background: l.color }} /><span className="nav-name">{l.name}</span></button>)}
            {saved.length > 0 && <div className="nav-heading">Saved searches</div>}
            {saved.map((s) => (
              <div key={s.id} className="nav-row" onContextMenu={(e) => ctxMenu(e, [{ label: "Run this search", icon: "search", onClick: () => { setTyped(s.query); setView("mail"); } }, { label: "Delete saved search", icon: "trash", danger: true, onClick: async () => { await api(`/accounts/${accountId}/saved-searches/${s.id}`, { method: "DELETE" }).catch(() => {}); refreshLabels(accountId!); } }])}>
                <button className="nav-item" onClick={() => { setTyped(s.query); setView("mail"); setNavOpen(false); }}><Icon name="search" size={16} /><span className="nav-name">{s.name}</span></button>
                <button className="nav-x" aria-label={`Delete saved search ${s.name}`} title="Delete this saved search" onClick={async () => { await api(`/accounts/${accountId}/saved-searches/${s.id}`, { method: "DELETE" }).catch(() => {}); refreshLabels(accountId!); }}><Icon name="x" size={13} /></button>
              </div>
            ))}
          </div>
          <div className="nav-footer">
            <button className="nav-item" onClick={() => {
              setView("settings"); setNavOpen(false);
              // open on the account being used, so "its settings" is one click away
              if (settingsPage.kind === "general" && accountId) setSettingsPage({ kind: "account", id: accountId, tab: "details" });
            }}><Icon name="settings" size={16} /><span className="nav-name">Account &amp; settings</span></button>
          </div>
        </nav>
        <Resizer cssVar="--nav-w" storageKey="ncmail.w.nav" min={200} max={440} label="Resize folder column" />
        <div className="scrim" onClick={() => setNavOpen(false)} />
        {!folder ? (
          <main className="content"><div className="content-inner"><p className="hint">{loaded ? "Loading folders…" : "Loading…"}</p></div></main>
        ) : (
          <MailView key={folder.id} focus={focus} onFocused={() => setFocus(null)} folder={folder} folders={unifiedOn ? allFolders : folders} accounts={accounts} onFolderUpdate={loadFolders} onCompose={openCompose}
            search={q ? { q, scope, text: textMode, onScope: setScope, onText: setTextMode, onClear: () => { setTyped(""); setQ(""); } } : undefined} />
        )}
      </div>
      {view === "settings" && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setView("mail")}>
          <div className="modal settings-modal" role="dialog" aria-label="Settings">
            <button className="btn icon sm ghost settings-close" aria-label="Close settings" title="Close (Esc)" onClick={() => setView("mail")}><Icon name="x" size={18} /></button>
            <Suspense fallback={<div className="settings"><p className="hint" style={{ padding: 24 }}>Loading…</p></div>}>
              <Settings accounts={accounts} page={settingsPage} onPage={setSettingsPage} onChanged={loadAccounts}
                onAdded={(a) => { setAccountId(a.id); setView("mail"); loadAccounts(); }}
                onRemoved={() => { setSettingsPage({ kind: "general" }); loadAccounts(); }} />
            </Suspense>
          </div>
        </div>
      )}
      {compose && <Suspense fallback={null}><Compose accounts={accounts} init={compose} undoSeconds={undoSend} onSent={onSent} onClose={() => setCompose(null)} onChanged={loadFolders} /></Suspense>}
      {schedOpen && <Scheduled items={scheduled} onChange={checkOutbox} onClose={() => setSchedOpen(false)} />}
      {help && <Help onClose={() => setHelp(false)} />}
    </div>
  );
}
