import { useState } from "react";
import type { AccountSummary } from "@ncmail/shared";
import { api } from "./api.ts";
import { refreshLabels, useLabels } from "./labels.ts";
import { Icon } from "./icons.tsx";
import { useToast } from "./ui.tsx";

export function LabelSettings({ account }: { account: AccountSummary }) {
  const toast = useToast();
  const { labels, saved } = useLabels(account.id);
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    try { await api(`/accounts/${account.id}/labels`, { method: "POST", body: JSON.stringify({ name }) }); setName(""); await refreshLabels(account.id); }
    catch (er: any) { setErr(er.message); }
  };
  const patch = async (slug: string, body: object) => { await api(`/accounts/${account.id}/labels/${slug}`, { method: "PATCH", body: JSON.stringify(body) }).catch((e) => toast({ kind: "error", message: e.message })); refreshLabels(account.id); };
  return (
    <div className="stack">
      <section className="card">
        <h3>Labels</h3>
        <p className="hint" style={{ margin: 0 }}>Tag messages with labels from the message toolbar or the list. A label is stored on the message itself, so other mail programs on this account keep it too. Click a label in the sidebar to see everything that has it, in every folder.</p>
        <div className="list">
          {labels.length === 0 && <p className="hint">No labels yet.</p>}
          {labels.map((l) => (
            <div className="list-row" key={l.slug} style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input type="color" aria-label={`Colour of ${l.name}`} value={l.color} onChange={(e) => patch(l.slug, { color: e.target.value })} style={{ width: 34, height: 30, padding: 2 }} />
              <input defaultValue={l.name} aria-label="Label name" style={{ flex: 1 }} onBlur={(e) => e.target.value.trim() && e.target.value !== l.name && patch(l.slug, { name: e.target.value })} />
              <button className="btn sm ghost danger" onClick={async () => { await api(`/accounts/${account.id}/labels/${l.slug}`, { method: "DELETE" }); refreshLabels(account.id); }}><Icon name="trash" size={14} /> Remove</button>
            </div>
          ))}
        </div>
        <form className="row" onSubmit={add}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New label, for example Work" aria-label="New label" style={{ flex: 1, minWidth: 180 }} />
          <button className="btn primary" disabled={!name.trim()}>Add label</button>
        </form>
        {err && <div className="note error">{err}</div>}
      </section>
      <section className="card">
        <h3>Saved searches</h3>
        <p className="hint" style={{ margin: 0 }}>Run a search, then choose "Save this search" in the results header. Saved searches appear in the sidebar. You can use <code>label:name</code> in any search.</p>
        {saved.length === 0 ? <p className="hint">None yet.</p> : <div className="list">{saved.map((s) => (
          <div className="list-row" key={s.id} style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <Icon name="search" size={15} /><div style={{ flex: 1 }}><b>{s.name}</b><div className="hint"><code>{s.query}</code></div></div>
            <button className="btn sm ghost danger" onClick={async () => { await api(`/accounts/${account.id}/saved-searches/${s.id}`, { method: "DELETE" }); refreshLabels(account.id); }}><Icon name="trash" size={14} /> Remove</button>
          </div>))}</div>}
      </section>
    </div>
  );
}
