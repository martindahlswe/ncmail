import { useMemo, useRef, useState } from "react";
import { api, bulk, can, isShared, undoMove, type Folder } from "./api.ts";
import { ShareFolder } from "./ShareFolder.tsx";
import { useContextMenu } from "./ContextMenu.tsx";
import { prefetch, listPath } from "./cache.ts";
import { Icon, folderIcon } from "./icons.tsx";
import { IconButton, useDialog, useToast, type MenuItem } from "./ui.tsx";
const bulkMove = bulk;
const SPECIAL_ORDER = ["\\Inbox", "\\Drafts", "\\Sent", "\\Archive", "\\Junk", "\\Trash"];

interface Node { key: string; name: string; folder?: Folder; children: Node[] }

const byName = (a: Node, b: Node) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
// other people's folders ("Shared with you") come last
const rank = (n: Node) => { if (isShared(n.folder)) return 200; const i = SPECIAL_ORDER.indexOf(n.folder?.specialUse ?? ""); return i < 0 ? 99 : i; };

/** Folder paths ("Clients/Acme", "INBOX.Projects.X") -> tree. Missing intermediate folders become plain containers. */
export function buildTree(folders: Folder[]): Node[] {
  const roots: Node[] = [];
  const index = new Map<string, Node>();
  const nodeFor = (key: string, name: string, parent: Node | null) => {
    let n = index.get(key);
    if (!n) { n = { key, name, children: [] }; index.set(key, n); (parent ? parent.children : roots).push(n); }
    return n;
  };
  for (const f of folders) {
    const delim = f.delimiter || "/";
    const parts = f.path.split(delim).filter(Boolean);
    // Special-use folders (Sent, Drafts, ...) stay top-level even on servers that nest them under INBOX.
    const topLevel = f.specialUse && f.specialUse !== "\\Inbox";
    if (topLevel || parts.length <= 1) { nodeFor(f.path, topLevel ? f.name : parts[0] ?? f.name, null).folder = f; continue; }
    let parent: Node | null = null;
    parts.forEach((part, i) => { parent = nodeFor(parts.slice(0, i + 1).join(delim), part, parent); });
    parent!.folder = f;
  }
  const sort = (list: Node[], top: boolean) => {
    list.sort((a, b) => (top ? rank(a) - rank(b) : 0) || byName(a, b));
    list.forEach((n) => sort(n.children, false));
  };
  sort(roots, true);
  return roots;
}

/** The top of someone else's folders: "Shared with you" for other users' folders, "Public folders" for a public namespace. */
const rootLabel = (f: Folder | undefined, selectable: boolean) =>
  !f || selectable || !isShared(f) ? null : f.namespace === "other" && !f.sharedOwner ? "Shared with you" : f.namespace === "shared" && !f.path.includes(f.delimiter || "/") ? "Public folders" : null;

const unseenTotal = (n: Node): number => (n.folder?.unseen ?? 0) + n.children.reduce((s, c) => s + unseenTotal(c), 0);
const hasActive = (n: Node, id: string | null): boolean => !!id && (n.folder?.id === id || n.children.some((c) => hasActive(c, id)));

const own = (f: Folder) => (f.namespace ?? "personal") === "personal";
const isInbox = (f: Folder) => f.specialUse === "\\Inbox" || f.path.toUpperCase() === "INBOX";
/** Subfolders may be made inside: your own folders, or where the server grants "k". */
const mayCreateIn = (f: Folder) => own(f) || (f.rights ?? "").includes("k");
/** Renaming and deleting: not Inbox or another special folder; your own, or where the server grants "x". */
const mayManage = (f: Folder) => !isInbox(f) && !f.specialUse && (own(f) || (f.rights ?? "").includes("x"));
const inside = (path: string, root: string, delim: string) => path === root || (!!delim && path.startsWith(root + delim));

