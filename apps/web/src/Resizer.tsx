import { useEffect, useRef, useState } from "react";

/**
 * A draggable divider between two columns. It resizes the element just before it by setting a CSS variable on <html>
 * (so every rule using it follows), and remembers the width. Double-click resets; arrow keys nudge it.
 */
export function Resizer({ cssVar, storageKey, min, max, label }: { cssVar: string; storageKey: string; min: number; max: number; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(min); // the width, for screen readers (a separator that can be moved needs a value)
  const set = (w: number) => {
    const v = Math.round(Math.min(max, Math.max(min, w)));
    document.documentElement.style.setProperty(cssVar, `${v}px`);
    setNow(v);
  };
  const measure = () => { const prev = ref.current?.previousElementSibling as HTMLElement | null; if (prev) setNow(Math.round(Math.min(max, Math.max(min, prev.getBoundingClientRect().width)))); };
  useEffect(() => {
    const saved = Number(localStorage.getItem(storageKey));
    if (saved) set(saved); else measure();
  }, []);
  const save = () => { const v = parseInt(document.documentElement.style.getPropertyValue(cssVar)); if (v) localStorage.setItem(storageKey, String(v)); };
  return (
    <div ref={ref} className="resizer" role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0}
      aria-valuemin={min} aria-valuemax={max} aria-valuenow={now} aria-valuetext={`${now} pixels wide`} title="Drag to resize, double-click to reset"
      onPointerDown={(e) => {
        const prev = ref.current?.previousElementSibling as HTMLElement | null;
        if (!prev) return;
        e.preventDefault();
        ref.current!.setPointerCapture(e.pointerId);
        document.body.classList.add("resizing");
        const left = prev.getBoundingClientRect().left;
        const move = (ev: PointerEvent) => set(ev.clientX - left);
        const up = () => { document.body.classList.remove("resizing"); ref.current?.removeEventListener("pointermove", move); ref.current?.removeEventListener("pointerup", up); save(); };
        ref.current!.addEventListener("pointermove", move); ref.current!.addEventListener("pointerup", up);
      }}
      onDoubleClick={() => { document.documentElement.style.removeProperty(cssVar); localStorage.removeItem(storageKey); requestAnimationFrame(measure); }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const prev = ref.current?.previousElementSibling as HTMLElement;
        set(prev.getBoundingClientRect().width + (e.key === "ArrowRight" ? 16 : -16)); save();
      }} />
  );
}
