import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountSummary } from "@ncmail/shared";
import { api } from "./api.ts";
import { Icon } from "./icons.tsx";
import { useToast } from "./ui.tsx";

interface KeyView {
  id: string; kind: "pgp" | "smime"; hasPrivate: boolean; name: string; emails: string[]; fingerprint: string;
  notBefore: string | null; notAfter: string | null; canSign: boolean; canEncrypt: boolean; status: "valid" | "expired" | "not-yet-valid"; info: any;
}
interface KeyList { identities: { identityId: string; name: string; email: string; keys: KeyView[] }[]; contacts: KeyView[]; hidden: number }

const ACCEPT = ".asc,.gpg,.pgp,.key,.pub,.crt,.cer,.pem,.der,.p12,.pfx,.p7b,.p7c";
const fp = (s: string) => (s.length > 24 ? s.slice(-16) : s).replace(/(.{4})/g, "$1 ").trim();
const day = (d: string | null) => (d ? new Date(d).toLocaleDateString([], { dateStyle: "medium" }) : "never");
const toB64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] ?? ""); r.onerror = () => rej(r.error); r.readAsDataURL(f); });

function KeyRow({ k, onDelete }: { k: KeyView; onDelete: () => void }) {
  const [sure, setSure] = useState(false);
  const limits: string[] = k.info?.limitations ?? [];
  return (
    <div className="list-row">
      <div className="list-row-title">
        <Icon name={k.hasPrivate ? "key" : "shield"} size={16} />
        <b>{k.kind === "pgp" ? "PGP key" : "S/MIME certificate"}</b>
        <span className={`chip ${k.status === "valid" ? "ok" : "bad"}`}>{k.status === "valid" ? "Valid" : k.status === "expired" ? "Expired" : "Not valid yet"}</span>
        {k.hasPrivate && k.canSign && <span className="chip on">Signs</span>}
        {k.canEncrypt && <span className="chip on">{k.hasPrivate ? "Decrypts" : "Encrypts"}</span>}
      </div>
      <div className="hint" style={{ marginTop: 2 }}>
        {k.name && <>{k.name} · </>}{k.emails.join(", ")}
        <br />Valid {day(k.notBefore)} to {day(k.notAfter)}{k.info?.issuer ? <> · issued by {String(k.info.issuer)}</> : null}{k.info?.algorithm ? <> · {String(k.info.algorithm)}</> : null}
        <br /><span title={k.fingerprint}>Fingerprint …{fp(k.fingerprint)}</span>
      </div>
      {limits.map((l) => <div key={l} className="note warning" style={{ marginTop: 6 }}>{l}</div>)}
      <div className="row list-row-actions">
        {sure ? (
          <>
            <span className="hint">Remove this {k.hasPrivate ? "key (the private part is deleted from this app)" : "key"}?</span>
            <button className="btn sm danger" onClick={onDelete}>Remove</button>
            <button className="btn sm" onClick={() => setSure(false)}>Keep</button>
          </>
        ) : <button className="btn sm ghost danger" onClick={() => setSure(true)}><Icon name="trash" size={14} /> Remove</button>}
      </div>
    </div>
  );
}

