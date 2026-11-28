import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api.ts";

/**
 * Reading choices kept on the server (so they hold on every device): senders whose remote images load without asking,
 * and whether read-receipt requests are offered. Loaded once and shared by every open message and Settings.
 */
interface State { imageSenders: string[] | null; readReceipts: "ask" | "never" | null }
let state: State = { imageSenders: null, readReceipts: null };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };

function load() {
  loading ??= Promise.all([
    api<string[]>("/image-senders").then((imageSenders) => set({ imageSenders })).catch(() => set({ imageSenders: [] })),
    api<{ readReceipts?: "ask" | "never" }>("/prefs").then((p) => set({ readReceipts: p.readReceipts ?? "ask" })).catch(() => set({ readReceipts: "ask" })),
  ]).then(() => {});
  return loading;
}

export function useReaderPrefs() {
  useEffect(() => { load(); }, []);
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => state);
}

/** Whether this address is allowed, by itself or by its domain ("@example.com"). */
export function imagesAllowedFor(list: string[] | null, address: string) {
  const a = address.trim().toLowerCase();
  const domain = a.split("@")[1];
  return !!list && !!domain && (list.includes(a) || list.includes(`@${domain}`));
}

export async function allowImagesFrom(sender: string) {
  const r = await api<{ sender: string }>("/image-senders", { method: "POST", body: JSON.stringify({ sender }) });
  set({ imageSenders: [...new Set([...(state.imageSenders ?? []), r.sender])] });
}
export async function stopImagesFrom(sender: string) {
  await api(`/image-senders/${encodeURIComponent(sender)}`, { method: "DELETE" });
  set({ imageSenders: (state.imageSenders ?? []).filter((s) => s !== sender) });
}
export async function setReadReceipts(v: "ask" | "never") {
  const before = state.readReceipts;
  set({ readReceipts: v });
  try { await api("/prefs", { method: "PATCH", body: JSON.stringify({ readReceipts: v }) }); }
  catch (e) { set({ readReceipts: before }); throw e; }
}
