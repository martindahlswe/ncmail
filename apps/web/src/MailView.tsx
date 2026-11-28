import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AccountSummary } from "@ncmail/shared";
import { load as cload, peek, prefetch, listPath } from "./cache.ts";
import {
  api, bulk, can, undoMove, fmtDate, folderPath, sortFolders, stripSubject, FILTER_LABELS, SORT_LABELS,
  type BulkAction, type FilterKey, type Folder, type ListPage, type MessageFull, type MessageItem, type SearchState, type SortKey,
} from "./api.ts";
import { Avatar } from "./ThreadBits.tsx";
import { Reader } from "./Reader.tsx";
import { Icon, folderIcon, type IconName } from "./icons.tsx";
import { IconButton, Menu, useToast, type MenuItem } from "./ui.tsx";
import { clearLastUndo, setLastUndo } from "./undoStack.ts";
import { usePref } from "./prefs.ts";
import { Resizer } from "./Resizer.tsx";
import { useContextMenu } from "./ContextMenu.tsx";
import { forwardAsAttachmentInit, forwardInit, replyInit, replyToListInit } from "./replies.ts";
import { SourceModal } from "./Viewer.tsx";
import { PickTime, timeMenu, whenLabel } from "./schedule.tsx";
import { refreshLabels, useLabels } from "./labels.ts";
import type { ComposeInit } from "./Compose.tsx";

const PAGE = 50;
const LATER_PAGE = 150;
const READ_AHEAD_ROWS = 300; // keep this many rows loaded ahead of time, so the first screens of scrolling never wait

/** Checkbox that can show the indeterminate ("some selected") state. */
function TriCheck({ state, onChange }: { state: "none" | "some" | "all"; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === "some"; }, [state]);
  return <input ref={ref} type="checkbox" aria-label="Select all" checked={state === "all"} onChange={onChange} />;
}

