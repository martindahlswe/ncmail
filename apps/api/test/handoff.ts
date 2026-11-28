import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

/**
 * What the Nextcloud app does, for tests: an Ed25519 key pair that signs tokens and server-to-server requests.
 * `signed` signs a request the way the app does, over the host it is sent to (`host`, as in the Host header: "127.0.0.1:4100").
 */
export interface TestNextcloud {
  publicKey: string;
  token: (uid: string, o?: Partial<Record<string, unknown>>) => string;
  signed: (method: string, path: string, body: unknown, host: string) => { headers: Record<string, string>; body?: string };
}
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function testNextcloud(): TestNextcloud {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from((publicKey.export({ format: "jwk" }) as any).x, "base64url").toString("base64");
  const sig = (key: KeyObject, msg: string) => b64u(sign(null, Buffer.from(msg), key));
  return {
    publicKey: raw,
    token: (uid, o = {}) => {
      const now = Math.floor(Date.now() / 1000);
      const payload = b64u(JSON.stringify({ v: 1, uid, name: `${uid} Example`, email: `${uid}@example.org`, lang: "en", jti: randomBytes(12).toString("hex"), iat: now, exp: now + 60, aud: "http://localhost:4000", ...o }));
      return `v1.${payload}.${sig(privateKey, `ncmail-handoff-v1.${payload}`)}`;
    },
    signed: (method, path, body, host) => {
      const raw = body === undefined ? "" : JSON.stringify(body);
      const ts = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(12).toString("hex");
      const head = ["ncmail-s2s-v2", method, host.toLowerCase()];
      const msg = [...head, path, ts, nonce, createHash("sha256").update(raw).digest("hex")].join("\n");
      return {
        headers: { "x-ncmail-ts": ts, "x-ncmail-nonce": nonce, "x-ncmail-sig": sig(privateKey, msg), "x-ncmail-sig-version": "2", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body === undefined ? undefined : raw,
      };
    },
  };
}
export { generateKeyPairSync };
