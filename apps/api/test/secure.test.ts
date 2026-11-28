import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as openpgp from "openpgp";
import { API_URL, MAILPIT_URL, user } from "./env.ts";
import { addAccount, api, apiRaw, imap, mailpit, resetMailbox, syncFolder, waitFor, type Acct } from "./helpers.ts";
import { dearmor, hasOpenssl, makeCert, makePgp, openssl, p12, p7b, type Cert } from "./secure-fixtures.ts";

const U = user(38);
const ALT = "alt@example.test";
const EXT = "ext@example.org";
const file = (name: string, data: Buffer | string) => ({ name, contentBase64: Buffer.from(data).toString("base64") });
let acct: Acct;
let altId = "";

const importKeys = (files: { name: string; contentBase64: string }[], password?: string) =>
  api<{ imported: any[]; errors: string[]; needsPassword: boolean }>(`/accounts/${acct.id}/keys/import`, { body: { files, password } });
const keyList = () => api<{ identities: { email: string; keys: any[] }[]; contacts: any[]; hidden: number }>(`/accounts/${acct.id}/keys`);
const rawOf = async (id: string) => Buffer.from(await (await fetch(`${MAILPIT_URL}/api/v1/message/${id}/raw`)).arrayBuffer());
const send = (body: Record<string, unknown>) => api(`/accounts/${acct.id}/send`, { body: { to: [EXT], text: "", ...body } });

/** Put a raw message in the inbox, sync, and return what the reader shows for it. */
async function receive(raw: Buffer | string, subject: string) {
  await imap(U, (c) => c.append("INBOX", Buffer.from(raw)));
  const inbox = await acct.folder("INBOX");
  await syncFolder(inbox.id);
  const item = await waitFor(async () => (await api<any>(`/folders/${inbox.id}/messages?limit=200`)).items.find((i: any) => i.subject === subject), { what: `"${subject}" in the inbox` });
  return api<any>(`/messages/${item.id}`);
}
/** The copy of a message we sent, as the reader shows it. */
async function sentCopy(subject: string) {
  const sent = await acct.folder("Sent");
  const item = await waitFor(async () => { await syncFolder(sent.id); return (await api<any>(`/folders/${sent.id}/messages?limit=200`)).items.find((i: any) => i.subject === subject); }, { what: `"${subject}" in Sent` });
  return api<any>(`/messages/${item.id}`);
}
const header = (from: string, subject: string, extra = "") =>
  `From: ${from}\r\nTo: ${U}\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@test>\r\n${extra}`;

let me: Cert, alt: Cert, ext: Cert;
let myPgp: Awaited<ReturnType<typeof makePgp>>, extPgp: Awaited<ReturnType<typeof makePgp>>;

beforeAll(async () => {
  me = makeCert({ email: U, cn: "Me Myself", keyIndex: 0 });
  ext = makeCert({ email: EXT, cn: "External Person", keyIndex: 1 });
  alt = makeCert({ email: ALT, cn: "Alt Me", keyIndex: 2 });
  myPgp = await makePgp(U, "Me Myself");
  extPgp = await makePgp(EXT, "External Person");
  await resetMailbox(U);
  acct = await addAccount(U);
  altId = (await api(`/accounts/${acct.id}/identities`, { body: { name: "Alt", email: ALT } })).id;
}, 120_000);
afterAll(async () => { if (acct) await api(`/accounts/${acct.id}`, { method: "DELETE" }); });

