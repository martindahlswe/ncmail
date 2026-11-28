/**
 * Mail runs inside Nextcloud's page. Nextcloud (the parent window) vouches for the user: it hands this frame a short-lived signed token,
 * which the server exchanges for a session. The session is short and is renewed the same way, so it ends when the Nextcloud session does.
 * Messages are only accepted from the parent window, from the Nextcloud address the server was configured with.
 */
export const inFrame = window.parent !== window;
let parentOrigin = "";
export const setParentOrigin = (o: string) => { parentOrigin = o; };

type Listener = (m: any) => void;
const listeners = new Set<Listener>();
window.addEventListener("message", (e) => {
  if (!parentOrigin || e.origin !== parentOrigin || e.source !== window.parent || !e.data || typeof e.data.type !== "string" || !e.data.type.startsWith("ncmail:")) return;
  listeners.forEach((l) => l(e.data));
});
const post = (type: string, extra: object = {}) => { if (inFrame && parentOrigin) window.parent.postMessage({ type, ...extra }, parentOrigin); };
const once = (type: string[], ms: number) => new Promise<any>((resolve) => {
  const l: Listener = (m) => { if (type.includes(m.type)) { clearTimeout(t); listeners.delete(l); resolve(m); } };
  const t = setTimeout(() => { listeners.delete(l); resolve(null); }, ms);
  listeners.add(l);
});
export const onParent = (type: string, fn: (m: any) => void) => { const l: Listener = (m) => { if (m.type === type) fn(m); }; listeners.add(l); return () => { listeners.delete(l); }; };

let inflight: Promise<boolean> | null = null;
/** Ask Nextcloud for a token and exchange it for a session. False when Nextcloud will not vouch for the user any more. */
export function handshake(first = false): Promise<boolean> {
  if (!inFrame || !parentOrigin) return Promise.resolve(false); // nobody to ask (yet)
  return (inflight ??= (async () => {
    try {
      const reply = once(["ncmail:token", "ncmail:no-session"], 10_000);
      post(first ? "ncmail:hello" : "ncmail:token-request");
      const m = await reply;
      if (m?.type !== "ncmail:token") return false;
      const r = await fetch("/api/auth/handoff", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: m.token }) });
      return r.ok;
    } catch { return false; } finally { inflight = null; }
  })());
}

/** Keep the session alive while the page is in use: renew every few minutes and whenever the tab comes back. */
export function keepSession(seconds: number, onLost: () => void) {
  let last = Date.now();
  const renew = async () => { if (await handshake()) last = Date.now(); else onLost(); };
  const every = Math.max(60, Math.min(300, Math.floor(seconds / 3))) * 1000;
  const t = setInterval(() => { if (!document.hidden) renew(); }, every);
  const vis = () => { if (!document.hidden && Date.now() - last > every / 2) renew(); };
  document.addEventListener("visibilitychange", vis);
  return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
}

export const tellParentReady = () => post("ncmail:ready");
// One request at a time: each one replaces Nextcloud's app password, so two at once could leave the service with a revoked one.
let linking: Promise<void> | null = null;
export const askParentToLink = (): Promise<void> => linking ??= (async () => {
  try { const done = once(["ncmail:link-done"], 20_000); post("ncmail:need-link"); await done; } finally { linking = null; }
})();
