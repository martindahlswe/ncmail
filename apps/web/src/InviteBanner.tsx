import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { Icon } from "./icons.tsx";
import { useToast } from "./ui.tsx";

interface Invite {
  method: string; summary: string; start: string; end: string; allDay: boolean; location: string; status: string;
  organizer: { email: string; name: string } | null; attendees: number; linked: boolean; calendarName: string; imported: string | null; answer: string; calendarAppUrl: string | null;
}

/** "2026-12-01T10:00:00Z" / "2026-12-01T10:00:00 Europe/Stockholm" / "2026-12-01" -> readable */
function when(i: Invite) {
  const f = (s: string) => {
    if (!s) return "";
    const day = /^\d{4}-\d{2}-\d{2}$/.test(s);
    const zoned = s.match(/^(.*?)(?: (.+))?$/)!;
    const d = new Date(zoned[1]!);
    if (isNaN(+d)) return s;
    return day ? d.toLocaleDateString([], { dateStyle: "full" }) : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short", ...(zoned[2] && !zoned[1]!.endsWith("Z") ? { timeZone: "UTC" } : {}) }) + (zoned[2] ? ` (${zoned[2]})` : "");
  };
  return i.end && i.end !== i.start ? `${f(i.start)} to ${f(i.end)}` : f(i.start);
}

/** A calendar invitation in a message: what it is, and whether it is in your Nextcloud calendar yet. */
export function InviteBanner({ messageId }: { messageId: string }) {
  const toast = useToast();
  const [inv, setInv] = useState<Invite | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const load = () => api<Invite | null>(`/messages/${messageId}/invite`).then(setInv).catch(() => setInv(null));
  useEffect(() => { load(); const h = () => load(); window.addEventListener("ncmail:refresh", h); return () => window.removeEventListener("ncmail:refresh", h); }, [messageId]);
  if (!inv) return null;
  const cancelled = inv.method === "CANCEL" || inv.status === "CANCELLED";
  const add = async () => {
    setBusy(true);
    try { await api(`/messages/${messageId}/invite/add`, { method: "POST" }); toast({ kind: "success", message: "Added to your calendar as tentative. Answer it in the calendar." }); await load(); }
    catch (e: any) { toast({ kind: "error", message: e.message }); }
    setBusy(false);
  };
  return (
    <div className={`sec ${cancelled ? "bad" : "ok"}`} style={{ alignItems: "center" }}>
      <Icon name="calendar" size={18} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>{cancelled ? "Cancelled: " : "Invitation: "}{inv.summary || "(no title)"}</b>
        <div className="hint">{when(inv)}{inv.location ? ` · ${inv.location}` : ""}{inv.organizer ? ` · from ${inv.organizer.name || inv.organizer.email}` : ""}{inv.attendees > 1 ? ` · ${inv.attendees} people` : ""}</div>
        <div className="hint" style={{ marginTop: 2 }}>
          {inv.imported ? (inv.imported === "cancelled" ? "Marked as cancelled in your calendar."
            : inv.answer === "accepted" ? "You accepted this. It is in your calendar."
            : inv.answer === "declined" ? "You declined this."
            : inv.answer === "tentative" ? "You answered maybe. It is in your calendar."
            : inv.answer === "removed" ? "You removed it from your calendar."
            : <>In your calendar{inv.calendarName ? ` (${inv.calendarName})` : ""} as tentative. Accept or decline it there.</>)
            : inv.linked ? "Not in your calendar yet." : "Connect your Nextcloud calendar under Settings > Calendar to add invitations automatically."}
        </div>
      </div>
      {inv.linked && !inv.imported && !cancelled && <button className="btn sm" disabled={busy} onClick={add}>Add to calendar</button>}
      {inv.imported && inv.answer !== "removed" && inv.calendarAppUrl && <a className="btn sm" href={inv.calendarAppUrl} target="_blank" rel="noreferrer">Open calendar</a>}
    </div>
  );
}
