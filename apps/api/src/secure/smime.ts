import forge from "node-forge";
import { X509Certificate, createDecipheriv, createHash, createPrivateKey, createPublicKey, constants, verify as cryptoVerify, type CipherGCMTypes, type KeyObject } from "node:crypto";
import { rootCertificates } from "node:tls";
import { EMAIL, type ParsedKey, type ParseResult, type SignatureInfo, type StoredKey } from "./types.ts";

/**
 * S/MIME (CMS / PKCS#7).
 *
 *  - Reading keys: PEM and DER certificates, PKCS#7 bundles (.p7b/.p7c), PKCS#12 (.p12/.pfx), PEM private keys (plain or encrypted).
 *  - Verifying signatures works for RSA and ECDSA certificates (Node's crypto does the maths).
 *  - Signing, encrypting and decrypting use node-forge, which is RSA-only: an ECDSA certificate can be imported and its
 *    signatures checked, but not used to sign or decrypt.
 */

const OID = {
  signedData: "1.2.840.113549.1.7.2", messageDigest: "1.2.840.113549.1.9.4", signingTime: "1.2.840.113549.1.9.5",
  emailProtection: "1.3.6.1.5.5.7.3.4", anyEku: "2.5.29.37.0",
  sha1: "1.3.14.3.2.26", sha224: "2.16.840.1.101.3.4.2.4", sha256: "2.16.840.1.101.3.4.2.1", sha384: "2.16.840.1.101.3.4.2.2", sha512: "2.16.840.1.101.3.4.2.3",
  rsaPss: "1.2.840.113549.1.1.10", authEnvelopedData: "1.2.840.113549.1.9.16.1.23", rsaEncryption: "1.2.840.113549.1.1.1",
};
/** AES-GCM content encryption (RFC 5084), by key length in bytes. */
const GCM_BY_OID: Record<string, number> = { "2.16.840.1.101.3.4.1.6": 16, "2.16.840.1.101.3.4.1.26": 24, "2.16.840.1.101.3.4.1.46": 32 };
const HASH_BY_OID: Record<string, string> = { [OID.sha1]: "sha1", [OID.sha224]: "sha224", [OID.sha256]: "sha256", [OID.sha384]: "sha384", [OID.sha512]: "sha512" };
const { asn1 } = forge;
const OIDS: any = forge.pki.oids;

// ------------------------------------------------------------------ certificates
const pems = (text: string) => text.match(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g) ?? [];
const certPems = (text: string) => pems(text).filter((b) => /BEGIN (X509 |TRUSTED )?CERTIFICATE/.test(b));
const derToPem = (der: Buffer) => `-----BEGIN CERTIFICATE-----\n${(der.toString("base64").match(/.{1,64}/g) ?? []).join("\n")}\n-----END CERTIFICATE-----\n`;
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex").toUpperCase();

export function certEmails(c: X509Certificate): string[] {
  const out = new Set<string>();
  for (const m of (c.subjectAltName ?? "").matchAll(/email:([^,\s]+)/gi)) out.add(m[1]!.toLowerCase());
  for (const m of c.subject.matchAll(/emailAddress=([^\n,]+)/gi)) out.add(m[1]!.trim().toLowerCase());
  return [...out].filter((e) => EMAIL.test(e) || /^[^@\s]+@[^@\s]+$/.test(e));
}
const cn = (name: string) => name.match(/(?:^|\n)CN=([^\n]+)/)?.[1]?.trim() ?? "";
const spkiOf = (k: KeyObject) => k.export({ type: "spki", format: "der" }).toString("hex");
const isCa = (c: X509Certificate) => !!c.ca;

function usageOf(c: X509Certificate): { sign: boolean; encrypt: boolean } {
  try { // basic key usage: forge reads it for RSA certificates; other kinds are not restricted here
    const ku = forge.pki.certificateFromPem(c.toString()).getExtension("keyUsage") as any;
    if (ku) return { sign: !!(ku.digitalSignature || ku.nonRepudiation), encrypt: !!(ku.keyEncipherment || ku.dataEncipherment) };
  } catch { /* not RSA, or no extension */ }
  return { sign: true, encrypt: true };
}

