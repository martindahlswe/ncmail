import { useEffect, useState } from "react";
import { Icon } from "./icons.tsx";
import type { MenuItem } from "./ui.tsx";

const at = (d: Date, h: number, m = 0) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x; };
const day = (d: Date) => d.toLocaleDateString([], { weekday: "short" });
const hm = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** "Tue 08:00", "Today 18:00", "12 Dec 08:00" */
export function whenLabel(d: Date) {
  const now = new Date(), tomorrow = new Date(+now + 86400_000);
  if (d.toDateString() === now.toDateString()) return `Today ${hm(d)}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${hm(d)}`;
  return `${+d - +now < 6 * 86400_000 ? day(d) : d.toLocaleDateString([], { day: "numeric", month: "short" })} ${hm(d)}`;
}

/** The usual choices for "when": later today, tomorrow morning, the weekend, next week. */
export function timePresets(): { label: string; date: Date }[] {
  const now = new Date(), out: { label: string; date: Date }[] = [];
  if (now.getHours() < 17) out.push({ label: "Later today", date: at(now, 18) });
  out.push({ label: "Tomorrow morning", date: at(new Date(+now + 86400_000), 8) });
  const dow = now.getDay();
  if (dow !== 6 && dow !== 0) out.push({ label: "This weekend", date: at(new Date(+now + (6 - dow) * 86400_000), 9) });
  out.push({ label: "Next week", date: at(new Date(+now + (((8 - dow) % 7) || 7) * 86400_000), 8) });
  return out;
}

/** Menu entries for the presets, plus "Pick date and time…". */
export function timeMenu(onPick: (d: Date) => void, onCustom: () => void): MenuItem[] {
  return [...timePresets().map((p) => ({ label: p.label, hint: whenLabel(p.date), onClick: () => onPick(p.date) })), { divider: true, label: "", onClick: () => {} }, { label: "Pick date and time…", icon: "calendar" as const, onClick: onCustom }];
}

export function PickTime({ title, onPick, onClose }: { title: string; onPick: (d: Date) => void; onClose: () => void }) {
  const local = (d: Date) => new Date(+d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [v, setV] = useState(local(at(new Date(+new Date() + 86400_000), 8)));
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
  const d = new Date(v);
  const ok = !isNaN(+d) && +d > Date.now();
  return (
    <div className="modal-backdrop" style={{ zIndex: 130 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" role="dialog" aria-label={title} style={{ width: "min(380px, 100%)" }} onSubmit={(e) => { e.preventDefault(); if (ok) onPick(d); }}>
        <div className="modal-head"><b>{title}</b><span style={{ flex: 1 }} /><button type="button" className="btn icon sm ghost" aria-label="Close" onClick={onClose}><Icon name="x" /></button></div>
        <div className="modal-body">
          <input type="datetime-local" aria-label="Date and time" value={v} min={local(new Date())} onChange={(e) => setV(e.target.value)} autoFocus />
          <span className="hint">{ok ? whenLabel(d) : "Choose a time in the future"}</span>
        </div>
        <div className="modal-foot"><span /><div className="row"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!ok}>Set</button></div></div>
      </form>
    </div>
  );
}
