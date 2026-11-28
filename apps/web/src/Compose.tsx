import { useEffect, useRef, useState } from "react";
import type { AccountSummary, Identity } from "@ncmail/shared";
// the file itself, so the composer does not pull in the schema library with the rest of the package
import { mentionsAttachment } from "@ncmail/shared/src/attachmentHint.ts";
import { api, attachmentRef, htmlToPlain, parseRecipients, textToHtml, uploadFile, fmtSize, type UploadedFile } from "./api.ts";
import { RichEditor, sigBlock, type EditorHandle } from "./RichEditor.tsx";
import { RecipientInput } from "./RecipientInput.tsx";
import { Icon } from "./icons.tsx";
import { IconButton, useDialog } from "./ui.tsx";
import { useNc } from "./nc.ts";
import { PickTime, timeMenu, whenLabel } from "./schedule.tsx";
import { Menu } from "./ui.tsx";
import { NcFilePicker } from "./NcFilePicker.tsx";
import { getPref } from "./prefs.ts";
import { MESSAGE_PICTURES } from "./pictures.ts";

export interface ComposeInit {
  accountId?: string; identityId?: string; to?: string; cc?: string; bcc?: string; subject?: string; body?: string;
  /** Initial rich-text body (takes precedence over `body`). */
  html?: string;
  inReplyTo?: string; references?: string[]; attachments?: UploadedFile[];
  /** UID of an existing draft in the Drafts folder being edited. */
  draftUid?: number;
  /** Start with signing / encryption switched on (for example when replying to an encrypted message). */
  security?: SecurityChoice;
  /** Files in the user's Nextcloud to attach right away ("Send by mail" in Files). */
  ncFiles?: string[];
  /** Ask for a read receipt (when not given: the setting under Settings > General). */
  readReceipt?: boolean;
}
export interface Template { id: string; name: string; subject: string; html: string }
/** The body without the signature block, so a template does not carry one sender's signature to another. */
const withoutSignature = (html: string) => {
  const d = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  d.querySelectorAll("[data-signature]").forEach((n) => n.remove());
  return d.body.innerHTML;
};
/** What the person wrote themselves: without the signature, the quoted message or a forwarded one. */
const writtenText = (html: string) => {
  const d = new DOMParser().parseFromString(`<body>${html.replace(/<\/(p|li|div|h\d)>|<br\s*\/?>/gi, "\n$&")}</body>`, "text/html");
  d.querySelectorAll("[data-signature], blockquote").forEach((n) => n.remove());
  return (d.body.textContent ?? "").split("---------- Forwarded message ----------")[0]!;
};
export interface SecurityChoice { sign: boolean; encrypt: boolean; protocol: "pgp" | "smime" }
interface Caps { from: string; sign: Record<"pgp" | "smime", boolean>; drafts?: Record<"pgp" | "smime", boolean>; recipients: { email: string; pgp: boolean; smime: boolean }[] }
const PNAME = { pgp: "PGP", smime: "S/MIME" } as const;
export interface SentInfo { outboxId?: string; delay: number; scheduledFor?: string; snapshot: ComposeInit }

interface Att { key: string; id?: string; filename: string; size: number; progress: number; error?: string; abort?: () => void }
let attSeq = 0;

/** An address's signature as HTML: the rich one, or the plain one turned into paragraphs. */
const signatureOf = (i?: Identity) => (i?.signatureHtml?.trim() ? i.signatureHtml : i?.signatureText?.trim() ? textToHtml(i.signatureText) : "");
/** The signature was entered as HTML and is kept as it is in the message (see htmlSignature.ts). */
const sigAsHtml = (i?: Identity) => !!(i?.signatureIsHtml && i.signatureHtml?.trim());
const refresh = (delay = 1500) => setTimeout(() => window.dispatchEvent(new Event("ncmail:refresh")), delay);
const addrs = (s: string) => parseRecipients(s).map((r) => r.raw);

