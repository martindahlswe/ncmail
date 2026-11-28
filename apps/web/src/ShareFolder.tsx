import { useEffect, useState } from "react";
import { api, type Folder } from "./api.ts";
import { Icon } from "./icons.tsx";

type Entry = { user: string; access: "read" | "write" | "other"; rights: string };
const ACCESS_LABEL = { read: "Can read", write: "Can read and change", other: "Custom rights" } as const;

/** Share one of your folders with other users of the same mail server (IMAP ACL). It appears for them under "Shared with you". */
export function ShareFolder({ folder, onClose }: { folder: Folder; onClose: () => void }) {
  const [list, setList] = useState<Entry[] | null>(null);
  const [user, setUser] = useState("");
  const [access, setAccess] = useState<"read" | "write">("read");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const base = `/folders/${folder.id}/acl`;
  const load = () => api<Entry[]>(base).then(setList).catch((e) => { setErr(e.message); setList([]); });
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr("");
    try { await fn(); await load(); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const share = () => run(async () => { await api(base, { method: "PUT", body: JSON.stringify({ user: user.trim(), access }) }); setUser(""); });

  return (
    <div className="modal-backdrop" style={{ zIndex: 130 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" role="dialog" aria-label={`Share ${folder.name}`} style={{ width: "min(480px, 100%)" }} onSubmit={(e) => { e.preventDefault(); if (user.trim()) share(); }}>
        <div className="modal-head"><b>Share “{folder.name}”</b><span style={{ flex: 1 }} /><button type="button" className="btn icon sm ghost" aria-label="Close" onClick={onClose}><Icon name="x" /></button></div>
        <div className="modal-body">
          <p className="hint" style={{ margin: 0 }}>The people you add, on the same mail server, see this folder in their sidebar. Use their user name on the mail server (usually their email address).</p>
          {list === null && <span className="hint">Loading…</span>}
          {list && list.length === 0 && <span className="hint">Not shared with anyone yet.</span>}
          {list && list.length > 0 && (
            <div className="list">
              {list.map((e) => (
                <div key={e.user} className="list-row">
                  <div className="list-row-main">
                    <div className="list-row-title"><b>{e.user}</b> <span className="hint">{ACCESS_LABEL[e.access]}{e.access === "other" ? ` (${e.rights})` : ""}</span></div>
                    <div className="row list-row-actions">
                      {e.access !== "write" && <button type="button" className="btn sm" disabled={busy} onClick={() => run(() => api(base, { method: "PUT", body: JSON.stringify({ user: e.user, access: "write" }) }))}>Allow changes</button>}
                      {e.access !== "read" && <button type="button" className="btn sm" disabled={busy} onClick={() => run(() => api(base, { method: "PUT", body: JSON.stringify({ user: e.user, access: "read" }) }))}>Read only</button>}
                      <button type="button" className="btn sm danger" disabled={busy} onClick={() => run(() => api(`${base}/${encodeURIComponent(e.user)}`, { method: "DELETE" }))}>Stop sharing</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="row" style={{ alignItems: "stretch" }}>
            <input aria-label="User to share with" placeholder="colleague@example.com" value={user} onChange={(e) => setUser(e.target.value)} style={{ flex: 1 }} autoFocus />
            <select aria-label="Access" value={access} onChange={(e) => setAccess(e.target.value as "read" | "write")} style={{ flex: "0 0 auto", width: "auto" }}>
              <option value="read">Can read</option>
              <option value="write">Can read and change</option>
            </select>
          </div>
          <span className="hint">"Can read and change" lets them mark, add, move and delete messages in this folder. Neither lets them share it further.</span>
          {err && <div className="note error">{err}</div>}
        </div>
        <div className="modal-foot"><span /><div className="row"><button type="button" className="btn" onClick={onClose}>Close</button><button className="btn primary" disabled={busy || !user.trim()}>Share</button></div></div>
      </form>
    </div>
  );
}
