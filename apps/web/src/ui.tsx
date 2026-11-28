import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./icons.tsx";

// ------------------------------------------------------------------ toasts
export interface ToastInput { message: string; kind?: "info" | "error" | "success"; action?: { label: string; run: () => void }; ttl?: number }
interface Toast extends ToastInput { id: number }
const ToastCtx = createContext<(t: ToastInput) => number>(() => 0);
const DismissCtx = createContext<(id: number) => void>(() => {});
/** Show a message at the bottom of the screen, optionally with one action such as Undo. Returns its id. */
export const useToast = () => useContext(ToastCtx);
export const useDismissToast = () => useContext(DismissCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setList((cur) => cur.filter((t) => t.id !== id)), []);
  const show = useCallback((t: ToastInput) => {
    const id = ++seq.current;
    setList((cur) => [...cur.slice(-3), { ...t, id }]);
    setTimeout(() => dismiss(id), t.ttl ?? (t.kind === "error" ? 8000 : 6000));
    return id;
  }, [dismiss]);
  return (
    <ToastCtx.Provider value={show}>
      <DismissCtx.Provider value={dismiss}>
        {children}
        <div className="toasts" role="status" aria-live="polite">
          {list.map((t) => (
            <div key={t.id} className={`toast ${t.kind ?? "info"}`}>
              <Icon name={t.kind === "error" ? "alert" : t.kind === "success" ? "check" : "info"} />
              <span className="toast-msg">{t.message}</span>
              {t.action && <button className="btn sm ghost toast-action" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
              <button className="btn icon sm ghost" aria-label="Dismiss" onClick={() => dismiss(t.id)}><Icon name="x" size={14} /></button>
            </div>
          ))}
        </div>
      </DismissCtx.Provider>
    </ToastCtx.Provider>
  );
}

// ------------------------------------------------------------------ dialogs
export interface ConfirmInput { title: string; message?: React.ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
export interface PromptInput { title: string; label: string; initial?: string; confirmLabel?: string; message?: React.ReactNode }
interface Dialogs { confirm: (o: ConfirmInput) => Promise<boolean>; prompt: (o: PromptInput) => Promise<string | null> }
type Open = ({ kind: "confirm" } & ConfirmInput) | ({ kind: "prompt" } & PromptInput);
const DialogCtx = createContext<Dialogs>({ confirm: async () => false, prompt: async () => null });
/** In-app replacements for window.confirm and window.prompt; each resolves when the person answers. */
export const useDialog = () => useContext(DialogCtx);

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState<Open | null>(null);
  const [text, setText] = useState("");
  const resolver = useRef<((v: any) => void) | null>(null);
  const ask = useCallback(<T,>(o: Open, init = ""): Promise<T> => new Promise<T>((resolve) => {
    resolver.current?.(o.kind === "confirm" ? false : null); // a dialog already open counts as cancelled
    resolver.current = resolve; setText(init); setOpen(o);
  }), []);
  const value = useRef<Dialogs>({
    confirm: (o) => ask<boolean>({ kind: "confirm", ...o }),
    prompt: (o) => ask<string | null>({ kind: "prompt", ...o }, o.initial ?? ""),
  }).current;
  const finish = (ok: boolean) => {
    const r = resolver.current; resolver.current = null;
    if (open?.kind === "prompt") r?.(ok ? text.trim() || null : null); else r?.(ok);
    setOpen(null);
  };
  return (
    <DialogCtx.Provider value={value}>
      {children}
      {open && (
        <div className="modal-backdrop dialog-layer" onMouseDown={(e) => e.target === e.currentTarget && finish(false)}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); } }}>
          <form className="modal dialog" role={open.kind === "confirm" && open.danger ? "alertdialog" : "dialog"} aria-label={open.title}
            onSubmit={(e) => { e.preventDefault(); finish(true); }}>
            <div className="modal-body">
              <b className="dialog-title">{open.title}</b>
              {open.message && <div className="dialog-message">{open.message}</div>}
              {open.kind === "prompt" && (
                <label className="field">
                  <span className="field-label">{open.label}</span>
                  <input autoFocus value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.target.select()} />
                </label>
              )}
            </div>
            <div className="modal-foot dialog-foot">
              <button type="button" className="btn" onClick={() => finish(false)}>{open.kind === "confirm" ? open.cancelLabel ?? "Cancel" : "Cancel"}</button>
              <button type="submit" className={`btn ${open.kind === "confirm" && open.danger ? "danger" : "primary"}`} autoFocus={open.kind === "confirm"}
                disabled={open.kind === "prompt" && !text.trim()}>
                {open.confirmLabel ?? "OK"}
              </button>
            </div>
          </form>
        </div>
      )}
    </DialogCtx.Provider>
  );
}

