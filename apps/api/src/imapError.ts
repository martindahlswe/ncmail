/**
 * What went wrong with the mail server, in words a person can act on.
 *
 * imapflow reports every refusal (a NO or BAD answer) as "Command failed" and keeps the server's own words in `responseText`
 * and its machine-readable reason (RFC 5530 response codes such as NOPERM or OVERQUOTA) in `serverResponseCode`. Showing
 * "Command failed" tells nobody anything, so the reason is turned into a sentence and the server's text, cleaned of protocol
 * noise, is added where it helps.
 */
import { isConnectionLost } from "./mail.ts";

const PLAIN: Record<string, string> = {
  NOPERM: "You do not have permission for this on the mail server.",
  NONEXISTENT: "This folder is no longer on the mail server.",
  TRYCREATE: "That folder does not exist on the mail server.",
  ALREADYEXISTS: "A folder with that name already exists there.",
  OVERQUOTA: "The mailbox is full: it is over its storage quota on the mail server.",
  LIMIT: "The mail server refused because a limit was reached (too many messages or folders at once).",
  INUSE: "The mail server says this folder is in use by something else right now. Try again in a moment.",
  UNAVAILABLE: "The mail server cannot reach this mailbox right now. Try again later.",
  SERVERBUG: "The mail server had an internal error with this folder. Its administrator can find the details in the mail server's log.",
  CORRUPTION: "The mail server found this folder damaged. Its administrator can repair it.",
  AUTHENTICATIONFAILED: "The mail server did not accept the sign-in. Check the password (or app password) in the account settings.",
  AUTHORIZATIONFAILED: "The mail server accepted the sign-in but does not let this account in.",
  EXPIRED: "The password for this account has expired on the mail server.",
  PRIVACYREQUIRED: "The mail server requires an encrypted connection. Change the security setting of this account.",
  CONTACTADMIN: "The mail server asks you to contact its administrator.",
  CANNOT: "The mail server cannot do this.",
  EXPUNGEISSUED: "Some of these messages were deleted on the mail server meanwhile.",
};

/** The server's words without the protocol around them: the tag, NO/BAD, a [CODE], Dovecot's timings and timestamps. */
export function serverText(e: any): string {
  const raw = String(e?.responseText ?? (typeof e?.response === "string" ? e.response : "") ?? "");
  return raw
    .replace(/^[A-Za-z0-9.*]+ (NO|BAD) /, "")
    .replace(/\[[A-Z-]+(?: [^\]]*)?\]\s*/g, "")      // [SERVERBUG], [NOPERM] ...
    .replace(/\[\d{4}-\d{2}-\d{2} [\d:]+\]\s*/g, "") // [2026-11-27 21:45:47]
    .replace(/\s*\(\d+\.\d+(?: \+ \d+\.\d+)* secs\)\.?/g, "") // (0.011 + 0.000 + 0.010 secs).
    .replace(/\s+/g, " ").trim().slice(0, 200);
}

/** The reason in plain words; `what` names the action for a refusal with no known reason ("open this folder"). */
export function describeImapError(e: any, what = "do this"): string {
  if (isConnectionLost(e)) return "The connection to the mail server was lost. It is tried again automatically.";
  const code = String(e?.serverResponseCode ?? "").toUpperCase();
  if (e?.authenticationFailed) return PLAIN.AUTHENTICATIONFAILED!;
  const text = serverText(e);
  const plain = PLAIN[code];
  if (plain) {
    // the server's own words add something for most reasons; not for "internal error, see the log", which is in the sentence
    const generic = !text || /internal error|refer to server log/i.test(text) || code === "AUTHENTICATIONFAILED";
    return generic ? plain : `${plain} (The mail server said: ${text})`;
  }
  if (text && !/^command failed\.?$/i.test(text)) return `The mail server refused to ${what}: ${text}`;
  if (e?.responseStatus === "NO" || e?.responseStatus === "BAD" || /^Command failed/i.test(String(e?.message ?? ""))) return `The mail server refused to ${what}.`;
  if (e?.code === "ETIMEDOUT" || /timed? ?out/i.test(String(e?.message ?? ""))) return "The mail server did not answer in time. It is tried again automatically.";
  return String(e?.message ?? e ?? "Something went wrong with the mail server.");
}

/** A refusal from the mail server (imapflow: a NO or BAD answer), as opposed to a bug in the service. */
export const isImapRefusal = (e: any) => e?.responseStatus === "NO" || e?.responseStatus === "BAD" || !!e?.serverResponseCode || !!e?.authenticationFailed;