function describe(c: X509Certificate, privatePem: string | undefined, chain: X509Certificate[]): ParsedKey | string {
  const emails = certEmails(c);
  if (!emails.length) return `The certificate for "${cn(c.subject) || c.subject.split("\n")[0]}" contains no email address, so it cannot be matched to a sender or a recipient.`;
  const eku = c.keyUsage as string[] | undefined;
  if (eku?.length && !eku.includes(OID.emailProtection) && !eku.includes(OID.anyEku)) return `The certificate for ${emails[0]} is not meant for email (it is for something else, such as a web server).`;
  const { sign, encrypt } = usageOf(c);
  const rsa = c.publicKey.asymmetricKeyType === "rsa" || c.publicKey.asymmetricKeyType === "rsa-pss";
  const details = c.publicKey.asymmetricKeyDetails as any;
  const limits: string[] = [];
  if (!rsa) limits.push("Only RSA certificates can be used to sign, encrypt and decrypt here. This one can still be used to check signatures.");
  return {
    kind: "smime", hasPrivate: !!privatePem, emails, name: cn(c.subject), fingerprint: sha256(c.raw),
    keyIds: [], notBefore: new Date(c.validFrom), notAfter: new Date(c.validTo),
    canSign: rsa && sign, canEncrypt: rsa && encrypt,
    publicData: [c.toString(), ...chain.map((x) => x.toString())].join(""), privateData: privatePem,
    info: { issuer: cn(c.issuer) || c.issuer, subject: c.subject.replace(/\n/g, ", "), serial: c.serialNumber, algorithm: `${c.publicKey.asymmetricKeyType}${details?.modulusLength ? ` ${details.modulusLength}` : details?.namedCurve ? ` ${details.namedCurve}` : ""}`, limitations: limits },
  };
}

// Password-based key derivation runs synchronously on the shared event loop, so the iteration counts a file asks for are
// capped well above what real tools write (OpenSSL: 2048, newer defaults: 10000 to 600000).
const MAX_KDF_ITERATIONS = 1_000_000;
const KDF_TOO_COSTLY = new Error("iteration count too high");

/** Run a PKCS#12 parse with every key derivation it starts (MAC key, bag decryption) refusing counts above the cap. */
function withKdfCap<T>(fn: () => T): T {
  const pbe: any = (forge as any).pbe, p12: any = forge.pkcs12, p5: any = forge.pkcs5;
  const saved = { pkcs12Key: pbe.generatePkcs12Key, macKey: p12.generateKey, pbkdf2: p5.pbkdf2 };
  const check = (n: unknown) => { if (typeof n !== "number" || !(n <= MAX_KDF_ITERATIONS)) throw KDF_TOO_COSTLY; };
  pbe.generatePkcs12Key = (pw: any, salt: any, id: any, iter: number, ...rest: any[]) => { check(iter); return saved.pkcs12Key(pw, salt, id, iter, ...rest); };
  p12.generateKey = (pw: any, salt: any, id: any, iter: number, ...rest: any[]) => { check(iter); return saved.macKey(pw, salt, id, iter, ...rest); };
  p5.pbkdf2 = (pw: any, salt: any, iter: number, ...rest: any[]) => { check(iter); return saved.pbkdf2(pw, salt, iter, ...rest); };
  try { return fn(); } finally { pbe.generatePkcs12Key = saved.pkcs12Key; p12.generateKey = saved.macKey; p5.pbkdf2 = saved.pbkdf2; } // gitleaks:allow (restores library functions, no secret)
}

/** An encrypted PKCS#8 PEM key whose PBE parameters ask for more iterations than the cap (Node would run them unchecked). */
function pemKdfTooCostly(block: string): boolean {
  if (!/BEGIN ENCRYPTED PRIVATE KEY/.test(block)) return false;
  try {
    const algId: any = (asn1.fromDer(forge.util.decode64(block.replace(/-----[^-]+-----|\s/g, ""))).value as any[])[0];
    // the only large INTEGER in PBES1/PBES2/PKCS#12-PBE parameters is the iteration count
    const tooBig = (n: any): boolean => n.tagClass === asn1.Class.UNIVERSAL && n.type === asn1.Type.INTEGER
      ? n.value.length > 4 || parseInt(forge.util.bytesToHex(n.value) || "0", 16) > MAX_KDF_ITERATIONS
      : Array.isArray(n.value) && n.value.some(tooBig);
    return tooBig(algId);
  } catch { return false; } // unreadable: let the normal key reader report it
}

