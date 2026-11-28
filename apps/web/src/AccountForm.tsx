import { useEffect, useState } from "react";
import { presets, type AccountSummary, type ServerConfig, type TestResult } from "@ncmail/shared";
import { api } from "./api.ts";

interface MailServer { host: string; port: number; security: ServerConfig["security"] }
interface MailPresets {
  allowCustom: boolean; suggested: string | null; user: { uid: string; email: string; name: string };
  servers: { id: string; name: string; domains: string[]; username: "email" | "local" | "uid"; imap: MailServer; smtp: MailServer; sieve?: MailServer }[];
}

const blank = (port: number, security: ServerConfig["security"]): ServerConfig => ({ host: "", port, security, username: "", password: "" });
const fromSummary = (s: AccountSummary["imap"]): ServerConfig => ({ ...s, password: "" });

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function ServerFields({ title, help, v, set, keepPassword }: { title: string; help: string; v: ServerConfig; set: (s: ServerConfig) => void; keepPassword?: boolean }) {
  const f = (k: keyof ServerConfig) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    set({ ...v, [k]: k === "port" ? Number(e.target.value) : e.target.value });
  return (
    <section className="card">
      <h3>{title}</h3>
      <p className="hint" style={{ margin: 0 }}>{help}</p>
      <div className="form-grid g3">
        <Field label="Server"><input aria-label={`${title} server`} placeholder="mail.example.com" value={v.host} onChange={f("host")} /></Field>
        <Field label="Port"><input aria-label={`${title} port`} type="number" value={v.port} onChange={f("port")} /></Field>
        <Field label="Security">
          <select aria-label={`${title} security`} value={v.security} onChange={f("security")}>
            <option value="tls">SSL/TLS</option><option value="starttls">STARTTLS</option><option value="none">None (not recommended)</option>
          </select>
        </Field>
      </div>
      <div className="form-grid g2">
        <Field label="Username"><input aria-label={`${title} username`} value={v.username} onChange={f("username")} autoComplete="off" /></Field>
        <Field label="Password" hint={keepPassword ? "Leave blank to keep the current password" : undefined}>
          <input aria-label={`${title} password`} type="password" autoComplete="new-password" value={v.password} onChange={f("password")} />
        </Field>
      </div>
    </section>
  );
}

export type AccountFormMode = "add" | "details" | "servers";

/**
 * One form, three jobs:
 *  - add:      everything, for a new account
 *  - details:  the account's label and primary address
 *  - servers:  IMAP/SMTP settings (blank passwords keep the stored ones; changes must be tested before saving)
 */
