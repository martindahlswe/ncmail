import { useEffect, useRef, useState } from "react";
import { api, isEmail, parseRecipients } from "./api.ts";
import { Avatar } from "./ThreadBits.tsx";
import { Icon } from "./icons.tsx";
import { useContextMenu } from "./ContextMenu.tsx";
import { useToast } from "./ui.tsx";

interface Suggestion { email: string; name: string; sentTo: number }

/**
 * Address field: typed or pasted addresses become chips; people you have written to or heard from are suggested as you type.
 * The value is the plain "a@b.c, Name <d@e.f>" string the rest of the app uses.
 */
export function RecipientInput({ value, onChange, accountId, label, autoFocus, onBlurAdd }: {
  value: string; onChange: (v: string) => void; accountId?: string; label: string; autoFocus?: boolean; onBlurAdd?: () => void;
}) {
  const ctx = useContextMenu();
  const toast = useToast();
  const chips = parseRecipients(value);
  const [text, setText] = useState("");
  const [list, setList] = useState<Suggestion[]>([]);
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  const emit = (next: typeof chips) => onChange(next.map((c) => c.raw).join(", "));
  const commit = (raw: string) => {
    const add = parseRecipients(raw);
    if (add.length) emit([...chips, ...add.filter((a) => !chips.some((c) => c.address.toLowerCase() === a.address.toLowerCase()))]);
    setText(""); setList([]);
  };

  useEffect(() => {
    const q = text.trim();
    if (q.length < 1) { setList([]); return; }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      api<Suggestion[]>(`/contacts?q=${encodeURIComponent(q)}${accountId ? `&accountId=${accountId}` : ""}`)
        .then((r) => { if (mine === seq.current) { setList(r.filter((s) => !chips.some((c) => c.address.toLowerCase() === s.email))); setHi(0); } }).catch(() => {});
    }, 100);
    return () => clearTimeout(t);
  }, [text, accountId]);

  const pick = (s: Suggestion) => commit(s.name ? `${s.name.replace(/[<>,;]/g, "")} <${s.email}>` : s.email);

  return (
    <div className="rcpt" onClick={() => input.current?.focus()}>
      {chips.map((c, i) => (
        <span key={i} className={`rcpt-chip${c.valid ? "" : " invalid"}`} title={c.valid ? c.address : "This is not a valid address"} onContextMenu={(e) => ctx(e, [
          { label: "Copy address", icon: "copy", onClick: () => { navigator.clipboard.writeText(c.address); toast({ message: `Copied ${c.address}` }); } },
          { label: "Remove", icon: "x", danger: true, onClick: () => emit(chips.filter((_, j) => j !== i)) },
        ])}>
          <span>{c.label}</span>
          <button type="button" aria-label={`Remove ${c.label}`} onClick={(e) => { e.stopPropagation(); emit(chips.filter((_, j) => j !== i)); }}><Icon name="x" size={12} /></button>
        </span>
      ))}
      <input ref={input} aria-label={label} value={text} autoFocus={autoFocus} autoComplete="off" spellCheck={false}
        onChange={(e) => {
          const v = e.target.value;
          if (/[,;]\s*$/.test(v) || /\s$/.test(v) && isEmail(v.trim())) commit(v); else setText(v);
        }}
        onPaste={(e) => {
          const t = e.clipboardData.getData("text");
          if (/[,;\n]/.test(t)) { e.preventDefault(); commit(t.replace(/\n/g, ",")); }
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === "Tab") && list[hi] && text.trim()) { e.preventDefault(); pick(list[hi]!); }
          else if ((e.key === "Enter" || e.key === "Tab") && text.trim()) { if (e.key === "Enter") e.preventDefault(); commit(text); }
          else if (e.key === "ArrowDown" && list.length) { e.preventDefault(); setHi((hi + 1) % list.length); }
          else if (e.key === "ArrowUp" && list.length) { e.preventDefault(); setHi((hi - 1 + list.length) % list.length); }
          else if (e.key === "Escape" && list.length) { e.stopPropagation(); setList([]); }
          else if (e.key === "Backspace" && !text && chips.length) emit(chips.slice(0, -1));
        }}
        onBlur={() => { if (text.trim()) commit(text); setTimeout(() => setList([]), 120); onBlurAdd?.(); }} />
      {list.length > 0 && (
        <div className="suggest" role="listbox">
          {list.map((s, i) => (
            <button type="button" key={s.email} role="option" aria-selected={i === hi} className={i === hi ? "on" : ""}
              onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setHi(i)} onClick={() => pick(s)}>
              <Avatar name={s.name} address={s.email} small />
              <span className="who"><span>{s.name || s.email}</span>{s.name && <span>{s.email}</span>}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
