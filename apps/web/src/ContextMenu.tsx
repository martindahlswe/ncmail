import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./icons.tsx";
import type { MenuItem } from "./ui.tsx";

/**
 * Right-click menus. `useContextMenu()` returns a function: call it from onContextMenu with the event and the entries.
 * Entries can have `children` (a submenu; add `filterable` for long lists), a shortcut hint, and can be disabled or dangerous.
 * Works with the keyboard too: arrows to move, Right/Left for submenus, Enter to choose, Esc to close, and the menu key / Shift+F10 on a focused element.
 */
type Open = (e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation?: () => void }, items: MenuItem[], onClose?: () => void) => void;
const Ctx = createContext<Open>(() => {});
export const useContextMenu = () => useContext(Ctx);

interface State { x: number; y: number; items: MenuItem[]; onClose?: () => void }

export function ContextMenuProvider({ children }: { children: React.ReactNode }) {
  const [s, setS] = useState<State | null>(null);
  const close = useCallback(() => setS((cur) => { cur?.onClose?.(); return null; }), []);
  const open = useCallback<Open>((e, items, onClose) => {
    e.preventDefault(); e.stopPropagation?.();
    setS((cur) => { cur?.onClose?.(); return items.length ? { x: e.clientX, y: e.clientY, items, onClose } : null; });
  }, []);

  useEffect(() => {
    if (!s) return;
    const away = (e: Event) => { if (!(e.target as Element).closest?.(".ctx")) close(); };
    // scrolling the page closes the menu, but scrolling inside the menu (a long submenu) must not
    const outside = (e: Event) => { const t = e.target; if (!(t instanceof Element) || !t.closest(".ctx")) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); } };
    document.addEventListener("mousedown", away, true); document.addEventListener("contextmenu", away, true);
    document.addEventListener("keydown", esc, true);
    window.addEventListener("resize", close); window.addEventListener("blur", close); document.addEventListener("scroll", outside, true); document.addEventListener("wheel", outside, { passive: true, capture: true });
    return () => {
      document.removeEventListener("mousedown", away, true); document.removeEventListener("contextmenu", away, true);
      document.removeEventListener("keydown", esc, true);
      window.removeEventListener("resize", close); window.removeEventListener("blur", close); document.removeEventListener("scroll", outside, true); document.removeEventListener("wheel", outside, true);
    };
  }, [s, close]);

  return (
    <Ctx.Provider value={open}>
      {children}
      {s && <div className="ctx" role="presentation"><Panel items={s.items} x={s.x} y={s.y} root close={close} /></div>}
    </Ctx.Provider>
  );
}

function Panel({ items, x, y, root, close, onLeft, filter }: { items: MenuItem[]; x?: number; y?: number; root?: boolean; close: () => void; onLeft?: () => void; filter?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hi, setHi] = useState(-1);
  const [child, setChild] = useState(-1);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [flip, setFlip] = useState(false);
  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter((i) => !i.divider && i.label.toLowerCase().includes(needle)) : items;
  const live = shown.map((it, i) => ({ it, i })).filter((r) => !r.it.divider && !r.it.disabled);

  // keep the panel on screen
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight;
    if (root) setPos({ left: Math.max(6, Math.min(x!, W - r.width - 6)), top: Math.max(6, Math.min(y!, H - r.height - 6)) });
    else { setFlip(r.right > W - 6); if (r.bottom > H - 6) el.style.top = `${Math.min(0, H - 6 - r.bottom) - 4}px`; }
  }, [root, x, y, items.length, q]);
  useEffect(() => { if (root) ref.current?.focus(); }, [root]);

  const choose = (it: MenuItem) => { if (it.disabled || it.divider) return; if (it.children) { return; } close(); it.onClick?.(); };
  const move = (d: number) => { if (!live.length) return; const at = live.findIndex((r) => r.i === hi); setHi(live[(at + d + live.length) % live.length]!.i); setChild(-1); };

  return (
    <div ref={ref} className={`ctx-panel${root ? "" : " ctx-sub"}${flip ? " flip" : ""}`} role="menu" tabIndex={-1}
      style={root ? { left: pos?.left ?? x, top: pos?.top ?? y, visibility: pos ? "visible" : "hidden" } : undefined}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement && !["ArrowDown", "ArrowUp", "Enter", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
        if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
        else if (e.key === "ArrowRight" && items[hi]?.children) { e.preventDefault(); setChild(hi); }
        else if (e.key === "ArrowLeft" && onLeft) { e.preventDefault(); e.stopPropagation(); onLeft(); }
        else if (e.key === "Enter" || (e.key === " " && !(e.target instanceof HTMLInputElement))) {
          e.preventDefault(); const it = (hi >= 0 ? items[hi] : needle ? live[0]?.it : undefined); if (!it) return;
          if (it.children) setChild(hi); else choose(it);
        }
      }}>
      {filter && <input className="menu-filter" autoFocus={!root} placeholder="Type to filter…" aria-label="Filter the list" value={q} onChange={(e) => { setQ(e.target.value); setHi(-1); }} />}
      {needle && shown.length === 0 && <div className="hint" style={{ padding: "8px 10px" }}>Nothing matches “{q}”</div>}
      {shown.map((it, i) => it.divider ? <div key={i} className="menu-sep" role="separator" /> : (
        <div key={i} className="ctx-row" onMouseEnter={() => { setHi(i); setChild(it.children && !it.disabled ? i : -1); }}>
          <button role="menuitem" aria-haspopup={it.children ? "menu" : undefined} disabled={it.disabled}
            className={`menu-item${it.danger ? " danger" : ""}${hi === i || child === i ? " hi" : ""}`}
            onClick={() => (it.children ? setChild(i) : choose(it))}>
            <span className="menu-check">{it.checked && <Icon name="check" size={14} />}</span>
            {it.icon && <Icon name={it.icon} size={15} />}
            <span className="menu-label">{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
            {it.children && <Icon name="chevronRight" size={13} />}
          </button>
          {it.children && child === i && <Panel items={it.children} filter={it.filterable && it.children.length > 7} close={close} onLeft={() => { setChild(-1); ref.current?.focus(); }} />}
        </div>
      ))}
    </div>
  );
}
