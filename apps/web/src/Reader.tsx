import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountSummary } from "@ncmail/shared";
import { load as cload, peek, patchCached } from "./cache.ts";
import { replyInit, forwardInit, forwardAsAttachmentInit, replyToListInit } from "./replies.ts";
import { allowImagesFrom, imagesAllowedFor, useReaderPrefs } from "./readerPrefs.ts";
import { ToNextcloud, useIntegrations, type ToKind } from "./ToNextcloud.tsx";
import { api, can, folderPath, sortFolders, escapeHtml, fmtAddr, fmtSize, stripSubject, textToHtml, type BulkAction, type Folder, type MessageFull, type MessageItem } from "./api.ts";
import { Avatar } from "./ThreadBits.tsx";
import { Icon } from "./icons.tsx";
import { IconButton, Menu, useDialog, useToast } from "./ui.tsx";
import { SecurityBanner } from "./SecurityBanner.tsx";
import { InviteBanner } from "./InviteBanner.tsx";
import { PhishingBanner } from "./PhishingBanner.tsx";
import { analyzeLinks } from "./linkCheck.ts";
import { useNc } from "./nc.ts";
import { useContextMenu } from "./ContextMenu.tsx";
import { NcFilePicker } from "./NcFilePicker.tsx";
import { PickTime, timeMenu } from "./schedule.tsx";
import { refreshLabels, useLabels } from "./labels.ts";
import { AttachmentPreview, SourceModal, canPreview, mailCsp, printMessage } from "./Viewer.tsx";
import type { ComposeInit } from "./Compose.tsx";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** The message body lives in a sandboxed iframe (no scripts) with a CSP that blocks remote loads until allowed. */
function srcDoc(m: MessageFull, allowImages: boolean, html: string | null) {
  const csp = mailCsp(allowImages);
  const body = html ?? `<pre style="white-space:pre-wrap;font:inherit;margin:0">${esc(m.text)}</pre>`;
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">
<style>html{color-scheme:light;background:#fff;color:#222;overflow-y:hidden;overflow-x:auto}body{font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;margin:16px 24px;overflow-wrap:anywhere}img{max-width:100%;height:auto}blockquote{margin:0 0 0 .4em;padding-left:1em;border-left:3px solid #ddd;color:#555}a[data-ncmail-warn]{outline:2px solid #dc2626;outline-offset:2px;border-radius:2px}</style>${body}`;
}

/** Iframe that grows to its content. Same-origin is safe here: scripts are disabled by the sandbox and the CSP. */
function AutoFrame({ doc }: { doc: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const dialog = useDialog();
  const ro = useRef<ResizeObserver | null>(null);
  useEffect(() => () => ro.current?.disconnect(), []);
  const recent = useRef<{ h: number; at: number }[]>([]);
  const fit = () => {
    const el = ref.current, d = el?.contentDocument, w = el?.contentWindow;
    if (!el || !d || !w || !d.body) return;
    // The frame grows to the message and never scrolls by itself (html has overflow-y: hidden): a scrollbar of its own would
    // narrow the text, which then wraps taller, the frame grows, the scrollbar goes, the text wraps shorter... and the body
    // jumps up and down. The height counts what sticks out of the <html> box too (body.scrollHeight), plus room for a
    // horizontal scrollbar when the message is wider than the frame. (documentElement.scrollHeight would never go below the
    // frame's current height, so it cannot be used to shrink.)
    const bs = w.getComputedStyle(d.body);
    const content = Math.max(d.documentElement.getBoundingClientRect().height, d.body.scrollHeight + parseFloat(bs.marginTop) + parseFloat(bs.marginBottom));
    const hScrollbar = Math.max(0, w.innerHeight - d.documentElement.clientHeight);
    let h = Math.max(40, Math.ceil(content + hScrollbar));
    // Should anything still flip between two heights, settle on the larger one instead of jumping.
    const now = Date.now();
    const r = recent.current.filter((x) => now - x.at < 1000);
    if (r.length >= 2 && r[r.length - 2]!.h === h && r[r.length - 1]!.h !== h) h = Math.max(h, r[r.length - 1]!.h);
    recent.current = [...r, { h, at: now }].slice(-6);
    if (el.style.height !== `${h}px`) el.style.height = `${h}px`;
  };
  return (
    <iframe ref={ref} title="Message" className="reader-frame" srcDoc={doc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      onLoad={() => {
        fit();
        const d = ref.current?.contentDocument;
        ro.current?.disconnect();
        if (d && "ResizeObserver" in window) { ro.current = new ResizeObserver(fit); ro.current.observe(d.documentElement); }
        // keyboard shortcuts keep working while the message body has focus
        // a link that is not what it says asks first (this runs in the app, so the question is not blocked by the message frame)
        d?.addEventListener("click", async (e) => {
          const a = (e.target as Element | null)?.closest?.("a[data-ncmail-warn]") as HTMLAnchorElement | null;
          if (!a) return;
          e.preventDefault();
          const ok = await dialog.confirm({ title: "Open this link?", message: a.getAttribute("data-ncmail-warn"), confirmLabel: "Open anyway", danger: true });
          if (ok) window.open(a.href, "_blank", "noopener,noreferrer");
        });
        d?.addEventListener("keydown", (e) => window.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, shiftKey: e.shiftKey, bubbles: true })));
      }} />
  );
}

