import type { ImapFlow } from "imapflow";
import { encodePath } from "imapflow/lib/tools";

/**
 * Shared folders: IMAP namespaces (RFC 2342) and access control lists (RFC 4314).
 * Folders in another user's namespace ("Shared/anna/Projects") or a shared namespace are someone else's: they never act as your
 * Sent or Trash, and what you may do in them depends on the rights the server grants (MYRIGHTS).
 */
export type NamespaceKind = "personal" | "other" | "shared";

export function namespaceOf(client: ImapFlow, path: string): { kind: NamespaceKind; owner: string | null } {
  const ns: any = client.namespaces ?? {};
  const match = (list: any) => (Array.isArray(list) ? list : []).map((n: any) => String(n.prefix ?? "")).filter((p: string) => p !== "")
    .sort((a: string, b: string) => b.length - a.length)
    .find((p: string) => path === p.replace(/[./]$/, "") || path.startsWith(p));
  const other = match(ns.other);
  if (other) {
    const rest = path.slice(other.length);
    const delim = (Array.isArray(ns.other) ? ns.other.find((n: any) => n.prefix === other)?.delimiter : null) || "/";
    return { kind: "other", owner: path.length > other.length ? rest.split(delim)[0] || null : null };
  }
  if (match(ns.shared)) return { kind: "shared", owner: null };
  return { kind: "personal", owner: null };
}

export const supportsAcl = (client: ImapFlow) => client.capabilities?.has("ACL") ?? false;

/** Rights that do not include reading the messages (null means the server did not say, or a personal folder: readable). */
export const lacksRead = (rights: string | null | undefined) => rights != null && !rights.includes("r");
/** SQL condition on folders (alias `f`): its mail may be shown. Mail of a folder you can no longer read is not served. */
export const READABLE_SQL = "(f.rights is null or strpos(f.rights, 'r') > 0)";
/** The server refused because of missing rights (RFC 5530 NOPERM). */
export const isNoPerm = (e: any) => {
  const code = e?.serverResponseCode ?? e?.response?.attributes?.[0]?.section?.[0]?.value;
  return String(code ?? "").toUpperCase() === "NOPERM" || /\bNOPERM\b/.test(`${e?.responseText ?? ""} ${typeof e?.response === "string" ? e.response : ""}`);
};

/** Your rights in a folder ("lrs" = look up, read, keep seen), or null when the server does not say. */
export async function myRights(client: ImapFlow, path: string): Promise<string | null> {
  let rights: string | null = null;
  try {
    const r: any = await (client as any).exec("MYRIGHTS", [{ type: "STRING", value: encodePath(client, path) }], {
      untagged: { MYRIGHTS: async (u: any) => { rights = String(u.attributes?.[1]?.value ?? ""); } },
    });
    r.next();
  } catch { return null; }
  return rights;
}

export interface AclEntry { identifier: string; rights: string }

export async function getAcl(client: ImapFlow, path: string): Promise<AclEntry[]> {
  const out: AclEntry[] = [];
  const r: any = await (client as any).exec("GETACL", [{ type: "STRING", value: encodePath(client, path) }], {
    untagged: {
      ACL: async (u: any) => {
        const a = (u.attributes ?? []).slice(1).map((x: any) => String(x?.value ?? ""));
        for (let i = 0; i + 1 < a.length; i += 2) out.push({ identifier: a[i]!, rights: a[i + 1]! });
      },
    },
  });
  r.next();
  return out;
}

export async function setAcl(client: ImapFlow, path: string, identifier: string, rights: string) {
  const r: any = await (client as any).exec("SETACL", [
    { type: "STRING", value: encodePath(client, path) }, { type: "STRING", value: identifier }, { type: "STRING", value: rights },
  ]);
  r.next();
}

export async function deleteAcl(client: ImapFlow, path: string, identifier: string) {
  const r: any = await (client as any).exec("DELETEACL", [{ type: "STRING", value: encodePath(client, path) }, { type: "STRING", value: identifier }]);
  r.next();
}

/** What sharing a folder grants: reading it, or also changing it (flags, adding, deleting). Never sharing or creating folders. */
export const ACCESS = { read: "lrs", write: "lrswipte" } as const;
export const accessOf = (rights: string): "read" | "write" | "other" =>
  [..."lrswite"].every((c) => rights.includes(c)) ? "write" : [..."lr"].every((c) => rights.includes(c)) ? "read" : "other";
