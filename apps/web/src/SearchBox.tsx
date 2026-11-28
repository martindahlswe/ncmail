import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.tsx";

const TIPS: { token: string; text: string }[] = [
  { token: "from:", text: "sender, e.g. from:anna" },
  { token: "to:", text: "recipient" },
  { token: "subject:", text: "words in the subject" },
  { token: "has:attachment", text: "with attachments" },
  { token: "is:unread", text: "also is:read, is:starred" },
  { token: "before:", text: "e.g. before:2026-01-31" },
  { token: "after:", text: "e.g. after:2026-01-01" },
  { token: "in:", text: "folder, e.g. in:sent or in:clients" },
  { token: '"..."', text: "exact phrase;  -word excludes" },
];

export function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  // "/" focuses search from anywhere (unless you are typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.isContentEditable) { e.preventDefault(); ref.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const insert = (token: string) => {
    const t = token === '"..."' ? '""' : token;
    // Operators that take a value stay open for typing; complete ones end with a space so the next tip can be picked.
    onChange((value && !value.endsWith(" ") ? value + " " : value) + t + (t.endsWith(":") || t === '""' ? "" : " "));
    ref.current?.focus();
  };

  return (
    // the tips stay open while the focus is anywhere in here, so they can be reached with Tab (not only clicked)
    <div className="search" onFocus={() => setFocused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}
      onKeyDown={(e) => { if (e.key === "Escape" && e.target !== ref.current) { e.preventDefault(); ref.current?.focus(); setFocused(false); } }}>
      <Icon name="search" size={16} className="search-icon" />
      <input ref={ref} type="search" aria-label="Search mail" placeholder="Search mail" value={value} spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { onChange(""); ref.current?.blur(); } }} />
      {value && <button className="search-clear" aria-label="Clear search" onMouseDown={(e) => e.preventDefault()} onClick={() => onChange("")}><Icon name="x" size={14} /></button>}
      {focused && (!value || value.endsWith(" ")) && (
        <div className="search-tips" role="group" aria-label="Search operators">
          <div className="hint" style={{ padding: "2px 12px 6px" }}>Search narrows with operators. Click one to add it:</div>
          {TIPS.map((t) => (
            <button key={t.token} className="tip" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(t.token)}>
              <code>{t.token}</code><span className="hint">{t.text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
