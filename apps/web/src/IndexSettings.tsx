import { useEffect, useState } from "react";
import type { AccountSummary } from "@ncmail/shared";
import { api } from "./api.ts";
import { useToast } from "./ui.tsx";

const WINDOWS: [number | "default", string][] = [["default", "Recommended (the last 2 years)"], [6, "The last 6 months"], [12, "The last year"], [36, "The last 3 years"], [0, "Everything"]];

/** How much mail the first sync brings in. Older mail stays on the server: it is searched there, and can be loaded any time. */
function SyncWindow({ account }: { account: AccountSummary }) {
  const toast = useToast();
  const [st, setSt] = useState<{ months: number | null; default: number; olderOnServer: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api<NonNullable<typeof st>>(`/accounts/${account.id}/sync-window`).then(setSt).catch(() => {});
  useEffect(() => { load(); }, [account.id]);
  const value = st?.months == null ? "default" : String(st.months);
  const save = async (v: string, loadNow = false) => {
    setBusy(true);
    try {
      await api(`/accounts/${account.id}/sync-window`, { method: "PUT", body: JSON.stringify({ months: v === "default" ? null : Number(v), loadNow }) });
      toast({ kind: "success", message: loadNow ? "Loading older mail in the background" : "Saved" });
      await load();
    } catch (e: any) { toast({ kind: "error", message: e.message }); }
    setBusy(false);
  };
  return (
    <section className="card">
      <h3>How much mail to keep in sync</h3>
      <p className="hint" style={{ margin: 0 }}>
        The first time a folder is opened, only recent mail is copied into this app, so a huge mailbox is ready in moments and does not slow the mail server.
        Older mail stays on the server: searching still finds it (the newest matches are added as you search), and you can load it at any time.
      </p>
      <label className="field"><span className="field-label">When a folder is first synced, bring in</span>
        <select value={value} disabled={busy || !st} onChange={(e) => save(e.target.value)} style={{ maxWidth: 320 }}>
          {WINDOWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <span className="field-hint">Applies to folders that have not been synced yet. Folders that are already synced keep what they have.</span></label>
      {st && st.olderOnServer > 0 && (
        <div className="row">
          <span className="hint">{st.olderOnServer.toLocaleString()} older messages are still only on the server.</span>
          <button className="btn" disabled={busy} onClick={() => save(value, true)}>Load them all now</button>
        </div>
      )}
    </section>
  );
}

/** Opt-in local index of message text: toggle, progress, and what it does. */
export function IndexSettings({ account, onChanged }: { account: AccountSummary; onChanged: () => void }) {
  const [st, setSt] = useState<{ enabled: boolean; total: number; indexed: number; running: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [err, setErr] = useState("");
  const load = () => api<NonNullable<typeof st>>(`/accounts/${account.id}/index`).then(setSt).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [account.id]);

  const set = async (enabled: boolean) => {
    setBusy(true); setErr("");
    try { setSt(await api(`/accounts/${account.id}/index`, { method: "PATCH", body: JSON.stringify({ enabled }) })); onChanged(); }
    catch (e: any) { setErr(e.message); }
    setBusy(false); setConfirmOff(false);
  };
  const pct = st && st.total ? Math.floor((st.indexed / st.total) * 100) : 0;

  return (
    <div className="stack">
    <SyncWindow account={account} />
    <section className="card">
      <h3>Search inside message text</h3>
      <p className="hint" style={{ margin: 0 }}>
        Search always covers sender, recipients and subject. Turn this on to also search inside message text, instantly.
        Each message is downloaded once (read-only, nothing is marked as read) and a word index is stored in this app's database. Junk and Trash are skipped.
      </p>
      {st?.enabled ? (
        <>
          <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${pct}%` }} /></div>
          <div className="hint">
            {st.indexed.toLocaleString()} of {st.total.toLocaleString()} messages indexed ({pct}%)
            {st.indexed < st.total ? (st.running ? " · working…" : " · waiting for the next run") : " · up to date"}
          </div>
          {confirmOff ? (
            <div className="note warning">
              Turn off and delete this account's text index? Searching message text will need the server again until you turn it back on.
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn danger" style={{ flex: "0 0 auto" }} disabled={busy} onClick={() => set(false)}>Turn off and delete</button>
                <button className="btn" style={{ flex: "0 0 auto" }} onClick={() => setConfirmOff(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div><button className="btn" onClick={() => setConfirmOff(true)}>Turn off…</button></div>
          )}
        </>
      ) : (
        <div><button className="btn primary" disabled={busy || !st} onClick={() => set(true)}>{busy ? "Starting…" : "Turn on message text index"}</button></div>
      )}
      {err && <div className="note error">{err}</div>}
    </section>
    </div>
  );
}
