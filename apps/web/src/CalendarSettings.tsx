import { useEffect, useState } from "react";
import type { AccountSummary } from "@ncmail/shared";
import { api } from "./api.ts";
import { useToast } from "./ui.tsx";
import { useNc } from "./nc.ts";

interface State { linked: boolean; baseUrl: string; username: string; calendarUrl: string; calendarName: string; autoImport: boolean; suggestedUrl: string }

export function CalendarSettings({ account }: { account: AccountSummary }) {
  const toast = useToast();
  const [s, setS] = useState<State | null>(null);
  const [url, setUrl] = useState(""), [user, setUser] = useState(""), [pw, setPw] = useState("");
  const [cals, setCals] = useState<{ url: string; name: string }[]>([]);
  const [cal, setCal] = useState("");
  const [auto, setAuto] = useState(true);
  const nc = useNc();
  const [own, setOwn] = useState(false); // enter credentials here instead of using the Nextcloud connection
  const useConn = nc.connected && !own && !(s?.linked && s.username && s.username !== nc.user);
  const [busy, setBusy] = useState(false), [err, setErr] = useState("");

  useEffect(() => {
    api<State>(`/accounts/${account.id}/calendar`).then((x) => {
      setS(x); setUrl(x.baseUrl || x.suggestedUrl); setUser(x.username); setCal(x.calendarUrl); setAuto(x.autoImport);
      if (x.linked) setCals([{ url: x.calendarUrl, name: x.calendarName }]);
    });
  }, [account.id]);

  const body = () => (useConn ? { useConnection: true } : { baseUrl: url, username: user, password: pw || undefined });
  const find = async () => {
    setBusy(true); setErr("");
    try { const r = await api<{ calendars: { url: string; name: string }[] }>(`/accounts/${account.id}/calendar/discover`, { method: "POST", body: JSON.stringify(body()) }); setCals(r.calendars); if (!r.calendars.some((c) => c.url === cal)) setCal(r.calendars[0]?.url ?? ""); if (!r.calendars.length) setErr("This account has no calendar that can hold events."); }
    catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const save = async () => {
    setBusy(true); setErr("");
    try {
      await api(`/accounts/${account.id}/calendar`, { method: "PUT", body: JSON.stringify({ ...body(), calendarUrl: cal, calendarName: cals.find((c) => c.url === cal)?.name ?? "", autoImport: auto }) });
      toast({ kind: "success", message: "Calendar connected" }); setPw("");
      setS(await api<State>(`/accounts/${account.id}/calendar`));
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const disconnect = async () => { await api(`/accounts/${account.id}/calendar`, { method: "DELETE" }); setS(await api<State>(`/accounts/${account.id}/calendar`)); setCals([]); setCal(""); setPw(""); };
  if (!s) return <p className="hint">Loading…</p>;

  return (
    <div className="stack">
      <section className="card">
        <h3>Nextcloud calendar {s.linked && <span className="chip ok" style={{ marginLeft: 8 }}>Connected</span>}</h3>
        <p className="hint" style={{ margin: 0 }}>
          When an email with a calendar invitation arrives in your inbox, it is added to this calendar as a <b>tentative</b> entry, with your answer left open.
          Open the entry in the Calendar app to accept, tentatively accept or decline; Nextcloud then sends the reply to the organizer.
          Entries you delete are not added back.
        </p>
        {useConn ? (
          <p className="hint" style={{ margin: 0 }}>Using your Nextcloud connection ({nc.user}). <button className="btn link" onClick={() => setOwn(true)}>Use different credentials</button></p>
        ) : (
        <div className="form-grid g1">
          <label className="field"><span className="field-label">Nextcloud address</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://cloud.example.com" /></label>
          <div className="form-grid g2">
            <label className="field"><span className="field-label">User name</span><input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" /></label>
            <label className="field"><span className="field-label">Password</span>
              <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" placeholder={s.linked ? "Unchanged" : ""} />
              <span className="field-hint">Use an app password (Nextcloud: Settings → Security → Devices &amp; sessions). It is stored encrypted.</span></label>
          </div>
        </div>
        )}
        <div><button className="btn" disabled={busy || (!useConn && (!url || !user || (!pw && !s.linked)))} onClick={find}>{cals.length ? "Reload calendars" : "Find my calendars"}</button></div>
        {cals.length > 0 && (
          <div className="form-grid g1">
            <label className="field"><span className="field-label">Add invitations to</span>
              <select value={cal} onChange={(e) => setCal(e.target.value)}>{cals.map((c) => <option key={c.url} value={c.url}>{c.name}</option>)}</select></label>
            <label className="check-row"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
              <span><b>Add new invitations automatically</b><span className="field-hint">Invitations that arrive in the inbox in the last two weeks. You can still add one yourself from the message.</span></span></label>
          </div>
        )}
        {err && <div className="note error">{err}</div>}
        <div className="row">
          <button className="btn primary" disabled={busy || !cal} onClick={save}>{s.linked ? "Save changes" : "Connect calendar"}</button>
          {s.linked && <button className="btn danger" onClick={disconnect}>Disconnect</button>}
        </div>
      </section>
    </div>
  );
}
