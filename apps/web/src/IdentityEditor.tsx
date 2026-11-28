import { useEffect, useRef, useState } from "react";
import type { AccountSummary, Identity } from "@ncmail/shared";
import { api, htmlToPlain, textToHtml } from "./api.ts";
import { RichEditor } from "./RichEditor.tsx";
import { signatureFrame, signaturePlain } from "./htmlSignature.ts";
import { SIGNATURE_PICTURES } from "./pictures.ts";
import { Field } from "./AccountForm.tsx";

/** A live preview of an HTML signature, in a frame where nothing can run (as it appears in messages). */
function SignaturePreview({ html }: { html: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => { box.current?.replaceChildren(signatureFrame(html, "Signature preview")); }, 250);
    return () => clearTimeout(t);
  }, [html]);
  return <div ref={box} className="html-sig html-sig-preview" />;
}

/**
 * Signature for one sender address: rich (HTML) plus an optional plain-text version for the text part of emails. The rich
 * one is written in the editor, or entered as HTML (pasted from a signature generator or another mail program), which is
 * kept exactly as it is because the editor would simplify tables and styles.
 */
function SignatureEditor({ identity, base, onSaved, onCancel }: { identity: Identity; base: string; onSaved: () => void; onCancel: () => void }) {
  const [html, setHtml] = useState(identity.signatureHtml || (identity.signatureText ? textToHtml(identity.signatureText) : ""));
  const [asHtml, setAsHtml] = useState(!!identity.signatureIsHtml);
  const [pasted, setPasted] = useState(false);
  const [editorKey, setEditorKey] = useState(0); // remounts the editor when switching back to it with new content
  const [text, setText] = useState(identity.signatureText);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async () => {
    setBusy(true); setErr("");
    try {
      const empty = !htmlToPlain(html).trim() && !/<img\b/i.test(html);
      await api(`${base}/${identity.id}`, { method: "PATCH", body: JSON.stringify({ signatureHtml: empty ? "" : html, signatureIsHtml: asHtml && !empty, signatureText: text.trim() ? text : "" }) });
      onSaved();
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  const toEditor = () => { setAsHtml(false); setPasted(false); setEditorKey((k) => k + 1); };
  return (
    <div className="subcard">
      <h4>Signature for {identity.email}</h4>
      <div className="field-label">Rich signature <span className="field-hint">{asHtml
        ? "(HTML, used in HTML emails exactly as shown below; scripts and forms are removed when you save)"
        : "(used in HTML emails; a small picture such as a logo is fine, big ones are made smaller; paste HTML to use it as it is)"}</span></div>
      {asHtml ? (
        <>
          {pasted && <div className="note">Pasted as HTML, so its layout is kept. The preview shows how it looks in your emails.</div>}
          <textarea aria-label="Signature HTML" className="code" rows={8} spellCheck={false} value={html} onChange={(e) => { setHtml(e.target.value); setPasted(false); }} placeholder="<table>…</table>" />
          <div className="field-label" style={{ marginTop: 6 }}>Preview</div>
          <SignaturePreview html={html} />
        </>
      ) : (
        <RichEditor key={editorKey} compact initialHtml={html || "<p></p>"} onChange={(v) => setHtml(v.html)} pictures={SIGNATURE_PICTURES} onError={setErr}
          onPasteHtml={(h) => { setHtml(h); setAsHtml(true); setPasted(true); return true; }} />
      )}
      <div className="row" style={{ justifyContent: "flex-start", marginTop: 4 }}>
        {asHtml
          ? <button className="btn sm" type="button" onClick={toEditor} title="The editor keeps text, links, lists and pictures; tables, colours and fonts are lost">Use the editor instead</button>
          : <button className="btn sm" type="button" onClick={() => setAsHtml(true)}>Edit as HTML</button>}
      </div>
      <div className="field-label" style={{ marginTop: 6 }}>Plain-text signature <span className="field-hint">(used for the plain-text part of every email)</span></div>
      <textarea aria-label="Plain-text signature" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Leave blank to generate it from the rich signature" />
      <div className="row" style={{ justifyContent: "flex-start" }}>
        <button className="btn" style={{ flex: "0 0 auto" }} type="button" onClick={() => setText(signaturePlain(html))}>Fill from rich signature</button>
        <button className="btn primary" style={{ flex: "0 0 auto" }} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save signature"}</button>
        <button className="btn" style={{ flex: "0 0 auto" }} disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {err && <div className="note error">{err}</div>}
    </div>
  );
}

/** Edit the name recipients see, and the address, of one sender address. */
function IdentityDetails({ identity, base, onSaved, onCancel }: { identity: Identity; base: string; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(identity.name);
  const [email, setEmail] = useState(identity.email);
  const [replyTo, setReplyTo] = useState(identity.replyTo);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async () => {
    setBusy(true); setErr("");
    try { await api(`${base}/${identity.id}`, { method: "PATCH", body: JSON.stringify({ name, email, replyTo: replyTo.trim() }) }); onSaved(); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className="subcard">
      <div className="form-grid g2">
        <Field label="Name shown to recipients" hint="Appears in the From line of mail you send from this address."><input aria-label="Name shown to recipients" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Email address" hint="Your mail server must allow you to send as this address."><input aria-label="Sender email address" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Reply-To address" hint="Optional. Leave blank to get replies at the address above."><input aria-label="Reply-To address" type="email" placeholder={email} value={replyTo} onChange={(e) => setReplyTo(e.target.value)} /></Field>
      </div>
      <div className="row" style={{ justifyContent: "flex-start" }}>
        <button className="btn primary" style={{ flex: "0 0 auto" }} disabled={busy || !name.trim() || !email.includes("@") || (!!replyTo.trim() && !replyTo.includes("@"))} onClick={save}>Save</button>
        <button className="btn" style={{ flex: "0 0 auto" }} disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {err && <div className="note error">{err}</div>}
    </div>
  );
}

/** All sender addresses of an account: names, default, signatures, add and remove. */
export function IdentityEditor({ account, onChanged }: { account: AccountSummary; onChanged: () => void }) {
  const first = account.identities.find((i) => i.isDefault) ?? account.identities[0];
  const [name, setName] = useState(first?.name ?? account.name);
  const [email, setEmail] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ id: string; what: "details" | "signature" } | null>(null);
  const base = `/accounts/${account.id}/identities`;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr("");
    try { await fn(); onChanged(); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const done = () => { setOpen(null); onChanged(); };

  return (
    <div className="stack">
      <section className="card">
        <h3>Sender addresses</h3>
        <p className="hint" style={{ margin: 0 }}>
          You can send mail from each of these. The <b>default</b> is preselected when you write a new message; you can pick another in the From line of the composer.
          Each address has its own name, signature and optional Reply-To address.
        </p>
        <div className="list">
          {account.identities.map((i) => (
            <div key={i.id} className="list-row">
              <div className="list-row-main">
                <div className="list-row-title">
                  <b>{i.name}</b> <span className="hint">&lt;{i.email}&gt;</span>
                  {i.isDefault && <span className="chip on">Default</span>}
                  {(i.signatureHtml || i.signatureText) && <span className="chip">Signature</span>}
                </div>
                {i.replyTo && <div className="hint">Replies go to {i.replyTo}</div>}
                <div className="row list-row-actions">
                  <button className="btn sm" onClick={() => setOpen(open?.id === i.id && open.what === "details" ? null : { id: i.id, what: "details" })}>Edit name / address</button>
                  <button className="btn sm" onClick={() => setOpen(open?.id === i.id && open.what === "signature" ? null : { id: i.id, what: "signature" })}>
                    {i.signatureHtml || i.signatureText ? "Edit signature" : "Add signature"}
                  </button>
                  {!i.isDefault && <button className="btn sm" disabled={busy} onClick={() => run(() => api(`${base}/${i.id}`, { method: "PATCH", body: JSON.stringify({ isDefault: true }) }))}>Make default</button>}
                  {account.identities.length > 1 && <button className="btn sm danger" disabled={busy} onClick={() => run(() => api(`${base}/${i.id}`, { method: "DELETE" }))}>Remove</button>}
                </div>
                {open?.id === i.id && open.what === "details" && <IdentityDetails identity={i} base={base} onSaved={done} onCancel={() => setOpen(null)} />}
                {open?.id === i.id && open.what === "signature" && <SignatureEditor identity={i} base={base} onSaved={done} onCancel={() => setOpen(null)} />}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>Add another sender address</h3>
        <div className="form-grid g2">
          <Field label="Name shown to recipients"><input aria-label="New sender name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Email address" hint="An alias or another address you may send as."><input aria-label="New sender address" type="email" placeholder="alias@example.com" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Reply-To address" hint="Optional. Leave blank to get replies at the address above."><input aria-label="New Reply-To address" type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} /></Field>
        </div>
        <div>
          <button className="btn primary" disabled={busy || !email.includes("@") || !name.trim() || (!!replyTo.trim() && !replyTo.includes("@"))}
            onClick={() => run(async () => { await api(base, { method: "POST", body: JSON.stringify({ name, email, replyTo: replyTo.trim() }) }); setEmail(""); setReplyTo(""); })}>Add address</button>
        </div>
        <p className="hint" style={{ margin: 0, fontSize: 13 }}>If your mail server does not allow you to send as an address, it will reject mail sent from it.</p>
        {err && <div className="note error">{err}</div>}
      </section>
    </div>
  );
}