export function Compose({ accounts, init, undoSeconds, onSent, onClose, onChanged }: {
  accounts: AccountSummary[]; init: ComposeInit; undoSeconds: number; onSent: (s: SentInfo) => void; onClose: () => void; onChanged: () => void;
}) {
  // Every identity of every account is a possible sender; the account's default is preselected.
  const senders = accounts.flatMap((a) => a.identities.map((i) => ({ account: a, identity: i })));
  const initial =
    senders.find((s) => s.identity.id === init.identityId) ??
    senders.find((s) => s.account.id === (init.accountId ?? accounts[0]?.id) && s.identity.isDefault) ??
    senders[0];
  const dialog = useDialog();
  const [identityId, setIdentityId] = useState(initial?.identity.id ?? "");
  const sender = senders.find((s) => s.identity.id === identityId);
  const [to, setTo] = useState(init.to ?? "");
  const [cc, setCc] = useState(init.cc ?? "");
  const [bcc, setBcc] = useState(init.bcc ?? "");
  const [showCc, setShowCc] = useState(!!(init.cc || init.bcc));
  const [subject, setSubject] = useState(init.subject ?? "");
  const editorRef = useRef<EditorHandle>(null);
  // New mail, replies and forwards get the sender's signature (above the quoted text); reopened drafts already contain theirs.
  const baseHtml = init.html ?? textToHtml(init.body ?? "");
  const sig = signatureOf(initial?.identity);
  const sigHtml = sigBlock(sig, sigAsHtml(initial?.identity));
  const initialHtml = init.draftUid || !sig
    ? baseHtml
    : baseHtml.startsWith("<p></p>")
      ? "<p></p>" + sigHtml + baseHtml.slice("<p></p>".length)
      : baseHtml + sigHtml;
  const [html, setHtml] = useState(initialHtml);
  const [text, setText] = useState(init.html ? htmlToPlain(init.html) : init.body ?? "");
  const [atts, setAtts] = useState<Att[]>(() => (init.attachments ?? []).map((a) => ({ key: `a${++attSeq}`, id: a.id, filename: a.filename, size: a.size, progress: 1 })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState(init.draftUid ? "Editing saved draft" : "");
  const nc = useNc();
  const [picker, setPicker] = useState(false);
  const [pickSend, setPickSend] = useState(false);
  const [readReceipt, setReadReceipt] = useState(() => init.readReceipt ?? getPref("readReceipt"));

  // ---- signing and encryption ----
  const memory = (id: string): SecurityChoice => { try { return JSON.parse(localStorage.getItem(`ncmail.sec.${id}`) ?? "null") ?? { sign: false, encrypt: false, protocol: "smime" }; } catch { return { sign: false, encrypt: false, protocol: "smime" }; } };
  const [sec, setSecState] = useState<SecurityChoice>(() => init.security ?? memory(initial?.identity.id ?? ""));
  const [secOpen, setSecOpen] = useState(!!(init.security?.sign || init.security?.encrypt));
  const [caps, setCaps] = useState<Caps | null>(null);
  // the draft is saved again, so turning encryption on or off applies to the copy on the server too
  const setSec = (next: SecurityChoice) => { setSecState(next); localStorage.setItem(`ncmail.sec.${identityId}`, JSON.stringify(next)); if (next.encrypt !== sec.encrypt || next.protocol !== sec.protocol) touch(); };

  // ---- draft autosave: debounced, serialised, replaces the previous server copy ----
  const draftUid = useRef<number | undefined>(init.draftUid);
  const draftAccount = useRef<string | undefined>(init.draftUid ? initial?.account.id : undefined);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef({ identityId, to, cc, bcc, subject, text, html, atts, sender, sec, readReceipt });
  latest.current = { identityId, to, cc, bcc, subject, text, html, atts, sender, sec, readReceipt };
  const attRefs = (list: Att[]) => list.filter((a) => a.id).map((a) => attachmentRef({ id: a.id!, filename: a.filename }));
  const hasContent = () => { const l = latest.current; return !!(l.to || l.cc || l.bcc || l.subject || l.text.trim() || l.atts.length || /<img\b/i.test(l.html)); };

  const saveDraft = () => {
    chain.current = chain.current.then(async () => {
      const l = latest.current;
      if (!dirty.current || !l.sender || !hasContent()) return;
      dirty.current = false;
      setStatus("Saving draft…");
      try {
        const r = await api<{ uid: number | null }>(`/accounts/${l.sender.account.id}/drafts`, {
          method: "POST",
          body: JSON.stringify({
            identityId: l.identityId, to: addrs(l.to), cc: addrs(l.cc), bcc: addrs(l.bcc), subject: l.subject, text: l.text, html: l.html,
            inReplyTo: init.inReplyTo, references: init.references ?? [], attachments: attRefs(l.atts), replacesUid: draftUid.current, readReceipt: l.readReceipt,
            security: l.sec.encrypt ? { encrypt: true, protocol: l.sec.protocol } : undefined,
          }),
        });
        draftUid.current = r.uid ?? undefined;
        draftAccount.current = l.sender.account.id;
        setStatus(`Draft saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
        onChanged(); refresh();
      } catch (e: any) {
        dirty.current = true;
        setStatus(`Draft not saved: ${e.message}`);
      }
    });
    return chain.current;
  };
  const touch = () => { dirty.current = true; setConfirm(null); clearTimeout(timer.current); timer.current = setTimeout(saveDraft, 4000); };
  useEffect(() => () => clearTimeout(timer.current), []);

  const deleteServerDraft = async () => {
    await chain.current;
    if (draftUid.current && draftAccount.current) {
      await api(`/accounts/${draftAccount.current}/drafts/${draftUid.current}`, { method: "DELETE" }).catch(() => {});
      draftUid.current = undefined; onChanged(); refresh(500);
    }
  };

  const changeSender = async (id: string) => {
    const next = senders.find((s) => s.identity.id === id);
    if (next && draftAccount.current && next.account.id !== draftAccount.current) await deleteServerDraft(); // draft follows the account
    // Swap the signature: replace/remove the current block; if there is none, add the new one only when the previous sender had none either (otherwise the user deleted it on purpose).
    editorRef.current?.setSignature(signatureOf(next?.identity), !signatureOf(sender?.identity), sigAsHtml(next?.identity));
    setIdentityId(id); touch();
  };

  const close = async () => { clearTimeout(timer.current); atts.forEach((a) => !a.id && a.abort?.()); await saveDraft(); onClose(); };
  const discard = async () => { clearTimeout(timer.current); dirty.current = false; atts.forEach((a) => a.abort?.()); await deleteServerDraft(); onClose(); };

  // ---- attachments: uploaded as soon as they are added, with progress ----
  const attach = (files: FileList | File[] | null) => {
    for (const f of Array.from(files ?? [])) {
      const key = `a${++attSeq}`;
      const up = uploadFile(f, (p) => setAtts((cur) => cur.map((a) => (a.key === key ? { ...a, progress: p } : a))));
      setAtts((cur) => [...cur, { key, filename: f.name, size: f.size, progress: 0, abort: up.abort }]);
      up.promise.then((u) => { setAtts((cur) => cur.map((a) => (a.key === key ? { ...a, id: u.id, progress: 1, abort: undefined } : a))); touch(); })
        .catch((e) => setAtts((cur) => cur.map((a) => (a.key === key ? { ...a, error: e.message, abort: undefined } : a))));
    }
  };
  const attachFromNc = async (paths: string[]) => {
    setPicker(false);
    try {
      const ups = await api<UploadedFile[]>("/nextcloud/files/attach", { method: "POST", body: JSON.stringify({ paths }) });
      setAtts((cur) => [...cur, ...ups.map((u) => ({ key: `a${++attSeq}`, id: u.id, filename: u.filename, size: u.size, progress: 1 }))]); touch();
    } catch (e: any) { setErr(e.message); }
  };
  // "Send by mail" from Files: the files are fetched from Nextcloud as soon as the composer opens
  const ncStarted = useRef(false);
  useEffect(() => {
    if (ncStarted.current || !init.ncFiles?.length) return;
    ncStarted.current = true;
    attachFromNc(init.ncFiles);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // templates: reusable messages, inserted where the cursor is
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const loadTemplates = () => api<Template[]>("/templates").then(setTemplates).catch(() => setTemplates([]));
  useEffect(() => { loadTemplates(); }, []);
  const applyTemplate = (t: Template) => {
    editorRef.current?.insertHtml(t.html || "<p></p>");
    if (t.subject && !subject.trim()) setSubject(t.subject);
    touch();
  };
  const saveTemplate = async () => {
    const body = withoutSignature(html);
    if (body.length > 200_000) { setErr("This message is too big to keep as a template. Pictures take a lot of room; remove them and try again."); return; }
    const name = await dialog.prompt({ title: "Save as a template", label: "Name", initial: subject.trim() || "Template", confirmLabel: "Save template" });
    if (!name) return;
    try {
      await api("/templates", { method: "POST", body: JSON.stringify({ name, subject, html: body }) });
      loadTemplates();
    } catch (e: any) { setErr(e.message); }
  };
  const removeAtt = (a: Att) => { a.abort?.(); if (a.id) api(`/uploads/${a.id}`, { method: "DELETE" }).catch(() => {}); setAtts((cur) => cur.filter((x) => x.key !== a.key)); touch(); };
  const uploading = atts.some((a) => !a.id && !a.error);

  const recipients = parseRecipients(`${to}, ${cc}, ${bcc}`);
  const allTo = recipients.filter((r) => r.valid).map((r) => r.address).join(",");
  useEffect(() => {
    if (!sender) return;
    const t = setTimeout(() => api<Caps>(`/accounts/${sender.account.id}/security?identityId=${identityId}&to=${encodeURIComponent(allTo)}`).then(setCaps).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [identityId, allTo, sender?.account.id]);
  const wants = sec.sign || sec.encrypt;
  const signOk = (p: "pgp" | "smime") => !!caps?.sign[p];
  const missing = (p: "pgp" | "smime") => (caps?.recipients ?? []).filter((r) => !r[p]).map((r) => r.email);
  const encOk = (p: "pgp" | "smime") => (caps?.recipients.length ?? 0) > 0 && missing(p).length === 0;
  const feasible = (p: "pgp" | "smime", c: SecurityChoice) => (!c.sign || signOk(p)) && (!c.encrypt || encOk(p));
  const secProblem = !wants || !caps ? null
    : sec.sign && !signOk(sec.protocol) ? `You have no ${PNAME[sec.protocol]} ${sec.protocol === "pgp" ? "key" : "certificate"} for ${caps.from}. Add one under Settings > Security, or switch the type.`
    : sec.encrypt && !encOk(sec.protocol) ? (caps.recipients.length === 0 ? "Add a recipient to encrypt." : `No ${PNAME[sec.protocol]} ${sec.protocol === "pgp" ? "key" : "certificate"} for ${missing(sec.protocol).join(", ")}. Add theirs under Settings > Security, or switch the type.`)
    : null;
  const toggle = (what: "sign" | "encrypt") => {
    const next = { ...sec, [what]: !sec[what] };
    // pick the type that works, if only one does
    if ((next.sign || next.encrypt) && !feasible(next.protocol, next)) { const other = next.protocol === "pgp" ? "smime" : "pgp"; if (feasible(other, next)) next.protocol = other; }
    setSec(next);
  };

  const invalid = recipients.filter((r) => !r.valid);
  const canSend = !busy && !!sender && parseRecipients(to).length > 0 && !uploading && !secProblem;

  const send = async (force = false, sendAt?: Date) => {
    if (!canSend) return;
    if (invalid.length) { setErr(`"${invalid[0]!.raw}" is not a valid address. Fix or remove it before sending.`); return; }
    if (!force) {
      if (!subject.trim()) { setConfirm("This message has no subject."); return; }
    }
    if (!atts.some((a) => a.id) && mentionsAttachment(writtenText(html))) {
      const ok = await dialog.confirm({ title: "Send without an attachment?", message: "You mention an attachment, but nothing is attached.", confirmLabel: "Send anyway", cancelLabel: "Go back" });
      if (!ok) return;
    }
    setBusy(true); setErr(""); setConfirm(null); clearTimeout(timer.current);
    try {
      await chain.current; // let an in-flight draft save finish first so we know its UID
      const draft = draftAccount.current === sender!.account.id ? draftUid.current : undefined;
      const r = await api<{ queued?: boolean; outboxId?: string }>(`/accounts/${sender!.account.id}/send`, {
        method: "POST",
        body: JSON.stringify({
          identityId, to: addrs(to), cc: addrs(cc), bcc: addrs(bcc), subject, text, html,
          inReplyTo: init.inReplyTo, references: init.references ?? [], attachments: attRefs(atts), draftUid: draft, ...(sendAt ? { sendAt: sendAt.toISOString() } : { delaySeconds: undoSeconds }),
          security: wants ? sec : undefined, readReceipt,
        }),
      });
      dirty.current = false; onChanged(); refresh();
      onSent({
        outboxId: r.queued ? r.outboxId : undefined, delay: sendAt ? 0 : undoSeconds, scheduledFor: sendAt && +sendAt - Date.now() > 120_000 ? whenLabel(sendAt) : undefined,
        snapshot: { accountId: sender!.account.id, identityId, to, cc, bcc, subject, html, inReplyTo: init.inReplyTo, references: init.references,
          attachments: atts.filter((a) => a.id).map((a) => ({ id: a.id!, filename: a.filename, size: a.size, contentType: "" })), draftUid: draft, security: wants ? sec : undefined, readReceipt },
      });
      onClose();
    } catch (e: any) { setErr(e.message?.includes("Invalid input") ? "Check the recipients: at least one valid address is required." : e.message); }
    setBusy(false);
  };

  // Ctrl/⌘+Enter sends, Esc closes (the draft is saved).
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); send(); }
    else if (e.key === "Escape" && !e.defaultPrevented) close();
  };
  useEffect(() => { const h = (e: KeyboardEvent) => keys.current(e); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-label="New message"
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
        onDrop={(e) => { if (e.dataTransfer.files.length && !e.defaultPrevented) { e.preventDefault(); attach(e.dataTransfer.files); } setDragging(false); }}>
        {pickSend && <PickTime title="Send at" onPick={(d) => { setPickSend(false); send(false, d); }} onClose={() => setPickSend(false)} />}
        {picker && <NcFilePicker mode="files" title="Attach from Nextcloud" onPick={attachFromNc} onClose={() => setPicker(false)} />}
        {dragging && <div className="drop-overlay"><Icon name="upload" size={28} />Drop files to attach, or drop pictures on the text to put them in it</div>}
        <div className="modal-head">
          <b>{subject.trim() || "New message"}</b>
          <span className="hint" style={{ marginLeft: "auto", marginRight: 8, fontSize: 12.5 }}>{status}</span>
          <IconButton icon="x" label="Close and save draft" hint="Esc" onClick={close} />
        </div>
        <div className="modal-body">
          <div className="from-row">
            <span className="hint">From</span>
            {senders.length > 1 ? (
              <select aria-label="From" value={identityId} onChange={(e) => changeSender(e.target.value)}>
                {senders.map(({ account, identity }) => (
                  <option key={identity.id} value={identity.id}>
                    {identity.name} &lt;{identity.email}&gt;{identity.isDefault ? " (default)" : ""}{accounts.length > 1 ? ` · ${account.name}` : ""}
                  </option>
                ))}
              </select>
            ) : <span>{sender ? `${sender.identity.name} <${sender.identity.email}>` : "No sender address configured"}</span>}
            {sender?.identity.replyTo && <span className="hint" style={{ gridColumn: 2, fontSize: 12 }} title="Set under Settings > Sender addresses">Replies go to {sender.identity.replyTo}</span>}
          </div>
          <div className="rcpt-row">
            <span className="hint">To</span>
            <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0 }}><RecipientInput label="To" value={to} onChange={(v) => { setTo(v); touch(); }} accountId={sender?.account.id} autoFocus={!init.to} /></div>
              {!showCc && <button type="button" className="btn sm ghost" onClick={() => setShowCc(true)}>Cc / Bcc</button>}
            </div>
          </div>
          {showCc && (
            <>
              <div className="rcpt-row"><span className="hint">Cc</span><RecipientInput label="Cc" value={cc} onChange={(v) => { setCc(v); touch(); }} accountId={sender?.account.id} /></div>
              <div className="rcpt-row"><span className="hint">Bcc</span><RecipientInput label="Bcc" value={bcc} onChange={(v) => { setBcc(v); touch(); }} accountId={sender?.account.id} /></div>
            </>
          )}
          <div className="rcpt-row"><span className="hint">Subject</span><input aria-label="Subject" value={subject} onChange={(e) => { setSubject(e.target.value); touch(); }} /></div>
          <RichEditor ref={editorRef} initialHtml={initialHtml} autofocus={init.to ? "start" : false} pictures={MESSAGE_PICTURES} onError={setErr}
            onChange={(v) => { setHtml(v.html); setText(v.text); touch(); }} />
          {atts.length > 0 && (
            <div className="att-list">
              {atts.map((a) => (
                <span className={`att${a.error ? " err" : ""}`} key={a.key} title={a.error ?? a.filename}>
                  <Icon name="paperclip" size={14} />
                  <span className="att-name">{a.filename}</span>
                  <span className="hint">{a.error ? "failed" : fmtSize(a.size)}</span>
                  <button type="button" className="btn icon sm ghost" aria-label={`Remove ${a.filename}`} onClick={() => removeAtt(a)}><Icon name="x" size={13} /></button>
                  {!a.id && !a.error && <span className="att-bar" style={{ width: `${Math.round(a.progress * 100)}%` }} />}
                </span>
              ))}
            </div>
          )}
          {(secOpen || wants) && (
            <div className="sec-box">
              <div className="sec-opts">
                <label className="check-row"><input type="checkbox" checked={sec.sign} onChange={() => toggle("sign")} /><span><b>Sign</b> <span className="hint">proves it is from you</span></span></label>
                <label className="check-row"><input type="checkbox" checked={sec.encrypt} onChange={() => toggle("encrypt")} /><span><b>Encrypt</b> <span className="hint">only the recipients can read it</span></span></label>
                <div className="seg" role="group" aria-label="Type" style={{ marginLeft: "auto" }}>
                  {(["smime", "pgp"] as const).map((p) => <button key={p} type="button" className={sec.protocol === p ? "on" : ""} onClick={() => setSec({ ...sec, protocol: p })} title={`${caps ? (signOk(p) ? "You can sign with this" : "No key of this type for your address") : ""}`}>{PNAME[p]}</button>)}
                </div>
              </div>
              {secProblem && <div className="note warning">{secProblem}</div>}
              {wants && !secProblem && caps && (
                <div className="hint" style={{ fontSize: 12.5 }}>
                  {sec.sign && <>Signed as {caps.from} ({PNAME[sec.protocol]}). </>}{sec.encrypt && <>Encrypted for {caps.recipients.map((r) => r.email).join(", ")} and you. {caps.drafts?.[sec.protocol] ? "Drafts are saved encrypted to your own key." : "Drafts are saved on your mail server without encryption."}</>}
                </div>
              )}
            </div>
          )}
          {readReceipt && <div className="hint" style={{ fontSize: 12.5 }}>A read receipt is requested. The recipient's mail program may ask them first, or not send one.</div>}
          {confirm && (
            <div className="note warning">
              {confirm} Send anyway?
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn primary sm" onClick={() => send(true)}>Send anyway</button>
                <button className="btn sm" onClick={() => setConfirm(null)}>Go back</button>
              </div>
            </div>
          )}
          {err && <div className="note error">{err}</div>}
        </div>
        <div className="modal-foot">
          <div className="row">
            <button className="btn primary" disabled={!canSend} onClick={() => send()} title="Send (Ctrl/⌘+Enter)">
              <Icon name="send" size={15} />{busy ? "Sending…" : uploading ? "Uploading…" : "Send"}
            </button>
            <Menu icon="clock" iconOnly label="Send later" items={timeMenu((d) => send(false, d), () => setPickSend(true))} />
            {/* sending | attaching | how the message is written and protected */}
            <label className="btn ghost" style={{ cursor: "pointer" }} title="Attach files (or drop them here)">
              <Icon name="paperclip" size={15} /> Attach<input type="file" multiple hidden onChange={(e) => { attach(e.target.files); e.target.value = ""; }} />
            </label>
            {nc.connected && <button type="button" className="btn ghost" title="Attach a file from your Nextcloud" onClick={() => setPicker(true)}><Icon name="cloud" size={15} /> From Nextcloud</button>}
            <Menu icon="file" iconOnly label="Templates" title="Templates: insert one, or save this message as one" filterable items={[
              ...(templates ?? []).map((t) => ({ label: t.name, onClick: () => applyTemplate(t) })),
              ...(templates && templates.length === 0 ? [{ label: "No templates yet", disabled: true }] : []),
              { label: "", divider: true },
              { label: "Save this message as a template…", icon: "plus" as const, onClick: saveTemplate, disabled: !htmlToPlain(withoutSignature(html)).trim() },
            ]} />
            <button type="button" className={`btn ghost${wants ? " on" : ""}`} aria-pressed={secOpen || wants} onClick={() => setSecOpen(!secOpen)} title="Sign or encrypt this message">
              <Icon name={sec.encrypt ? "lock" : "shield"} size={15} /> {wants ? [sec.sign && "Signed", sec.encrypt && "Encrypted"].filter(Boolean).join(" + ") : "Security"}
            </button>
            <Menu icon="more" iconOnly label="Options" title="More options" align="right" items={[
              { label: "Ask for a read receipt", checked: readReceipt, onClick: () => { setReadReceipt(!readReceipt); touch(); } },
            ]} />
          </div>
          <button className="btn ghost danger" onClick={discard}><Icon name="trash" size={15} /> Discard</button>
        </div>
      </div>
    </div>
  );
}
