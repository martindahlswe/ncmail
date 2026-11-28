import { useSyncExternalStore } from "react";

/** Small settings kept in this browser. Components re-render when one changes (also across tabs). */
const DEFAULTS = { density: "comfortable" as "comfortable" | "compact", undoSend: 10, threads: true, persist: true, confirmDelete: false, readReceipt: false };
export type Prefs = typeof DEFAULTS;

const KEY = (k: string) => `ncmail.pref.${k}`;
const listeners = new Set<() => void>();
const LEGACY: Partial<Record<keyof Prefs, string>> = { threads: "ncmail.threads", persist: "ncmail.persist" };

export function getPref<K extends keyof Prefs>(k: K): Prefs[K] {
  const raw = localStorage.getItem(KEY(k)) ?? (LEGACY[k] ? localStorage.getItem(LEGACY[k]!) : null);
  if (raw == null) return DEFAULTS[k];
  const d = DEFAULTS[k];
  if (typeof d === "boolean") return (raw !== "0" && raw !== "false") as Prefs[K];
  if (typeof d === "number") return (Number.isFinite(Number(raw)) ? Number(raw) : d) as Prefs[K];
  return raw as Prefs[K];
}
export function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]) {
  const raw = typeof v === "boolean" ? (v ? "1" : "0") : String(v);
  localStorage.setItem(KEY(k), raw);
  if (LEGACY[k]) localStorage.setItem(LEGACY[k]!, raw); // cache.ts reads the old keys at startup
  listeners.forEach((l) => l());
}
window.addEventListener("storage", () => listeners.forEach((l) => l()));

export function usePref<K extends keyof Prefs>(k: K): [Prefs[K], (v: Prefs[K]) => void] {
  const v = useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => getPref(k));
  return [v, (x) => setPref(k, x)];
}
