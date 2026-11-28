import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { refreshNc, useNc } from "./nc.ts";
import { Icon } from "./icons.tsx";
import { useToast } from "./ui.tsx";

export function NextcloudSettings() {
  const nc = useNc();
  const toast = useToast();
  const [busy, setBusy] = useState(false), [err, setErr] = useState(""), [waiting, setWaiting] = useState(false);
  const [manual, setManual] = useState(false), [user, setUser] = useState(""), [pw, setPw] = useState("");
  const [contacts, setContacts] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  useEffect(() => () => clearInterval(timer.current), []);

  const connect = async () => {
    setErr(""); setBusy(true);
    try {
      const { id, loginUrl } = await api<{ id: string; loginUrl: string }>("/nextcloud/connect", { method: "POST" });
      window.open(loginUrl, "_blank", "noopener");
      setWaiting(true);
      let tries = 0;
      timer.current = setInterval(async () => {
        if (++tries > 600) { clearInterval(timer.current); setWaiting(false); setErr("The sign-in took too long. Try again."); return; }
        try { const r = await api<{ connected: boolean }>("/nextcloud/connect/poll", { method: "POST", body: JSON.stringify({ id }) }); if (r.connected) { clearInterval(timer.current); setWaiting(false); await refreshNc(); toast({ kind: "success", message: "Connected to Nextcloud" }); } }
        catch (e: any) { clearInterval(timer.current); setWaiting(false); setErr(e.message); }
      }, 2000);
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const withPassword = async () => {
    setErr(""); setBusy(true);
    try { await api("/nextcloud/connect-password", { method: "POST", body: JSON.stringify({ username: user, password: pw }) }); setPw(""); await refreshNc(); toast({ kind: "success", message: "Connected to Nextcloud" }); }
    catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const disconnect = async () => { await api("/nextcloud", { method: "DELETE" }); setContacts(null); await refreshNc(); };
  const sync = async () => { setBusy(true); try { setContacts((await api<{ contacts: number }>("/nextcloud/contacts/sync", { method: "POST" })).contacts); } catch (e: any) { setErr(e.message); } setBusy(false); };

  return (
    <div className="stack">
      <section className="card">
        <h3>Connection {nc.connected && <span className="chip ok" style={{ marginLeft: 8 }}>Connected as {nc.user}</span>}</h3>
        <p className="hint" style={{ margin: 0 }}>
          Connecting lets Mail use your Nextcloud <b>Contacts</b> (suggestions while you type, and "Add to contacts") and <b>Files</b> (attach a file from Nextcloud, or save an attachment to it).
          Nextcloud gives Mail an app password, not your own, and you can revoke it any time under Nextcloud settings → Security.
        </p>
        {nc.connected ? (
          <div className="row">
            <button className="btn" disabled={busy} onClick={sync}><Icon name="refresh" size={14} /> Refresh contacts</button>
            <button className="btn danger" onClick={disconnect}>Disconnect</button>
            {contacts !== null && <span className="hint">{contacts} contacts with an email address</span>}
          </div>
        ) : (
          <>
            <div className="row"><button className="btn primary" disabled={busy || waiting} onClick={connect}><Icon name="cloud" size={15} /> {waiting ? "Waiting for you to approve in Nextcloud…" : "Connect to Nextcloud"}</button></div>
            {waiting && <p className="hint" style={{ margin: 0 }}>A Nextcloud tab opened. Sign in there if asked and choose <b>Grant access</b>. If no tab opened, allow pop-ups for this site and try again.</p>}
            <div><button className="btn link" onClick={() => setManual(!manual)}>{manual ? "Hide" : "Or enter an app password yourself"}</button></div>
            {manual && (
              <form className="form-grid g2" onSubmit={(e) => { e.preventDefault(); withPassword(); }}>
                <label className="field"><span className="field-label">User name</span><input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" /></label>
                <label className="field"><span className="field-label">App password</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></label>
                <div><button className="btn" disabled={busy || !user || !pw}>Connect</button></div>
              </form>
            )}
          </>
        )}
        {err && <div className="note error">{err}</div>}
      </section>
    </div>
  );
}