type Patch = { seen?: boolean; flagged?: boolean; labels?: string[] };
interface Common {
  folders: Folder[]; accounts: AccountSummary[];
  onChanged: (id: string, patch: Patch) => void;
  onRemoved: (id: string) => void;
  onCompose: (init: ComposeInit) => void;
  /** Move / copy / delete / spam by message id, with the list's undo toast. */
  act: (action: BulkAction, ids: string[], target?: Folder, extra?: Record<string, unknown>) => Promise<void>;
  onBack: () => void;
}

const fullDate = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/** One message: collapsed summary row, or expanded with toolbar, body and attachments. */
function MessageView({ item, folder, expanded, onToggle, standalone, inThread, primary, ...c }: Common & {
  item: MessageItem; folder: Folder; expanded: boolean; onToggle?: () => void; standalone?: boolean; inThread?: boolean; primary?: boolean;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const [unsubscribed, setUnsubscribed] = useState(false);
  const [toNc, setToNc] = useState<ToKind | null>(null);
  const [m, setM] = useState<MessageFull | null>(null);
  const [err, setErr] = useState("");
  const [allowImages, setAllowImages] = useState(false);
  const [seen, setSeen] = useState(item.seen);
  const [details, setDetails] = useState(false);
  const nc = useNc();
  // other Nextcloud apps (Tasks, Calendar, Talk), offered only when the Nextcloud has them
  const integrations = useIntegrations(nc.connected);
  const ctxMenu = useContextMenu();
  const [showSource, setShowSource] = useState(false);
  const { labels: allLabels } = useLabels(folder.accountId);
  const [pickSnooze, setPickSnooze] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const [savePick, setSavePick] = useState<null | { idx: string; label: string }>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [known, setKnown] = useState<boolean | null>(null);
  const prefs = useReaderPrefs();
  const [receiptDone, setReceiptDone] = useState(false);
  useEffect(() => { setUnsubscribed(false); setReceiptDone(false); }, [m?.id]);
  useEffect(() => { setKnown(null); if (expanded && m && nc.connected) api<{ known: boolean }>(`/nextcloud/contacts/known?email=${encodeURIComponent(m.fromAddr)}`).then((r) => setKnown(r.known)).catch(() => {}); }, [expanded, m?.id, nc.connected]);
  useEffect(() => setSeen(item.seen), [item.seen]);

  useEffect(() => {
    if (!expanded) return;
    let live = true;
    // A message seen or hovered before is already cached (its content never changes), so it opens with no wait.
    const path = `/messages/${item.id}`;
    const cached = peek<MessageFull>(path);
    setM(cached ?? null); setErr(""); setAllowImages(false);
    (cached ? Promise.resolve(cached) : cload<MessageFull>(path)).then((x) => {
      if (!live) return;
      setM(x);
      if (!x.seen && can(folder, "s")) api(`/messages/${x.id}`, { method: "PATCH", body: JSON.stringify({ seen: true }) })
        .then(() => { setSeen(true); c.onChanged(x.id, { seen: true }); patchCached<MessageFull>(path, (v) => ({ ...v, seen: true })); }).catch(() => {});
    }).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [item.id, expanded]);

  const linkCheck = useMemo(() => (m?.html ? analyzeLinks(m.html) : { html: null as string | null, issues: [] }), [m?.html]);
  // images load when allowed for this message, or for its sender when the message can be trusted with that (see imagesTrustable)
  const autoImages = !!m?.imagesTrustable && imagesAllowedFor(prefs.imageSenders, m.fromAddr);
  const showImages = (allowImages || autoImages) && !m?.remoteBlocked;
  const doc = useMemo(() => (m ? srcDoc(m, showImages, linkCheck.html) : ""), [m, showImages, linkCheck]);

  // keyboard shortcuts r / a / l / f act on the message you are reading
  const compose = useRef<{ reply: () => void; replyAll: () => void; replyList: () => void; forward: () => void }>({ reply() {}, replyAll() {}, replyList() {}, forward() {} });
  useEffect(() => {
    if (!primary) return;
    const h = (e: Event) => {
      const name = (e as CustomEvent<string>).detail;
      if (name === "reply") compose.current.reply(); else if (name === "replyAll") compose.current.replyAll(); else if (name === "replyList") compose.current.replyList(); else if (name === "forward") compose.current.forward();
    };
    window.addEventListener("ncmail:cmd", h);
    return () => window.removeEventListener("ncmail:cmd", h);
  }, [primary]);

  if (!expanded) {
    return (
      <button className={`thread-card collapsed${inThread ? " in-thread" : ""}${seen ? "" : " unseen"}`} onClick={onToggle}>
        {inThread && <span className="gutter"><Avatar name={item.fromName} address={item.fromAddr} small /></span>}
        <span className="card-main collapsed-main">
          <span className="msg-from">{item.fromName || item.fromAddr}</span>
          <span className="hint" style={{ flexShrink: 0, display: "inline-flex", gap: 6, alignItems: "center" }}>{item.hasAttachments && <Icon name="paperclip" size={13} />}{fullDate(item.date)}</span>
        </span>
      </button>
    );
  }
  if (err) return <div className="note error" style={{ margin: 12 }}>{err}</div>;
  if (!m) return <div className="reader-empty hint">Loading…</div>;

  // Optimistic: the button reacts at once; if the server refuses, it goes back.
  const patch = async (p: Patch) => {
    const before = m;
    setM({ ...m, ...p }); if (p.seen !== undefined) setSeen(p.seen); c.onChanged(m.id, p);
    patchCached<MessageFull>(`/messages/${m.id}`, (v) => ({ ...v, ...p }));
    try { await api(`/messages/${m.id}`, { method: "PATCH", body: JSON.stringify(p) }); }
    catch {
      setM(before); setSeen(before.seen); c.onChanged(m.id, { seen: before.seen, flagged: before.flagged });
      patchCached<MessageFull>(`/messages/${m.id}`, () => before);
      toast({ message: "Could not update the message", kind: "error" });
    }
  };
  const saveToNc = async (folderPath: string) => {
    const pick = savePick!; setSavePick(null);
    try { const r = await api<{ saved: string[] }>(`/messages/${m.id}/attachments/${pick.idx}/save-to-nextcloud`, { method: "POST", body: JSON.stringify({ folder: folderPath }) }); toast({ kind: "success", message: `Saved to Nextcloud: ${r.saved.join(", ")}` }); }
    catch (e: any) { toast({ kind: "error", message: e.message }); }
  };
  const addContact = async () => {
    try { await api("/nextcloud/contacts", { method: "POST", body: JSON.stringify({ name: m.fromName, email: m.fromAddr }) }); setKnown(true); toast({ kind: "success", message: `Added ${m.fromName || m.fromAddr} to your Nextcloud contacts` }); }
    catch (e: any) { toast({ kind: "error", message: e.message }); }
  };
  const isDraft = folder.specialUse === "\\Drafts";
  const sameAcct = sortFolders(c.folders.filter((f) => f.selectable && f.accountId === folder.accountId));
  // in a folder someone shared with you, only what the server allows
  const mayRemove = can(folder, "te"), mayFlag = can(folder, "w"), maySeen = can(folder, "s");
  const archive = sameAcct.find((f) => f.specialUse === "\\Archive");
  const junk = sameAcct.find((f) => f.specialUse === "\\Junk");
  const inJunk = folder.specialUse === "\\Junk";
  const inTrash = folder.specialUse === "\\Trash";
  const run =async (action: BulkAction, target?: Folder) => { try { await c.act(action, [m.id], target); c.onRemoved(m.id); } catch { /* toast already shown */ } };
  const snooze = async (d: Date) => { try { await c.act("snooze", [m.id], undefined, { until: d.toISOString() }); c.onRemoved(m.id); } catch { /* toast already shown */ } };
  const toggleLabel = async (slug: string) => {
    const has = (m.labels ?? []).includes(slug);
    try { await c.act(has ? "unlabel" : "label", [m.id], undefined, { label: slug }); const labels = has ? (m.labels ?? []).filter((x) => x !== slug) : [...(m.labels ?? []), slug]; setM({ ...m, labels }); c.onChanged(m.id, { labels }); patchCached<MessageFull>(`/messages/${m.id}`, (v) => ({ ...v, labels })); }
    catch { /* toast already shown */ }
  };
  const copyTo = async (target: Folder) => { try { await c.act("copy", [m.id], target); } catch { /* toast already shown */ } };
  const editDraft = async () => {
    const d = await api<any>(`/messages/${m.id}/draft`);
    c.onCompose({ accountId: d.accountId, identityId: d.identityId ?? undefined, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject,
      body: d.text, html: d.html ?? undefined, inReplyTo: d.inReplyTo ?? undefined, references: d.references, attachments: d.attachments, draftUid: d.uid, security: d.security ?? undefined, readReceipt: !!d.readReceipt });
  };

  const unsubscribe = async () => {
    const u = m.unsubscribe;
    if (!u) return;
    const who = m.fromName || m.fromAddr;
    const question = u.method === "one-click" ? `${u.target} will be asked to stop sending to you.`
      : u.method === "mail" ? `A message asking to be removed is sent from your address to ${u.target}.`
      : `The list's own page opens in a new tab (${new URL(u.target).hostname}), where you confirm it.`;
    if (!(await dialog.confirm({ title: `Unsubscribe from ${who}?`, message: question, confirmLabel: "Unsubscribe" }))) return;
    if (u.method === "link") { window.open(u.target, "_blank", "noopener,noreferrer"); return; }
    try {
      await api(`/messages/${m.id}/unsubscribe`, { method: "POST" });
      setUnsubscribed(true);
      toast({ kind: "success", message: `Unsubscribed from ${who}. It can take a few days before the mail stops.` });
    } catch (e: any) { toast({ kind: "error", message: e.message }); }
  };
  const reply = (all: boolean) => c.onCompose(replyInit(m, c.accounts, folder.accountId, all));
  const forward = () => c.onCompose(forwardInit(m, c.accounts, folder.accountId));
  const replyList = () => m.listPost && c.onCompose(replyToListInit(m, c.accounts, folder.accountId));
  const forwardAsAttachment = () => c.onCompose(forwardAsAttachmentInit([m], c.accounts, folder.accountId, m));
  compose.current = { reply: () => !isDraft && reply(false), replyAll: () => !isDraft && reply(true), replyList: () => !isDraft && replyList(), forward: () => !isDraft && forward() };

  const fromDomain = m.fromAddr.split("@")[1]?.toLowerCase() ?? "";
  const alwaysImages = async (sender: string) => {
    try { await allowImagesFrom(sender); setAllowImages(true); toast({ kind: "success", message: `Images from ${sender.startsWith("@") ? `everyone at ${sender.slice(1)}` : sender} will load automatically. You can change this in Settings.` }); }
    catch (e: any) { toast({ kind: "error", message: e.message }); }
  };
  // a read receipt is sent or declined once; either way it is not asked again
  const answerReceipt = async (send: boolean) => {
    try {
      await api(`/messages/${m.id}/receipt`, { method: "POST", body: JSON.stringify({ send }) });
      setReceiptDone(true);
      patchCached<MessageFull>(`/messages/${m.id}`, (v) => ({ ...v, receiptTo: null }));
      if (send) toast({ kind: "success", message: `Read receipt sent to ${m.receiptTo}` });
    } catch (e: any) { toast({ kind: "error", message: e.message }); }
  };

  return (
    <article className={`thread-card${standalone ? " standalone" : ""}${inThread ? " in-thread" : ""}`}>
      {inThread && <div className="gutter"><Avatar name={m.fromName} address={m.fromAddr} small /></div>}
      <div className="card-main">
        <div className="reader-toolbar" role="toolbar" aria-label="Message actions">
          <IconButton icon="chevronLeft" label="Back to the list" className="back" onClick={c.onBack} />
          {isDraft ? <button className="btn sm primary" onClick={editDraft}><Icon name="edit" size={14} /> Edit draft</button> : (
            <>
              <button className="btn sm ghost" title="Reply (r)" onClick={() => reply(false)}><Icon name="reply" size={15} /> Reply</button>
              <IconButton icon="replyAll" label="Reply all" hint="a" onClick={() => reply(true)} />
              {m.listPost && <IconButton icon="thread" label={`Reply to list (${m.listPost})`} hint="l" onClick={replyList} />}
              <IconButton icon="forward" label="Forward" hint="f" onClick={forward} />
            </>
          )}
          {/* the same order as the selection toolbar and the right-click menu: remove | mark | file */}
          <span className="sep" />
          {mayRemove && archive && archive.id !== folder.id && <IconButton icon="archive" label="Archive" hint="e" onClick={() => run("move", archive)} />}
          {mayRemove && <IconButton icon="trash" label={inTrash ? "Delete forever…" : "Delete"} hint="#" danger onClick={() => (inTrash ? setConfirmDel(true) : run("delete"))} />}
          {junk && mayRemove && <IconButton icon="spam" label={inJunk ? "Not spam" : "Report spam"} hint="!" onClick={() => run(inJunk ? "notspam" : "spam")} />}
          <span className="sep" />
          {maySeen && <IconButton icon="mail" label="Mark as unread" hint="u" onClick={() => patch({ seen: false })} />}
          {mayFlag && <IconButton icon="star" label={m.flagged ? "Remove star" : "Star"} hint="s" active={m.flagged} onClick={() => patch({ flagged: !m.flagged })} />}
          {mayRemove && <Menu icon="clock" iconOnly label="Snooze" items={timeMenu(snooze, () => setPickSnooze(true))} />}
          <span className="sep" />
          {mayRemove && <Menu icon="move" label="Move to" filterable items={sameAcct.filter((f) => f.id !== folder.id && can(f, "i")).map((f) => ({ label: folderPath(f), onClick: () => run("move", f) }))} />}
          <Menu icon="copy" iconOnly label="Copy to" filterable items={sameAcct.filter((f) => can(f, "i")).map((f) => ({ label: folderPath(f), onClick: () => copyTo(f) }))} />
          {mayFlag && <Menu icon="tag" iconOnly label="Labels" items={allLabels.length ? allLabels.map((l) => ({ label: l.name, checked: (m.labels ?? []).includes(l.slug), onClick: () => toggleLabel(l.slug) })) : [{ label: "No labels yet: add some in Settings", disabled: true, onClick: () => {} }]} />}
          <span style={{ flex: 1 }} />
          <Menu icon="more" iconOnly label="More" align="right" items={[
            ...(!isDraft ? [
              ...(m.listPost ? [{ label: "Reply to list", icon: "thread" as const, hint: "l", onClick: replyList }] : []),
              { label: "Forward as attachment", icon: "forward" as const, onClick: forwardAsAttachment },
              { label: "", divider: true },
            ] : []),
            ...(integrations?.tasks ? [{ label: "Create a task…", icon: "check" as const, onClick: () => setToNc("task") }] : []),
            ...(integrations?.calendar ? [{ label: "Create an event…", icon: "calendar" as const, onClick: () => setToNc("event") }] : []),
            ...(integrations?.talk ? [{ label: "Share to Talk…", icon: "send" as const, onClick: () => setToNc("talk") }] : []),
            ...(integrations && (integrations.tasks || integrations.calendar || integrations.talk) ? [{ label: "", divider: true }] : []),
            { label: "Print", icon: "file", onClick: () => printMessage(m, showImages) },
            { label: "View source and headers", icon: "info", onClick: () => setShowSource(true) },
            { label: "Download as .eml", icon: "download", onClick: () => { window.location.href = `/api/messages/${m.id}/source?download=1`; } },
          ]} />
        </div>
        {confirmDel && (
          <div className="note error" role="alertdialog" aria-label="Delete forever">
            <b>Delete this message forever?</b> It cannot be undone.
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn danger" autoFocus onClick={() => { setConfirmDel(false); run("delete"); }}>Delete forever</button>
              <button className="btn" onClick={() => setConfirmDel(false)}>Cancel</button>
            </div>
          </div>
        )}
        <div className="reader-head">
          {standalone && <h2>{m.subject || "(no subject)"}</h2>}
          <div className="sender">
            {!inThread && <Avatar name={m.fromName} address={m.fromAddr} />}
            <div className="sender-main" onContextMenu={(e) => ctxMenu(e, [
              { label: `Write to ${m.fromName || m.fromAddr}`, icon: "compose", onClick: () => c.onCompose({ accountId: folder.accountId, to: m.fromAddr }) },
              ...(!isDraft ? [{ label: "Reply", icon: "reply" as const, onClick: () => reply(false) }] : []),
              { label: "Copy email address", icon: "copy", onClick: () => { navigator.clipboard.writeText(m.fromAddr); toast({ message: `Copied ${m.fromAddr}` }); } },
              { label: "Find messages from this sender", icon: "search", onClick: () => window.dispatchEvent(new CustomEvent("ncmail:search", { detail: `from:${m.fromAddr}` })) },
              ...(nc.connected && known === false ? [{ label: "Add to contacts", icon: "user" as const, onClick: addContact }] : []),
            ])} onClick={onToggle} style={{ cursor: onToggle ? "pointer" : undefined }}>
              <div><span className="sender-name">{m.fromName || m.fromAddr}</span> <span className="sender-meta">&lt;{m.fromAddr}&gt;</span></div>
              <div className="sender-meta">
                {fullDate(m.date)} · to {m.to.slice(0, 2).map((a) => a.name || a.address).join(", ")}{m.to.length > 2 ? ` +${m.to.length - 2}` : ""}{m.cc.length ? ` · cc ${m.cc.length}` : ""}
                {" "}<button className="btn link" onClick={(e) => { e.stopPropagation(); setDetails(!details); }}>{details ? "Hide details" : "Details"}</button>
                {known === false && <>{" · "}<button className="btn link" onClick={(e) => { e.stopPropagation(); addContact(); }}>Add to contacts</button></>}
                {m.unsubscribe && !unsubscribed && <>{" · "}<button className="btn link" onClick={(e) => { e.stopPropagation(); unsubscribe(); }}>Unsubscribe</button></>}
              </div>
              {(m.labels ?? []).length > 0 && <div style={{ marginTop: 4 }}>{(m.labels ?? []).map((slug) => { const l = allLabels.find((x) => x.slug === slug); return <span key={slug} className="label-chip" style={{ background: l?.color ?? "#64748b" }}>{l?.name ?? slug}</span>; })}</div>}
              {details && (
                <div className="sender-meta" style={{ marginTop: 4 }}>
                  <div>From: {fmtAddr({ name: m.fromName, address: m.fromAddr })}</div>
                  <div>To: {m.to.map(fmtAddr).join(", ")}</div>
                  {m.cc.length > 0 && <div>Cc: {m.cc.map(fmtAddr).join(", ")}</div>}
                  {m.auth?.present && <div>Sender checks: SPF {m.auth.spf || "n/a"} · DKIM {m.auth.dkim || "n/a"} · DMARC {m.auth.dmarc || "n/a"}</div>}
                  {m.replyTo.length > 0 && <div>Reply-To: {m.replyTo.map(fmtAddr).join(", ")}</div>}
                </div>
              )}
            </div>
          </div>
        </div>
        <PhishingBanner warnings={m.warnings ?? []} links={linkCheck.issues} />
        <SecurityBanner message={m} accountId={folder.accountId} />
        {m.hasInvite && <InviteBanner messageId={m.id} />}
        {m.remoteBlocked && <div className="note warning">Remote images were removed: this encrypted message is not signed by the sender, so they are never loaded.</div>}
        {m.receiptTo && !receiptDone && prefs.readReceipts === "ask" && (
          <div className="note" role="group" aria-label="Read receipt">
            {m.fromName || m.fromAddr} asked to be told when you read this.{" "}
            <button className="btn link" onClick={() => answerReceipt(true)}>Send a read receipt</button>{" · "}
            <button className="btn link" onClick={() => answerReceipt(false)}>Don't send</button>
          </div>
        )}
        {m.hasRemoteImages && !m.remoteBlocked && !showImages && (
          <div className="note warning">Remote images are blocked to protect your privacy. <button className="btn link" onClick={() => setAllowImages(true)}>Load images</button>
            {m.imagesTrustable && fromDomain && <>
              {" · "}<button className="btn link" onClick={() => alwaysImages(m.fromAddr.toLowerCase())}>Always from {m.fromAddr}</button>
              {" · "}<button className="btn link" onClick={() => alwaysImages(`@${fromDomain}`)}>Always from everyone at {fromDomain}</button>
            </>}
          </div>
        )}
        <AutoFrame doc={doc} />
        {pickSnooze && <PickTime title="Snooze until" onPick={(d) => { setPickSnooze(false); snooze(d); }} onClose={() => setPickSnooze(false)} />}
        {showSource && <SourceModal messageId={m.id} onClose={() => setShowSource(false)} />}
        {toNc && <ToNextcloud kind={toNc} message={m} onClose={() => setToNc(null)} onDone={(text) => { setToNc(null); toast({ kind: "success", message: text }); }} />}
        {preview !== null && <AttachmentPreview messageId={m.id} items={m.attachments.filter((x) => canPreview(x.contentType))} start={preview} onClose={() => setPreview(null)} extra={nc.connected ? (a) => <button className="btn sm ghost" onClick={() => { setPreview(null); setSavePick({ idx: String(a.idx), label: a.filename }); }}><Icon name="cloud" size={14} /> Save to Nextcloud</button> : undefined} />}
        {savePick && <NcFilePicker mode="folder" title={`Save ${savePick.label} to Nextcloud`} onPick={(p) => saveToNc(p[0]!)} onClose={() => setSavePick(null)} />}
        {m.attachments.length > 0 && (
          <div className="attachments">
            {m.attachments.map((a) => (
              <span key={a.idx} className="att-chip" onContextMenu={(e) => ctxMenu(e, [
                ...(canPreview(a.contentType) ? [{ label: "Preview", icon: "search" as const, onClick: () => setPreview(m.attachments.filter((x) => canPreview(x.contentType)).findIndex((x) => x.idx === a.idx)) }] : []),
                { label: "Download", icon: "download", onClick: () => { window.location.href = `/api/messages/${m.id}/attachments/${a.idx}`; } },
                ...(nc.connected ? [{ label: "Save to Nextcloud…", icon: "cloud" as const, onClick: () => setSavePick({ idx: String(a.idx), label: a.filename }) }] : []),
                { label: "Copy file name", icon: "copy", onClick: () => { navigator.clipboard.writeText(a.filename); toast({ message: "Copied" }); } },
              ])}>
                {canPreview(a.contentType)
                  ? <a href={`/api/messages/${m.id}/attachments/${a.idx}`} title="Preview" onClick={(e) => { e.preventDefault(); setPreview(m.attachments.filter((x) => canPreview(x.contentType)).findIndex((x) => x.idx === a.idx)); }}><Icon name="paperclip" size={14} /> {a.filename} <span className="hint">{fmtSize(a.size)}</span></a>
                  : <a href={`/api/messages/${m.id}/attachments/${a.idx}`}><Icon name="paperclip" size={14} /> {a.filename} <span className="hint">{fmtSize(a.size)}</span></a>}
                {nc.connected && <button className="btn icon sm ghost" title="Save to Nextcloud" aria-label={`Save ${a.filename} to Nextcloud`} onClick={() => setSavePick({ idx: String(a.idx), label: a.filename })}><Icon name="cloud" size={14} /></button>}
              </span>
            ))}
            {nc.connected && m.attachments.length > 1 && <button className="btn sm ghost" onClick={() => setSavePick({ idx: "all", label: "all attachments" })}><Icon name="cloud" size={14} /> Save all to Nextcloud</button>}
          </div>
        )}
      </div>
    </article>
  );
}

interface ThreadItem extends MessageItem { folderId: string; folderName: string }

/** A whole conversation, oldest first. Unread messages and the newest one start expanded. */
function ThreadView({ threadId, folder, onEmpty, ...c }: Common & { threadId: string; folder: Folder; onEmpty: () => void }) {
  const [items, setItems] = useState<ThreadItem[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [err, setErr] = useState("");
  const seenIds = useRef(new Set<string>());

  const apply = (list: ThreadItem[], initial: boolean) => {
    if (!list.length) { onEmpty(); return; }
    setItems(list);
    setOpen((cur) => {
      const next = new Set(initial ? [] : cur);
      list.forEach((m, i) => {
        const isNew = !seenIds.current.has(m.id);
        if (isNew && (!m.seen || i === list.length - 1) && (initial || !m.seen)) next.add(m.id);
        seenIds.current.add(m.id);
      });
      return next;
    });
  };
  // A conversation seen or hovered before shows instantly from the cache, then updates if anything changed.
  const load = (initial: boolean) => {
    const path = `/threads/${threadId}?folderId=${folder.id}`;
    const cached = initial ? peek<ThreadItem[]>(path) : undefined;
    if (cached) apply(cached, true);
    return cload<ThreadItem[]>(path).then((list) => apply(list, initial && !cached)).catch((e) => setErr(e.message));
  };

  useEffect(() => { seenIds.current = new Set(); setItems(null); setErr(""); load(true); }, [threadId]);
  useEffect(() => { // a new reply arriving while the conversation is open
    const h = () => load(false);
    window.addEventListener("ncmail:refresh", h);
    return () => window.removeEventListener("ncmail:refresh", h);
  }, [threadId, folder.id]);

  if (err) return <div className="reader-empty"><div className="note error">{err}</div></div>;
  if (!items) return <div className="reader-empty hint">Loading…</div>;
  const last = items[items.length - 1]!;
  const people = new Set(items.map((m) => (m.fromAddr || m.fromName).toLowerCase())).size;
  const primaryId = [...items].reverse().find((m) => open.has(m.id))?.id;

  return (
    <div className="reader">
      <div className="thread-banner">
        <span className="thread-badge"><Icon name="thread" size={13} /> Conversation</span>
        <h2>{stripSubject(last.subject) || "(no subject)"}</h2>
        <div className="thread-meta">
          <span className="hint">{items.length} messages · {people} {people === 1 ? "person" : "people"}</span>
          <button className="btn link" onClick={() => setOpen(open.size === items.length ? new Set() : new Set(items.map((m) => m.id)))}>
            {open.size === items.length ? "Collapse all" : "Expand all"}
          </button>
        </div>
      </div>
      <div className="thread-list">
        {items.map((m) => (
          <MessageView key={m.id} item={m} inThread primary={m.id === primaryId} folder={c.folders.find((f) => f.id === m.folderId) ?? folder} {...c}
            expanded={open.has(m.id)}
            onToggle={() => setOpen((cur) => { const n = new Set(cur); n.has(m.id) ? n.delete(m.id) : n.add(m.id); return n; })}
            onRemoved={(id) => {
              const rest = items.filter((x) => x.id !== id);
              setItems(rest); c.onRemoved(id);
              if (!rest.length) onEmpty();
            }} />
        ))}
      </div>
    </div>
  );
}

export function Reader({ selection, folder, onEmpty, ...c }: Common & {
  selection: { messageId: string; threadId: string | null; item: MessageItem }; folder: Folder; onEmpty: () => void;
}) {
  if (selection.threadId) return <ThreadView threadId={selection.threadId} folder={folder} onEmpty={onEmpty} {...c} />;
  return (
    <div className="reader">
      <MessageView key={selection.messageId} item={selection.item} folder={folder} expanded standalone primary {...c} />
    </div>
  );
}