/** Read S/MIME material from any number of files at once (a certificate and its separate key file go together). */
export function parseSmime(files: { name: string; data: Buffer }[], password?: string): ParseResult {
  const certs: X509Certificate[] = [], privs: { pem: string; spki: string }[] = [], errors: string[] = [];
  let needsPassword = false;
  const addCert = (src: Buffer | string) => { try { certs.push(new X509Certificate(src)); } catch { /* skip an unreadable one */ } };
  const addKey = (key: string | Buffer | KeyObject, label: string) => {
    try {
      const ko = key instanceof Object && "type" in (key as any) && typeof (key as any).export === "function" ? (key as KeyObject) : createPrivateKey({ key: key as any, passphrase: password });
      privs.push({ pem: ko.export({ type: "pkcs8", format: "pem" }).toString(), spki: spkiOf(createPublicKey(ko)) });
    } catch (e: any) {
      if (/passphrase|bad decrypt|BAD_DECRYPT|interrupted or cancelled/i.test(e.message ?? e.code ?? "")) { needsPassword = true; errors.push(password ? `The password for ${label} is not correct` : `${label} is protected by a password`); }
      else errors.push(`${label}: not a readable private key`);
    }
  };

  for (const f of files) {
    const text = f.data.toString("latin1");
    if (/-----BEGIN /.test(text)) {
      for (const block of pems(text)) {
        if (/BEGIN (X509 |TRUSTED )?CERTIFICATE/.test(block)) addCert(block);
        else if (/BEGIN PKCS7|BEGIN CMS/.test(block)) { try { for (const d of certsInCms(Buffer.from(block.replace(/-----[^-]+-----|\s/g, ""), "base64"))) addCert(d); } catch { errors.push(`${f.name}: unreadable certificate bundle`); } }
        else if (/PRIVATE KEY/.test(block)) { if (pemKdfTooCostly(block)) errors.push(`${f.name}: its password protection uses an unusually high iteration count, which is not supported`); else addKey(block, f.name); }
        else if (/PUBLIC KEY|PGP/.test(block)) errors.push(`${f.name}: this is not an S/MIME certificate`);
      }
      continue;
    }
    // binary: a DER certificate, a PKCS#7 bundle, or a PKCS#12 archive
    try { certs.push(new X509Certificate(f.data)); continue; } catch { /* not a lone certificate */ }
    try { const found = certsInCms(f.data); if (found.length) { found.forEach(addCert); continue; } } catch { /* not PKCS#7 */ }
    try {
      const p12 = withKdfCap(() => forge.pkcs12.pkcs12FromAsn1(asn1.fromDer(f.data.toString("latin1")), false, password ?? ""));
      const keyBags = [...(p12.getBags({ bagType: OIDS.pkcs8ShroudedKeyBag })[OIDS.pkcs8ShroudedKeyBag] ?? []), ...(p12.getBags({ bagType: OIDS.keyBag })[OIDS.keyBag] ?? [])];
      for (const b of keyBags) if (b.key) addKey(forge.pki.privateKeyToPem(b.key), f.name);
      for (const b of p12.getBags({ bagType: OIDS.certBag })[OIDS.certBag] ?? []) if (b.cert) addCert(forge.pki.certificateToPem(b.cert));
    } catch (e: any) {
      if (e === KDF_TOO_COSTLY) errors.push(`${f.name}: its password protection uses an unusually high iteration count, which is not supported`);
      else if (/password|MAC/i.test(e.message ?? "")) { needsPassword = true; errors.push(password ? `The password for ${f.name} is not correct` : `${f.name} is protected by a password`); }
      else errors.push(`${f.name}: not a recognised certificate, key or PKCS#12 file`);
    }
  }

  const keys: ParsedKey[] = [];
  const used = new Set<string>();
  const cas = certs.filter(isCa);
  const chainFor = (c: X509Certificate) => { // issuers found in the same files, closest first
    const out: X509Certificate[] = []; let cur = c;
    for (let i = 0; i < 5; i++) { const up = cas.find((x) => x.fingerprint256 !== cur.fingerprint256 && cur.checkIssued(x)); if (!up) break; out.push(up); cur = up; }
    return out;
  };
  for (const c of certs) {
    if (used.has(c.fingerprint256)) continue;
    used.add(c.fingerprint256);
    const mine = privs.find((p) => p.spki === spkiOf(c.publicKey));
    if (isCa(c) && !mine) continue; // CA certificates only serve as chain
    const r = describe(c, mine?.pem, chainFor(c));
    typeof r === "string" ? errors.push(r) : keys.push(r);
  }
  if (!certs.length && privs.length) errors.push("A private key needs its certificate too. Select the certificate file together with the key file.");
  else for (const p of privs) if (!certs.some((c) => spkiOf(c.publicKey) === p.spki)) errors.push("A private key was given without a matching certificate. Select its certificate file as well.");
  return { keys, errors: [...new Set(errors)], needsPassword };
}

