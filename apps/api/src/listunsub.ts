/**
 * Unsubscribing from mailing lists (List-Unsubscribe, RFC 2369, and its one-click form, RFC 8058): reading the headers and
 * deciding what to offer. One click (the service posts to the list's address) is offered only when a DKIM signature that passed
 * covers both List-Unsubscribe headers and its domain is the one-click address's or the sender's, as RFC 8058 asks, so a forged
 * or altered message cannot make the server call an address of the forger's choosing. Otherwise one unsubscribe address is
 * mailed, or the list's page is opened for the user. Mail in Junk gets no offer: answering spam confirms the address.
 */
export interface Unsubscribe {
  http: string | null; mailto: string | null; oneClick: boolean;
  /** The message's DKIM signatures: their domain (d=) and whether they cover List-Unsubscribe and List-Unsubscribe-Post (h=). */
  signatures?: { d: string; covers: boolean }[];
}
export type UnsubscribeOffer = { method: "one-click" | "link"; target: string } | { method: "mail"; target: string };

const unfold = (l: string) => l.slice(l.indexOf(":") + 1).replace(/\r?\n[ \t]+/g, " ").trim();

/** d= and h= of a DKIM-Signature header (RFC 6376 tag list). */
export function dkimSignature(line: string): { d: string; covers: boolean } {
  const tags = new Map(unfold(line).split(";").map((t) => {
    const i = t.indexOf("=");
    return [t.slice(0, i).trim().toLowerCase(), t.slice(i + 1).replace(/\s+/g, "")] as [string, string];
  }));
  const h = (tags.get("h") ?? "").toLowerCase().split(":");
  return { d: (tags.get("d") ?? "").toLowerCase().replace(/\.$/, ""), covers: h.includes("list-unsubscribe") && h.includes("list-unsubscribe-post") };
}

/** From the raw header lines; null when the message has no usable List-Unsubscribe. */
export function parseUnsubscribe(lines: { key: string; line: string }[] | undefined): Unsubscribe | null {
  const value = (key: string) => {
    const l = (lines ?? []).find((h) => h.key === key)?.line;
    return l ? unfold(l) : "";
  };
  const targets = [...value("list-unsubscribe").matchAll(/<\s*([^>\s]+)\s*>/g)].map((m) => m[1]!);
  const http = targets.find((t) => /^https?:\/\/[^\s]+$/i.test(t)) ?? null;
  const mailto = targets.find((t) => /^mailto:[^\s]+@[^\s]+$/i.test(t)) ?? null;
  if (!http && !mailto) return null;
  const oneClick = /(^|[\s;])List-Unsubscribe=One-Click(\s|;|$)/i.test(value("list-unsubscribe-post")) && !!http && /^https:/i.test(http);
  const signatures = (lines ?? []).filter((h) => h.key === "dkim-signature").slice(0, 10).map((h) => dkimSignature(h.line));
  return { http: http && http.length <= 2000 ? http : null, mailto: mailto && mailto.length <= 2000 ? mailto : null, oneClick, signatures };
}

/** The one address a mailto: link names first; its subject, body and other recipients are not used. */
export function mailtoAddress(mailto: string | null | undefined): string | null {
  if (!mailto) return null;
  let to: string;
  try { to = decodeURIComponent(mailto.slice(7).split("?")[0]!); } catch { return null; }
  to = to.split(",")[0]!.trim();
  return /^[^\s@,;:<>()"\\]+@[^\s@,;:<>()"\\]+\.[^\s@,;:<>()"\\]+$/.test(to) ? to : null;
}

/** host is domain d or a subdomain of it */
const under = (host: string, d: string) => !!d && (host === d || host.endsWith(`.${d}`));

/**
 * Whether one click may be used: a DKIM signature that the receiving server says passed (header.d / header.i in its
 * Authentication-Results) covers both List-Unsubscribe headers, and its domain is the one-click address's or the sender's.
 */
export function oneClickTrusted(u: Unsubscribe, auth: { dkimPass?: string[] } | null | undefined, fromDomain: string): boolean {
  if (!u.oneClick || !u.http) return false;
  const host = new URL(u.http).hostname.toLowerCase();
  const sigs = u.signatures ?? [];
  const passed = auth?.dkimPass ?? [];
  const domains = passed.flatMap((p) => {
    // no header.d / header.i: only unambiguous when the message has a single signature and a single passing result
    if (!p) return passed.length === 1 && sigs.length === 1 ? [sigs[0]!] : [];
    // exactly the signature's own domain: a passing result for attacker.example must not vouch for a planted d=example
    return sigs.filter((s) => s.d.toLowerCase().replace(/\.$/, "") === p);
  }).filter((s) => s.covers).map((s) => s.d);
  return domains.some((d) => under(host, d) || under(fromDomain.toLowerCase(), d));
}

/** What the reader may offer for a message. */
export function unsubscribeOffer(u: Unsubscribe | null | undefined, auth: { dkimPass?: string[] } | null | undefined, folderSpecial: string | null, fromAddr = ""): UnsubscribeOffer | null {
  if (!u || folderSpecial === "\\Junk") return null;
  const fromDomain = fromAddr.split("@").pop() ?? "";
  if (oneClickTrusted(u, auth, fromAddr.includes("@") ? fromDomain : "")) return { method: "one-click", target: new URL(u.http!).hostname };
  const to = mailtoAddress(u.mailto);
  if (to) return { method: "mail", target: to };
  if (u.http) return { method: "link", target: u.http };
  return null;
}

/**
 * The list's posting address from List-Post (RFC 2369), for "Reply to list": its first mailto: address, or null when the
 * header is missing, says NO (a list nobody may post to) or names only a web page.
 */
export function parseListPost(lines: { key: string; line: string }[] | undefined): string | null {
  const l = (lines ?? []).find((h) => h.key === "list-post")?.line;
  if (!l) return null;
  const mailto = [...unfold(l).matchAll(/<\s*([^>\s]+)\s*>/g)].map((m) => m[1]!).find((t) => /^mailto:/i.test(t) && t.length <= 2000);
  return mailtoAddress(mailto);
}
