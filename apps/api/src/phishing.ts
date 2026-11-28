import { pool } from "./db.ts";

/**
 * Cues that a message may not be from who it says: what the receiving mail server concluded about SPF / DKIM / DMARC
 * (from its Authentication-Results header), and whether the sender looks like someone you know but is not.
 */

export interface AuthResult {
  spf: string; dkim: string; dmarc: string; fromDomain: string; dkimDomain: string; spfDomain: string; present: boolean;
  /** One entry per DKIM signature that passed: its domain (header.d, else the domain of header.i), "" when neither is given. */
  dkimPass: string[];
}

const word = (s: string, key: string) => s.match(new RegExp(`(?:^|[;\\s])${key}\\s*=\\s*([a-z]+)`, "i"))?.[1]?.toLowerCase() ?? "";
const prop = (s: string, key: string) => s.match(new RegExp(`${key}\\s*=\\s*"?([^\\s;"]+)`, "i"))?.[1]?.toLowerCase() ?? "";

/** The DKIM results that passed in one Authentication-Results value (RFC 8601), comments left out. */
export function passedDkim(s: string): string[] {
  const plain = s.replace(/\([^()]*\)/g, " ");
  return plain.split(";").slice(1).filter((r) => /^\s*dkim\s*=\s*pass\b/i.test(r))
    .map((r) => (prop(r, "header\\.d") || (prop(r, "header\\.i").split("@").pop() ?? "")).replace(/\.$/, ""));
}

/** The topmost Authentication-Results (the receiving server's own) plus Received-SPF as a fallback. */
export function parseAuth(ar: unknown, receivedSpf: unknown): AuthResult {
  const first = (Array.isArray(ar) ? ar[0] : ar);
  const s = typeof first === "string" ? first : (first as any)?.value ?? "";
  const rs = typeof receivedSpf === "string" ? receivedSpf : Array.isArray(receivedSpf) ? String(receivedSpf[0] ?? "") : "";
  const spf = word(s, "spf") || (rs.match(/^\s*([a-z]+)/i)?.[1]?.toLowerCase() ?? "");
  return {
    spf, dkim: word(s, "dkim"), dmarc: word(s, "dmarc"), present: !!(s || rs), dkimPass: passedDkim(s),
    fromDomain: prop(s, "header\\.from"), dkimDomain: prop(s, "header\\.d"), spfDomain: (prop(s, "smtp\\.mailfrom").split("@").pop() ?? ""),
  };
}

/** a and b are the same domain or one sits under the other (relaxed alignment, approximated without a public suffix list). */
const aligned = (a: string, b: string) => !!a && !!b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));

/**
 * The receiving server positively confirmed the From domain: DMARC passed, or a passing DKIM signature or an SPF pass is for
 * the From domain (or one above or below it). No results at all is not confirmation.
 */
export function senderAuthenticated(a: AuthResult | null | undefined, fromDomain: string): boolean {
  if (!a?.present) return false;
  const from = fromDomain.toLowerCase();
  if (a.dmarc === "pass") return true;
  if (a.dkimPass.some((d) => aligned(from, d))) return true;
  return a.spf === "pass" && aligned(from, a.spfDomain);
}

export interface Warning { kind: "auth" | "lookalike" | "name-spoof" | "impersonation"; level: "bad" | "warn"; message: string }

export function authWarnings(a: AuthResult, fromDomain: string): Warning[] {
  if (!a.present) return [];
  const out: Warning[] = [];
  const failed = (r: string) => r === "fail" || r === "permerror";
  if (a.dmarc === "fail") out.push({ kind: "auth", level: "bad", message: `This message failed the sender checks (DMARC): the server that sent it is not allowed to send mail as ${fromDomain || "this address"}. It may be forged.` });
  else if (failed(a.spf) && a.dkim !== "pass") out.push({ kind: "auth", level: "bad", message: `This message did not pass the sender checks (SPF ${a.spf}${a.dkim ? `, DKIM ${a.dkim}` : ""}). It may be forged.` });
  else if (a.spf === "softfail" && a.dkim !== "pass") out.push({ kind: "auth", level: "warn", message: "The sending server is not clearly allowed to send for this address (SPF softfail), and there is no valid signature (DKIM)." });
  // A valid signature from another domain is normal (mail sent through Microsoft 365, mailing services...). Whether it is acceptable
  // is what DMARC alignment decides, and that is covered above.
  return out;
}

// ---- look-alikes ----
const BRANDS = ["paypal.com", "microsoft.com", "office.com", "outlook.com", "google.com", "gmail.com", "apple.com", "icloud.com", "amazon.com", "facebook.com", "linkedin.com", "dropbox.com", "docusign.com", "netflix.com", "github.com", "nextcloud.com"];

