/**
 * Stale-while-revalidate cache for read requests.
 *
 *  - peek(path)  returns what we last saw instantly (memory, then localStorage), or undefined
 *  - load(path)  fetches fresh data (identical concurrent requests share one fetch) and stores it
 *
 * Screens show peek() immediately and replace it with load() when it arrives, so folders, lists and messages
 * you have seen before appear with no wait. Only first pages of lists, the account list and folder lists are persisted
 * (so the app starts with your last view); message bodies live in memory only. Persisting stores message headers
 * (sender, subject) in this browser; General settings can turn it off, which also clears it.
 */

const PREFIX = "ncmail.cache.";
const INDEX_KEY = PREFIX + "__keys";
const MAX_PERSISTED = 60;
const MAX_BODIES = 150;

const mem = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();

export const persistEnabled = () => localStorage.getItem("ncmail.persist") !== "0";
const persistable = (path: string) =>
  /^\/accounts$|^\/accounts\/[^/]+\/folders$|^\/(folders\/[^/?]+|unified)\/messages\?limit=50(&(unread|threads|sort|filter)=[\w]+)*$/.test(path);

/** First page of a folder's list; the key shared by every screen that shows or prefetches it. */
export const listPath = (folderId: string, o: { filter?: string; sort?: string; threads?: boolean } = {}) =>
  `${folderId === "unified" ? "/unified" : `/folders/${folderId}`}/messages?limit=50${o.filter && o.filter !== "all" ? `&filter=${o.filter}` : ""}${o.sort && o.sort !== "date_desc" ? `&sort=${o.sort}` : ""}${o.threads && (!o.sort || o.sort.startsWith("date")) ? "&threads=1" : ""}`;

export function peek<T>(path: string): T | undefined {
  if (mem.has(path)) return mem.get(path) as T;
  if (persistable(path) && persistEnabled()) {
    try {
      const raw = localStorage.getItem(PREFIX + path);
      if (raw) { const v = JSON.parse(raw); mem.set(path, v); return v as T; }
    } catch { /* unreadable: treat as a miss */ }
  }
  return undefined;
}

export function put(path: string, value: unknown) {
  mem.delete(path); mem.set(path, value); // re-insert so Map order = recency
  if (path.startsWith("/messages/")) {
    const bodies = [...mem.keys()].filter((k) => k.startsWith("/messages/"));
    for (const k of bodies.slice(0, Math.max(0, bodies.length - MAX_BODIES))) mem.delete(k);
  }
  if (persistable(path) && persistEnabled()) {
    try {
      localStorage.setItem(PREFIX + path, JSON.stringify(value));
      const keys: string[] = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "[]").filter((k: string) => k !== path);
      keys.push(path);
      while (keys.length > MAX_PERSISTED) localStorage.removeItem(PREFIX + keys.shift()!);
      localStorage.setItem(INDEX_KEY, JSON.stringify(keys));
    } catch { /* storage full or blocked: memory cache still works */ }
  }
}

/** Change a cached value in place (e.g. mark a cached message as read). */
export function patchCached<T>(path: string, fn: (v: T) => T) {
  const v = peek<T>(path);
  if (v !== undefined) put(path, fn(v));
}

export function load<T>(path: string): Promise<T> {
  const existing = inflight.get(path);
  if (existing) return existing as Promise<T>;
  const p = fetch(`/api${path}`).then(async (r) => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      if (r.status === 401 && body.code === "auth") window.dispatchEvent(new Event("ncmail:auth-required"));
      throw new Error(body.error ?? r.statusText);
    }
    const v = await r.json();
    put(path, v);
    return v as T;
  }).finally(() => inflight.delete(path));
  inflight.set(path, p);
  return p;
}

/** Warm the cache for something the user is about to open (hover). Errors are ignored. */
export function prefetch(path: string) {
  if (!mem.has(path)) load(path).catch(() => {});
}

export function clearPersisted() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch { /* ignore */ }
}

// ---- remembering the last view, so the app can start by fetching exactly what it will show ----
const LAST = "ncmail.last";
export const lastView = (): { accountId?: string; folderId?: string } => {
  if (!persistEnabled()) return {};
  try { return JSON.parse(localStorage.getItem(LAST) ?? "{}"); } catch { return {}; }
};
export const rememberView = (v: { accountId: string | null; folderId: string | null }) => {
  if (persistEnabled()) try { localStorage.setItem(LAST, JSON.stringify(v)); } catch { /* ignore */ }
};

/** Called before the app renders: start the requests the first screen needs, all at once instead of one after another. */
export function primeLastView() {
  const { accountId, folderId } = lastView();
  load("/accounts").catch(() => {});
  if (accountId) load(`/accounts/${accountId}/folders`).catch(() => {});
  if (folderId) load(listPath(folderId, { threads: localStorage.getItem("ncmail.threads") !== "0" })).catch(() => {});
}