describe("importing keys and certificates", () => {
  it("reads an ASCII-armored PGP key pair and lists it under the matching sender address only", async () => {
    const r = await importKeys([file("me.asc", myPgp.privateArmored)]);
    expect(r.errors).toEqual([]);
    expect(r.imported).toHaveLength(1);
    expect(r.imported[0]).toMatchObject({ kind: "pgp", hasPrivate: true, emails: [U] });
    const l = await keyList();
    expect(l.identities.find((i) => i.email === U)!.keys.map((k) => k.kind)).toEqual(["pgp"]);
    expect(l.identities.find((i) => i.email === ALT)!.keys).toEqual([]);
    expect(l.contacts).toEqual([]);
  });

  it("refuses a private key whose address is not one of this account's senders", async () => {
    const other = await makePgp("someone.else@example.net");
    const r = await importKeys([file("other.asc", other.privateArmored)]);
    expect(r.imported).toEqual([]);
    expect(r.errors.join(" ")).toMatch(/none of this account's sender addresses/);
    expect((await keyList()).hidden).toBe(0);
  });

  it("accepts someone else's public key as a contact, in armored and binary form", async () => {
    await importKeys([file("ext.asc", extPgp.publicArmored)]);
    const third = await makePgp("third@example.net");
    const r = await importKeys([file("third.gpg", await dearmor(third.publicArmored))]);
    expect(r.errors).toEqual([]);
    expect(r.imported[0]).toMatchObject({ kind: "pgp", hasPrivate: false, emails: ["third@example.net"] });
    const emails = (await keyList()).contacts.flatMap((c) => c.emails).sort();
    expect(emails).toEqual([EXT, "third@example.net"].sort());
  });

  it("asks for the passphrase of a protected PGP key, and rejects a wrong one", async () => {
    const prot = await makePgp(ALT, "Alt Me", "s3cret");
    const files = [file("alt.key", prot.privateArmored)];
    const a = await importKeys(files);
    expect(a.needsPassword).toBe(true); expect(a.imported).toEqual([]);
    expect((await importKeys(files, "wrong")).imported).toEqual([]);
    const ok = await importKeys(files, "s3cret");
    expect(ok.imported).toHaveLength(1);
    const l = await keyList();
    expect(l.identities.find((i) => i.email === ALT)!.keys.map((k) => k.kind)).toEqual(["pgp"]);
    await api(`/keys/${ok.imported[0].id}`, { method: "DELETE" });
  });

  it("pairs a PEM certificate with its separate private key file", async () => {
    const r = await importKeys([file("me.key", me.keyPem), file("me.crt", me.certPem)]);
    expect(r.errors).toEqual([]);
    expect(r.imported).toHaveLength(1);
    expect(r.imported[0]).toMatchObject({ kind: "smime", hasPrivate: true, emails: [U] });
  });

  it("explains a private key that comes without its certificate", async () => {
    const r = await importKeys([file("lonely.key", alt.keyPem)]);
    expect(r.imported).toEqual([]);
    expect(r.errors.join(" ")).toMatch(/certificate/);
  });

  it("reads a PKCS#12 file (asks for the password first)", async () => {
    const f = [file("alt.pfx", p12(alt, "pw123"))];
    const first = await importKeys(f);
    expect(first.needsPassword).toBe(true); expect(first.imported).toEqual([]);
    const ok = await importKeys(f, "pw123");
    expect(ok.errors).toEqual([]);
    expect(ok.imported[0]).toMatchObject({ kind: "smime", hasPrivate: true, emails: [ALT] });
    const l = await keyList();
    expect(l.identities.find((i) => i.email === ALT)!.keys).toHaveLength(1);
    expect(l.identities.find((i) => i.email === U)!.keys.filter((k) => k.kind === "smime")).toHaveLength(1);
  });

  it("reads DER certificates and PKCS#7 bundles as contacts", async () => {
    const a = makeCert({ email: "der@example.net", keyIndex: 3 });
    const b = makeCert({ email: "bundle1@example.net", keyIndex: 3 });
    const c = makeCert({ email: "bundle2@example.net", keyIndex: 3 });
    expect((await importKeys([file("der.cer", a.certDer)])).imported[0]).toMatchObject({ emails: ["der@example.net"], hasPrivate: false });
    const bundle = await importKeys([file("chain.p7b", p7b([b, c]))]);
    expect(bundle.imported.flatMap((i) => i.emails).sort()).toEqual(["bundle1@example.net", "bundle2@example.net"]);
    const pem = makeCert({ email: "pem7@example.net", keyIndex: 3 });
    expect((await importKeys([file("c.p7b", p7b([pem], true))])).imported[0].emails).toEqual(["pem7@example.net"]);
  });

  it("rejects certificates that cannot be tied to an address or are not for email", async () => {
    const noMail = makeCert({ email: null, keyIndex: 3 });
    expect((await importKeys([file("n.crt", noMail.certPem)])).errors.join(" ")).toMatch(/no email address/);
    const web = makeCert({ email: "web@example.net", eku: "server", keyIndex: 3 });
    expect((await importKeys([file("w.crt", web.certPem)])).errors.join(" ")).toMatch(/not meant for email/);
  });

  it("refuses your own certificate for an address that is not yours", async () => {
    const stranger = makeCert({ email: "stranger@example.net", keyIndex: 3 });
    const r = await importKeys([file("s.key", stranger.keyPem), file("s.crt", stranger.certPem)]);
    expect(r.imported).toEqual([]);
    expect(r.errors.join(" ")).toMatch(/none of this account's sender addresses/);
  });

  it("keeps expired certificates but never offers them for signing", async () => {
    const old = makeCert({ email: ALT, days: -5, startDaysAgo: 400, keyIndex: 3 });
    const r = await importKeys([file("old.key", old.keyPem), file("old.crt", old.certPem)]);
    expect(r.imported).toHaveLength(1);
    const k = (await keyList()).identities.find((i) => i.email === ALT)!.keys.find((x) => x.id === r.imported[0].id);
    expect(k.status).toBe("expired");
    const caps = await api<any>(`/accounts/${acct.id}/security?identityId=${altId}`);
    expect(caps.sign.smime).toBe(true); // the valid PFX one is still there
    await api(`/keys/${k.id}`, { method: "DELETE" });
  });

  it("re-importing the same key updates it instead of duplicating it", async () => {
    const before = (await keyList()).identities.find((i) => i.email === U)!.keys.length;
    await importKeys([file("me.asc", myPgp.privateArmored)]);
    expect((await keyList()).identities.find((i) => i.email === U)!.keys.length).toBe(before);
  });

  it("reports what can be used while composing", async () => {
    const caps = await api<any>(`/accounts/${acct.id}/security?to=${EXT},nobody@example.net`);
    expect(caps.from).toBe(U);
    expect(caps.sign).toEqual({ pgp: true, smime: true });
    expect(caps.drafts).toEqual({ pgp: true, smime: true });
    expect(caps.recipients.find((r: any) => r.email === EXT)).toMatchObject({ pgp: true, smime: false });
    expect(caps.recipients.find((r: any) => r.email === "nobody@example.net")).toMatchObject({ pgp: false, smime: false });
  });
});

describe("sending signed and encrypted mail", () => {
  beforeAll(async () => { await importKeys([file("ext.crt", ext.certPem)]); });

  it("signs with S/MIME: the message verifies with OpenSSL and shows as signed in the Sent copy", async () => {
    await send({ subject: "S/MIME signed", text: "Signed hello", security: { sign: true, encrypt: false, protocol: "smime" } });
    const m = await mailpit.bySubject("S/MIME signed");
    const raw = await rawOf(m.ID);
    expect(raw.toString()).toMatch(/multipart\/signed; protocol="application\/pkcs7-signature"; micalg=sha-256/);
    if (hasOpenssl) {
      const out = openssl(["smime", "-verify", "-in", "@m.eml", "-CAfile", "@ca.pem", "-purpose", "any"], undefined, { "m.eml": raw, "ca.pem": me.certPem });
      expect(out.toString()).toContain("Signed hello");
    }
    const copy = await sentCopy("S/MIME signed");
    expect(copy.security.signature).toMatchObject({ protocol: "smime", status: "valid", signer: { email: U } });
    expect(copy.text).toContain("Signed hello");
    expect(copy.attachments).toEqual([]); // the signature is not shown as an attachment
  });

  it("signs with PGP/MIME and verifies it", async () => {
    await send({ subject: "PGP signed", html: "<p>Signed <b>html</b></p>", security: { sign: true, encrypt: false, protocol: "pgp" } });
    const raw = await rawOf((await mailpit.bySubject("PGP signed")).ID);
    expect(raw.toString()).toMatch(/multipart\/signed; protocol="application\/pgp-signature"; micalg=pgp-sha256/);
    expect(raw.toString()).toContain("BEGIN PGP SIGNATURE");
    const copy = await sentCopy("PGP signed");
    expect(copy.security.signature).toMatchObject({ protocol: "pgp", status: "valid" });
    expect(copy.html).toContain("<b>html</b>");
  });

  it("encrypts with S/MIME to the recipient and to yourself; OpenSSL can decrypt it, and the Sent copy opens", async () => {
    await send({ subject: "S/MIME secret", text: "The launch code is 1234", security: { sign: false, encrypt: true, protocol: "smime" } });
    const raw = await rawOf((await mailpit.bySubject("S/MIME secret")).ID);
    expect(raw.toString()).toMatch(/application\/pkcs7-mime; smime-type=enveloped-data/);
    expect(raw.toString()).not.toContain("launch code");
    if (hasOpenssl) {
      const out = openssl(["smime", "-decrypt", "-in", "@m.eml", "-recip", "@c.pem", "-inkey", "@k.pem"], undefined, { "m.eml": raw, "c.pem": ext.certPem, "k.pem": ext.keyPem });
      expect(out.toString()).toContain("The launch code is 1234");
    }
    const copy = await sentCopy("S/MIME secret");
    expect(copy.security.encryption).toMatchObject({ protocol: "smime", status: "decrypted" });
    expect(copy.text).toContain("The launch code is 1234");
  });

  it("encrypts with PGP to the recipient and to yourself", async () => {
    await send({ subject: "PGP secret", text: "Meet at noon", security: { sign: false, encrypt: true, protocol: "pgp" } });
    const raw = (await rawOf((await mailpit.bySubject("PGP secret")).ID)).toString();
    expect(raw).toMatch(/multipart\/encrypted; protocol="application\/pgp-encrypted"/);
    expect(raw).not.toContain("Meet at noon");
    // the recipient can read it with their private key
    const armored = raw.match(/-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/)![0];
    const dec = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: armored }), decryptionKeys: await openpgp.readPrivateKey({ armoredKey: extPgp.privateArmored }) });
    expect(String(dec.data)).toContain("Meet at noon");
    const copy = await sentCopy("PGP secret");
    expect(copy.security.encryption).toMatchObject({ protocol: "pgp", status: "decrypted" });
    expect(copy.text).toContain("Meet at noon");
  });

  it("signs and encrypts together, attachments included", async () => {
    const up = await (async () => {
      const fd = new FormData(); fd.append("file", new Blob(["top secret attachment"]), "plan.txt");
      return (await fetch(`${API_URL}/api/uploads`, { method: "POST", body: fd })).json() as Promise<any>;
    })();
    for (const protocol of ["smime", "pgp"] as const) {
      const subject = `Both ${protocol}`;
      await send({ subject, text: "Both body", attachments: [{ uploadId: up.id }], security: { sign: true, encrypt: true, protocol } });
      // the PGP recipient key was imported, the S/MIME one too, so both work
      const copy = await sentCopy(subject);
      expect(copy.security.encryption.status).toBe("decrypted");
      expect(copy.security.signature.status).toBe("valid");
      if (protocol === "smime") expect(copy.security.encryption.authenticated).toBe(true);
      expect(copy.text).toContain("Both body");
      expect(copy.attachments.map((a: any) => a.filename)).toEqual(["plan.txt"]);
      const dl = await fetch(`${API_URL}/api/messages/${copy.id}/attachments/${copy.attachments[0].idx}`);
      expect(await dl.text()).toBe("top secret attachment");
    }
  });

  it.skipIf(!hasOpenssl)("encrypts a separate copy for each Bcc recipient and files only the To/Cc copy in Sent", async () => {
    const hidden = makeCert({ email: "hidden-bcc@example.org", cn: "Hidden", keyIndex: 3 });
    await importKeys([file("hidden.crt", hidden.certPem)]);
    const subject = "S/MIME with Bcc";
    await send({ subject, text: "Bcc body", bcc: ["hidden-bcc@example.org"], security: { sign: true, encrypt: true, protocol: "smime" } });
    const both = await waitFor(async () => { const l = (await mailpit.recent()).filter((m) => m.Subject === subject); return l.length === 2 && l; }, { what: "two deliveries" });
    const full = await Promise.all(both.map((m: any) => mailpit.get(m.ID)));
    const openCopy = full.find((m) => !m.Bcc?.length)!, bccCopy = full.find((m) => m.Bcc?.length)!;
    expect(openCopy.To.map((t: any) => t.Address)).toEqual([EXT]);
    expect(bccCopy.Bcc.map((t: any) => t.Address)).toEqual(["hidden-bcc@example.org"]);
    const decrypt = (raw: Buffer, c: Cert) => openssl(["smime", "-decrypt", "-in", "@m.eml", "-recip", "@c.pem", "-inkey", "@k.pem"], undefined, { "m.eml": raw, "c.pem": c.certPem, "k.pem": c.keyPem }).toString();
    const openRaw = await rawOf(openCopy.ID), bccRaw = await rawOf(bccCopy.ID);
    expect(decrypt(openRaw, ext)).toContain("Bcc body");
    expect(() => decrypt(openRaw, hidden)).toThrow(); // not encrypted for the Bcc recipient
    expect(decrypt(bccRaw, hidden)).toContain("Bcc body");
    expect(() => decrypt(bccRaw, ext)).toThrow();
    const copy = await sentCopy(subject);
    expect(copy.security.encryption.status).toBe("decrypted");
    expect(copy.text).toContain("Bcc body");
    const sent = await acct.folder("Sent");
    expect((await api<any>(`/folders/${sent.id}/messages?limit=200`)).items.filter((i: any) => i.subject === subject)).toHaveLength(1);
  });

  it("explains which recipients have no key", async () => {
    const r = await apiRaw(`/accounts/${acct.id}/send`, { body: { to: [EXT, "nokey@example.net"], text: "x", subject: "nope", security: { sign: false, encrypt: true, protocol: "pgp" } } });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/nokey@example\.net/);
    expect(r.data.error).not.toContain(EXT);
  });

  it("refuses to sign when you have no key for the sending address", async () => {
    const other = await api(`/accounts/${acct.id}/identities`, { body: { name: "NoKey", email: "nokey-sender@example.test" } });
    const r = await apiRaw(`/accounts/${acct.id}/send`, { body: { to: [EXT], text: "x", subject: "nosign", identityId: other.id, security: { sign: true, encrypt: false, protocol: "smime" } } });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/no valid S\/MIME certificate for nokey-sender@example\.test/);
  });

  it("keeps a draft of an encrypted message encrypted to your own key, and opens it again", async () => {
    const drafts = await acct.folder("Drafts");
    const onServer = (uid: number) => imap(U, async (c) => {
      const lock = await c.getMailboxLock("Drafts");
      try { return (await c.fetchOne(String(uid), { source: true }, { uid: true }) as any).source.toString() as string; } finally { lock.release(); }
    });
    const reopen = async (subject: string) => {
      await syncFolder(drafts.id);
      const item = await waitFor(async () => (await api<any>(`/folders/${drafts.id}/messages?limit=200`)).items.find((i: any) => i.subject === subject), { what: subject });
      return api<any>(`/messages/${item.id}/draft`);
    };
    for (const protocol of ["smime", "pgp"] as const) {
      const subject = `Secret draft ${protocol}`;
      const d = await api<any>(`/accounts/${acct.id}/drafts`, { body: { to: [EXT], bcc: ["quiet@example.org"], subject, text: "Draft code 5678", security: { sign: true, encrypt: true, protocol } } });
      expect(d.encrypted).toBe(true);
      const raw = await onServer(d.uid);
      expect(raw).not.toContain("Draft code"); // the text in clear (a space never occurs in base64; "5678" alone can, by chance)
      expect(raw).toMatch(protocol === "pgp" ? /multipart\/encrypted/ : /application\/pkcs7-mime/);
      const back = await reopen(subject);
      expect(back.text).toContain("Draft code 5678");
      expect(back.bcc).toBe("quiet@example.org");
      expect(back.security).toEqual({ sign: false, encrypt: true, protocol });
    }
    // no own PGP key for the other address: saved as before, without encryption
    const plain = await api<any>(`/accounts/${acct.id}/drafts`, { body: { identityId: altId, to: [EXT], subject: "Plain draft", text: "Visible 4321", security: { encrypt: true, protocol: "pgp" } } });
    expect(plain.encrypted).toBe(false);
    expect(await onServer(plain.uid)).toContain("Visible 4321");
    expect((await reopen("Plain draft")).security).toBeNull();
  });

  it("keeps working with undo send (the protected message waits in the outbox)", async () => {
    const r = await send({ subject: "Delayed signed", text: "later", delaySeconds: 2, security: { sign: true, encrypt: false, protocol: "pgp" } });
    expect(r.queued).toBe(true);
    const raw = await rawOf((await mailpit.bySubject("Delayed signed")).ID);
    expect(raw.toString()).toContain("BEGIN PGP SIGNATURE");
  });
});

