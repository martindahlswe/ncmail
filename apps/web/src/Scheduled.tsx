import { useEffect } from "react";
import { api } from "./api.ts";
import { Icon } from "./icons.tsx";
import { whenLabel } from "./schedule.tsx";
import { useToast } from "./ui.tsx";

export interface ScheduledItem { id: string; subject: string; to: string[]; sendAt: string }

/** Messages waiting for their send time. They can be sent right away or cancelled. */
export function Scheduled({ items, onChange, onClose }: { items: ScheduledItem[]; onChange: () => void; onClose: () => void }) {
  const toast = useToast();
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
  const act = async (id: string, what: "cancel" | "send-now") => {
    try { await api(`/outbox/${id}/${what}`, { method: "POST" }); toast({ message: what === "cancel" ? "Cancelled. The message stays in your Drafts." : "Sending now…", kind: "success" }); }
    catch (e: any) { toast({ message: e.message, kind: "error" }); }
    onChange();
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Scheduled messages" style={{ width: "min(620px, 100%)" }}>
        <div className="modal-head"><b>Scheduled messages</b><span style={{ flex: 1 }} /><button className="btn icon sm ghost" aria-label="Close" onClick={onClose}><Icon name="x" /></button></div>
        <div className="modal-body" style={{ gap: 0 }}>
          {items.length === 0 && <p className="hint">Nothing is scheduled.</p>}
          {items.map((o) => (
            <div className="list-row" key={o.id}>
              <div className="list-row-title"><Icon name="clock" size={15} /><b>{o.subject || "(no subject)"}</b></div>
              <div className="hint">To {o.to.join(", ")} · sends {whenLabel(new Date(o.sendAt))}</div>
              <div className="row list-row-actions"><button className="btn sm" onClick={() => act(o.id, "send-now")}>Send now</button><button className="btn sm ghost danger" onClick={() => act(o.id, "cancel")}>Cancel</button></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