export function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}
/** What the eye sees: 0 for o, 1/l/i alike, rn for m, and so on. */
export const skeleton = (s: string) => s.toLowerCase().replace(/rn/g, "m").replace(/vv/g, "w").replace(/cl/g, "d").replace(/0/g, "o").replace(/[1il|]/g, "l").replace(/5/g, "s").replace(/3/g, "e").replace(/\$/g, "s");
/** Top-level domains only their owner can register under (a message from mail.microsoft is from Microsoft), and sending infrastructure of big providers. */
const BRAND_TLDS = new Set(["microsoft", "google", "apple", "amazon", "azure", "office", "windows", "bing", "skype", "xbox", "aws", "youtube", "android", "chrome", "gmail", "linkedin", "facebook", "meta", "ibm", "oracle", "sap", "ing", "bmw"]);
const TRUSTED_INFRA = ["microsoft.com", "microsoftonline.com", "office365.com", "onmicrosoft.com", "outlook.com", "office.com", "amazonses.com", "google.com", "googlemail.com", "gmail.com", "sendgrid.net", "mailchimp.com", "mcsv.net", "mandrillapp.com", "salesforce.com", "atlassian.net", "github.com", "nextcloud.com"];
const sld = (d: string) => d.split(".").slice(-2, -1)[0] ?? d;
const registrable = (d: string) => d.split(".").slice(-2).join(".");
const mixedScript = (d: string) => /[^\u0000-\u007f]/.test(d) || d.split(".").some((l) => l.startsWith("xn--"));

export function domainWarnings(domain: string, known: { domain: string; weight: number }[]): Warning[] {
  domain = domain.toLowerCase();
  if (BRAND_TLDS.has(domain.split(".").pop() ?? "") || TRUSTED_INFRA.some((t) => domain === t || domain.endsWith(`.${t}`))) return [];
  const reg = registrable(domain);
  const out: Warning[] = [];
  if (mixedScript(domain)) out.push({ kind: "lookalike", level: "warn", message: `The sender's domain (${domain}) uses unusual characters that can imitate a familiar name.` });
  if (known.some((k) => k.domain === reg || domain === k.domain || domain.endsWith(`.${k.domain}`))) return out;
  for (const k of known) {
    const a = sld(reg), b = sld(k.domain);
    if (a === b || b.length < 5 || a.length < 5) continue;
    const sa = skeleton(a), sb = skeleton(b); // compare how they look, so paypa1-security matches paypal
    // one changed letter only counts for names long enough that it is unlikely to be chance (mail / gmail, or / ibm)
    const similar = (lev(a, b) === 1 && a.length >= 6 && b.length >= 6) || sa === sb || sa.split("-").includes(sb) || (a.length > b.length + 3 && sa.includes(sb));
    if (similar) { out.push({ kind: "lookalike", level: "bad", message: `The sender's domain (${reg}) looks like ${k.domain}, but it is not the same. This is a common way to trick people.` }); break; }
  }
  return out;
}

export async function senderWarnings(owner: string, accountId: string, fromName: string, fromAddr: string): Promise<Warning[]> {
  const addr = fromAddr.toLowerCase();
  const domain = addr.split("@")[1] ?? "";
  if (!domain) return [];
  // someone you have written to, or whose address is one of yours, is not second-guessed
  const { rows: self } = await pool.query(
    `select 1 from contacts c join accounts a on a.id = c.account_id where a.owner = $1 and c.email = $2 and c.to_count > 0
     union select 1 from identities i join accounts a on a.id = i.account_id where a.owner = $1 and lower(i.email) = $2 limit 1`, [owner, addr]);
  if (self.length) return [];
  const out: Warning[] = [];
  const { rows: ds } = await pool.query(
    `select split_part(c.email, '@', 2) as d, sum(c.to_count * 3 + c.from_count)::int as w from contacts c join accounts a on a.id = c.account_id
     where a.owner = $1 group by 1 having sum(c.to_count) > 0 or sum(c.from_count) >= 3 order by w desc limit 400`, [owner]);
  const { rows: own } = await pool.query("select distinct split_part(lower(i.email), '@', 2) as d from identities i join accounts a on a.id = i.account_id where a.owner = $1", [owner]);
  const known = [...own.map((r) => ({ domain: r.d as string, weight: 99 })), ...ds.map((r) => ({ domain: r.d as string, weight: r.w as number })), ...BRANDS.map((d) => ({ domain: d, weight: 1 }))];
  out.push(...domainWarnings(domain, known));

  const name = fromName.trim();
  const inName = name.match(/[^\s<>"']+@([^\s<>"']+\.[a-z]{2,})/i);
  if (inName && inName[1]!.toLowerCase() !== domain) out.push({ kind: "name-spoof", level: "bad", message: `The name shown (“${name}”) contains an address at ${inName[1]!.toLowerCase()}, but the message really comes from ${domain}.` });
  if (name.split(/\s+/).length >= 2 && !inName) {
    const { rows } = await pool.query(
      `select c.email from contacts c join accounts a on a.id = c.account_id where a.owner = $1 and lower(c.name) = lower($2) and c.email <> $3 and (c.to_count > 0 or c.from_count >= 2) limit 2`, [owner, name, addr]);
    if (rows.length) out.push({ kind: "impersonation", level: "warn", message: `You know someone called ${name} at ${rows[0].email}, but this message comes from a different address (${addr}).` });
  }
  return out;
}