interface Selection { key: string; messageId: string; threadId: string | null; item: MessageItem }
const typing = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable); };
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function MailView({ folder, folders, accounts, search, onFolderUpdate, onCompose, focus, onFocused }: {
  focus?: MessageItem & { folderId: string } | null; onFocused?: () => void; folder: Folder; folders: Folder[]; accounts: AccountSummary[]; search?: SearchState; onFolderUpdate: () => void; onCompose: (i: ComposeInit) => void;
}) {
  const toast = useToast();
  const ctxMenu = useContextMenu();
  const [ctxKey, setCtxKey] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const isUnified = folder.id === "unified"; // every account's inbox in one list
  const { labels: allLabels } = useLabels(folder.accountId);
  const [pickRows, setPickRows] = useState<MessageItem[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [density] = usePref("density");
  const ROW = density === "compact" ? 52 : 68;
  const [items, setItems] = useState<MessageItem[]>([]);
  const [next, setNext] = useState<ListPage["next"]>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSortState] = useState<SortKey>(() => (localStorage.getItem("ncmail.sort") as SortKey) || "date_desc");
  const setSort = (s: SortKey) => { localStorage.setItem("ncmail.sort", s); setSortState(s); };
  const [threadPref, setThreadPref] = usePref("threads");
  const dated = sort === "date_desc" || sort === "date_asc";
  const threadMode = threadPref && !search && dated && !isUnified; // search results, other orders and the unified inbox list individual messages
  const searchKey = search ? `${search.q}|${search.scope}|${search.text}` : "";
  const [meta, setMeta] = useState<{ total: number; capped: boolean; partial: boolean; notes: string[]; index?: { enabled: boolean; indexed: number; total: number } } | null>(null);
  const indexOn = !!accounts.find((a) => a.id === folder.accountId)?.indexBodies;
  const [searchBusy, setSearchBusy] = useState(false);

  // ---- bulk selection ----
  const [checked, setChecked] = useState<Set<string>>(new Set()); // row keys
  const [wholeFolder, setWholeFolder] = useState(false);           // "all N messages in this folder"
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const anchor = useRef<number | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [syncing, setSyncing] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const gen = useRef(0); // guards against stale responses after switching folder/filter

  // In conversation mode a row stands for a whole thread; its newest message can change, the thread does not.
  const keyOf = (i: MessageItem) => (threadMode && i.threadId ? `t${i.threadId}` : `m${i.id}`);

  // The first page is small (fastest first paint); later pages are bigger, so fast scrolling needs fewer round trips.
  const query = (cursor?: ListPage["next"], limit = PAGE) => {
    if (search) {
      return `/accounts/${folder.accountId}/search?q=${encodeURIComponent(search.q)}&scope=${search.scope}&folderId=${folder.id}${search.text ? "&text=1" : ""}&limit=${limit}` +
        (cursor ? `&beforeDate=${encodeURIComponent(cursor.date)}&beforeId=${cursor.id}` : "");
    }
    return `${isUnified ? "/unified" : `/folders/${folder.id}`}/messages?limit=${limit}${filter !== "all" ? `&filter=${filter}` : ""}${sort !== "date_desc" ? `&sort=${sort}` : ""}${threadMode ? "&threads=1" : ""}` +
      (cursor ? `&cursor=${encodeURIComponent(JSON.stringify({ v: cursor.v ?? cursor.date, id: cursor.id }))}` : "");
  };

  const firstPath = listPath(folder.id, { filter, sort, threads: threadMode });
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Warm what a click would open, once the pointer rests on a row for a moment.
  const prefetchSoon = (m: MessageItem) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      prefetch(`/messages/${m.id}`);
      if (threadMode && m.threadId) prefetch(`/threads/${m.threadId}?folderId=${folder.id}`);
    }, 120);
  };

  // Reload when folder/filter/mode changes; kick off a background sync. A list seen before appears instantly from the cache.
  useEffect(() => {
    const g = ++gen.current;
    const cached = search ? undefined : peek<ListPage>(firstPath);
    setItems(cached?.items ?? []); setNext(cached?.next ?? null); setSelection(null); setMeta(null); setReady(!!cached);
    setChecked(new Set()); setWholeFolder(false); setConfirmDelete(false); anchor.current = null;
    if (search) {
      setSyncing(false); setSearchBusy(true);
      api<ListPage>(query()).then((p) => {
        if (g !== gen.current) return;
        setItems(p.items); setNext(p.next); setReady(true);
        setMeta({ total: p.total ?? p.items.length, capped: !!p.capped, partial: !!p.partial, notes: p.notes ?? [], index: p.index });
      }).catch((e) => g === gen.current && setMeta({ total: 0, capped: false, partial: false, notes: [e.message] }))
        .finally(() => g === gen.current && setSearchBusy(false));
      return;
    }
    setSearchBusy(false); setSyncing(!isUnified);
    if (!isUnified) api(`/folders/${folder.id}/sync`, { method: "POST" }).catch(() => {});
    cload<ListPage>(firstPath).then((p) => { if (g === gen.current) { setItems(p.items); setNext(p.next); setReady(true); } }).catch(() => g === gen.current && setReady(true));
  }, [folder.id, filter, sort, threadMode, searchKey, reloadTick]);

  // Refresh the head of the list. Also reconciles server-side removals (moved/deleted/replaced drafts):
  // everything newer than the oldest refreshed item must be in the refreshed page, otherwise it is gone.
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  refreshRef.current = async () => {
    if (search) return; // results are a snapshot of the query
    const g = gen.current;
    const [f, p] = await Promise.all([isUnified ? Promise.resolve({ syncing: false } as Folder) : api<Folder>(`/folders/${folder.id}`), cload<ListPage>(firstPath)]).catch(() => [null, null] as const);
    if (!f || !p || g !== gen.current) return;
    setSyncing(f.syncing);
    setItems((cur) => {
      if (!p.next) return p.items; // the page covers the whole folder
      if (sort !== "date_desc") { // other orders: update what is on screen; new mail appears on the next reload
        const fresh = new Map(p.items.map((i) => [keyOf(i), i]));
        return cur.map((i) => fresh.get(keyOf(i)) ?? i);
      }
      const last = p.items[p.items.length - 1];
      const newer = (i: MessageItem) => !last || i.date > last.date || (i.date === last.date && Number(i.id) > Number(last.id));
      const fresh = new Set(p.items.map(keyOf));
      const kept = cur.filter((i) => !newer(i) && !fresh.has(keyOf(i)));
      return [...p.items, ...kept];
    });
    onFolderUpdate();
  };
  useEffect(() => {
    const t = setInterval(() => refreshRef.current(), syncing ? 2000 : 30000);
    return () => clearInterval(t);
  }, [folder.id, filter, sort, threadMode, syncing, searchKey]);
  useEffect(() => {
    const onRefresh = () => refreshRef.current();
    const onMoved = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      setItems((cur) => cur.filter((i) => i.id !== id));
      setSelection((s) => (s && s.messageId === id ? null : s));
    };
    const onBulkMoved = () => { clearSel(); setSelection(null); setReloadTick((t) => t + 1); };
    window.addEventListener("ncmail:refresh", onRefresh);
    window.addEventListener("ncmail:moved", onMoved);
    window.addEventListener("ncmail:bulkmoved", onBulkMoved);
    return () => { window.removeEventListener("ncmail:refresh", onRefresh); window.removeEventListener("ncmail:moved", onMoved); window.removeEventListener("ncmail:bulkmoved", onBulkMoved); };
  }, []);

  // Ask the mail server for anything new in this folder now, then reload the list.
  const [refreshing, setRefreshing] = useState(false);
  const refreshNow = async () => {
    setRefreshing(true);
    try {
      api(`/accounts/${folder.accountId}/calendar/sync`, { method: "POST" }).catch(() => {}); // pick up answers given in the calendar
      if (isUnified) await Promise.all(folders.filter((f) => f.specialUse === "\\Inbox").map((f) => api(`/folders/${f.id}/sync`, { method: "POST" }).catch(() => {})));
      else await api(`/folders/${folder.id}/sync`, { method: "POST" }).catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      for (let i = 0; i < 20 && !isUnified; i++) { const f = await api<Folder>(`/folders/${folder.id}`).catch(() => null); if (!f?.syncing) break; await new Promise((r) => setTimeout(r, 400)); }
      await refreshRef.current();
      window.dispatchEvent(new Event("ncmail:refresh-folders"));
      onFolderUpdate();
    } finally { setRefreshing(false); }
  };

  // Older mail that the first sync left on the server (it is searched there already; this brings it into the list).
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadOlderMail = async (count: number | "all") => {
    setLoadingOlder(true);
    try {
      const r = await api<{ added: number }>(`/folders/${folder.id}/sync-older`, { method: "POST", body: JSON.stringify({ count }) });
      toast({ kind: "success", message: `Loaded ${r.added.toLocaleString()} older messages` });
      onFolderUpdate(); setReloadTick((t) => t + 1);
    } catch (e: any) { toast({ kind: "error", message: e.message }); }
    setLoadingOlder(false);
  };

  const loadMore = useCallback(async () => {
    if (!next || loading) return;
    setLoading(true);
    const g = gen.current;
    const p = await api<ListPage>(query(next, LATER_PAGE)).catch(() => null);
    if (p && g === gen.current) { setItems((cur) => [...cur, ...p.items]); setNext(p.next); }
    setLoading(false);
  }, [next, loading, folder.id, filter, sort, threadMode, searchKey]);

  const virt = useVirtualizer({ count: items.length, getScrollElement: () => scroller.current, estimateSize: () => ROW, overscan: 8 });
  // opened from a link (a Nextcloud search result): select that message once its folder is showing
  useEffect(() => {
    if (focus && String(focus.folderId) === String(folder.id)) { setSelection({ key: keyOf(focus), messageId: focus.id, threadId: null, item: focus }); onFocused?.(); }
  }, [focus, folder.id]);
  useEffect(() => { virt.measure(); }, [ROW]);
  const vItems = virt.getVirtualItems();
  useEffect(() => {
    const last = vItems[vItems.length - 1];
    if (last && last.index >= items.length - 10) loadMore();
    else if (items.length > 0 && items.length < READ_AHEAD_ROWS && next) loadMore(); // read ahead while idle
  }, [vItems, items.length, loadMore]);

  // Changes made in the reader. In conversation mode the row's counts depend on the whole thread, so re-query.
  const patchLocal = (id: string, p: { seen?: boolean; flagged?: boolean }) => {
    setItems((cur) => cur.map((i) => (i.id === id && !threadMode ? { ...i, ...p } : i)));
    if (threadMode) setTimeout(() => refreshRef.current(), 300);
    onFolderUpdate();
  };
  const removeLocal = (id: string) => {
    // a conversation row survives while it still has other messages; a single message's row goes
    setItems((cur) => cur.filter((i) => i.id !== id || (threadMode && (i.count ?? 1) > 1)));
    // the message that was removed is no longer shown (a whole conversation closes itself when its last message goes)
    setSelection((s) => (s && !s.threadId && s.messageId === id ? null : s));
    if (threadMode) setTimeout(() => refreshRef.current(), 300);
    onFolderUpdate();
  };

  // Diagnostics: performance.getEntriesByType("mark") shows when the first list was painted.
  useEffect(() => { if (items.length && !performance.getEntriesByName("ncmail:first-list").length) performance.mark("ncmail:first-list"); }, [items.length]);

  const anyChecked = checked.size > 0 || wholeFolder;
  const selectedItems = items.filter((i) => checked.has(keyOf(i)));
  const canWhole = !search && !isUnified && (filter === "all" || filter === "unread");
  const wholeCount = filter === "unread" ? folder.unseen : folder.total;
  const selectedCount = wholeFolder ? wholeCount : checked.size;
  const allLoaded = items.length > 0 && items.every((i) => checked.has(keyOf(i)));
  const archiveFor = (accountId: string) => folders.find((f) => f.specialUse === "\\Archive" && f.accountId === accountId);
  const archive = isUnified ? archiveFor(folders.find((f) => f.specialUse === "\\Inbox")?.accountId ?? "") : archiveFor(folder.accountId);
  const hasJunk = !isUnified && folders.some((f) => f.specialUse === "\\Junk" && f.accountId === folder.accountId);
  const inJunk = folder.specialUse === "\\Junk";
  const inTrash = folder.specialUse === "\\Trash";
  // in a folder someone shared with you, only what the server allows
  const mayRemove = can(folder, "te"), mayFlag = can(folder, "w"), maySeen = can(folder, "s");
  const rangeCursor = useRef<number | null>(null); // the moving end of a Shift+arrow selection
  const clearSel = () => { setChecked(new Set()); setWholeFolder(false); setConfirmDelete(false); anchor.current = null; rangeCursor.current = null; };
  const selectAllLoaded = () => { setChecked(new Set(items.map(keyOf))); setWholeFolder(false); };
  const targets = sortFolders(folders.filter((f) => f.selectable && f.accountId === folder.accountId && can(f, "i")));

  // Click toggles one row; shift-click selects the range from the last clicked row.
  const toggleRow = (index: number, shift: boolean) => {
    setWholeFolder(false);
    const from = anchor.current; // read now: the updater below runs later, after the anchor has moved
    setChecked((cur) => {
      const nx = new Set(cur);
      const key = keyOf(items[index]!);
      if (shift && from != null) {
        const [a, b] = [Math.min(from, index), Math.max(from, index)];
        for (let i = a; i <= b; i++) nx.add(keyOf(items[i]!));
      } else if (nx.has(key)) nx.delete(key); else nx.add(key);
      return nx;
    });
    anchor.current = index; rangeCursor.current = index;
  };

  // What a bulk action looks like on a row, so the screen can change before the server has answered.
  const extraLabel = useRef("");
  const rowAfter = (i: MessageItem, action: string): MessageItem =>
    action === "read" ? { ...i, seen: true, unseenCount: 0 } : action === "unread" ? { ...i, seen: false, unseenCount: Math.max(1, i.unseenCount ?? 0) }
    : action === "star" ? { ...i, flagged: true } : action === "unstar" ? { ...i, flagged: false }
    : action === "label" ? { ...i, labels: [...new Set([...(i.labels ?? []), extraLabel.current])] } : action === "unlabel" ? { ...i, labels: (i.labels ?? []).filter((l) => l !== extraLabel.current) } : i;

  /** Run a bulk action on the server, then say what happened, with Undo where it can be undone. */
  const perform = async (body: Record<string, unknown>, action: BulkAction, target?: Folder) => {
    const r = await bulk(body);
    const n = r.affected;
    const msg =
      action === "move" ? (target?.specialUse === "\\Archive" ? `Archived ${plural(n, "message")}` : `Moved ${plural(n, "message")} to ${target ? folderPath(target) : ""}`)
      : action === "copy" ? `Copied ${plural(n, "message")} to ${target ? folderPath(target) : ""}`
      : action === "delete" ? (r.undo ? `Moved ${plural(n, "message")} to Trash` : `Deleted ${plural(n, "message")} permanently`)
      : action === "spam" ? `Reported ${plural(n, "message")} as spam` : action === "notspam" ? `Moved ${plural(n, "message")} to the inbox`
      : action === "snooze" ? `Snoozed until ${whenLabel(new Date(String(body.until)))}` : "";
    if (msg) {
      const undo = r.undo ? () => undoMove(r.undo!).then(() => { onFolderUpdate(); setReloadTick((t) => t + 1); clearLastUndo(); }).catch((e) => toast({ message: e.message, kind: "error" })) : undefined;
      toast({ message: msg, action: undo ? { label: "Undo", run: undo } : undefined });
      if (undo) setLastUndo(undo);
    }
    return r;
  };

  /** In the unified inbox a selection can span accounts, and the server acts on one account at a time: do each account's part in turn. */
  const runBulk = async (action: BulkAction, target?: Folder, rows: MessageItem[] = selectedItems, extra: Record<string, unknown> = {}) => {
    const { __archive, ...rest } = extra as { __archive?: boolean } & Record<string, unknown>;
    if (!isUnified) return runBulkOne(action, __archive ? archive : target, rows, rest);
    const byAccount = new Map<string, MessageItem[]>();
    for (const r of rows) byAccount.set(r.accountId ?? "", [...(byAccount.get(r.accountId ?? "") ?? []), r]);
    for (const [acc, list] of byAccount) { const t = __archive ? archiveFor(acc) : target; if (__archive && !t) continue; await runBulkOne(action, t, list, rest); }
  };
  const runBulkOne = async (action: BulkAction, target?: Folder, rows: MessageItem[] = selectedItems, extra: Record<string, unknown> = {}) => {
    setBulkBusy(true);
    extraLabel.current = String(extra.label ?? "");
    const body: Record<string, unknown> = { action, targetFolderId: target?.id, ...extra };
    const snapshot = items;
    const gone = action === "move" || action === "delete" || action === "spam" || action === "notspam" || action === "snooze";
    const whole = wholeFolder && rows === selectedItems;
    if (whole) Object.assign(body, { scope: "folder", folderId: folder.id, unreadOnly: filter === "unread" });
    else {
      // In conversation mode a row is a whole thread (its messages in this folder); otherwise individual messages.
      body.messageIds = rows.filter((i) => !(threadMode && i.threadId)).map((i) => i.id);
      body.threadIds = rows.filter((i) => threadMode && i.threadId).map((i) => i.threadId);
      if (!isUnified) body.folderId = folder.id;
      // Optimistic: show the result now; the server confirms, or we put the rows back and say why.
      const keys = new Set(rows.map(keyOf));
      setItems((cur) => (gone ? cur.filter((i) => !keys.has(keyOf(i))) : cur.map((i) => (keys.has(keyOf(i)) ? rowAfter(i, action) : i))));
      if (gone) setSelection((s) => (s && keys.has(s.key) ? null : s));
      clearSel();
    }
    try {
      await perform(body, action, target);
      if (whole) { if (gone) setSelection(null); clearSel(); setReloadTick((t) => t + 1); }
      else setTimeout(() => refreshRef.current(), 400);
      onFolderUpdate();
    } catch (e: any) {
      toast({ message: e.message, kind: "error" });
      if (!whole) setItems(snapshot);
    } finally { setBulkBusy(false); setConfirmDelete(false); }
  };
  /** Delete: straight to Trash with Undo; only permanent deletion (in Trash) or a whole folder asks first. */
  const askDelete = () => { if (inTrash || wholeFolder) setConfirmDelete(true); else runBulk("delete"); };

  // What the reader's toolbar uses: act on single messages by id (also inside a conversation).
  const readerAct = async (action: BulkAction, ids: string[], target?: Folder, extra: Record<string, unknown> = {}) => {
    try { await perform({ action, messageIds: ids, targetFolderId: target?.id, ...extra }, action, target); onFolderUpdate(); }
    catch (e: any) { toast({ message: e.message, kind: "error" }); throw e; }
  };

  // ---- right-click menus ----
  const acctOf = (r: MessageItem) => r.accountId ?? folders.find((f) => f.id === r.folderId)?.accountId ?? folder.accountId;
  const compose = async (r: MessageItem, kind: "reply" | "replyAll" | "replyList" | "forward" | "draft") => {
    try {
      if (kind === "draft") {
        const d = await api<any>(`/messages/${r.id}/draft`);
        return onCompose({ accountId: d.accountId, identityId: d.identityId ?? undefined, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, body: d.text, html: d.html ?? undefined, inReplyTo: d.inReplyTo ?? undefined, references: d.references, attachments: d.attachments, draftUid: d.uid, security: d.security ?? undefined, readReceipt: !!d.readReceipt });
      }
      const m = await cload<MessageFull>(`/messages/${r.id}`);
      onCompose(kind === "forward" ? forwardInit(m, accounts, acctOf(r)) : kind === "replyList" ? replyToListInit(m, accounts, acctOf(r)) : replyInit(m, accounts, acctOf(r), kind === "replyAll"));
    } catch (e: any) { toast({ message: e.message, kind: "error" }); }
  };
  /** The original messages attached whole (.eml), not quoted; one message also picks the address it reached. */
  const forwardAsAttachments = async (rows: MessageItem[]) => {
    const first = rows.length === 1 ? await cload<MessageFull>(`/messages/${rows[0]!.id}`).catch(() => undefined) : undefined;
    onCompose(forwardAsAttachmentInit(rows, accounts, acctOf(rows[0]!), first));
  };
  /** Labels as on/off switches: checked when every one of `rows` has it, so choosing it adds or removes it for all. */
  const labelItems = (rows: MessageItem[]): MenuItem[] => allLabels.length
    ? allLabels.map((l) => { const all = rows.length > 0 && rows.every((r) => (r.labels ?? []).includes(l.slug)); return { label: l.name, checked: all, onClick: () => runBulk(all ? "unlabel" : "label", undefined, rows, { label: l.slug }) }; })
    : [{ label: "No labels yet: add some in Settings", disabled: true, onClick: () => {} }];
  const rowMenu = (rows: MessageItem[]): MenuItem[] => {
    const one = rows.length === 1 ? rows[0]! : null;
    const items: MenuItem[] = [];
    if (one) {
      if (folder.specialUse === "\\Drafts") items.push({ label: "Edit draft", icon: "edit", onClick: () => compose(one, "draft") });
      else {
        items.push({ label: "Reply", icon: "reply", hint: "r", onClick: () => compose(one, "reply") }, { label: "Reply all", icon: "replyAll", hint: "a", onClick: () => compose(one, "replyAll") });
        // known once the message was opened or hovered (its details are cached then)
        if (peek<MessageFull>(`/messages/${one.id}`)?.listPost) items.push({ label: "Reply to list", icon: "thread", hint: "l", onClick: () => compose(one, "replyList") });
        items.push({ label: "Forward", icon: "forward", hint: "f", onClick: () => compose(one, "forward") }, { label: "Forward as attachment", icon: "forward", onClick: () => forwardAsAttachments([one]) });
      }
      items.push({ divider: true, label: "" });
    } else if (folder.specialUse !== "\\Drafts" && rows.length <= 20) {
      items.push({ label: `Forward ${rows.length} as attachments`, icon: "forward", onClick: () => forwardAsAttachments(rows) }, { divider: true, label: "" });
    }
    // the same order as the reader's and the selection toolbar: remove | mark | file
    if (mayRemove && (isUnified || (archive && folder.id !== archive.id))) items.push({ label: "Archive", icon: "archive", hint: "e", onClick: () => runBulk("move", undefined, rows, { __archive: true }) });
    if (mayRemove) items.push({ label: inTrash ? "Delete forever…" : "Delete", icon: "trash", hint: "#", danger: true, onClick: () => { if (inTrash) { setChecked(new Set(rows.map(keyOf))); setConfirmDelete(true); } else runBulk("delete", undefined, rows); } });
    if (hasJunk && mayRemove) items.push({ label: inJunk ? "Not spam" : "Report spam", icon: "spam", hint: "!", onClick: () => runBulk(inJunk ? "notspam" : "spam", undefined, rows) });
    if (items.length && !items[items.length - 1]!.divider) items.push({ divider: true, label: "" });
    const unread = rows.some((r) => !r.seen);
    if (maySeen) items.push({ label: unread ? "Mark as read" : "Mark as unread", icon: unread ? "mailOpen" : "mail", hint: unread ? "" : "u", onClick: () => runBulk(unread ? "read" : "unread", undefined, rows) });
    const starred = rows.every((r) => r.flagged);
    if (mayFlag) items.push({ label: starred ? "Remove star" : "Star", icon: "star", hint: "s", onClick: () => runBulk(starred ? "unstar" : "star", undefined, rows) });
    if (mayRemove) items.push({ label: "Snooze", icon: "clock", children: timeMenu((d) => runBulk("snooze", undefined, rows, { until: d.toISOString() }), () => setPickRows(rows)) });
    if (!isUnified) {
      items.push({ divider: true, label: "" });
      if (mayRemove) items.push({ label: "Move to", icon: "move", filterable: true, children: targets.filter((f) => search || f.id !== folder.id).map((f) => ({ label: folderPath(f), onClick: () => runBulk("move", f, rows) })) });
      items.push({ label: "Copy to", icon: "copy", filterable: true, children: targets.map((f) => ({ label: folderPath(f), onClick: () => runBulk("copy", f, rows) })) });
      if (mayFlag) items.push({ label: "Labels", icon: "tag", children: labelItems(rows) });
    }
    if (one) items.push({ divider: true, label: "" }, { label: "View source and headers", icon: "info", onClick: () => setSourceId(one.id) }, { label: "Download as .eml", icon: "download", onClick: () => { window.location.href = `/api/messages/${one.id}/source?download=1`; } });
    return items;
  };
  const onRowContext = (e: React.MouseEvent, m: MessageItem, key: string) => {
    const rows = checked.has(key) && checked.size > 1 ? selectedItems : [m]; // right-click inside a selection acts on all of it
    setCtxKey(key);
    ctxMenu(e, rowMenu(rows), () => setCtxKey(null));
  };
  const onListContext = (e: React.MouseEvent) => {
    if ((e.target as Element).closest(".msg-row")) return;
    ctxMenu(e, [
      { label: "Refresh", icon: "refresh", onClick: refreshNow },
      { label: "Select all loaded", icon: "check", hint: "⌘A", onClick: selectAllLoaded },
      ...(search ? [] : [{ label: "Sort by", icon: "sort" as const, children: sortItems }]),
    ]);
  };

  // dragging a selected row drags the whole selection onto a folder in the sidebar
  const dragPayload = (m: MessageItem, key: string) => {
    if (checked.has(key) && checked.size > 1 && !wholeFolder) {
      return { type: "text/ncmail-bulk", data: JSON.stringify({
        messageIds: selectedItems.filter((i) => !(threadMode && i.threadId)).map((i) => i.id),
        threadIds: selectedItems.filter((i) => threadMode && i.threadId).map((i) => i.threadId), folderId: folder.id }) };
    }
    return { type: "text/ncmail-message", data: m.id };
  };

  // ---- keyboard ----
  const openRow = (index: number) => {
    const m = items[index]; if (!m) return;
    setSelection({ key: keyOf(m), messageId: m.id, threadId: threadMode && (m.count ?? 1) > 1 ? m.threadId ?? null : null, item: m });
    virt.scrollToIndex(index, { align: "auto" });
    anchor.current = index; rangeCursor.current = index; // a newly opened message is where a Shift+arrow selection starts
  };
  /** j / k / Enter from the list: the opened row takes the keyboard focus, so Tab goes on into the message (not back to the top). */
  const openRowByKey = (index: number) => {
    const from = document.activeElement;
    openRow(index);
    if (from && from !== document.body && !scroller.current?.contains(from)) return;
    requestAnimationFrame(() => requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>("button.msg.active")?.focus({ preventScroll: true })));
  };
  /** Shift+Down / Shift+Up: select the messages from where you started to the one you moved to (like Shift+click). */
  const extendSelection = (d: number) => {
    if (!items.length) return;
    const start = anchor.current ?? (curIndex >= 0 ? curIndex : 0);
    const to = Math.max(0, Math.min(items.length - 1, (rangeCursor.current ?? start) + d));
    anchor.current = start; rangeCursor.current = to;
    setWholeFolder(false);
    setChecked(new Set(items.slice(Math.min(start, to), Math.max(start, to) + 1).map(keyOf)));
    virt.scrollToIndex(to, { align: "auto" });
  };
  const curIndex = selection ? items.findIndex((i) => keyOf(i) === selection.key) : -1;
  const kb = useRef<(e: KeyboardEvent) => void>(() => {});
  kb.current = (e) => {
    if (typing(e.target) || document.querySelector(".modal-backdrop")) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && !(e.target as HTMLElement).closest?.(".reader-frame")) {
      if (document.activeElement === document.body || scroller.current?.contains(document.activeElement)) { e.preventDefault(); selectAllLoaded(); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp") && !(e.target as HTMLElement).closest?.(".reader")) { e.preventDefault(); extendSelection(e.key === "ArrowDown" ? 1 : -1); return; }
    const row = selection ? items[curIndex] : undefined;
    const cmd = (name: string) => window.dispatchEvent(new CustomEvent("ncmail:cmd", { detail: name }));
    switch (e.key) {
      case "j": case "ArrowDown": if (!(e.key === "ArrowDown" && (e.target as HTMLElement).closest?.(".reader"))) { e.preventDefault(); openRowByKey(Math.min(items.length - 1, curIndex + 1)); } break;
      case "k": case "ArrowUp": if (!(e.key === "ArrowUp" && (e.target as HTMLElement).closest?.(".reader"))) { e.preventDefault(); openRowByKey(Math.max(0, curIndex - 1)); } break;
      case "Enter": if (!selection && items.length) openRowByKey(0); break;
      case "Escape": if (anyChecked) clearSel(); else if (selection) setSelection(null); else if (search) search.onClear(); break;
      case "x": if (row) { e.preventDefault(); toggleRow(curIndex, false); } break;
      case "e": if (row && mayRemove && archive && folder.id !== archive.id) { e.preventDefault(); runBulk("move", undefined, [row], { __archive: true }); } break;
      case "#": case "Delete": if (row && mayRemove) { e.preventDefault(); if (inTrash) { setChecked(new Set([keyOf(row)])); setConfirmDelete(true); } else runBulk("delete", undefined, [row]); } break;
      case "!": if (row && hasJunk) { e.preventDefault(); runBulk(inJunk ? "notspam" : "spam", undefined, [row]); } break;
      case "s": if (row && mayFlag) { e.preventDefault(); runBulk(row.flagged ? "unstar" : "star", undefined, [row]); } break;
      case "u": if (row && maySeen) { e.preventDefault(); runBulk("unread", undefined, [row]); setSelection(null); } break;
      case "r": cmd("reply"); break;
      case "a": cmd("replyAll"); break;
      case "l": cmd("replyList"); break;
      case "f": cmd("forward"); break;
    }
  };
  useEffect(() => { const h = (e: KeyboardEvent) => kb.current(e); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, []);

  const sortItems: MenuItem[] = (Object.keys(SORT_LABELS) as SortKey[]).filter((k) => !isUnified || k.startsWith("date")).map((k) => ({ label: SORT_LABELS[k], checked: sort === k, onClick: () => setSort(k) }));
  const folderItems = (fn: (f: Folder) => void, skipCurrent: boolean): MenuItem[] =>
    targets.filter((f) => !skipCurrent || search || f.id !== folder.id).map((f) => ({ label: folderPath(f), icon: undefined, onClick: () => fn(f) }));

  const reading = !!selection;
  const emptyMsg = search ? "No matching messages" : filter === "unread" ? "No unread messages" : filter === "starred" ? "No starred messages" : filter === "attachments" ? "No messages with attachments" : folder.specialUse === "\\Inbox" ? "Your inbox is empty" : "No messages here";

  return (
    <div className={`mail${reading ? " reading" : ""}`}>
      <section className="list-pane" aria-label="Messages">
        {anyChecked ? (
          <div className="list-head bulk-head" role="toolbar" aria-label="Bulk actions">
            <label className="sel-all" title="Select / clear all loaded">
              <TriCheck state={allLoaded || wholeFolder ? "all" : "some"} onChange={() => (allLoaded || wholeFolder ? clearSel() : selectAllLoaded())} />
            </label>
            <b>{selectedCount.toLocaleString()} selected</b>
            {/* the same order as the reader's toolbar and the right-click menu: remove | mark | file */}
            {mayRemove && (isUnified || (archive && folder.id !== archive.id)) && <IconButton icon="archive" label="Archive" hint="e" disabled={bulkBusy} onClick={() => runBulk("move", undefined, selectedItems, { __archive: true })} />}
            {mayRemove && <IconButton icon="trash" label={inTrash ? "Delete forever…" : "Delete"} hint="#" danger disabled={bulkBusy} onClick={askDelete} />}
            {hasJunk && mayRemove && <IconButton icon="spam" label={inJunk ? "Not spam" : "Report spam"} hint="!" disabled={bulkBusy} onClick={() => runBulk(inJunk ? "notspam" : "spam")} />}
            {(maySeen || mayFlag || mayRemove) && <span className="sep" />}
            {maySeen && <IconButton icon="mailOpen" label="Mark as read" disabled={bulkBusy} onClick={() => runBulk("read")} />}
            {maySeen && <IconButton icon="mail" label="Mark as unread" hint="u" disabled={bulkBusy} onClick={() => runBulk("unread")} />}
            {mayFlag && <IconButton icon="star" label={selectedItems.length && selectedItems.every((r) => r.flagged) ? "Remove star" : "Star"} hint="s" disabled={bulkBusy}
              onClick={() => runBulk(selectedItems.length && selectedItems.every((r) => r.flagged) ? "unstar" : "star")} />}
            {mayRemove && <Menu icon="clock" iconOnly label="Snooze" items={timeMenu((d) => runBulk("snooze", undefined, selectedItems, { until: d.toISOString() }), () => setPickRows(selectedItems))} />}
            {!isUnified && <span className="sep" />}
            {!isUnified && mayRemove && <Menu icon="move" label="Move to" filterable items={folderItems((f) => runBulk("move", f), true)} />}
            {!isUnified && <Menu icon="copy" iconOnly label="Copy to" filterable items={folderItems((f) => runBulk("copy", f), false)} />}
            {!isUnified && mayFlag && <Menu icon="tag" iconOnly label="Labels" items={labelItems(selectedItems)} />}
            <span style={{ flex: 1 }} />
            <IconButton icon="x" label="Clear selection" hint="Esc" onClick={clearSel} />
          </div>
        ) : search ? (
          <>
            <div className="list-head">
              <label className="sel-all" title="Select all loaded"><TriCheck state="none" onChange={selectAllLoaded} /></label>
              <h2>Results</h2>
              <span className="hint">
                {searchBusy ? (search.text ? "Searching the mail server…" : "Searching…") : meta ? `${meta.total.toLocaleString()}${meta.capped ? "+" : ""} found` : ""}
                {!searchBusy && meta?.index?.enabled && meta.index.indexed < meta.index.total && (
                  <span className="folder-chip" style={{ marginLeft: 8 }} title="Message text is still being indexed, so text matches may be incomplete">
                    text index {Math.floor((meta.index.indexed / Math.max(1, meta.index.total)) * 100)}%
                  </span>
                )}
              </span>
              <span className="spacer" />
              <IconButton icon="tag" label="Save this search" onClick={() => setSaving(search.q)} />
              <IconButton icon="x" label="Close search" hint="Esc" onClick={search.onClear} />
            </div>
            {saving !== null && (
              <form className="list-tools" onSubmit={async (e) => { e.preventDefault(); const name = saving.trim(); if (!name) return; try { await api(`/accounts/${folder.accountId}/saved-searches`, { method: "POST", body: JSON.stringify({ name, query: search.q }) }); await refreshLabels(folder.accountId); toast({ kind: "success", message: `Saved search "${name}" (see the sidebar)` }); setSaving(null); } catch (er: any) { toast({ kind: "error", message: er.message }); } }}>
                <input aria-label="Name for this search" placeholder="Name this search" value={saving} autoFocus onChange={(e) => setSaving(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
                <button className="btn primary sm">Save</button><button type="button" className="btn sm" onClick={() => setSaving(null)}>Cancel</button>
              </form>
            )}
            <div className="list-tools">
              <select aria-label="Search scope" value={search.scope} onChange={(e) => search.onScope(e.target.value as "all" | "folder")}>
                <option value="all">All folders</option>
                <option value="folder">Only {folder.name}</option>
              </select>
              <label className="check-row hint" style={{ alignItems: "center" }} title={indexOn ? "Message text is already searched from the local index. This also asks the mail server (slower)." : "Ask the mail server to search inside message bodies. Slower. Turn on the text index in settings for instant text search."}>
                <input type="checkbox" checked={search.text} onChange={(e) => search.onText(e.target.checked)} style={{ marginTop: 0 }} /> {indexOn ? "Also ask the server" : "Search message text"}
              </label>
            </div>
          </>
        ) : (
          <>
            <div className="list-head">
              <label className="sel-all" title="Select all loaded"><TriCheck state="none" onChange={selectAllLoaded} /></label>
              <h2>{folderLabel(folder)}</h2>
              <span className="hint">{folder.total.toLocaleString()}{folder.queued ? " · waiting for other imports…" : syncing ? " · syncing…" : ""}</span>
              <span className="spacer" />
              <IconButton icon="refresh" label="Refresh" className={refreshing ? "spin" : ""} disabled={refreshing} onClick={refreshNow} />
              <Menu icon="sort" label="Sort" items={sortItems} align="right" title={`Sort: ${SORT_LABELS[sort]}`} />
              <IconButton icon="thread" label={threadPref ? "Conversations are on" : "Group into conversations"} active={threadPref && dated} disabled={!dated || isUnified} onClick={() => setThreadPref(!threadPref)} />
            </div>
            <div className="list-tools">
              <div className="seg" role="group" aria-label="Filter">
                {(Object.keys(FILTER_LABELS) as FilterKey[]).map((k) => <button key={k} className={filter === k ? "on" : ""} aria-pressed={filter === k} onClick={() => setFilter(k)}>{FILTER_LABELS[k]}</button>)}
              </div>
            </div>
          </>
        )}
        {confirmDelete && (
          <div className="note error" style={{ margin: "0 12px 8px" }}>
            <b>Delete {plural(selectedCount, "message")}?</b>{" "}
            {inTrash ? "They will be permanently deleted. This cannot be undone." : "They will be moved to Trash."}
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn danger" disabled={bulkBusy} onClick={() => runBulk("delete")}>{bulkBusy ? "Deleting…" : inTrash ? "Delete forever" : "Delete"}</button>
              <button className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
            </div>
          </div>
        )}
        {canWhole && allLoaded && !wholeFolder && next && wholeCount > items.length && (
          <div className="note" style={{ margin: "0 12px 8px" }}>
            The {items.length} loaded {threadMode ? "conversations are" : "messages are"} selected.{" "}
            <button className="btn link" onClick={() => setWholeFolder(true)}>Select all {wholeCount.toLocaleString()} {filter === "unread" ? "unread " : ""}messages in {folder.name}</button>
          </div>
        )}
        {wholeFolder && (
          <div className="note" style={{ margin: "0 12px 8px" }}>
            All {wholeCount.toLocaleString()} {filter === "unread" ? "unread " : ""}messages in {folder.name} are selected.{" "}
            <button className="btn link" onClick={clearSel}>Clear selection</button>
          </div>
        )}
        {meta?.notes.map((n) => <div key={n} className="note warning" style={{ margin: "0 12px 8px" }}>{n}</div>)}
        {folder.syncError && <div className="note error" style={{ margin: "0 12px 8px" }}>Sync error: {folder.syncError}</div>}
        <div className="list-scroll" ref={scroller} onContextMenu={onListContext}>
          {items.length === 0 && !ready && Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton" />)}
          {items.length === 0 && ready && (
            <div className="empty">
              <Icon name={search ? "search" : folderIconFor(folder)} size={40} />
              <h3>{syncing && !search ? "Syncing…" : emptyMsg}</h3>
              {!search && filter !== "all" && <button className="btn" onClick={() => setFilter("all")}>Show all messages</button>}
            </div>
          )}
          <div style={{ height: virt.getTotalSize(), position: "relative" }}>
            {vItems.map((v) => {
              const m = items[v.index]!;
              const key = keyOf(m);
              const many = threadMode && (m.count ?? 1) > 1;
              const who = many ? (m.names ?? []).slice(0, 3).join(", ") : m.fromName || m.fromAddr;
              const isChecked = wholeFolder || checked.has(key);
              return (
                <div key={key} className={`msg-row${isChecked ? " checked" : ""}${anyChecked ? " any" : ""}${ctxKey === key ? " ctx-target" : ""}`} onContextMenu={(e) => onRowContext(e, m, key)}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", height: ROW, transform: `translateY(${v.start}px)` }}>
                  <Avatar className="msg-av" name={many ? who : m.fromName} address={many ? who : m.fromAddr} />
                  <label className="msg-check" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`Select ${m.subject || "message"}`} checked={isChecked} onChange={() => {}}
                      onClick={(e) => { e.stopPropagation(); toggleRow(v.index, e.shiftKey); }} />
                  </label>
                  <button draggable onMouseEnter={() => prefetchSoon(m)} onMouseLeave={() => clearTimeout(hoverTimer.current)} onDragStart={(e) => { const d = dragPayload(m, key); e.dataTransfer.setData(d.type, d.data); e.dataTransfer.effectAllowed = "move"; }}
                    className={`msg${m.seen ? "" : " unseen"}${selection?.key === key ? " active" : ""}${many ? " thread" : ""}`}
                    onClick={(e) => {
                      // Ctrl/⌘-click adds or removes this message from the selection, Shift-click selects the range from the last one
                      if (e.metaKey || e.ctrlKey || e.shiftKey) {
                        e.preventDefault();
                        if (checked.size === 0 && selection) setChecked(new Set([selection.key])); // the message that is open counts as the first one
                        toggleRow(v.index, e.shiftKey && !(e.metaKey || e.ctrlKey));
                      } else openRow(v.index);
                    }}>
                    <span className="msg-top">
                      <span className="msg-from">{many && <span className="count" title={`${m.count} messages in this conversation`}><Icon name="thread" size={11} />{m.count}</span>}<span>{who}</span></span>
                      <span className="msg-date">{search && m.folderName && <span className="folder-chip">{m.folderName}</span>}{isUnified && m.accountName && <span className="folder-chip" title="Account">{m.accountName}</span>}{fmtDate(m.date)}</span>
                    </span>
                    <span className="msg-subject">
                      {m.flagged && <Icon name="star" size={12} filled className="star-on" />}
                      <span>{(many ? stripSubject(m.subject) : m.subject) || "(no subject)"}</span>
                      {m.hasAttachments && <Icon name="paperclip" size={12} />}
                      {(m.labels ?? []).slice(0, 2).map((slug) => { const l = allLabels.find((x) => x.slug === slug); return <span key={slug} className="label-chip" style={{ background: l?.color ?? "#64748b" }}>{l?.name ?? slug}</span>; })}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
          {!next && !search && !isUnified && (folder.olderOnServer ?? 0) > 0 && filter === "all" && (
            <div className="older-footer">
              <Icon name="clock" size={18} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{folder.olderOnServer!.toLocaleString()} older messages</b> are on the server and not loaded yet.
                <div className="hint">Search already looks through them. Load them to browse the list.</div>
              </div>
              <button className="btn sm" disabled={loadingOlder || folder.queued} onClick={() => loadOlderMail(5000)}>{loadingOlder ? "Loading…" : "Load 5,000 more"}</button>
              {folder.olderOnServer! > 5000 && <button className="btn sm ghost" disabled={loadingOlder} onClick={() => loadOlderMail("all")}>Load all</button>}
            </div>
          )}
        </div>
      </section>
      {sourceId && <SourceModal messageId={sourceId} onClose={() => setSourceId(null)} />}
      {pickRows && <PickTime title="Snooze until" onPick={(d) => { runBulk("snooze", undefined, pickRows, { until: d.toISOString() }); setPickRows(null); }} onClose={() => setPickRows(null)} />}
      <Resizer cssVar="--list-w" storageKey="ncmail.w.list" min={280} max={720} label="Resize message list" />
      <section className="reader-pane" aria-label="Message">
        {selection
          ? <Reader key={selection.threadId ?? selection.messageId} selection={selection} folder={folders.find((f) => f.id === selection.item.folderId) ?? folder} folders={folders} accounts={accounts}
              onChanged={patchLocal} onRemoved={removeLocal} onCompose={onCompose} act={readerAct} onBack={() => setSelection(null)}
              onEmpty={() => { setSelection(null); setTimeout(() => refreshRef.current(), 300); }} />
          : <div className="reader-empty"><Icon name="mailOpen" size={44} /><span>Select a message to read</span><span className="hint">Tip: press <kbd>?</kbd> for keyboard shortcuts</span></div>}
      </section>
    </div>
  );
}

export const folderLabel = (f: { id?: string; name: string; specialUse: string | null }) => (f.specialUse === "\\Inbox" && f.id !== "unified" ? "Inbox" : f.name);
const folderIconFor = (f: Folder): IconName => folderIcon(f.specialUse);
