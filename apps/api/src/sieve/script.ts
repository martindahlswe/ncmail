import { z } from "zod";

/** Filter rules and the vacation reply as data, and the Sieve script made from them. The data travels inside the script as a comment, so the server holds the only copy. */

const field = z.enum(["from", "to", "cc", "subject", "list-id", "size"]);
const op = z.enum(["contains", "is", "not-contains", "starts-with", "ends-with", "over"]);
/** The longest value an action may hold (a folder path for "move", an address for "forward"). */
export const MAX_ACTION_VALUE = 200;
export const ruleSchema = z.object({
  id: z.string().max(40),
  name: z.string().max(80).default(""),
  enabled: z.boolean().default(true),
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(z.object({ field, op, value: z.string().min(1).max(200) })).min(1).max(8),
  actions: z.array(z.object({ type: z.enum(["move", "read", "star", "label", "discard", "forward", "stop"]), value: z.string().max(MAX_ACTION_VALUE).default("") })).min(1).max(8),
});
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const configSchema = z.object({
  vacation: z.object({
    enabled: z.boolean().default(false), subject: z.string().max(200).default(""), body: z.string().max(5000).default(""),
    days: z.number().int().min(1).max(30).default(7), from: day.optional(), to: day.optional(),
  }).default({ enabled: false, subject: "", body: "", days: 7 }),
  rules: z.array(ruleSchema).max(50).default([]),
});
export type SieveConfig = z.infer<typeof configSchema>;
export const emptyConfig = (): SieveConfig => configSchema.parse({});

export const SCRIPT_NAME = "ncmail";
const q = (s: string) => `"${s.replace(/[\r\n]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** Escape * and ? so a :matches pattern means the text literally. */
const lit = (s: string) => s.replace(/[\\*?]/g, "\\$&");
const textBlock = (s: string) => `text:\r\n${s.replace(/\r?\n/g, "\r\n").split("\r\n").map((l) => (l.startsWith(".") ? "." + l : l)).join("\r\n")}\r\n.\r\n`;
const HEADER: Record<string, string> = { from: "from", to: "to", cc: "cc", subject: "subject", "list-id": "list-id" };

export function buildScript(cfg: SieveConfig, ownAddresses: string[]): string {
  const need = new Set<string>();
  const body: string[] = [];

  const v = cfg.vacation;
  if (v.enabled && v.body.trim()) {
    need.add("vacation");
    const addrs = ownAddresses.length ? ` :addresses [${ownAddresses.map(q).join(", ")}]` : "";
    const call = `vacation :days ${v.days}${v.subject.trim() ? ` :subject ${q(v.subject)}` : ""}${addrs} ${textBlock(v.body)};`;
    if (v.from || v.to) {
      need.add("date"); need.add("relational");
      const tests = [v.from && `currentdate :value "ge" "date" ${q(v.from)}`, v.to && `currentdate :value "le" "date" ${q(v.to)}`].filter(Boolean);
      body.push(`if allof(${tests.join(", ")}) {\r\n${call}\r\n}`);
    } else body.push(call);
  }

  for (const r of cfg.rules) {
    if (!r.enabled) continue;
    const tests = r.conditions.map((c) => {
      if (c.field === "size") { const mb = Math.max(1, parseInt(c.value) || 1); return `size :over ${mb}M`; }
      const h = q(HEADER[c.field]!);
      const t = c.op === "is" ? `header :is ${h} ${q(c.value)}` : c.op === "starts-with" ? (need.add("x"), `header :matches ${h} ${q(lit(c.value) + "*")}`)
        : c.op === "ends-with" ? `header :matches ${h} ${q("*" + lit(c.value))}` : `header :contains ${h} ${q(c.value)}`;
      return c.op === "not-contains" ? `not header :contains ${h} ${q(c.value)}` : t;
    });
    const flags: string[] = [];
    let folder = "", discard = false, stop = false;
    const extra: string[] = [];
    for (const a of r.actions) {
      if (a.type === "read") flags.push("\\Seen");
      else if (a.type === "star") flags.push("\\Flagged");
      else if (a.type === "label" && /^[a-z0-9-]{1,40}$/.test(a.value)) flags.push(`$ncl_${a.value}`);
      else if (a.type === "move" && a.value) folder = a.value;
      else if (a.type === "discard") discard = true;
      else if (a.type === "forward" && /^[^\s@]+@[^\s@]+$/.test(a.value)) { need.add("copy"); extra.push(`redirect :copy ${q(a.value)};`); }
      else if (a.type === "stop") stop = true;
    }
    const acts: string[] = [];
    const fl = flags.length ? ` :flags [${flags.map(q).join(", ")}]` : "";
    if (flags.length) need.add("imap4flags");
    if (discard) acts.push("discard;", "stop;");
    else {
      if (folder) { need.add("fileinto"); need.add("mailbox"); acts.push(`fileinto :create${fl} ${q(folder)};`); }
      else if (flags.length) acts.push(`keep${fl};`);
      acts.push(...extra);
      if (stop || folder) acts.push("stop;"); // a message that was filed does not go on to later rules
    }
    const cond = tests.length === 1 ? tests[0]! : `${r.match === "all" ? "allof" : "anyof"}(${tests.join(", ")})`;
    body.push(`# ${r.name.replace(/[\r\n]/g, " ") || "Rule"}\r\nif ${cond} {\r\n  ${acts.join("\r\n  ")}\r\n}`);
  }
  need.delete("x");

  const req = [...need].sort();
  const embedded = Buffer.from(JSON.stringify(cfg)).toString("base64");
  return [`# Managed by Mail. Change these rules in the app; edits made here are overwritten.`, `# ncmail:config:${embedded}`, req.length ? `require [${req.map(q).join(", ")}];` : "", ...body].filter((x) => x !== "").join("\r\n") + "\r\n";
}

/** The settings stored in a script we wrote earlier. */
export function readConfig(script: string | null): SieveConfig | null {
  const m = script?.match(/^# ncmail:config:([A-Za-z0-9+/=]+)/m);
  if (!m) return null;
  try { return configSchema.parse(JSON.parse(Buffer.from(m[1]!, "base64").toString())); } catch { return null; }
}
