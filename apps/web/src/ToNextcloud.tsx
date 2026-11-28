import { useEffect, useState } from "react";
import { api, type MessageFull } from "./api.ts";
import { Icon } from "./icons.tsx";

/** What the Nextcloud offers, asked once per visit: task lists (Tasks), calendars (Calendar), Talk. */
export interface Integrations { connected: boolean; tasks: boolean; calendar: boolean; talk: boolean }
let cached: Promise<Integrations> | null = null;
export function useIntegrations(enabled: boolean): Integrations | null {
  const [v, setV] = useState<Integrations | null>(null);
  useEffect(() => {
    if (!enabled) return;
    cached ??= api<Integrations>("/nextcloud/integrations").catch(() => { cached = null; return { connected: false, tasks: false, calendar: false, talk: false }; });
    cached.then(setV);
  }, [enabled]);
  return v;
}

export type ToKind = "task" | "event" | "talk";
const TITLE: Record<ToKind, string> = { task: "Create a task", event: "Create an event", talk: "Share to Talk" };
const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Turn a message into a task or an event, or share it to a Talk conversation. */
export function ToNextcloud({ kind, message, onDone, onClose }: { kind: ToKind; message: MessageFull; onDone: (text: string) => void; onClose: () => void }) {
  const [targets, setTargets] = useState<{ id: string; name: string }[] | null>(null);
  const [target, setTarget] = useState("");
  const [title, setTitle] = useState(message.subject || "");
  const [note, setNote] = useState("");
  const [due, setDue] = useState("");
  const next = new Date(); next.setDate(next.getDate() + 1); next.setHours(10, 0, 0, 0);
  const [allDay, setAllDay] = useState(false);
  const [startDay, setStartDay] = useState(localDate(next));
  const [startTime, setStartTime] = useState("10:00");
  const [endTime, setEndTime] = useState("11:00");
  const [location, setLocation] = useState("");
  const [includeText, setIncludeText] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const load = kind === "talk"
      ? api<{ token: string; name: string }[]>("/nextcloud/talk/rooms").then((r) => r.map((x) => ({ id: x.token, name: x.name })))
      : api<{ url: string; name: string }[]>(`/nextcloud/calendars?kind=${kind === "task" ? "tasks" : "events"}`).then((r) => r.map((x) => ({ id: x.url, name: x.name })));
    load.then((t) => { setTargets(t); setTarget(t[0]?.id ?? ""); }).catch((e) => { setErr(e.message); setTargets([]); });
  }, [kind]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);

  const submit = async () => {
    setBusy(true); setErr("");
    try {
      if (kind === "task") {
        const r = await api<{ list: string }>(`/messages/${message.id}/task`, { method: "POST", body: JSON.stringify({ list: target, title, note, ...(due ? { due } : {}) }) });
        onDone(`Task added to ${r.list}`);
      } else if (kind === "event") {
        const start = allDay ? startDay : new Date(`${startDay}T${startTime}`).toISOString();
        const end = allDay ? startDay : new Date(`${startDay}T${endTime}`).toISOString();
        const r = await api<{ calendar: string }>(`/messages/${message.id}/event`, { method: "POST", body: JSON.stringify({ calendar: target, title, note, location, allDay, start, end }) });
        onDone(`Event added to ${r.calendar}`);
      } else {
        const r = await api<{ conversation: string }>(`/messages/${message.id}/talk`, { method: "POST", body: JSON.stringify({ token: target, note, includeText }) });
        onDone(`Shared to ${r.conversation}`);
      }
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  const ok = !!target && (kind === "talk" || !!title.trim()) && (kind !== "event" || allDay || endTime > startTime);
  const label = kind === "task" ? "Task list" : kind === "event" ? "Calendar" : "Conversation";

  return (
    <div className="modal-backdrop" style={{ zIndex: 130 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" role="dialog" aria-label={TITLE[kind]} style={{ width: "min(460px, 100%)" }} onSubmit={(e) => { e.preventDefault(); if (ok && !busy) submit(); }}>
        <div className="modal-head"><b>{TITLE[kind]}</b><span style={{ flex: 1 }} /><button type="button" className="btn icon sm ghost" aria-label="Close" onClick={onClose}><Icon name="x" /></button></div>
        <div className="modal-body">
          {targets === null ? <span className="hint">Loading…</span> : targets.length === 0 && !err ? (
            <span className="hint">{kind === "talk" ? "You are not in any conversation you can write to." : kind === "task" ? "You have no task lists in Nextcloud." : "You have no calendars in Nextcloud."}</span>
          ) : (
            <label className="field"><span className="field-label">{label}</span>
              <select aria-label={label} value={target} onChange={(e) => setTarget(e.target.value)}>{targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
            </label>
          )}
          {kind !== "talk" && <label className="field"><span className="field-label">Title</span><input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>}
          {kind === "task" && <label className="field"><span className="field-label">Due <span className="field-hint">(optional)</span></span><input aria-label="Due date" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>}
          {kind === "event" && (
            <>
              <label className="check-row"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /><span>All day</span></label>
              <div className="row" style={{ alignItems: "end" }}>
                <label className="field" style={{ flex: 2 }}><span className="field-label">Day</span><input aria-label="Day" type="date" value={startDay} onChange={(e) => setStartDay(e.target.value)} /></label>
                {!allDay && <label className="field" style={{ flex: 1 }}><span className="field-label">From</span><input aria-label="From" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></label>}
                {!allDay && <label className="field" style={{ flex: 1 }}><span className="field-label">To</span><input aria-label="To" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></label>}
              </div>
              <label className="field"><span className="field-label">Location <span className="field-hint">(optional)</span></span><input aria-label="Location" value={location} onChange={(e) => setLocation(e.target.value)} /></label>
            </>
          )}
          <label className="field"><span className="field-label">{kind === "talk" ? "Message" : "Notes"} <span className="field-hint">(optional)</span></span>
            <textarea aria-label={kind === "talk" ? "Message" : "Notes"} rows={3} value={note} onChange={(e) => setNote(e.target.value)} autoFocus={kind === "talk"} />
          </label>
          {kind === "talk" ? (
            <label className="check-row"><input type="checkbox" checked={includeText} onChange={(e) => setIncludeText(e.target.checked)} /><span>Include the opening lines<span className="field-hint">The sender and subject are always included. Everyone in the conversation can read them.</span></span></label>
          ) : (
            <span className="hint">The sender, date, subject and a link back to this message are added{kind === "task" ? " to the task" : " to the event"}.</span>
          )}
          {err && <div className="note error">{err}</div>}
        </div>
        <div className="modal-foot"><span /><div className="row"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!ok || busy}>{busy ? "Working…" : kind === "talk" ? "Share" : "Create"}</button></div></div>
      </form>
    </div>
  );
}