export function AccountForm({ account, mode, onDone, onCancel }: {
  account?: AccountSummary; mode: AccountFormMode; onDone: (a: AccountSummary) => void; onCancel?: () => void;
}) {
  const [label, setLabel] = useState(account?.name ?? "");
  const [senderName, setSenderName] = useState("");
  const [email, setEmail] = useState(account?.email ?? "");
  const [imap, setImap] = useState<ServerConfig>(account ? fromSummary(account.imap) : blank(993, "tls"));
  const [smtp, setSmtp] = useState<ServerConfig>(account ? fromSummary(account.smtp) : blank(465, "tls"));
  const [result, setResult] = useState<TestResult | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  // Servers an administrator set up for this installation: the user then only needs their address and password.
  const [pre, setPre] = useState<MailPresets | null>(null);
  const [pid, setPid] = useState("");
  useEffect(() => {
    if (mode !== "add") return;
    api<MailPresets>("/mail-presets").then((p) => {
      setPre(p);
      setPid(p.suggested ?? (!p.allowCustom ? p.servers[0]?.id ?? "" : ""));
      if (p.user.email) setEmail((e) => e || p.user.email);
      if (p.user.name) setSenderName((n) => n || p.user.name);
    }).catch(() => {});
  }, [mode]);
  const chosen = pre?.servers.find((x) => x.id === pid);
  const loginFor = (c: MailPresets["servers"][number], mail: string) => (c.username === "uid" ? pre!.user.uid : c.username === "local" ? mail.split("@")[0]! : mail);
  useEffect(() => {
    if (!chosen) return;
    setImap((v) => ({ ...v, host: chosen.imap.host, port: chosen.imap.port, security: chosen.imap.security, username: loginFor(chosen, email) }));
    setSmtp((v) => ({ ...v, host: chosen.smtp.host, port: chosen.smtp.port, security: chosen.smtp.security, username: loginFor(chosen, email) }));
  }, [pid, email, pre]); // eslint-disable-line react-hooks/exhaustive-deps

  const showServers = mode !== "details";
  const showIdentity = mode !== "servers";
  // A test result only describes the settings it was run with.
  useEffect(() => setResult(null), [imap, smtp]);

  const connChanged = mode === "add" || (!!account && (["host", "port", "security", "username"] as const).some((k) => imap[k] !== account.imap[k] || smtp[k] !== account.smtp[k])) || !!imap.password || !!smtp.password;
  const tested = !!result?.imap.ok && !!result?.smtp.ok;
  const dirty = mode === "add" || label !== account?.name || email !== account?.email || connChanged;
  const canSave = !!label && !!email && (mode !== "add" || !!senderName) && (!showServers || !connChanged || tested) && dirty;
  const mailboxWillReset = mode === "servers" && account && (imap.host.toLowerCase() !== account.imap.host.toLowerCase() || imap.username.toLowerCase() !== account.imap.username.toLowerCase());

  const preset = (k: string) => {
    const p = presets[k]; if (!p) return;
    setImap({ ...imap, host: p.imap[0], port: p.imap[1], security: "tls" });
    setSmtp({ ...smtp, host: p.smtp[0], port: p.smtp[1], security: p.smtp[1] === 465 ? "tls" : "starttls" });
  };
  // The servers for the address's domain, looked up as mail apps do (its autoconfig file, its DNS records, Thunderbird's list),
  // when no server set up by the administrator applies and the servers are still empty.
  const [lookup, setLookup] = useState<{ state: "busy" | "found" | "none" | "error"; text: string } | null>(null);
  const lookUp = async (mail = email, force = false) => {
    if (mode !== "add" || chosen || !mail.includes("@") || (pre && !pre.allowCustom)) return;
    if (!force && imap.host) return;
    setLookup({ state: "busy", text: `Looking up the mail servers for ${mail.split("@").pop()}…` });
    try {
      const r = await api<{ domain: string; found: null | { source: string; from: string; name?: string; username: "email" | "local"; imap: { host: string; port: number; security: ServerConfig["security"] }; smtp: { host: string; port: number; security: ServerConfig["security"] } } }>(`/mail-presets/lookup?email=${encodeURIComponent(mail)}`);
      if (!r.found) { setLookup({ state: "none", text: `No published settings for ${r.domain}. Choose a provider above or enter the servers below; your mail provider's help pages list them.` }); return; }
      const f = r.found, login = f.username === "local" ? mail.split("@")[0]! : mail;
      setImap((v) => ({ ...v, host: f.imap.host, port: f.imap.port, security: f.imap.security, username: login }));
      setSmtp((v) => ({ ...v, host: f.smtp.host, port: f.smtp.port, security: f.smtp.security, username: login }));
      const from = f.source === "autoconfig" ? `its own settings file (${f.from})` : f.source === "srv" ? "its DNS records" : "Thunderbird's list of mail providers";
      setLookup({ state: "found", text: `Found the servers${f.name ? ` for ${f.name}` : ""} in ${from}. Enter your password and test the connection.` });
    } catch (e: any) { setLookup({ state: "error", text: e.message }); }
  };
  const autofill = () => {
    if (mode !== "add" || chosen) return;
    setImap((s) => ({ ...s, username: s.username || email }));
    setSmtp((s) => ({ ...s, username: s.username || email, password: s.password || imap.password }));
    void lookUp();
  };
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(""); setSaved(false); try { await fn(); } catch (e: any) { setErr(e.message); } setBusy(false); };

  const test = () => run(async () => setResult(await api<TestResult>("/accounts/test", { method: "POST", body: JSON.stringify({ accountId: account?.id, imap, smtp }) })));
  const save = () => run(async () => {
    if (mode === "add") {
      const a = await api<AccountSummary>("/accounts", { method: "POST", body: JSON.stringify({ name: label, senderName, email, imap, smtp }) });
      await api(`/accounts/${a.id}/sync`, { method: "POST" });
      onDone(a);
    } else {
      const a = await api<AccountSummary>(`/accounts/${account!.id}`, { method: "PATCH", body: JSON.stringify({
        name: label, email,
        imap: showServers ? imap : fromSummary(account!.imap), smtp: showServers ? smtp : fromSummary(account!.smtp),
      }) });
      setSaved(true); setResult(null); setImap((s) => ({ ...s, password: "" })); setSmtp((s) => ({ ...s, password: "" }));
      onDone(a);
    }
  });

  return (
    <div className="stack">
      {mode === "add" && !!pre?.servers.length && (
        <div className="field">
          <span className="field-label">Mail servers</span>
          <select aria-label="Mail servers" value={pid} onChange={(e) => setPid(e.target.value)}>
            {pre.allowCustom && <option value="">Other (enter the servers myself)</option>}
            {pre.servers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </div>
      )}
      {mode === "add" && !chosen && (
        <div className="field">
          <span className="field-label">Start from a provider</span>
          <select aria-label="Provider preset" onChange={(e) => preset(e.target.value)} defaultValue="">
            <option value="" disabled>Choose a provider to fill in the servers…</option>
            {Object.keys(presets).map((k) => <option key={k}>{k}</option>)}
          </select>
        </div>
      )}

      {showIdentity && (
        <section className="card">
          <h3>{mode === "add" ? "About this account" : "Account"}</h3>
          <div className={`form-grid ${mode === "add" ? "g2" : "g1"}`}>
            <Field label="Account name" hint="Only for you: how this account is labelled in the sidebar and in settings, e.g. “Work”.">
              <input aria-label="Account name" placeholder="Work" value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            {mode === "add" && (
              <Field label="Your name" hint="What recipients see when you send mail, e.g. “Martin Dahl”. You can add more sender addresses and names later.">
                <input aria-label="Your name" placeholder="Martin Dahl" value={senderName} onChange={(e) => setSenderName(e.target.value)} />
              </Field>
            )}
          </div>
          <Field label="Email address" hint={mode === "add" ? "Becomes your first sender address." : "The address you log in with. A matching sender address is updated too."}>
            <input aria-label="Email address" type="email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={autofill} />
          </Field>
        </section>
      )}

      {showServers && chosen && (
        <section className="card">
          <h3>{chosen.name}</h3>
          <p className="hint" style={{ margin: 0 }}>The mail servers are set up for you. Sign in as <b>{imap.username || "…"}</b>.</p>
          <Field label="Password">
            <input aria-label="Mail password" type="password" autoComplete="new-password" value={imap.password} onChange={(e) => { setImap({ ...imap, password: e.target.value }); setSmtp({ ...smtp, password: e.target.value }); }} />
          </Field>
        </section>
      )}
      {showServers && !chosen && mode === "add" && (pre?.allowCustom ?? true) && (
        <div className={`note${lookup?.state === "error" ? " warning" : ""}`} role="status" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ flex: "1 1 260px" }}>{lookup?.text ?? "Enter your email address and the servers are looked up for you, where your provider publishes them."}</span>
          <button className="btn sm" type="button" disabled={lookup?.state === "busy" || !email.includes("@")} onClick={() => lookUp(email, true)}>Look up the servers</button>
        </div>
      )}
      {showServers && !chosen && (
        <>
          <ServerFields title="Incoming mail (IMAP)" help="Where your mail is read from." v={imap} set={setImap} keepPassword={mode !== "add"} />
          <ServerFields title="Outgoing mail (SMTP)" help="Where your mail is sent through." v={smtp} set={setSmtp} keepPassword={mode !== "add"} />
        </>
      )}

      {mailboxWillReset && (
        <div className="note warning">
          You changed the IMAP server or login. This account's local mail index will be rebuilt from the new mailbox. Mail on the servers is not touched.
        </div>
      )}

      <div className="row" style={{ justifyContent: "flex-start", alignItems: "center" }}>
        {showServers && <button className="btn" style={{ flex: "0 0 auto" }} disabled={busy} onClick={test}>{busy ? "Working…" : "Test connection"}</button>}
        <button className="btn primary" style={{ flex: "0 0 auto" }} disabled={busy || !canSave} onClick={save}>
          {mode === "add" ? "Add account" : "Save changes"}
        </button>
        {onCancel && <button className="btn" style={{ flex: "0 0 auto" }} disabled={busy} onClick={onCancel}>Cancel</button>}
        {saved && <span className="hint" style={{ flex: "0 0 auto" }}>✓ Saved</span>}
      </div>
      {showServers && connChanged && !tested && mode !== "add" && <p className="hint" style={{ margin: 0 }}>Test the new connection settings before saving.</p>}
      {showServers && mode === "add" && !tested && <p className="hint" style={{ margin: 0 }}>Test the connection first; Add account unlocks when both servers work.</p>}

      {result && (
        <>
          <div className={`note ${result.imap.ok ? "success" : "error"}`}>
            <b>Incoming (IMAP)</b> {result.imap.ok ? "connected" : `failed: ${result.imap.error}`}
            {result.imap.capabilities && <div className="chips">{Object.entries(result.imap.capabilities).map(([k, v]) => <span key={k} className={`chip${v ? " on" : ""}`}>{k.toUpperCase()}{v ? "" : " ✕"}</span>)}</div>}
          </div>
          <div className={`note ${result.smtp.ok ? "success" : "error"}`}><b>Outgoing (SMTP)</b> {result.smtp.ok ? "connected" : `failed: ${result.smtp.error}`}</div>
        </>
      )}
      {err && <div className="note error">{err}</div>}
    </div>
  );
}
