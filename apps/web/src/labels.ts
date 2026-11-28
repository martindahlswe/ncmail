import { useEffect, useState } from "react";
import { api } from "./api.ts";

export interface Label { slug: string; name: string; color: string }
export interface Saved { id: string; name: string; query: string }
const labels = new Map<string, Label[]>(), saved = new Map<string, Saved[]>();
const listeners = new Set<() => void>();
const bump = () => listeners.forEach((l) => l());

export async function refreshLabels(accountId: string) {
  try { labels.set(accountId, await api<Label[]>(`/accounts/${accountId}/labels`)); saved.set(accountId, await api<Saved[]>(`/accounts/${accountId}/saved-searches`)); } catch { /* keep what we had */ }
  bump();
}
/** An account's labels and saved searches (shared across the sidebar, list, reader and settings). */
export function useLabels(accountId: string | null | undefined): { labels: Label[]; saved: Saved[] } {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!accountId) return;
    const l = () => setN((n) => n + 1);
    listeners.add(l);
    if (!labels.has(accountId)) refreshLabels(accountId);
    return () => { listeners.delete(l); };
  }, [accountId]);
  return { labels: (accountId && labels.get(accountId)) || [], saved: (accountId && saved.get(accountId)) || [] };
}
