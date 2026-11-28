import forge from "node-forge";
import * as openpgp from "openpgp";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Test certificates and keys, generated on the fly (nothing secret is checked in). */

export interface Cert { keyPem: string; certPem: string; certDer: Buffer; key: forge.pki.rsa.PrivateKey; cert: forge.pki.Certificate }

let sharedKeys: forge.pki.rsa.KeyPair[] = [];
const keypair = (i: number) => (sharedKeys[i] ??= forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 }));

export function makeCert(o: {
  email?: string | null; cn?: string; eku?: "email" | "server" | "none"; days?: number; startDaysAgo?: number; keyIndex?: number;
  issuer?: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey }; ca?: boolean;
  /** null leaves the keyUsage extension out. */
  keyUsage?: { digitalSignature?: boolean; keyEncipherment?: boolean } | null;
  /** More addresses in subjectAltName, after `email`. */
  extraEmails?: string[];
}): Cert {
  const kp = keypair(o.keyIndex ?? 0);
  const cert = forge.pki.createCertificate();
  cert.publicKey = kp.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date(Date.now() - (o.startDaysAgo ?? 1) * 86400_000);
  cert.validity.notAfter = new Date(Date.now() + (o.days ?? 365) * 86400_000);
  const attrs: any[] = [{ name: "commonName", value: o.cn ?? "Test Person" }];
  const subject = o.email ? [...attrs, { name: "emailAddress", value: o.email }] : attrs;
  cert.setSubject(subject);
  cert.setIssuer(o.issuer ? o.issuer.cert.subject.attributes : subject);
  const ext: any[] = [{ name: "basicConstraints", cA: !!o.ca }];
  if (!o.ca && o.keyUsage !== null) ext.push({ name: "keyUsage", digitalSignature: o.keyUsage?.digitalSignature ?? true, keyEncipherment: o.keyUsage?.keyEncipherment ?? true });
  else ext.push({ name: "keyUsage", keyCertSign: true, cRLSign: true });
  if ((o.eku ?? "email") === "email") ext.push({ name: "extKeyUsage", emailProtection: true });
  if (o.eku === "server") ext.push({ name: "extKeyUsage", serverAuth: true });
  if (o.email) ext.push({ name: "subjectAltName", altNames: [o.email, ...(o.extraEmails ?? [])].map((value) => ({ type: 1, value })) });
  cert.setExtensions(ext);
  cert.sign(o.issuer?.key ?? kp.privateKey, forge.md.sha256.create());
  return {
    key: kp.privateKey, cert, keyPem: forge.pki.privateKeyToPem(kp.privateKey), certPem: forge.pki.certificateToPem(cert),
    certDer: Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), "binary"),
  };
}

export const p12 = (c: Cert, password: string, algorithm: "aes256" | "3des" = "3des", opts: { count?: number; useMac?: boolean } = {}) =>
  Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(c.key, [c.cert], password, { algorithm, ...opts } as any)).getBytes(), "binary");

/** Replace every DER INTEGER equal to `from` with `to` (both must encode to the same length). */
export function patchInteger(der: Buffer, from: number, to: number): Buffer {
  const enc = (n: number) => { let h = n.toString(16); if (h.length % 2) h = "0" + h; if (parseInt(h.slice(0, 2), 16) & 0x80) h = "00" + h; return Buffer.from(`02${(h.length / 2).toString(16).padStart(2, "0")}${h}`, "hex"); };
  const a = enc(from), b = enc(to);
  if (a.length !== b.length) throw new Error("the integers must have the same encoded length");
  const out = Buffer.from(der);
  for (let i = out.indexOf(a); i >= 0; i = out.indexOf(a, i + a.length)) b.copy(out, i);
  return out;
}

export function p7b(certs: Cert[], pem = false) {
  const p7 = forge.pkcs7.createSignedData();
  certs.forEach((c) => p7.addCertificate(c.cert));
  return pem ? Buffer.from(forge.pkcs7.messageToPem(p7)) : Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), "binary");
}

export async function makePgp(email: string, name = "Test Person", passphrase?: string) {
  const { privateKey, publicKey } = await openpgp.generateKey({ type: "ecc", curve: "curve25519Legacy", userIDs: [{ name, email }], passphrase, format: "armored" });
  return { privateArmored: privateKey, publicArmored: publicKey };
}
export const dearmor = async (armored: string) => Buffer.from((await openpgp.unarmor(armored)).data as Uint8Array);

// ---- OpenSSL as an independent implementation to interoperate with ----
export const hasOpenssl = (() => { try { execFileSync("openssl", ["version"]); return true; } catch { return false; } })();
export function openssl(args: string[], input?: Buffer, files: Record<string, string | Buffer> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ncmail-ssl-"));
  try {
    for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
    const out = execFileSync("openssl", args.map((a) => a.replace(/^@/, dir + "/")), { input, cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    return out;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
export { readFileSync };