export function SecuritySettings({ account }: { account: AccountSummary }) {
  const toast = useToast();
  const [list, setList] = useState<KeyList | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => api<KeyList>(`/accounts/${account.id}/keys`).then(setList).catch((e) => toast({ kind: "error", message: e.message })), [account.id]);
  useEffect(() => { reload(); }, [reload]);

  const run = async (fs: File[], pw?: string) => {
    if (!fs.length) return;
    setBusy(true); setProblems([]);
    try {
      const r = await api<{ imported: { emails: string[]; kind: string; hasPrivate: boolean }[]; errors: string[]; needsPassword: boolean }>(`/accounts/${account.id}/keys/import`, {
        method: "POST", body: JSON.stringify({ files: await Promise.all(fs.map(async (f) => ({ name: f.name, contentBase64: await toB64(f) }))), password: pw || undefined }),
      });
      setProblems(r.errors); setNeedsPassword(r.needsPassword);
      if (r.imported.length) {
        toast({ kind: "success", message: `Added ${r.imported.length} ${r.imported.length === 1 ? "key" : "keys"}: ${r.imported.map((i) => i.emails[0]).join(", ")}` });
        if (!r.needsPassword) { setFiles([]); setPassword(""); }
        reload();
      }
      if (!r.needsPassword && !r.errors.length) { setFiles([]); setPassword(""); }
      if (r.needsPassword) setFiles(fs);
      else if (r.errors.length && !r.imported.length) setFiles(fs);
    } catch (e: any) { setProblems([e.message]); }
    setBusy(false);
  };
  const pick = (fl: FileList | File[] | null) => { const fs = Array.from(fl ?? []); if (fs.length) { setFiles(fs); setPassword(""); setNeedsPassword(false); run(fs); } };
  const remove = async (id: string) => { await api(`/keys/${id}`, { method: "DELETE" }).catch(() => {}); reload(); };

  return (
    <div className="stack">
      <section className="card">
        <h3>Your keys and certificates</h3>
        <p className="hint" style={{ margin: 0 }}>
          Used to sign your mail (so people know it is from you) and to read mail encrypted for you. Each sender address lists only the keys and certificates
          that were issued for exactly that address.
        </p>
        {!list ? <p className="hint">Loading…</p> : list.identities.map((i) => (
          <div className="subcard" key={i.identityId}>
            <b>{i.name} <span className="hint">&lt;{i.email}&gt;</span></b>
            {i.keys.length === 0
              ? <span className="hint">No key or certificate for this address yet. Add one below.</span>
              : <div className="list">{i.keys.map((k) => <KeyRow key={k.id} k={k} onDelete={() => remove(k.id)} />)}</div>}
          </div>
        ))}
        {list && list.hidden > 0 && <div className="note">{list.hidden} {list.hidden === 1 ? "key is" : "keys are"} hidden because {list.hidden === 1 ? "its address is" : "their addresses are"} no longer one of your sender addresses.</div>}
      </section>

      <section className="card">
        <h3>Add a key or certificate</h3>
        <label className={`dropzone${over ? " over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files); }}>
          <Icon name="upload" size={22} />
          <b>{busy ? "Reading…" : "Choose files, or drop them here"}</b>
          <span className="hint">PGP: .asc .gpg .pgp .key .pub &nbsp;·&nbsp; S/MIME: .p12 .pfx .pem .crt .cer .der .p7b</span>
          <input ref={input} type="file" multiple accept={ACCEPT} hidden onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
        </label>
        {files.length > 0 && <div className="chips">{files.map((f, i) => <span key={i} className="chip"><Icon name="file" size={12} />{f.name}</span>)}</div>}
        {needsPassword && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); run(files, password); }}>
            <input type="password" aria-label="Password or passphrase" placeholder="Password or passphrase of the file" value={password} autoFocus onChange={(e) => setPassword(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
            <button className="btn primary" disabled={busy || !password}>Unlock and add</button>
          </form>
        )}
        {problems.map((p, i) => <div key={i} className="note error">{p}</div>)}
        <details>
          <summary className="hint" style={{ cursor: "pointer" }}>Which files can I use, and what happens to them?</summary>
          <ul className="hint" style={{ margin: "8px 0 0", paddingLeft: 18, display: "grid", gap: 4 }}>
            <li><b>S/MIME:</b> a PKCS#12 file (.p12 or .pfx) holds the certificate and its private key in one file. You can also select a certificate (.crt .cer .pem .der) together with its separate private key (.key .pem); they are matched up for you. Certificate bundles (.p7b .p7c) add other people's certificates.</li>
            <li><b>PGP:</b> ASCII-armored (.asc) or binary (.gpg .pgp) key files, for a single key or a whole keyring. A passphrase-protected key asks for its passphrase once and is stored without it.</li>
            <li>A key with a <b>private part</b> must belong to one of this account's sender addresses. Keys without a private part (other people's public keys and certificates) can be added for any address, and are used to encrypt mail to them and to check their signatures.</li>
            <li>Private keys are stored encrypted on the server with its <code>SECRET_KEY</code>, like your mail passwords. S/MIME signing and encryption need RSA certificates; ECDSA certificates can still be used to check signatures.</li>
          </ul>
        </details>
      </section>

      <section className="card">
        <h3>Other people's keys</h3>
        <p className="hint" style={{ margin: 0 }}>Public keys and certificates of the people you write to. They let you encrypt to them and check their signatures. A certificate in a signed message can be kept with one click when you open that message.</p>
        {list && list.contacts.length === 0 && <p className="hint">None yet.</p>}
        {list && list.contacts.length > 0 && <div className="list">{list.contacts.map((k) => <KeyRow key={k.id} k={k} onDelete={() => remove(k.id)} />)}</div>}
      </section>
    </div>
  );
}
