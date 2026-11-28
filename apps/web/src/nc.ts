import { useEffect, useState } from "react";
import { api } from "./api.ts";

export interface NcState { available: boolean; connected: boolean; user: string; baseUrl: string }
let state: NcState = { available: false, connected: false, user: "", baseUrl: "" };
let loaded = false;
const listeners = new Set<(s: NcState) => void>();
export async function refreshNc() {
  try { state = await api<NcState>("/nextcloud"); } catch { /* signed out or offline: keep what we knew */ }
  loaded = true; listeners.forEach((l) => l(state));
}
/** The user's Nextcloud connection (for Contacts and Files features). */
export function useNc(): NcState {
  const [s, setS] = useState(state);
  useEffect(() => { listeners.add(setS); if (!loaded) refreshNc(); else setS(state); return () => { listeners.delete(setS); }; }, []);
  return s;
}
