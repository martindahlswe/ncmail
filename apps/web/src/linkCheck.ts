/** Links that go somewhere other than they say: the usual way phishing hides its destination. */
export interface LinkIssue { text: string; to: string; reason: string }

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu", "ne", "or"]);
const registrable = (host: string) => { const p = host.split("."); const n = p.length >= 3 && p[p.length - 1]!.length === 2 && SECOND_LEVEL.has(p[p.length - 2]!) ? 3 : 2; return p.slice(-n).join("."); };
const TEXT_URL = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(?:[/?#].*)?$/i;

export function analyzeLinks(html: string): { html: string; issues: LinkIssue[] } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const issues: LinkIssue[] = [];
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    let u: URL;
    try { u = new URL(a.getAttribute("href")!, "https://placeholder.invalid"); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.hostname === "placeholder.invalid") continue;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const text = (a.textContent ?? "").trim().replace(/\s+/g, " ");
    let reason = "";
    const shown = text.match(TEXT_URL)?.[1]?.toLowerCase().replace(/^www\./, "");
    if (shown && registrable(shown) !== registrable(host)) reason = `The link says ${shown} but goes to ${host}.`;
    else if (u.username) reason = `The address hides its real destination (${host}) behind a user name.`;
    else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) reason = `The link goes to a numeric address (${host}), not a named site.`;
    else if (host.split(".").some((l) => l.startsWith("xn--"))) reason = `The link goes to ${host}, which uses unusual characters that can imitate another name.`;
    if (reason) {
      a.setAttribute("data-ncmail-warn", reason); a.setAttribute("title", reason);
      issues.push({ text: text.slice(0, 80), to: host, reason });
    }
  }
  const seen = new Set<string>();
  const unique = issues.filter((i) => { const k = `${i.text}|${i.to}`; return seen.has(k) ? false : (seen.add(k), true); }).slice(0, 6);
  return { html: issues.length ? doc.body.innerHTML : html, issues: unique };
}