/** Certificates inside a PKCS#7 / CMS structure, as DER. Works for any key type (no certificate parsing). */
function certsInCms(der: Buffer): Buffer[] {
  const top = asn1.fromDer(forge.util.createBuffer(der.toString("latin1")));
  if (asn1.derToOid((top.value as any)[0].value) !== OID.signedData) throw new Error("not signed-data");
  const sd = (top.value as any)[1].value[0];
  const set = sd.value.slice(3).find((e: any) => e.tagClass === asn1.Class.CONTEXT_SPECIFIC && e.type === 0);
  return (set?.value ?? []).map((c: any) => Buffer.from(asn1.toDer(c).getBytes(), "latin1"));
}

// ------------------------------------------------------------------ sign / encrypt / decrypt (RSA)
const first = (pemText: string) => forge.pki.certificateFromPem(certPems(pemText)[0]!);
const bin = (b: Buffer) => forge.util.createBuffer(b.toString("latin1"));
const toBuf = (s: string) => Buffer.from(s, "latin1");

/** Detached CMS signature over `entity`, with the certificate chain embedded so recipients can verify it. */
export function smimeSign(entity: Buffer, key: StoredKey): Buffer {
  const privateKey = forge.pki.privateKeyFromPem(key.privateData!);
  const certs = certPems(key.publicData).map((p) => forge.pki.certificateFromPem(p));
  const p7 = forge.pkcs7.createSignedData();
  p7.content = bin(entity);
  certs.forEach((c) => p7.addCertificate(c));
  p7.addSigner({
    key: privateKey as any, certificate: certs[0]!, digestAlgorithm: OIDS.sha256,
    authenticatedAttributes: [
      { type: OIDS.contentType, value: OIDS.data },
      { type: OIDS.messageDigest },
      { type: OIDS.signingTime, value: new Date() as any },
    ],
  });
  p7.sign({ detached: true });
  return toBuf(asn1.toDer(p7.toAsn1()).getBytes());
}

export function smimeEncrypt(entity: Buffer, recipients: StoredKey[]): Buffer {
  const p7 = forge.pkcs7.createEnvelopedData();
  for (const r of recipients) p7.addRecipient(first(r.publicData));
  p7.content = bin(entity);
  p7.encrypt();
  return toBuf(asn1.toDer(p7.toAsn1()).getBytes());
}

/** Single DES (56-bit keys) can be broken by brute force: such content is not decrypted. */
const WEAK_CIPHERS = new Set(["1.3.14.3.2.7"]);

export function smimeDecrypt(der: Buffer, mine: StoredKey[]): Buffer | "no-key" {
  const top: any = asn1.fromDer(bin(der));
  if (oidOf(top.value[0]) === OID.authEnvelopedData) return authEnvelopedDecrypt(top, mine);
  const p7: any = forge.pkcs7.messageFromAsn1(top);
  if (WEAK_CIPHERS.has(p7.encryptedContent?.algorithm)) throw new Error("it uses single DES, which is too weak to trust");
  for (const k of mine) {
    if (!k.hasPrivate || !k.privateData) continue;
    let rec; try { rec = p7.findRecipient(first(k.publicData)); } catch { continue; }
    if (!rec) continue;
    try { p7.decrypt(rec, forge.pki.privateKeyFromPem(k.privateData)); return toBuf(p7.content.getBytes()); }
    catch { throw new Error("This message could not be decrypted"); } // one answer for every failure (no padding-oracle hints)
  }
  return "no-key";
}

