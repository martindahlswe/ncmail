/** Just enough iCalendar (RFC 5545 / iTIP RFC 5546) to read invitations and turn them into calendar entries. */

export interface Person { email: string; name: string; partstat: string }
export interface IcsEvent {
  uid: string; sequence: number; recurrenceId: string; summary: string; start: string; end: string; allDay: boolean;
  location: string; description: string; status: string; organizer: Person | null; attendees: Person[];
}
export interface ParsedIcs { method: string; events: IcsEvent[] }

const unfold = (t: string) => t.replace(/\r?\n[ \t]/g, "");
const lines = (t: string) => unfold(t).split(/\r?\n/).filter((l) => l.length);
const unescapeText = (s: string) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

function prop(line: string): { name: string; params: Record<string, string>; value: string } {
  const colon = (() => { let q = false; for (let i = 0; i < line.length; i++) { if (line[i] === '"') q = !q; else if (line[i] === ":" && !q) return i; } return -1; })();
  const head = line.slice(0, colon), value = line.slice(colon + 1);
  const [name = "", ...ps] = head.split(";");
  const params: Record<string, string> = {};
  for (const p of ps) { const i = p.indexOf("="); if (i > 0) params[p.slice(0, i).toUpperCase()] = p.slice(i + 1).replace(/^"|"$/g, ""); }
  return { name: name.toUpperCase(), params, value };
}
const person = (p: ReturnType<typeof prop>): Person => ({ email: p.value.replace(/^mailto:/i, "").trim().toLowerCase(), name: p.params.CN ?? "", partstat: (p.params.PARTSTAT ?? "NEEDS-ACTION").toUpperCase() });

/** DTSTART:20261201T100000Z, or with TZID / as a date -> ISO-ish string (floating and zoned times are kept as written). */
function when(p: ReturnType<typeof prop>) {
  const v = p.value;
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return { text: v, allDay: false };
  if (!m[4]) return { text: `${m[1]}-${m[2]}-${m[3]}`, allDay: true };
  return { text: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ?? ""}${p.params.TZID ? ` ${p.params.TZID}` : ""}`, allDay: false };
}

export function parseIcs(text: string): ParsedIcs {
  const out: ParsedIcs = { method: "", events: [] };
  let cur: IcsEvent | null = null;
  let depth = 0; // nested components (VALARM) inside the event are skipped
  for (const l of lines(text)) {
    const u = l.toUpperCase();
    if (u === "BEGIN:VEVENT") { cur = { uid: "", sequence: 0, recurrenceId: "", summary: "", start: "", end: "", allDay: false, location: "", description: "", status: "", organizer: null, attendees: [] }; depth = 0; continue; }
    if (u === "END:VEVENT") { if (cur?.uid) out.events.push(cur); cur = null; continue; }
    if (cur) {
      if (u.startsWith("BEGIN:")) { depth++; continue; }
      if (u.startsWith("END:")) { depth--; continue; }
      if (depth > 0) continue;
      const p = prop(l);
      switch (p.name) {
        case "UID": cur.uid = p.value.trim(); break;
        case "SEQUENCE": cur.sequence = parseInt(p.value) || 0; break;
        case "RECURRENCE-ID": cur.recurrenceId = p.value.trim(); break;
        case "SUMMARY": cur.summary = unescapeText(p.value); break;
        case "LOCATION": cur.location = unescapeText(p.value); break;
        case "DESCRIPTION": cur.description = unescapeText(p.value); break;
        case "STATUS": cur.status = p.value.trim().toUpperCase(); break;
        case "DTSTART": { const w = when(p); cur.start = w.text; cur.allDay = w.allDay; break; }
        case "DTEND": cur.end = when(p).text; break;
        case "ORGANIZER": cur.organizer = person(p); break;
        case "ATTENDEE": cur.attendees.push(person(p)); break;
      }
    } else if (u.startsWith("METHOD:")) out.method = l.slice(7).trim().toUpperCase();
  }
  return out;
}

const fold = (l: string) => { if (l.length <= 74) return l; const parts = [l.slice(0, 74)]; for (let i = 74; i < l.length; i += 73) parts.push(" " + l.slice(i, i + 73)); return parts.join("\r\n"); };

export interface Keep { partstat?: string; status?: string }

/**
 * Turn an invitation into a calendar object: no METHOD (not allowed in a stored calendar object), STATUS tentative (or cancelled),
 * and the response state of your own address left open so the calendar app offers Accept / Decline.
 * `keep` carries over an answer you already gave if the event is being updated. Alarms and attachments from the sender are dropped:
 * reminders are the user's choice, and attachments can point anywhere.
 */
export function toCalendarObject(text: string, mine: string[], o: { cancel?: boolean; keep?: Keep } = {}): string {
  const mineSet = new Set(mine.map((m) => m.toLowerCase()));
  const out: string[] = [];
  let inEvent = false, depth = 0, alarm = 0, hasModified = false;
  const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, "");
  for (const l of lines(text)) {
    const u = l.toUpperCase();
    if (!inEvent && u.startsWith("METHOD:")) continue;
    if (u === "BEGIN:VEVENT") { inEvent = true; depth = 0; hasModified = false; out.push(l); continue; }
    if (u === "END:VEVENT") {
      const keepStatus = o.keep?.status && !o.cancel ? o.keep.status : o.cancel ? "CANCELLED" : "TENTATIVE";
      // Nextcloud decides whether to send your reply by comparing LAST-MODIFIED, so every stored event needs one
      if (!hasModified) out.push(`LAST-MODIFIED:${stamp}`);
      out.push(`STATUS:${keepStatus}`, l); inEvent = false; continue;
    }
    if (inEvent && (alarm || u === "BEGIN:VALARM")) { alarm += u === "BEGIN:VALARM" ? 1 : u === "END:VALARM" ? -1 : 0; continue; }
    if (inEvent) {
      if (u.startsWith("BEGIN:")) depth++;
      else if (u.startsWith("END:")) depth--;
      else if (depth === 0) {
        if (u.startsWith("STATUS:") || /^ATTACH[;:]/.test(u)) continue;
        if (u.startsWith("LAST-MODIFIED")) hasModified = true;
        if (u.startsWith("ATTENDEE")) {
          const p = prop(l);
          if (mineSet.has(p.value.replace(/^mailto:/i, "").trim().toLowerCase())) {
            const ps = o.keep?.partstat ?? "NEEDS-ACTION";
            const head = l.slice(0, l.indexOf(p.value) - 1);
            const h2 = /;PARTSTAT=[^;:]*/i.test(head) ? head.replace(/;PARTSTAT=[^;:]*/i, `;PARTSTAT=${ps}`) : `${head};PARTSTAT=${ps}`;
            out.push(`${h2}:${p.value}`); continue;
          }
        }
      }
    }
    out.push(l);
  }
  return out.map(fold).join("\r\n") + "\r\n";
}

/** The answer you already gave in a stored calendar object, if any (read from the calendar server's copy). */
export function myAnswer(text: string, mine: string[]): Keep & { sequence: number } {
  const set = new Set(mine.map((m) => m.toLowerCase()));
  const e = parseIcs(text).events[0];
  const me = e?.attendees.find((a) => set.has(a.email));
  const partstat = me && me.partstat !== "NEEDS-ACTION" ? me.partstat : undefined;
  return { partstat, status: partstat ? (e!.status === "CANCELLED" ? "CANCELLED" : partstat === "ACCEPTED" ? "CONFIRMED" : partstat === "TENTATIVE" ? "TENTATIVE" : e!.status || "TENTATIVE") : undefined, sequence: e?.sequence ?? -1 };
}