export function FolderTree({ folders, accountId, activeId, onSelect, onMoved, canShare, heading, headingTitle }: {
  folders: Folder[]; accountId: string; activeId: string | null; onSelect: (id: string) => void; onMoved: () => void;
  /** The account's name above its folders, with the New folder button beside it. */
  heading?: string; headingTitle?: string;
  /** The mail server lets you share folders (IMAP ACL). */
  canShare?: boolean;
}) {
  const [sharing, setSharing] = useState<Folder | null>(null);
  const storeKey = `ncmail.expanded.${accountId}`;
  const [open, setOpen] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem(storeKey) ?? "[]")));
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tree = useMemo(() => buildTree(folders), [folders]);
  const toast = useToast();
  const dialog = useDialog();
  const ctx = useContextMenu();
  const moved = (n: number, name: string, token: string | null) => {
    toast({ message: `Moved ${n === 1 ? "1 message" : `${n} messages`} to ${name}`, action: token ? { label: "Undo", run: () => undoMove(token).then(() => { window.dispatchEvent(new Event("ncmail:bulkmoved")); onMoved(); }).catch((e) => toast({ message: e.message, kind: "error" })) } : undefined });
  };

  const toggle = (key: string) => setOpen((cur) => {
    const next = new Set(cur);
    next.has(key) ? next.delete(key) : next.add(key);
    localStorage.setItem(storeKey, JSON.stringify([...next]));
    return next;
  });

  const setBranch = (n: Node, on: boolean) => setOpen((cur) => {
    const next = new Set(cur);
    const walk = (x: Node) => { if (x.children.length) { on ? next.add(x.key) : next.delete(x.key); x.children.forEach(walk); } };
    walk(n); localStorage.setItem(storeKey, JSON.stringify([...next]));
    return next;
  });
  const expandKeys = (keys: string[]) => setOpen((cur) => {
    const next = new Set(cur); keys.forEach((k) => next.add(k));
    localStorage.setItem(storeKey, JSON.stringify([...next]));
    return next;
  });
  const changed = () => { onMoved(); window.dispatchEvent(new Event("ncmail:refresh")); };

  /** New folder at the top of the account, or inside `parent`. */
  const createFolder = async (parent?: Folder) => {
    const name = await dialog.prompt({ title: parent ? `New folder in ${parent.name}` : "New folder", label: "Name", confirmLabel: "Create",
      message: parent ? undefined : "The folder is created on your mail server, so it shows in your other mail apps too." });
    if (!name) return;
    try {
      await api(`/accounts/${accountId}/folders`, { method: "POST", body: JSON.stringify({ name, parentId: parent?.id ?? null }) });
      if (parent) expandKeys([parent.path]);
      toast({ kind: "success", message: `Created ${name}` });
      changed();
    } catch (e: any) { toast({ kind: "error", message: e.message }); }
  };

  const renameFolder = async (f: Folder) => {
    const name = await dialog.prompt({ title: `Rename ${f.name}`, label: "New name", initial: f.name, confirmLabel: "Rename" });
    if (!name || name === f.name) return;
    try {
      const r = await api<{ path: string; filtersUpdated: number; filtersNotUpdated?: number }>(`/folders/${f.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      // keep open branches open under their new name
      const delim = f.delimiter || "/";
      setOpen((cur) => {
        const next = new Set([...cur].map((k) => (inside(k, f.path, delim) ? r.path + k.slice(f.path.length) : k)));
        localStorage.setItem(storeKey, JSON.stringify([...next]));
        return next;
      });
      const filters = r.filtersUpdated ? ` ${r.filtersUpdated === 1 ? "1 filter now files" : `${r.filtersUpdated} filters now file`} into the new name.` : "";
      const left = r.filtersNotUpdated ? ` ${r.filtersNotUpdated === 1 ? "1 filter still files" : `${r.filtersNotUpdated} filters still file`} into the old name, because the new folder path is too long for a filter: change ${r.filtersNotUpdated === 1 ? "it" : "them"} in Settings, Filters.` : "";
      toast({ kind: left ? "info" : "success", message: `Renamed to ${name}.${filters}${left}`, ttl: left ? 12000 : undefined });
      changed();
    } catch (e: any) { toast({ kind: "error", message: e.message }); }
  };

  const deleteFolder = async (f: Folder, permanent: boolean) => {
    const delim = f.delimiter || "/";
    const below = folders.filter((x) => x.id !== f.id && inside(x.path, f.path, delim));
    const count = [f, ...below].reduce((s, x) => s + (x.total ?? 0), 0);
    const parts = [below.length ? `its ${below.length === 1 ? "subfolder" : `${below.length} subfolders`}` : "", count ? `${count === 1 ? "1 message" : `${count.toLocaleString()} messages`}` : ""].filter(Boolean);
    const what = parts.length ? `${f.name}, with ${parts.join(" and ")},` : f.name;
    const ok = await dialog.confirm(permanent
      ? { title: `Delete ${f.name} permanently?`, message: `${what} is deleted from your mail server forever. This cannot be undone.`, confirmLabel: "Delete permanently", danger: true }
      : { title: `Delete ${f.name}?`, message: `${what} is moved to Trash, where you can delete it permanently.`, confirmLabel: "Move to Trash", danger: true });
    if (!ok) return;
    try {
      const r = await api<{ movedToTrash: boolean; filtersStillUsing: number }>(`/folders/${f.id}${permanent ? "?permanent=1" : ""}`, { method: "DELETE" });
      const gone = !r.movedToTrash && activeId && (activeId === f.id || below.some((x) => x.id === activeId));
      if (gone) { const inbox = folders.find(isInbox); if (inbox) onSelect(inbox.id); }
      const filters = r.filtersStillUsing ? ` ${r.filtersStillUsing === 1 ? "A filter still files" : `${r.filtersStillUsing} filters still file`} mail into it and would create it again: change ${r.filtersStillUsing === 1 ? "it" : "them"} in Settings, Filters.` : "";
      // Undo puts it back where it was, under its old name
      const cut = f.path.lastIndexOf(delim);
      const parent = cut < 0 ? null : folders.find((x) => x.path === f.path.slice(0, cut));
      const undo = r.movedToTrash && (cut < 0 || parent) ? { label: "Undo", run: () => api(`/folders/${f.id}`, { method: "PATCH", body: JSON.stringify({ name: f.name, parentId: parent?.id ?? null }) })
        .then(() => { toast({ kind: "success", message: `Restored ${f.name}` }); changed(); }).catch((e: any) => toast({ kind: "error", message: e.message })) } : undefined;
      toast({ kind: r.filtersStillUsing ? "info" : "success", message: `${r.movedToTrash ? `Moved ${f.name} to Trash` : `Deleted ${f.name}`}.${filters}`, action: undo, ttl: r.filtersStillUsing ? 12000 : undefined });
      changed();
    } catch (e: any) { toast({ kind: "error", message: e.message }); }
  };

  const menuFor = (n: Node, f: Folder | undefined): MenuItem[] => {
    const items: MenuItem[] = [];
    if (f?.selectable) {
      items.push({ label: "Open", icon: "folderOpen", onClick: () => onSelect(f.id) });
      items.push({ label: "Refresh", icon: "refresh", onClick: async () => { await api(`/folders/${f.id}/sync`, { method: "POST" }).catch(() => {}); setTimeout(() => { onMoved(); window.dispatchEvent(new Event("ncmail:refresh")); }, 800); } });
      if (f.unseen > 0) items.push({ label: `Mark all ${f.unseen.toLocaleString()} as read`, icon: "mailOpen", onClick: async () => {
        try { await bulk({ action: "read", scope: "folder", folderId: f.id }); toast({ kind: "success", message: `Marked everything in ${f.name} as read` }); onMoved(); window.dispatchEvent(new Event("ncmail:refresh")); }
        catch (e: any) { toast({ kind: "error", message: e.message }); } } });
      if ((f.specialUse === "\\Trash" || f.specialUse === "\\Junk") && f.total > 0) {
        const trash = f.specialUse === "\\Trash";
        items.push({ divider: true, label: "" }, { label: trash ? `Empty Trash (${f.total.toLocaleString()})…` : `Delete all junk (${f.total.toLocaleString()})…`, icon: "trash", danger: true, onClick: async () => {
          const ok = await dialog.confirm(trash
            ? { title: `Empty ${f.name}?`, message: `All ${f.total.toLocaleString()} messages in it are deleted forever. This cannot be undone.`, confirmLabel: "Empty Trash", danger: true }
            : { title: "Delete all junk?", message: `All ${f.total.toLocaleString()} messages in ${f.name} are moved to Trash.`, confirmLabel: "Move to Trash", danger: true });
          if (!ok) return;
          try { await bulk({ action: "delete", scope: "folder", folderId: f.id }); toast({ kind: "success", message: trash ? "Trash emptied" : "Junk moved to Trash" }); onMoved(); window.dispatchEvent(new Event("ncmail:bulkmoved")); }
          catch (e: any) { toast({ kind: "error", message: e.message }); } } });
      }
    }
    // making, renaming and deleting folders, where the server allows it
    if (f && !(isShared(f) && !f.selectable && !(f.rights ?? "").includes("k"))) {
      const manage: MenuItem[] = [];
      if (mayCreateIn(f)) manage.push({ label: "New folder inside…", icon: "plus", onClick: () => createFolder(f) });
      if (mayManage(f)) {
        const trash = folders.find((x) => x.specialUse === "\\Trash" && own(x));
        const permanent = !own(f) || !trash || inside(f.path, trash.path, trash.delimiter || f.delimiter || "/");
        manage.push({ label: "Rename…", icon: "edit", onClick: () => renameFolder(f) },
          { label: permanent ? "Delete permanently…" : "Delete folder…", icon: "trash", danger: true, onClick: () => deleteFolder(f, permanent) });
      }
      if (manage.length) { if (items.length) items.push({ divider: true, label: "" }); items.push(...manage); }
    }
    // who may use the folder: your own (when the server can share), or any where the server lets you manage access
    if (f?.selectable && canShare && (!isShared(f) || (f.rights ?? "").includes("a"))) items.push({ divider: true, label: "" }, { label: "Sharing…", icon: "user", onClick: () => setSharing(f) });
    if (f && isShared(f) && f.selectable) {
      const how = !can(f, "r") ? "no access" : can(f, "te") ? "you can read and change it" : "read only";
      const whose = f.namespace === "shared" ? "Public folder" : f.sharedOwner ? `Shared by ${f.sharedOwner}` : "Shared folder";
      items.unshift({ label: `${whose}: ${how}`, icon: "user", disabled: true }, { divider: true, label: "" });
    }
    if (n.children.length) { if (items.length) items.push({ divider: true, label: "" }); items.push({ label: "Expand all subfolders", icon: "chevronDown", onClick: () => setBranch(n, true) }, { label: "Collapse all subfolders", icon: "chevronRight", onClick: () => setBranch(n, false) }); }
    return items;
  };

  const render = (n: Node, depth: number): React.ReactNode => {
    const f = n.folder;
    const hasKids = n.children.length > 0;
    // The branch holding the selected folder is always shown open.
    const expanded = open.has(n.key) || (hasKids && n.children.some((c) => hasActive(c, activeId)));
    const own = f?.unseen ?? 0;
    const hidden = hasKids && !expanded ? unseenTotal(n) - own : 0; // unread inside collapsed children
    const selectable = !!f?.selectable;
    return (
      <div key={n.key}>
        <div className={`nav-row${dropTarget === f?.id ? " drop" : ""}`} style={{ paddingLeft: depth * 14 }} onContextMenu={(e) => { const m = menuFor(n, f); if (m.length) ctx(e, m); }}>
          <button className="twisty" aria-label={expanded ? `Collapse ${n.name}` : `Expand ${n.name}`} aria-expanded={hasKids ? expanded : undefined}
            style={{ visibility: hasKids ? "visible" : "hidden" }} onClick={() => toggle(n.key)}><Icon name={expanded ? "chevronDown" : "chevronRight"} size={14} /></button>
          <button className={`nav-item${f && f.id === activeId ? " active" : ""}`} style={{ flex: 1, minWidth: 0 }}
            onClick={() => (selectable ? onSelect(f!.id) : toggle(n.key))}
            onMouseEnter={() => { if (selectable) { clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => prefetch(listPath(f!.id, { threads: localStorage.getItem("ncmail.threads") !== "0" })), 150); } }}
            onMouseLeave={() => clearTimeout(hoverTimer.current)}
            onDragOver={(e) => { if (selectable && can(f, "i") && f!.id !== activeId && (e.dataTransfer.types.includes("text/ncmail-message") || e.dataTransfer.types.includes("text/ncmail-bulk"))) { e.preventDefault(); setDropTarget(f!.id); } }}
            onDragLeave={() => setDropTarget((t) => (t === f?.id ? null : t))}
            onDrop={async (e) => {
              e.preventDefault(); setDropTarget(null);
              const bulk = e.dataTransfer.getData("text/ncmail-bulk");
              if (bulk && selectable && can(f, "i") && f!.id !== activeId) {
                const r = await bulkMove({ ...JSON.parse(bulk), action: "move", targetFolderId: f!.id }).catch((er) => { toast({ message: er.message, kind: "error" }); return null; });
                if (r) { moved(r.affected, f!.name, r.undo); window.dispatchEvent(new Event("ncmail:bulkmoved")); onMoved(); }
                return;
              }
              const id = e.dataTransfer.getData("text/ncmail-message");
              if (!id || !selectable || !can(f, "i") || f!.id === activeId) return;
              const r = await bulkMove({ messageIds: [id], action: "move", targetFolderId: f!.id }).catch((er) => { toast({ message: er.message, kind: "error" }); return null; });
              if (r) { moved(1, f!.name, r.undo); window.dispatchEvent(new CustomEvent("ncmail:moved", { detail: id })); onMoved(); }
            }}>
            <Icon name={isShared(f) && !selectable ? "user" : !f?.specialUse && n.name === "Snoozed" ? "clock" : folderIcon(f?.specialUse ?? null)} size={16} />
            <span className="nav-name" style={{ opacity: selectable ? 1 : 0.7 }}>{f?.specialUse === "\\Inbox" ? "Inbox" : rootLabel(f, selectable) ?? n.name}</span>
            {own > 0 && <span className={`nav-count`}>{own.toLocaleString()}</span>}
            {hidden > 0 && <span className="nav-count" title="Unread in subfolders">({hidden.toLocaleString()})</span>}
          </button>
        </div>
        {hasKids && expanded && n.children.map((c) => render(c, depth + 1))}
      </div>
    );
  };

  const newFolderMenu: MenuItem[] = [{ label: "New folder…", icon: "plus", onClick: () => createFolder() }];
  return <>
    {heading && (
      <div className="nav-heading-row" onContextMenu={(e) => ctx(e, newFolderMenu)}>
        <div className="nav-heading" title={headingTitle}>{heading}</div>
        <IconButton icon="plus" label="New folder" size={14} className="nav-heading-add" onClick={() => createFolder()} />
      </div>
    )}
    {tree.map((n) => render(n, 0))}{sharing && <ShareFolder folder={sharing} onClose={() => setSharing(null)} />}
  </>;
}