/**
 * AuthEnvelopedData (RFC 5083) with AES-GCM (RFC 5084), as newer clients send: forge cannot read it, so the structure is
 * taken apart here, the content key unwrapped with forge (RSA, like EnvelopedData) and the content opened with Node's AES-GCM,
 * which also checks the content and the authenticated attributes were not changed.
 */
function authEnvelopedDecrypt(top: any, mine: StoredKey[]): Buffer | "no-key" {
  const fields: any[] = top.value[1].value[0].value;
  const universal = (type: number) => fields.filter((f) => f.tagClass === asn1.Class.UNIVERSAL && f.type === type);
  const [rinfos] = universal(asn1.Type.SET);
  const [eci] = universal(asn1.Type.SEQUENCE);
  const mac = universal(asn1.Type.OCTETSTRING).at(-1);
  const authAttrs = fields.find((f) => f.tagClass === asn1.Class.CONTEXT_SPECIFIC && f.type === 1);
  if (!rinfos || !eci || !mac) throw new Error("the encrypted data is incomplete");
  const recipients = (rinfos.value as any[]).flatMap((ri) => {
    const capture: any = {};
    if (!(asn1 as any).validate(ri, (forge as any).pkcs7asn1.recipientInfoValidator, capture, [])) return []; // only key transport, by issuer and serial
    return [{ issuer: (forge.pki as any).RDNAttributesAsArray(capture.issuer), serial: forge.util.createBuffer(capture.serial).toHex(), alg: asn1.derToOid(capture.encAlgorithm), key: capture.encKey as string }];
  });
  const sameIssuer = (a: any[], b: any[]) => a.length === b.length && a.every((x, i) => x.type === b[i].type && x.value === b[i].value);
  for (const k of mine) {
    if (!k.hasPrivate || !k.privateData) continue;
    let cert; try { cert = first(k.publicData); } catch { continue; }
    const rec = recipients.find((r) => r.serial === cert.serialNumber && sameIssuer(r.issuer, cert.issuer.attributes));
    if (!rec) continue;
    try {
      if (rec.alg !== OID.rsaEncryption) throw new Error("unsupported key transport");
      const alg = eci.value[1];
      const keyLen = GCM_BY_OID[oidOf(alg.value[0])];
      const params = alg.value[1]?.value ?? [];
      const nonce = toBuf(params[0]?.value ?? "");
      const icvLen = params[1] ? parseInt(forge.util.bytesToHex(params[1].value), 16) : 12;
      const tag = toBuf(mac.value);
      const body = eci.value[2];
      if (!keyLen || !nonce.length || !body || tag.length !== icvLen || icvLen < 12 || icvLen > 16) throw new Error("unsupported content encryption");
      const cek = toBuf((forge.pki.privateKeyFromPem(k.privateData) as any).decrypt(rec.key));
      if (cek.length !== keyLen) throw new Error("wrong key length");
      const d = createDecipheriv(`aes-${keyLen * 8}-gcm` as CipherGCMTypes, cek, nonce, { authTagLength: icvLen });
      // authenticated attributes are covered as a DER SET (RFC 5083 section 2.2)
      if (authAttrs) d.setAAD(toBuf(asn1.toDer(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, authAttrs.value)).getBytes()));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(octets(body)), d.final()]);
    } catch { throw new Error("This message could not be decrypted"); }
  }
  return "no-key";
}

// ------------------------------------------------------------------ verify
let rootStore: X509Certificate[] | null = null;
const roots = () => (rootStore ??= rootCertificates.flatMap((p) => { try { return [new X509Certificate(p)]; } catch { return []; } }));

type Trust = "trusted" | "pinned" | "none";

