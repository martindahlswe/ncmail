import { z } from "zod";

export const serverSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  /** "tls" = implicit TLS (993/465), "starttls" = upgrade (143/587), "none" = plaintext (dev only) */
  security: z.enum(["tls", "starttls", "none"]),
  username: z.string().min(1),
  password: z.string().min(1),
});
export type ServerConfig = z.infer<typeof serverSchema>;

/** An address you can send as. One account (one login) can have several; exactly one is the default. */
export const identityInputSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  /** Rich signature (HTML produced by the editor, small pictures included as data: URLs) and its plain-text counterpart; both optional. */
  signatureHtml: z.string().max(400_000).optional(),
  signatureText: z.string().max(20_000).optional(),
  /** The rich signature was entered as HTML (pasted from a signature generator or another mail program): the composer keeps
   *  it exactly as it is, as one block, instead of rewriting it into the editor's simpler formatting. */
  signatureIsHtml: z.boolean().optional(),
  /** Where replies should go, when that is not this address. Empty: replies come back to this address. */
  replyTo: z.union([z.literal(""), z.string().email()]).optional(),
});
export type IdentityInput = z.infer<typeof identityInputSchema>;
export interface Identity { id: string; accountId: string; name: string; email: string; isDefault: boolean; signatureHtml: string; signatureText: string; signatureIsHtml: boolean; replyTo: string }

export const accountInputSchema = z.object({
  /** A label only you see (sidebar, account list), e.g. "Work". */
  name: z.string().min(1),
  /** The name recipients see on mail you send from the first sender address. Defaults to `name`. */
  senderName: z.string().min(1).optional(),
  email: z.string().email(),
  imap: serverSchema,
  smtp: serverSchema,
  /** How many months of mail the first sync brings in (0 = everything, omitted = the server default). */
  syncMonths: z.number().int().min(0).max(600).nullable().optional(),
});
export type AccountInput = z.infer<typeof accountInputSchema>;

/** For testing/editing: a blank password means "keep the stored one" (needs accountId). */
const serverLoose = serverSchema.extend({ password: z.string().default("") });

export const testInputSchema = z.object({ accountId: z.string().uuid().optional(), imap: serverLoose, smtp: serverLoose });
export type TestInput = z.infer<typeof testInputSchema>;

export const accountUpdateSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  imap: serverLoose,
  smtp: serverLoose,
});
export type AccountUpdate = z.infer<typeof accountUpdateSchema>;

export interface TestResult {
  imap: { ok: boolean; error?: string; capabilities?: { condstore: boolean; qresync: boolean; idle: boolean; move: boolean; sieve?: never } };
  smtp: { ok: boolean; error?: string };
}

/** Account as returned to the client: never includes passwords. */
export interface AccountSummary {
  id: string;
  name: string;
  /** Login/primary address (also the first, default identity). */
  email: string;
  identities: Identity[];
  /** Local full-text index of message bodies is on for this account. */
  indexBodies: boolean;
  /** The mail server lets you share folders with other users (IMAP ACL). */
  supportsAcl: boolean;
  imap: Omit<ServerConfig, "password">;
  smtp: Omit<ServerConfig, "password">;
  createdAt: string;
}

/** Common provider presets to prefill the setup form. */
export const presets: Record<string, { imap: [string, number]; smtp: [string, number] }> = {
  "Gmail (app password)": { imap: ["imap.gmail.com", 993], smtp: ["smtp.gmail.com", 465] },
  "Fastmail": { imap: ["imap.fastmail.com", 993], smtp: ["smtp.fastmail.com", 465] },
  "Outlook / Microsoft 365": { imap: ["outlook.office365.com", 993], smtp: ["smtp.office365.com", 587] },
  "iCloud": { imap: ["imap.mail.me.com", 993], smtp: ["smtp.mail.me.com", 587] },
};
export { mentionsAttachment } from "./attachmentHint.ts";
