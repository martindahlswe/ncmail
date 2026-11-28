import { useEffect, useState } from "react";
import type { AccountSummary } from "@ncmail/shared";
import { api, folderPath, sortFolders, type Folder } from "./api.ts";
import { load as cload } from "./cache.ts";
import { useLabels } from "./labels.ts";
import { Icon } from "./icons.tsx";
import { useToast } from "./ui.tsx";

type Cond = { field: string; op: string; value: string };
type Act = { type: string; value: string };
interface Rule { id: string; name: string; enabled: boolean; match: "all" | "any"; conditions: Cond[]; actions: Act[] }
interface Config { vacation: { enabled: boolean; subject: string; body: string; days: number; from?: string; to?: string }; rules: Rule[] }
interface State { available: boolean; error?: string; connection: { host: string; port: number; security: string; separate: boolean; username: string }; config?: Config; oursActive?: boolean; hasOurs?: boolean; otherActive?: string; ownAddresses?: string[] }

const FIELDS: [string, string][] = [["from", "From"], ["to", "To"], ["cc", "Cc"], ["subject", "Subject"], ["list-id", "Mailing list"], ["size", "Size"]];
const OPS: [string, string][] = [["contains", "contains"], ["is", "is exactly"], ["not-contains", "does not contain"], ["starts-with", "starts with"], ["ends-with", "ends with"]];
const ACTS: [string, string][] = [["move", "Move to folder"], ["read", "Mark as read"], ["star", "Star it"], ["label", "Add label"], ["forward", "Send a copy to"], ["discard", "Delete it"], ["stop", "Stop here"]];
const newRule = (): Rule => ({ id: Math.random().toString(36).slice(2, 10), name: "", enabled: true, match: "all", conditions: [{ field: "from", op: "contains", value: "" }], actions: [{ type: "move", value: "" }] });