/** Whether `c` may issue the certificate below it: a CA (basicConstraints cA), allowed to sign certificates, valid at `at`,
 *  and with no more intermediates below it than its pathLenConstraint allows. Read from the DER so any key type works. */
function canIssue(c: X509Certificate, intermediatesBelow: number, at: Date): boolean {
  if (!c.ca || +at < +new Date(c.validFrom) - CLOCK_SKEW_MS || +at > +new Date(c.validTo) + CLOCK_SKEW_MS) return false;
  try {
    const tbs: any = (asn1.fromDer(bin(c.raw), { decodeBitStrings: false } as any).value as any[])[0];
    const exts: any[] = tbs.value.find((e: any) => e.tagClass === asn1.Class.CONTEXT_SPECIFIC && e.type === 3)?.value?.[0]?.value ?? [];
    for (const e of exts) {
      const oid = oidOf(e.value[0]);
      const inner: any = asn1.fromDer(e.value[e.value.length - 1].value, { decodeBitStrings: false } as any);
      if (oid === "2.5.29.15") { // keyUsage: keyCertSign is bit 5
        const bits: string = inner.value;
        if (!(bits.length > 1 && (bits.charCodeAt(1) & 0x04))) return false;
      }
      if (oid === "2.5.29.19") { // basicConstraints: optional pathLenConstraint
        const len = (inner.value as any[]).find((x) => x.type === asn1.Type.INTEGER);
        if (len && intermediatesBelow > parseInt(forge.util.bytesToHex(len.value) || "0", 16)) return false;
      }
    }
    return true;
  } catch { return false; }
}

/**
 * Who vouches for the signer. A certificate you keep as a contact vouches only for itself (exact match), never for
 * certificates it may have issued. Otherwise the chain must lead to a system root through real CA certificates.
 */
function trustOf(signer: X509Certificate, pool: X509Certificate[], pinned: Set<string>, at: Date): { trust: Trust; issuer: string } {
  if (pinned.has(sha256(signer.raw))) return { trust: "pinned", issuer: cn(signer.issuer) };
  const rs = roots();
  const isRoot = (c: X509Certificate) => rs.some((r) => r.fingerprint256 === c.fingerprint256);
  let cur = signer;
  for (let depth = 0; depth < 6; depth++) {
    if (isRoot(cur)) return { trust: "trusted", issuer: cn(signer.issuer) };
    const candidates = [...pool, ...rs].filter((c) => c.fingerprint256 !== cur.fingerprint256 && cur.checkIssued(c) && canIssue(c, depth, at));
    const up = candidates.find((c) => { try { return cur.verify(c.publicKey); } catch { return false; } });
    if (!up) break;
    if (isRoot(up)) return { trust: "trusted", issuer: cn(up.subject) };
    cur = up;
  }
  return { trust: "none", issuer: cn(signer.issuer) };
}

const CLOCK_SKEW_MS = 5 * 60_000;

export interface CmsSigned { content: Buffer | null; verify: (detached: Buffer | null, known: StoredKey[], from: string) => SignatureInfo }

const oidOf = (o: any) => asn1.derToOid(o.value);
const octets = (o: any): Buffer => toBuf(o.constructed ? (o.value as any[]).map((x) => x.value).join("") : o.value);