// ------------------------------------------------------------------ menus
export interface MenuItem { label: string; icon?: IconName; onClick?: () => void; checked?: boolean; danger?: boolean; hint?: string; disabled?: boolean; divider?: boolean; /** a submenu (right-click menus) */ children?: MenuItem[]; /** with `children`: a type-to-filter box */ filterable?: boolean }

/** A button that opens a small list of actions. Closes on outside click or Escape. */
export function Menu({ label, icon, items, align = "left", variant = "ghost", iconOnly, title, filterable }: {
  label?: string; icon?: IconName; items: MenuItem[]; align?: "left" | "right"; variant?: "ghost" | "default"; iconOnly?: boolean; title?: string;
  /** Show a type-to-filter box when the list is long (more than 7 entries). */
  filterable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  useEffect(() => { if (!open) { setQ(""); setHi(0); } }, [open]);
  const showFilter = !!filterable && items.length > 7;
  const needle = q.trim().toLowerCase();
  const visible = needle ? items.filter((it) => !it.divider && it.label.toLowerCase().includes(needle)) : items;
  const pickable = visible.filter((it) => !it.divider && !it.disabled);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc, true); };
  }, [open]);
  return (
    <div className="menu" ref={root}>
      <button className={`btn sm ${variant === "ghost" ? "ghost" : ""}${iconOnly ? " icon" : ""}`} aria-haspopup="menu" aria-expanded={open} title={title ?? label} onClick={() => setOpen(!open)}>
        {icon && <Icon name={icon} size={15} />}{!iconOnly && label && <span>{label}</span>}{!iconOnly && <Icon name="chevronDown" size={12} />}
      </button>
      {open && (
        <div className={`menu-pop ${align}`} role="menu">
          {showFilter && (
            <input className="menu-filter" autoFocus placeholder="Type to filter…" aria-label="Filter the list" value={q}
              onChange={(e) => { setQ(e.target.value); setHi(0); }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(pickable.length - 1, h + 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
                else if (e.key === "Enter") { e.preventDefault(); const it = pickable[hi]; if (it) { setOpen(false); it.onClick?.(); } }
              }} />
          )}
          {needle && visible.length === 0 && <div className="hint" style={{ padding: "8px 10px" }}>Nothing matches “{q}”</div>}
          {visible.map((it, i) => it.divider ? <div key={i} className="menu-sep" /> : (
            <button key={i} role="menuitem" className={`menu-item${it.danger ? " danger" : ""}${showFilter && needle && pickable[hi] === it ? " hi" : ""}`} disabled={it.disabled} onClick={() => { setOpen(false); it.onClick?.(); }}>
              <span className="menu-check">{it.checked && <Icon name="check" size={14} />}</span>
              {it.icon && <Icon name={it.icon} size={15} />}
              <span className="menu-label">{it.label}</span>
              {it.hint && <kbd>{it.hint}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Icon-only button with a tooltip (and the shortcut, if any). */
export function IconButton({ icon, label, hint, onClick, disabled, active, danger, size = 15, className = "" }: {
  icon: IconName; label: string; hint?: string; onClick?: () => void; disabled?: boolean; active?: boolean; danger?: boolean; size?: number; className?: string;
}) {
  return (
    <button className={`btn sm ghost icon${active ? " on" : ""}${danger ? " danger" : ""} ${className}`} title={hint ? `${label} (${hint})` : label} aria-label={label} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={size} filled={active && icon === "star"} />
    </button>
  );
}