export function FilterSettings({ account }: { account: AccountSummary }) {
  const toast = useToast();
  const { labels } = useLabels(account.id);
  const [st, setSt] = useState<State | null>(null);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [busy, setBusy] = useState(false), [err, setErr] = useState(""), [script, setScript] = useState("");
  const [conn, setConn] = useState({ host: "", port: 4190, security: "starttls", separate: false, username: "", password: "" });

  const load = () => api<State>(`/accounts/${account.id}/sieve`).then((s) => { setSt(s); setConn({ host: s.connection.host, port: s.connection.port, security: s.connection.security, separate: s.connection.separate, username: s.connection.username, password: "" }); if (s.config) setCfg(s.config); });
  useEffect(() => { load(); cload<Folder[]>(`/accounts/${account.id}/folders`).then(setFolders).catch(() => {}); }, [account.id]);

  const save = async () => {
    if (cfg) {
      const bad = cfg.rules.find((r) => r.enabled && (r.conditions.some((c) => !c.value.trim()) || r.actions.some((a) => (a.type === "move" || a.type === "label" || a.type === "forward") && !a.value.trim())));
      if (bad) { setErr(`Rule "${bad.name || "(unnamed)"}" is not finished: fill in every condition, and choose the folder, label or address for each action.`); return; }
      if (cfg.vacation.enabled && !cfg.vacation.body.trim()) { setErr("Write the message for the out-of-office reply, or switch it off."); return; }
    }
    setBusy(true); setErr("");
    try { const r = await api<{ script: string }>(`/accounts/${account.id}/sieve`, { method: "PUT", body: JSON.stringify(cfg) }); setScript(r.script); toast({ kind: "success", message: "Saved and switched on at your mail server" }); await load(); }
    catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const saveConn = async () => {
    setErr("");
    try { await api(`/accounts/${account.id}/sieve/connection`, { method: "PUT", body: JSON.stringify({ host: conn.host, port: conn.port, security: conn.security, useImapLogin: !conn.separate, username: conn.username, password: conn.password || undefined }) }); setConn((c) => ({ ...c, password: "" })); await load(); }
    catch (e: any) { setErr(e.message); }
  };
  if (!st) return <p className="hint">Connecting to your mail server…</p>;

  const connForm = (
    <div className="form-grid g1">
    <div className="form-grid g3">
      <label className="field"><span className="field-label">Server</span><input value={conn.host} placeholder="Same as your IMAP server" onChange={(e) => setConn({ ...conn, host: e.target.value })} /></label>
      <label className="field"><span className="field-label">Port</span><input type="number" value={conn.port} onChange={(e) => setConn({ ...conn, port: Number(e.target.value) })} /></label>
      <label className="field"><span className="field-label">Security</span><select value={conn.security} onChange={(e) => setConn({ ...conn, security: e.target.value })}><option value="starttls">STARTTLS</option><option value="tls">SSL/TLS</option><option value="none">None</option></select></label>
    </div>
      <div className="field">
        <span className="field-label">Log in to the Sieve service with</span>
        <label className="check-row"><input type="radio" name="sieve-login" checked={!conn.separate} onChange={() => setConn({ ...conn, separate: false })} /><span>My mail login <span className="field-hint">The same user name and password as for reading mail ({account.imap.username}).</span></span></label>
        <label className="check-row"><input type="radio" name="sieve-login" checked={conn.separate} onChange={() => setConn({ ...conn, separate: true })} /><span>A separate login <span className="field-hint">For servers where filters use their own user name or password.</span></span></label>
      </div>
      {conn.separate && (
        <div className="form-grid g2">
          <label className="field"><span className="field-label">User name</span><input value={conn.username} autoComplete="off" onChange={(e) => setConn({ ...conn, username: e.target.value })} /></label>
          <label className="field"><span className="field-label">Password</span><input type="password" value={conn.password} autoComplete="new-password" placeholder={st.connection.separate ? "Unchanged" : ""} onChange={(e) => setConn({ ...conn, password: e.target.value })} /></label>
        </div>
      )}
    </div>
  );
  if (!st.available || !cfg) return (
    <div className="stack"><section className="card">
      <h3>Filters are not available</h3>
      <p className="hint" style={{ margin: 0 }}>Filters and the out-of-office reply run on your mail server, using its Sieve service (ManageSieve, usually port 4190). {st.error}</p>
      {connForm}
      <div><button className="btn" onClick={saveConn}>Try again</button></div>
    </section></div>
  );

  const setRule = (i: number, r: Rule) => setCfg({ ...cfg, rules: cfg.rules.map((x, j) => (j === i ? r : x)) });
  const move = (i: number, d: number) => { const rs = [...cfg.rules]; const [x] = rs.splice(i, 1); rs.splice(i + d, 0, x!); setCfg({ ...cfg, rules: rs }); };
  const v = cfg.vacation;
  const picks = folders.filter((f) => f.selectable);

  return (
    <div className="stack">
      {st.otherActive && <div className="note warning">Another filter script, <b>{st.otherActive}</b>, is active on your mail server. Saving here switches it off and uses the rules below instead.</div>}
      <section className="card">
        <h3>Out of office {v.enabled && <span className="chip ok" style={{ marginLeft: 8 }}>On</span>}</h3>
        <label className="check-row"><input type="checkbox" checked={v.enabled} onChange={(e) => setCfg({ ...cfg, vacation: { ...v, enabled: e.target.checked } })} /><span><b>Reply automatically to people who write to me</b><span className="field-hint">Each sender gets one reply every few days, and mailing lists and automated mail are skipped. It keeps working while this app is closed.</span></span></label>
        {v.enabled && (
          <div className="form-grid g1">
            <label className="field"><span className="field-label">Subject</span><input value={v.subject} placeholder="Out of office" onChange={(e) => setCfg({ ...cfg, vacation: { ...v, subject: e.target.value } })} /></label>
            <label className="field"><span className="field-label">Message</span><textarea rows={5} value={v.body} placeholder="Thank you for your email. I am away until ... and will reply when I am back." onChange={(e) => setCfg({ ...cfg, vacation: { ...v, body: e.target.value } })} /></label>
            <div className="form-grid g3">
              <label className="field"><span className="field-label">From (optional)</span><input type="date" value={v.from ?? ""} onChange={(e) => setCfg({ ...cfg, vacation: { ...v, from: e.target.value || undefined } })} /></label>
              <label className="field"><span className="field-label">Until (optional)</span><input type="date" value={v.to ?? ""} onChange={(e) => setCfg({ ...cfg, vacation: { ...v, to: e.target.value || undefined } })} /></label>
              <label className="field"><span className="field-label">Reply again after</span><select value={v.days} onChange={(e) => setCfg({ ...cfg, vacation: { ...v, days: Number(e.target.value) } })}>{[1, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} {d === 1 ? "day" : "days"}</option>)}</select></label>
            </div>
            <span className="field-hint">Answers mail sent to {st.ownAddresses?.join(", ")}. Dates use the mail server's time zone.</span>
          </div>
        )}
      </section>

      <section className="card">
        <h3>Filter rules</h3>
        <p className="hint" style={{ margin: 0 }}>Rules run on your mail server as mail arrives, from top to bottom. A message that is moved to a folder does not go on to the rules below it.</p>
        {cfg.rules.length === 0 && <p className="hint">No rules yet.</p>}
        {cfg.rules.map((r, i) => (
          <div className="subcard" key={r.id}>
            <div className="row">
              <input type="checkbox" aria-label="Rule is on" checked={r.enabled} onChange={(e) => setRule(i, { ...r, enabled: e.target.checked })} />
              <input aria-label="Rule name" placeholder="Name this rule" value={r.name} onChange={(e) => setRule(i, { ...r, name: e.target.value })} style={{ flex: 1, minWidth: 140 }} />
              <button className="btn icon sm ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="arrowUp" size={14} /></button>
              <button className="btn icon sm ghost" aria-label="Move down" disabled={i === cfg.rules.length - 1} onClick={() => move(i, 1)}><Icon name="arrowDown" size={14} /></button>
              <button className="btn icon sm ghost danger" aria-label="Remove rule" onClick={() => setCfg({ ...cfg, rules: cfg.rules.filter((_, j) => j !== i) })}><Icon name="trash" size={14} /></button>
            </div>
            <div className="row"><b>When</b>
              <select aria-label="Match" value={r.match} onChange={(e) => setRule(i, { ...r, match: e.target.value as "all" | "any" })}><option value="all">all of these</option><option value="any">any of these</option></select><span>match:</span></div>
            {r.conditions.map((c, k) => (
              <div className="row" key={k}>
                <select aria-label="Field" value={c.field} onChange={(e) => setRule(i, { ...r, conditions: r.conditions.map((x, j) => (j === k ? { ...x, field: e.target.value, op: e.target.value === "size" ? "over" : x.op === "over" ? "contains" : x.op } : x)) })}>{FIELDS.map(([a, b]) => <option key={a} value={a}>{b}</option>)}</select>
                {c.field === "size" ? <span>is over</span> : <select aria-label="Test" value={c.op} onChange={(e) => setRule(i, { ...r, conditions: r.conditions.map((x, j) => (j === k ? { ...x, op: e.target.value } : x)) })}>{OPS.map(([a, b]) => <option key={a} value={a}>{b}</option>)}</select>}
                <input aria-label="Value" placeholder={c.field === "size" ? "MB" : "text"} value={c.value} style={{ flex: 1, minWidth: 120 }} onChange={(e) => setRule(i, { ...r, conditions: r.conditions.map((x, j) => (j === k ? { ...x, value: e.target.value } : x)) })} />
                {c.field === "size" && <span>MB</span>}
                {r.conditions.length > 1 && <button className="btn icon sm ghost" aria-label="Remove condition" onClick={() => setRule(i, { ...r, conditions: r.conditions.filter((_, j) => j !== k) })}><Icon name="x" size={13} /></button>}
              </div>
            ))}
            <div><button className="btn link" onClick={() => setRule(i, { ...r, conditions: [...r.conditions, { field: "subject", op: "contains", value: "" }] })}>+ Add a condition</button></div>
            <div className="row"><b>Then</b></div>
            {r.actions.map((a, k) => (
              <div className="row" key={k}>
                <select aria-label="Action" value={a.type} onChange={(e) => setRule(i, { ...r, actions: r.actions.map((x, j) => (j === k ? { type: e.target.value, value: "" } : x)) })}>{ACTS.map(([x, y]) => <option key={x} value={x}>{y}</option>)}</select>
                {a.type === "move" && <select aria-label="Folder" value={a.value} onChange={(e) => setRule(i, { ...r, actions: r.actions.map((x, j) => (j === k ? { ...x, value: e.target.value } : x)) })}><option value="">Choose a folder…</option>{sortFolders(picks).map((f) => <option key={f.id} value={f.path}>{folderPath(f)}</option>)}</select>}
                {a.type === "label" && <select aria-label="Label" value={a.value} onChange={(e) => setRule(i, { ...r, actions: r.actions.map((x, j) => (j === k ? { ...x, value: e.target.value } : x)) })}><option value="">Choose a label…</option>{labels.map((l) => <option key={l.slug} value={l.slug}>{l.name}</option>)}</select>}
                {a.type === "forward" && <span className="muted" style={{ flexBasis: "100%", fontSize: 12 }}>Matching mail will be copied to another address automatically. Only add addresses you control or trust.</span>}
                {a.type === "forward" && <input aria-label="Address" type="email" placeholder="name@example.com" value={a.value} onChange={(e) => setRule(i, { ...r, actions: r.actions.map((x, j) => (j === k ? { ...x, value: e.target.value } : x)) })} style={{ flex: 1 }} />}
                {r.actions.length > 1 && <button className="btn icon sm ghost" aria-label="Remove action" onClick={() => setRule(i, { ...r, actions: r.actions.filter((_, j) => j !== k) })}><Icon name="x" size={13} /></button>}
              </div>
            ))}
            <div><button className="btn link" onClick={() => setRule(i, { ...r, actions: [...r.actions, { type: "read", value: "" }] })}>+ Add an action</button></div>
          </div>
        ))}
        <div><button className="btn" onClick={() => setCfg({ ...cfg, rules: [...cfg.rules, newRule()] })}><Icon name="plus" size={14} /> Add a rule</button></div>
      </section>

      {err && <div className="note error">{err}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? "Saving…" : st.oursActive ? "Save changes" : "Save and switch on"}</button>
        {st.oursActive && <button className="btn" onClick={async () => { await api(`/accounts/${account.id}/sieve/disable`, { method: "POST" }); toast({ message: "Filters are switched off" }); load(); }}>Switch off</button>}
        <button className="btn link" onClick={async () => setScript((await api<{ script: string }>(`/accounts/${account.id}/sieve/script`)).script)}>Show the Sieve script</button>
      </div>
      {script && <pre className="source card" style={{ overflow: "auto" }}>{script}</pre>}
      <details><summary className="hint" style={{ cursor: "pointer" }}>Connection to the Sieve service</summary><div style={{ marginTop: 8 }}>{connForm}<div style={{ marginTop: 8 }}><button className="btn sm" onClick={saveConn}>Save connection</button></div></div></details>
    </div>
  );
}