/** Take a CMS SignedData apart. `content` is set when the data travels inside the signature (opaque signing). */
export function readSigned(der: Buffer): CmsSigned {
  const top: any = asn1.fromDer(bin(der));
  if (oidOf(top.value[0]) !== OID.signedData) throw new Error("not signed data");
  const sd = top.value[1].value[0];
  const encap = sd.value[2];
  const embedded: Buffer | null = encap.value[1] ? octets(encap.value[1].value[0]) : null;
  let certDers: Buffer[] = [], signerInfos: any = null;
  for (const el of sd.value.slice(3)) {
    if (el.tagClass === asn1.Class.CONTEXT_SPECIFIC && el.type === 0) certDers = el.value.map((c: any) => toBuf(asn1.toDer(c).getBytes()));
    else if (el.tagClass === asn1.Class.UNIVERSAL && el.type === asn1.Type.SET) signerInfos = el;
  }
  const si = signerInfos?.value?.[0];
  if (!si) throw new Error("no signer");
  const digestOid = oidOf(si.value[2].value[0]);
  let k = 3, attrs: any = null;
  if (si.value[k].tagClass === asn1.Class.CONTEXT_SPECIFIC && si.value[k].type === 0) { attrs = si.value[k]; k++; }
  const sigAlg = oidOf(si.value[k].value[0]);
  const signature = toBuf(si.value[k + 1].value);

  return {
    content: embedded,
    verify(detached, known, from) {
      const content = embedded ?? detached;
      const fail = (status: SignatureInfo["status"], message: string, extra: Partial<SignatureInfo> = {}): SignatureInfo => ({ protocol: "smime", status, message, ...extra });
      if (!content) return fail("invalid", "The signed content is missing.");
      const hash = HASH_BY_OID[digestOid];
      if (!hash) return fail("invalid", "The signature uses a digest algorithm that is not supported.");
      let data = content;
      if (attrs) {
        let digestOk = false;
        for (const a of attrs.value) {
          const o = oidOf(a.value[0]), v = a.value[1].value[0];
          if (o === OID.messageDigest) digestOk = Buffer.compare(toBuf(v.value), createHash(hash).update(content).digest()) === 0;
        }
        if (!digestOk) return fail("invalid", "The message does not match its signature: it was changed after it was signed.");
        data = toBuf(asn1.toDer(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, attrs.value)).getBytes());
      }
      const certs: X509Certificate[] = [];
      for (const d of certDers) { try { certs.push(new X509Certificate(d)); } catch { /* an unsupported certificate in the bundle */ } }
      // the signer is whichever embedded (or already-known) certificate makes the signature check out
      const known509 = known.flatMap((s) => certPems(s.publicData).flatMap((p) => { try { return [new X509Certificate(p)]; } catch { return []; } }));
      const signer = [...certs, ...known509].find((c) => {
        try {
          const opts: any = sigAlg === OID.rsaPss ? { key: c.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_AUTO } : c.publicKey;
          return cryptoVerify(hash, data, opts, signature);
        } catch { return false; }
      });
      if (!signer) {
        const hadCerts = certs.length > 0;
        return fail(hadCerts ? "invalid" : "unknown-key", hadCerts ? "The signature does not match the message. It may have been altered." : "The signature carries no certificate and none of yours matches, so it cannot be checked.");
      }
      const emails = certEmails(signer);
      const who = { name: cn(signer.subject), email: emails[0] ?? "", fingerprint: sha256(signer.raw), emails };
      const base = { signer: who, signerData: [signer, ...certs.filter((c) => c.fingerprint256 !== signer.fingerprint256 && isCa(c))].map((c) => c.toString()).join("") };
      // Judged now, not at the signing time the message claims: the sender writes that time, so it proves nothing.
      // A little clock skew is allowed for a certificate issued just before the message was sent.
      const at = new Date();
      if (+at < +new Date(signer.validFrom) - CLOCK_SKEW_MS || +at > +new Date(signer.validTo) + CLOCK_SKEW_MS) return fail("expired", `The signature is correct, but the certificate is not valid now (valid ${signer.validFrom} to ${signer.validTo}).`, base);
      if (from && emails.length && !emails.includes(from.toLowerCase())) return fail("mismatch", `The signature is correct, but the certificate belongs to ${emails.join(", ")}, not the sender (${from}).`, base);
      if (from && !emails.length) return fail("mismatch", "The signature is correct, but the certificate contains no email address, so it cannot be tied to the sender.", base);
      // a kept certificate counts only for the addresses it was kept for
      const sender = from.toLowerCase();
      const pinned = new Set(known.filter((s) => sender && s.emails.includes(sender)).map((s) => s.fingerprint));
      const t = trustOf(signer, certs, pinned, at);
      if (t.trust === "none") return fail("untrusted", `The signature is correct, but the certificate was issued by "${t.issuer}", which your system does not trust, and you have not added it to your contacts.`, base);
      return fail("valid", t.trust === "pinned" ? "The signature is correct and the certificate is in your contacts." : `The signature is correct. The certificate was issued by ${t.issuer}.`, base);
    },
  };
}