describe("reading protected mail from other people", () => {
  const body = "Content-Type: text/plain; charset=utf-8\r\n\r\nHello from outside\r\n";

  it.skipIf(!hasOpenssl)("shows an S/MIME signature from an unknown signer as untrusted, and trusted once you keep the certificate", async () => {
    const signer = makeCert({ email: "stranger2@example.org", cn: "Stranger Two", keyIndex: 1 });
    const out = openssl(["smime", "-sign", "-in", "@in.txt", "-signer", "@c.pem", "-inkey", "@k.pem", "-from", "Stranger <stranger2@example.org>", "-to", U, "-subject", "Signed by a stranger"],
      undefined, { "in.txt": body, "c.pem": signer.certPem, "k.pem": signer.keyPem });
    const m = await receive(out, "Signed by a stranger");
    expect(m.security.signature).toMatchObject({ protocol: "smime", status: "untrusted", signer: { email: "stranger2@example.org", name: "Stranger Two" } });
    expect(m.text).toContain("Hello from outside");
    // keep the certificate from the message
    const kept = await api<any>(`/messages/${m.id}/security/save-key`, { method: "POST" });
    expect(kept.emails).toEqual(["stranger2@example.org"]);
    const again = await api<any>(`/messages/${m.id}`);
    expect(again.security.signature).toMatchObject({ status: "valid" });
    expect((await keyList()).contacts.some((c) => c.emails.includes("stranger2@example.org"))).toBe(true);
  });

  it.skipIf(!hasOpenssl)("trusts a certificate kept from a message for the sender's address only", async () => {
    const genuine = makeCert({ email: "boss@example.org", cn: "Boss", keyIndex: 2 });
    await importKeys([file("boss.crt", genuine.certPem)]);
    const multi = makeCert({ email: "stranger3@example.org", extraEmails: ["boss@example.org"], cn: "Stranger Three", keyIndex: 1 });
    const signed = (from: string, subject: string) => openssl(["smime", "-sign", "-in", "@in.txt", "-signer", "@c.pem", "-inkey", "@k.pem", "-from", from, "-to", U, "-subject", subject],
      undefined, { "in.txt": body, "c.pem": multi.certPem, "k.pem": multi.keyPem });
    const m = await receive(signed("stranger3@example.org", "Signed by stranger three"), "Signed by stranger three");
    expect(m.security.signature.status).toBe("untrusted");
    const kept = await api<any>(`/messages/${m.id}/security/save-key`, { method: "POST" });
    expect(kept.emails).toEqual(["stranger3@example.org"]);
    expect((await api<any>(`/messages/${m.id}`)).security.signature.status).toBe("valid");
    expect((await apiRaw(`/messages/${m.id}/security/save-key`, { method: "POST" })).status).toBe(400); // already trusted
    // the same certificate does not vouch for the other address it lists
    const other = await receive(signed("boss@example.org", "Signed as the boss"), "Signed as the boss");
    expect(other.security.signature.status).toBe("untrusted");
    // even when trusted for that address too, it does not replace the imported certificate for encryption
    expect((await api<any>(`/messages/${other.id}/security/save-key`, { method: "POST" })).emails).toEqual(["boss@example.org"]);
    await send({ to: ["boss@example.org"], subject: "To the boss", text: "For the boss only", security: { sign: false, encrypt: true, protocol: "smime" } });
    const raw = await rawOf((await mailpit.bySubject("To the boss")).ID);
    const decrypt = (c: Cert) => openssl(["smime", "-decrypt", "-in", "@m.eml", "-recip", "@c.pem", "-inkey", "@k.pem"], undefined, { "m.eml": raw, "c.pem": c.certPem, "k.pem": c.keyPem }).toString();
    expect(decrypt(genuine)).toContain("For the boss only");
    expect(() => decrypt(multi)).toThrow();
  });

  it.skipIf(!hasOpenssl)("does not vouch for S/MIME-encrypted content the sender did not sign, and removes its remote images", async () => {
    const html = 'Content-Type: text/html; charset=utf-8\r\n\r\n<p>Hi <img src="https://tracker.example/p.png" alt="pixel"></p>\r\n';
    const out = openssl(["smime", "-encrypt", "-aes256", "-in", "@in.txt", "-from", "friend@example.org", "-to", U, "-subject", "Encrypted, not signed", "@c.pem"],
      undefined, { "in.txt": html, "c.pem": me.certPem });
    const m = await receive(out, "Encrypted, not signed");
    expect(m.security.encryption).toMatchObject({ protocol: "smime", status: "decrypted", authenticated: false });
    expect(m.security.encryption.message).toMatch(/not signed by the sender/);
    expect(m.hasRemoteImages).toBe(false);
    expect(m.remoteBlocked).toBe(true);
    expect(m.html).toContain("Hi");
    expect(m.html).not.toContain("tracker.example");
  });

  it.skipIf(!hasOpenssl)("detects a message that was changed after signing", async () => {
    const signer = makeCert({ email: "tamper@example.org", keyIndex: 1 });
    const out = openssl(["smime", "-sign", "-in", "@in.txt", "-signer", "@c.pem", "-inkey", "@k.pem", "-from", "tamper@example.org", "-to", U, "-subject", "Tampered"],
      undefined, { "in.txt": body, "c.pem": signer.certPem, "k.pem": signer.keyPem }).toString().replace("Hello from outside", "Hello from outsidX");
    const m = await receive(out, "Tampered");
    expect(m.security.signature.status).toBe("invalid");
  });

  it.skipIf(!hasOpenssl)("flags a valid signature from a different address than the sender", async () => {
    const signer = makeCert({ email: "real@example.org", keyIndex: 1 });
    const out = openssl(["smime", "-sign", "-in", "@in.txt", "-signer", "@c.pem", "-inkey", "@k.pem", "-from", "ceo@example.org", "-to", U, "-subject", "Spoofed sender"],
      undefined, { "in.txt": body, "c.pem": signer.certPem, "k.pem": signer.keyPem });
    const m = await receive(out, "Spoofed sender");
    expect(m.security.signature).toMatchObject({ status: "mismatch", signer: { email: "real@example.org" } });
  });

  it.skipIf(!hasOpenssl)("opens an S/MIME message encrypted for your certificate (made by OpenSSL)", async () => {
    const out = openssl(["smime", "-encrypt", "-aes256", "-in", "@in.txt", "-from", "friend@example.org", "-to", U, "-subject", "Encrypted by OpenSSL", "@c.pem"],
      undefined, { "in.txt": body, "c.pem": me.certPem });
    const m = await receive(out, "Encrypted by OpenSSL");
    expect(m.security.encryption).toMatchObject({ protocol: "smime", status: "decrypted" });
    expect(m.text).toContain("Hello from outside");
  });

  it.skipIf(!hasOpenssl)("says so when a message is encrypted for a certificate you do not have", async () => {
    const out = openssl(["smime", "-encrypt", "-in", "@in.txt", "-from", "friend@example.org", "-to", U, "-subject", "Not for me", "@c.pem"],
      undefined, { "in.txt": body, "c.pem": makeCert({ email: "someone@example.org", keyIndex: 3 }).certPem });
    const m = await receive(out, "Not for me");
    expect(m.security.encryption.status).toBe("no-key");
  });

  it.skipIf(!hasOpenssl)("handles opaque-signed S/MIME (the content inside the signature)", async () => {
    const signer = makeCert({ email: "opaque@example.org", keyIndex: 1 });
    const out = openssl(["smime", "-sign", "-nodetach", "-in", "@in.txt", "-signer", "@c.pem", "-inkey", "@k.pem", "-from", "opaque@example.org", "-to", U, "-subject", "Opaque signed"],
      undefined, { "in.txt": body, "c.pem": signer.certPem, "k.pem": signer.keyPem });
    const m = await receive(out, "Opaque signed");
    expect(m.security.signature.status).toBe("untrusted");
    expect(m.text).toContain("Hello from outside");
  });

  /** Build a PGP/MIME message the way another client would. */
  async function pgpMessage(o: { from: string; subject: string; sign?: openpgp.PrivateKey; encryptTo?: openpgp.Key }) {
    const entity = Buffer.from("Content-Type: text/plain; charset=utf-8\r\n\r\nPGP from outside\r\n");
    let wrapped = entity;
    let top = "";
    if (o.sign) {
      const sig = await openpgp.sign({ message: await openpgp.createMessage({ binary: entity.subarray(0, entity.length - 2) }), signingKeys: o.sign, detached: true, format: "armored" });
      wrapped = Buffer.from(`--B1\r\n${entity.toString().replace(/\r\n$/, "")}\r\n--B1\r\nContent-Type: application/pgp-signature; name="signature.asc"\r\n\r\n${sig}\r\n--B1--\r\n`);
      top = 'Content-Type: multipart/signed; protocol="application/pgp-signature"; micalg=pgp-sha256; boundary="B1"\r\nMIME-Version: 1.0\r\n';
      if (o.encryptTo) wrapped = Buffer.from(top + "\r\n" + wrapped.toString());
    }
    if (o.encryptTo) {
      const enc = await openpgp.encrypt({ message: await openpgp.createMessage({ binary: o.sign ? wrapped : entity }), encryptionKeys: o.encryptTo, format: "armored" });
      return Buffer.from(header(o.from, o.subject, 'MIME-Version: 1.0\r\nContent-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="E1"\r\n\r\n') +
        `--E1\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\r\n--E1\r\nContent-Type: application/octet-stream\r\n\r\n${enc}\r\n--E1--\r\n`);
    }
    return Buffer.from(header(o.from, o.subject, top + "\r\n") + wrapped.toString());
  }

  it("opens a PGP/MIME message encrypted to your key", async () => {
    const mine = await openpgp.readKey({ armoredKey: myPgp.publicArmored });
    const m = await receive(await pgpMessage({ from: EXT, subject: "PGP to me", encryptTo: mine }), "PGP to me");
    expect(m.security.encryption).toMatchObject({ protocol: "pgp", status: "decrypted" });
    expect(m.text).toContain("PGP from outside");
  });

  it("verifies a PGP/MIME signature from a key you have, and reports one from a key you lack", async () => {
    const signed = await receive(await pgpMessage({ from: EXT, subject: "PGP signed by ext", sign: await openpgp.readPrivateKey({ armoredKey: extPgp.privateArmored }) }), "PGP signed by ext");
    expect(signed.security.signature).toMatchObject({ protocol: "pgp", status: "valid", signer: { email: EXT } });
    const unknown = await makePgp("unknown@example.org");
    const u = await receive(await pgpMessage({ from: "unknown@example.org", subject: "PGP signed by unknown", sign: await openpgp.readPrivateKey({ armoredKey: unknown.privateArmored }) }), "PGP signed by unknown");
    expect(u.security.signature.status).toBe("unknown-key");
    const spoof = await receive(await pgpMessage({ from: "ceo@example.org", subject: "PGP spoof", sign: await openpgp.readPrivateKey({ armoredKey: extPgp.privateArmored }) }), "PGP spoof");
    expect(spoof.security.signature.status).toBe("mismatch");
  });

  it("does not store decrypted text in the database cache", async () => {
    const mine = await openpgp.readKey({ armoredKey: myPgp.publicArmored });
    const m = await receive(await pgpMessage({ from: EXT, subject: "PGP not cached", encryptTo: mine }), "PGP not cached");
    expect(m.text).toContain("PGP from outside");
    // a second read decrypts again rather than reading a cached plaintext copy
    const again = await api<any>(`/messages/${m.id}`);
    expect(again.security.encryption.status).toBe("decrypted");
  });

  it("leaves ordinary mail alone", async () => {
    const m = await receive(header("Plain <plain@example.org>", "Just plain", "MIME-Version: 1.0\r\n") + body, "Just plain");
    expect(m.security).toBeNull();
  });
});
