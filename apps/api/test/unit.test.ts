import { beforeAll, describe, expect, it } from "vitest";

// crypto.ts reads the key lazily; set it before the first use.
process.env.SECRET_KEY = Buffer.alloc(32, 9).toString("base64");

describe("search query parser", async () => {
  const { parseQuery } = await import("../src/search.ts");
  const parse = (q: string, opts?: { skipFree?: boolean }) => { const params: unknown[] = []; return { ...parseQuery(q, params, opts), params }; };

  it("treats plain words as free text matched as substrings", () => {
    const r = parse("Quarterly report");
    expect(r.freeTerms).toEqual(["Quarterly", "report"]);
    expect(r.params).toContain("%quarterly%");
    expect(r.params).toContain("%report%");
  });

  it("understands operators", () => {
    const r = parse("from:ada to:bob subject:invoice has:attachment is:unread in:sent");
    expect(r.hasIn).toBe(true);
    expect(r.freeTerms).toEqual([]);
    expect(r.params).toEqual(expect.arrayContaining(["%ada%", "%bob%", "%invoice%", "%sent%", "\\Sent"]));
    expect(r.conds.some((c) => c.includes("has_attachments"))).toBe(true);
    expect(r.conds.some((c) => c.includes("not ('\\Seen'"))).toBe(true);
  });

  it("keeps quoted phrases together and uses adjacency for the body index", () => {
    const r = parse('"quarterly invoice"');
    expect(r.freeTerms).toEqual(["quarterly invoice"]);
    expect(r.params).toContain("quarterly:* <-> invoice:*");
  });

  it("ANDs unquoted words in the body index query", () => {
    expect(parse("budget").params).toContain("budget:*");
  });

  it("negation does not count as a positive search term", () => {
    const r = parse("invoice -newsletter");
    expect(r.freeTerms).toEqual(["invoice"]);
    expect(r.conds.some((c) => c.startsWith("not ("))).toBe(true);
  });

  it("escapes LIKE wildcards so % and _ are literal", () => {
    const r = parse("100% a_b");
    expect(r.params).toContain("%100\\%%");
    expect(r.params).toContain("%a\\_b%");
  });

  it("validates dates and reports what it ignored", () => {
    const ok = parse("after:2026-01-31 before:2026-02-28");
    expect(ok.notes).toEqual([]);
    expect(ok.params).toEqual(expect.arrayContaining(["2026-01-31", "2026-02-28"]));
    expect(parse("before:soon").notes[0]).toMatch(/needs a date/);
    expect(parse("is:weird").notes[0]).toMatch(/Unknown is:/);
  });

  it("falls back to literal text for unknown operators", () => {
    expect(parse("foo:bar").freeTerms).toEqual(["foo:bar"]);
  });

  it("skips local free-text conditions in server-text mode but still collects the terms", () => {
    const r = parse("zebrafish from:ada", { skipFree: true });
    expect(r.freeTerms).toEqual(["zebrafish"]);
    expect(r.params).not.toContain("%zebrafish%");
    expect(r.params).toContain("%ada%");
  });

  it("never lets query text into the SQL itself (only into parameters)", () => {
    const evil = "'; drop table messages; --";
    const r = parse(`from:"${evil}" ${evil}`);
    expect(r.conds.join(" ")).not.toContain("drop table");
    expect(r.params.some((p) => String(p).includes("drop table"))).toBe(true);
  });
});

describe("plain-text part with signatures", async () => {
  const { toPlainText } = await import("../src/signature.ts");
  const sigHtml = '<div data-signature="true"><p><strong>Dev Team</strong></p><p>Platform Engineering</p></div>';

  it("uses the configured plain-text signature when the signature is untouched", () => {
    const text = toPlainText(`<p>Body</p>${sigHtml}`, { signatureHtml: "<p><strong>Dev Team</strong></p><p>Platform Engineering</p>", signatureText: "Dev Team | Platform Engineering" });
    expect(text).toBe("Body\n\n-- \nDev Team | Platform Engineering");
  });

  it("mirrors an edited signature instead of the configured one", () => {
    const edited = '<p>Body</p><div data-signature="true"><p>Dev Team</p><p>Edited for this mail</p></div>';
    const text = toPlainText(edited, { signatureHtml: "<p>Dev Team</p><p>Platform Engineering</p>", signatureText: "Dev Team | Platform Engineering" });
    expect(text).toContain("-- \nDev Team");
    expect(text).toContain("Edited for this mail");
    expect(text).not.toContain("Platform Engineering");
  });

  it("generates the plain signature from HTML when none is configured", () => {
    const text = toPlainText(`<p>Body</p>${sigHtml}`, { signatureHtml: "<p><strong>Dev Team</strong></p><p>Platform Engineering</p>" });
    expect(text).toMatch(/^Body\n\n-- \nDev Team\n\nPlatform Engineering$/);
  });

  it("recognises a signature configured as plain text only", () => {
    const html = '<p>Hi</p><div data-signature="true"><p>Line one<br>Line two</p></div>';
    expect(toPlainText(html, { signatureText: "Line one\nLine two" })).toBe("Hi\n\n-- \nLine one\nLine two");
  });

  it("finds a whole signature entered as HTML, with <div>s of its own, and uses its plain-text version", async () => {
    const sig = `<table><tr><td><div><b>Ada Lovelace</b></div><div>Analytical Engines</div></td></tr></table>`;
    const html = `<p>Hi</p><div data-signature="html">${sig}</div><blockquote><p>Earlier</p></blockquote>`;
    expect(toPlainText(html, { signatureHtml: sig, signatureText: "Ada Lovelace, Analytical Engines" }))
      .toBe("Hi\n\n-- \nAda Lovelace, Analytical Engines\n\n> Earlier");
    // without a plain-text version, the whole block is converted (not cut at its first </div>)
    const text = toPlainText(html, { signatureHtml: sig });
    expect(text).toContain("-- \nAda Lovelace");
    expect(text).toContain("Analytical Engines");
    expect(text).toContain("> Earlier");
  });

  it("adds no signature marker when the block is gone", () => {
    expect(toPlainText("<p>Just the body</p>", { signatureText: "Sig" })).toBe("Just the body");
  });

  it("writes link targets into the text part", () => {
    expect(toPlainText('<p>See <a href="https://example.com/docs">the docs</a></p>')).toContain("https://example.com/docs");
  });
});

describe("HTML sanitising", async () => {
  const { sanitizeEmailHtml } = await import("../src/content.ts");

  it("removes scripts, event handlers and javascript: links", () => {
    const { html } = sanitizeEmailHtml('<p onclick="x()">hi</p><script>alert(1)</script><a href="javascript:alert(1)">bad</a><iframe src="https://evil"></iframe>');
    expect(html).not.toMatch(/script|onclick|javascript:|iframe/i);
    expect(html).toContain("hi");
  });

  it("keeps harmless styling but drops risky CSS values", () => {
    const { html } = sanitizeEmailHtml('<p style="color:#00679e;background:url(javascript:alert(1));font-weight:bold">x</p>');
    expect(html).toContain("color:#00679e");
    expect(html).not.toContain("javascript");
  });

  it("flags remote images (the viewer blocks them) but not data: images", () => {
    expect(sanitizeEmailHtml('<img src="https://tracker.example/p.png">').hasRemoteImages).toBe(true);
    expect(sanitizeEmailHtml('<img src="data:image/png;base64,AAAA">').hasRemoteImages).toBe(false);
    expect(sanitizeEmailHtml('<img src="//tracker.example/p.png">').hasRemoteImages).toBe(true);
  });

  it("counts CSS backgrounds from elsewhere as remote images, but not inline data: ones", () => {
    expect(sanitizeEmailHtml('<div style="background:url(http://tracker.example/bg.gif)">x</div>').hasRemoteImages).toBe(true);
    expect(sanitizeEmailHtml('<div style="background:url(&quot;https://tracker.example/bg.gif&quot;)">x</div>').hasRemoteImages).toBe(true);
    expect(sanitizeEmailHtml('<div style="background:url(data:image/png;base64,AAAA)">x</div>').hasRemoteImages).toBe(false);
    expect(sanitizeEmailHtml('<div style="color:red;font-family:Arial">x</div>').hasRemoteImages).toBe(false);
  });

  it("drops CSS values that use escapes", () => {
    const r = sanitizeEmailHtml('<div style="color:red;background:u\\72l(http://tracker.example/a)">x</div>');
    expect(r.html).not.toContain("tracker");
    expect(r.html).toContain("color:red");
  });

  it("opens links safely", () => {
    const { html } = sanitizeEmailHtml('<a href="https://example.com">x</a>');
    expect(html).toMatch(/rel="noopener noreferrer"/);
    expect(html).toMatch(/target="_blank"/);
  });
});

describe("vCard and iCalendar text values", async () => {
  const { escText } = await import("../src/nextcloud/link.ts");

  it("escapes separators and backslashes", () => {
    expect(escText("a,b;c\\d")).toBe("a\\,b\\;c\\\\d");
  });
  it("keeps every value on one content line", () => {
    for (const v of ["Bob\rEMAIL:x@example.org", "Bob\nEND:VCARD", "Bob\r\nX", "Bob\u0085X", "Bob\u2028X"]) {
      expect(escText(v)).not.toMatch(/[\r\n\u0085\u2028\u2029]/);
      expect(escText(v)).toMatch(/^Bob\\n/);
    }
    expect(escText("a\u0000b\u001bc\u007fd")).toBe("abcd");
    expect(escText("tab\there")).toBe("tab\there");
  });
});

describe("credential encryption", async () => {
  const { encrypt, decrypt } = await import("../src/crypto.ts");

  it("round-trips and never stores the plaintext", () => {
    const enc = encrypt("s3cret-password");
    expect(enc).not.toContain("s3cret");
    expect(decrypt(enc)).toBe("s3cret-password");
  });

  it("uses a fresh nonce each time", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("detects tampering", () => {
    const buf = Buffer.from(encrypt("data"), "base64");
    buf[buf.length - 1] ^= 1;
    expect(() => decrypt(buf.toString("base64"))).toThrow();
  });

  it("refuses values too short to hold the nonce and a full tag", async () => {
    const { createCipheriv } = await import("node:crypto");
    expect(() => decrypt("v1:" + Buffer.alloc(27).toString("base64"))).toThrow(/could not be read/);
    expect(() => decrypt("")).toThrow(/could not be read/);
    // a value whose tag was cut to 4 bytes is not accepted, even though GCM could check a short tag
    const iv = Buffer.alloc(12, 1), c = createCipheriv("aes-256-gcm", Buffer.alloc(32, 9), iv);
    const enc = Buffer.concat([c.update("data"), c.final()]);
    expect(() => decrypt("v1:" + Buffer.concat([iv, c.getAuthTag().subarray(0, 4), enc]).toString("base64"))).toThrow(/could not be read/);
  });
});

describe("sharing mail text to Talk", async () => {
  const { noMentions } = await import("../src/nextcloud/integrations.ts");
  it("turns every @ into a look-alike that Talk does not read as a mention", () => {
    expect(noMentions("@all see a@b.example")).toBe("\uFF20all see a\uFF20b.example");
    expect(noMentions("no mentions")).toBe("no mentions");
  });
});

describe("outgoing message headers", async () => {
  const { buildRaw } = await import("../src/send.ts");
  const mail = { to: ["a@example.org"], cc: [], bcc: ["secret@example.org"], subject: "Hi", text: "body", references: [], attachments: [] };
  const head = (raw: Buffer) => raw.toString().split(/\r?\n\r?\n/)[0]!;

  it("does not put Bcc recipients into a sent message", async () => {
    expect(head(await buildRaw({} as any, { name: "Me", email: "me@example.test" }, mail))).not.toMatch(/^bcc:/im);
  });

  it("keeps Bcc in drafts so reopening them restores it", async () => {
    expect(head(await buildRaw({} as any, { name: "Me", email: "me@example.test" }, mail, { keepBcc: true }))).toMatch(/^Bcc: secret@example.org/m);
  });

  it("sends HTML as multipart/alternative with a text part", async () => {
    const raw = (await buildRaw({} as any, { name: "Me", email: "me@example.test" }, { ...mail, html: "<p>Hello <b>you</b></p>" })).toString();
    expect(raw).toMatch(/multipart\/alternative/);
    expect(raw).toMatch(/Content-Type: text\/plain/);
    expect(raw).toMatch(/Content-Type: text\/html/);
  });

  it("asks for a read receipt only when told to", async () => {
    const me = { name: "Me", email: "me@example.test" };
    expect(head(await buildRaw({} as any, me, { ...mail, readReceipt: true }))).toMatch(/^Disposition-Notification-To: me@example.test$/m);
    expect(head(await buildRaw({} as any, me, mail))).not.toMatch(/Disposition-Notification-To/i);
  });

  it("sends pictures in the text as inline cid parts, not data: URLs", async () => {
    const { simpleParser } = await import("mailparser");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const html = `<p>Look <img src="data:image/png;base64,${png}" width="1"></p><div data-signature="true"><p><img src="data:image/png;base64,${png}"></p></div>`;
    const raw = (await buildRaw({} as any, { name: "Me", email: "me@example.test" }, { ...mail, html })).toString();
    expect(raw).toMatch(/multipart\/related/);
    expect(raw).not.toMatch(/data:image/);
    const p = await simpleParser(raw);
    expect(p.attachments).toHaveLength(1); // the same picture twice is sent once
    expect(p.attachments[0]!.related).toBe(true);
    expect(p.attachments[0]!.contentDisposition).toBe("inline");
  });
});

describe("pictures in the text", async () => {
  const { extractInlineImages } = await import("../src/inlineImages.ts");
  const gif = "R0lGODlhAQABAAAAACw=";

  it("replaces data: pictures with cid: references", () => {
    const r = extractInlineImages(`<p><img alt="a" src="data:image/gif;base64,${gif}"><img src='data:image/jpg;base64,${gif}'></p>`, "example.test");
    expect(r.images).toHaveLength(1);
    expect(r.images[0]!.cid).toMatch(/@example\.test$/);
    expect(r.html).toBe(`<p><img alt="a" src="cid:${r.images[0]!.cid}"><img src='cid:${r.images[0]!.cid}'></p>`);
    expect(r.images[0]!.content.equals(Buffer.from(gif, "base64"))).toBe(true);
  });

  it("leaves other addresses and non-picture data alone", () => {
    const html = `<img src="https://example.org/a.png"><img src="data:text/html;base64,PGI+"><a href="data:image/png;base64,AAAA">x</a>`;
    expect(extractInlineImages(html)).toEqual({ html, images: [] });
  });
});

describe("forgotten attachment hint", async () => {
  const { mentionsAttachment } = await import("@ncmail/shared");

  it("finds attachment words in several languages", () => {
    for (const t of ["See the attached file.", "Attachment follows", "Please find enclosed", "I'll attach it", "Se bifogad fil", "Här är bilagan", "Siehe Anhang", "anbei die Datei",
      "Voir la pièce jointe", "ci-joint", "Te envío el archivo adjunto", "in allegato", "zie bijlage", "Se vedlagt", "liitteenä", "segue em anexo"]) {
      expect(mentionsAttachment(t), t).toBe(true);
    }
  });

  it("ignores words that only contain one of them", () => {
    for (const t of ["", "I am attacking the problem", "enclosing the garden", "Detached house", "bilagd", "Thanks!", "joint venture"]) {
      expect(mentionsAttachment(t), t).toBe(false);
    }
  });

  it("is not fooled by case or punctuation", () => {
    expect(mentionsAttachment("ATTACHED:")).toBe(true);
    expect(mentionsAttachment("(bilaga)")).toBe(true);
  });
});

describe("background sync cadence", async () => {
  const { bgDue, bgConfig } = await import("../src/sync.ts");
  const cfg = { tickMs: 1000, healthyMs: 180_000, degradedMs: 60_000 };

  it("runs immediately the first time", () => {
    expect(bgDue(true, undefined, 1_000_000, cfg)).toBe(true);
  });

  it("waits longer while IDLE is healthy than while it is not", () => {
    const now = 1_000_000;
    expect(bgDue(true, now - 90_000, now, cfg)).toBe(false);   // 90 s ago: too soon when IDLE is up
    expect(bgDue(false, now - 90_000, now, cfg)).toBe(true);   // ...but due when IDLE is down
    expect(bgDue(true, now - 181_000, now, cfg)).toBe(true);
  });

  it("has sane defaults and honours overrides", () => {
    expect(bgConfig()).toMatchObject({ tickMs: 30_000, healthyMs: 180_000, degradedMs: 60_000 });
    process.env.NCMAIL_BG_HEALTHY_MS = "5000";
    expect(bgConfig().healthyMs).toBe(5000);
    delete process.env.NCMAIL_BG_HEALTHY_MS;
  });
});

describe("sign-in settings at startup", async () => {
  const { checkAuthConfig, isLoopbackAddress } = await import("../src/auth.ts");

  it("runs single-user only when listening on this machine", () => {
    expect(checkAuthConfig({})).toBe("single");
    expect(checkAuthConfig({ API_HOST: "127.0.0.1" })).toBe("single");
    expect(checkAuthConfig({ API_HOST: "::1" })).toBe("single");
    expect(checkAuthConfig({ NCMAIL_AUTH: "", API_HOST: "localhost" })).toBe("single");
    for (const h of ["0.0.0.0", "::", "192.168.1.10", "mail.example.test"]) expect(() => checkAuthConfig({ API_HOST: h }), h).toThrow(/NCMAIL_AUTH/);
  });

  it("allows an explicit NCMAIL_AUTH=off on any address", () => {
    expect(checkAuthConfig({ NCMAIL_AUTH: "off", API_HOST: "0.0.0.0" })).toBe("off");
  });

  it("needs a usable NEXTCLOUD_URL for NCMAIL_AUTH=nextcloud", () => {
    expect(checkAuthConfig({ NCMAIL_AUTH: "nextcloud", NEXTCLOUD_URL: "https://cloud.example.test", API_HOST: "0.0.0.0" })).toBe("nextcloud");
    for (const u of [undefined, "", "cloud.example.test", "ftp://cloud.example.test"]) expect(() => checkAuthConfig({ NCMAIL_AUTH: "nextcloud", NEXTCLOUD_URL: u }), String(u)).toThrow(/NEXTCLOUD_URL/);
  });

  it("rejects unknown NCMAIL_AUTH values", () => {
    for (const v of ["Nextcloud", "on", "true", "none"]) expect(() => checkAuthConfig({ NCMAIL_AUTH: v, NEXTCLOUD_URL: "https://cloud.example.test" }), v).toThrow(/not a known value/);
  });

  it("tells loopback connections from others", () => {
    for (const a of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(a), a).toBe(true);
    for (const a of ["", "10.0.0.1", "172.17.0.1", "::ffff:10.0.0.1", "203.0.113.7", "fe80::1"]) expect(isLoopbackAddress(a), a).toBe(false);
  });
});

describe("request gate without sign-in", async () => {
  const Fastify = (await import("fastify")).default;
  const { installAuth } = await import("../src/auth.ts");
  const { internalRoutes } = await import("../src/internal.ts");
  const app = Fastify();
  beforeAll(async () => {
    const saved = { auth: process.env.NCMAIL_AUTH, nc: process.env.NEXTCLOUD_URL };
    delete process.env.NCMAIL_AUTH; delete process.env.NEXTCLOUD_URL;
    installAuth(app);
    await app.register(internalRoutes);
    app.get("/api/messages/:id", async () => ({ ok: true }));
    await app.ready();
    return async () => {
      await app.close();
      for (const [k, v] of [["NCMAIL_AUTH", saved.auth], ["NEXTCLOUD_URL", saved.nc]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    };
  });
  const get = (url: string, remoteAddress: string, host = "localhost") => app.inject({ method: "GET", url, remoteAddress, headers: { host } });

  it("serves connections from this machine", async () => {
    expect((await get("/api/messages/1", "127.0.0.1")).statusCode).toBe(200);
    expect((await get("/api/messages/1", "::1", "[::1]:4000")).statusCode).toBe(200);
  });

  it("refuses connections from other machines whatever their Host header says", async () => {
    for (const a of ["203.0.113.7", "172.17.0.1", "::ffff:192.0.2.1"]) {
      const r = await get("/api/messages/1", a);
      expect(r.statusCode, a).toBe(403);
      expect(r.json().code).toBe("no-auth");
    }
  });

  it("requires Nextcloud's signature on internal routes however the path is spelled", async () => {
    for (const u of ["/api/internal/unread?uid=x", "/%61pi/internal/unread?uid=x", "/api/%69nternal/unread?uid=x"]) expect((await get(u, "127.0.0.1")).statusCode, u).toBe(401);
  });

  it("does not serve paths that only resemble API routes", async () => {
    for (const u of ["/api//messages/1", "/api%2Fmessages/1", "/API/messages/1"]) expect((await get(u, "127.0.0.1")).statusCode, u).toBe(404);
  });
});

describe("outbound address checks", async () => {
  const net = await import("node:net");
  const { isPrivateIp, canonicalIp, guardHost, pinnedLookup, guardedLookup } = await import("../src/netguard.ts");
  const withPolicy = async (v: string, fn: () => Promise<void>) => {
    const old = process.env.NCMAIL_PRIVATE_HOSTS;
    process.env.NCMAIL_PRIVATE_HOSTS = v;
    try { await fn(); } finally { if (old === undefined) delete process.env.NCMAIL_PRIVATE_HOSTS; else process.env.NCMAIL_PRIVATE_HOSTS = old; }
  };
  // a resolver stand-in that answers from a list and counts its calls; no DNS is used
  const stubResolver = (answers: string[][]) => {
    const r = Object.assign(async () => (answers[Math.min(r.calls++, answers.length - 1)] ?? []).map((address) => ({ address, family: net.isIP(address) })), { calls: 0 });
    return r;
  };

  it("classifies IPv6 addresses in any spelling", () => {
    for (const ip of ["0:0:0:0:0:ffff:127.0.0.1", "0:0:0:0:0:ffff:7f00:1", "0::1", "0:0:0:0:0:0:0:1", "0:0:0:0:0:ffff:169.254.169.254", "0::ffff:10.0.0.1",
      "::", "0.0.0.0", "::127.0.0.1", "::ffff:0:7f00:1", "64:ff9b::7f00:1", "2002:a00:1::", "fec0::1", "FE80::1%eth0", "ff02::1", "FD12:3456::1"]) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ["::ffff:8.8.8.8", "0:0:0:0:0:ffff:808:808", "64:ff9b::808:808", "2001:4860:4860::8888", "2606:4700:4700:0:0:0:0:1111"]) expect(isPrivateIp(ip), ip).toBe(false);
  });

  it("writes addresses in one canonical form", () => {
    expect(canonicalIp("0:0:0:0:0:ffff:7f00:1")).toBe("127.0.0.1");
    expect(canonicalIp("0::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(canonicalIp("2606:4700:4700::1111")).toBe("2606:4700:4700:0:0:0:0:1111");
    expect(canonicalIp("not-an-address")).toBeNull();
  });

  it("checks the name again for every connection", async () => {
    await withPolicy("block", async () => {
      const resolve = stubResolver([["93.184.216.34"], ["127.0.0.1"]]);
      expect(await guardHost("changing.example", "mail server", resolve)).toEqual([{ address: "93.184.216.34", family: 4 }]);
      await expect(guardHost("changing.example", "mail server", resolve)).rejects.toMatchObject({ statusCode: 400 });
      expect(resolve.calls).toBe(2);
    });
  });

  it("refuses a name when any of its addresses is private", async () => {
    await withPolicy("block", async () => {
      await expect(guardHost("mixed.example", "x", stubResolver([["93.184.216.34", "10.0.0.1"]]))).rejects.toThrow(/private or local network/);
      await expect(guardHost("0:0:0:0:0:ffff:7f00:1", "x", stubResolver([]))).rejects.toThrow(/private or local network/);
    });
  });

  it("keeps the allow-list and allow modes", async () => {
    await withPolicy("mail.internal,10.5.0.0/16", async () => {
      expect(await guardHost("mail.internal", "x", stubResolver([["10.1.2.3"]]))).toHaveLength(1);
      expect(await guardHost("other.internal", "x", stubResolver([["10.5.1.1"]]))).toHaveLength(1);
      await expect(guardHost("other.internal", "x", stubResolver([["10.6.1.1"]]))).rejects.toMatchObject({ statusCode: 400 });
    });
    await withPolicy("allow", async () => {
      const resolve = stubResolver([["127.0.0.1"]]);
      expect(await guardHost("anything.example", "x", resolve)).toBeNull();
      expect(await guardedLookup("anything.example", "x", resolve)).toBeUndefined();
      expect(resolve.calls).toBe(0);
    });
  });

  it("answers socket lookups only with the checked addresses", async () => {
    const lookup = pinnedLookup([{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1", family: 6 }])!;
    const ask = (opts: object) => new Promise<unknown[]>((res) => lookup("checked.example", opts as never, ((...a: unknown[]) => res(a)) as never));
    expect(await ask({})).toEqual([null, "93.184.216.34", 4]);
    expect(await ask({ family: 6 })).toEqual([null, "2606:4700::1", 6]);
    expect(await ask({ all: true })).toEqual([null, [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1", family: 6 }]]);
    expect(pinnedLookup(null)).toBeUndefined();
  });

  it("connects to the address that was checked, not a fresh lookup of the name", async () => {
    await withPolicy("pinned.example", async () => {
      const server = net.createServer((s) => { s.on("error", () => {}); s.end("hello\r\n"); }).listen(0, "127.0.0.1");
      await new Promise((r) => server.once("listening", r));
      try {
        const lookup = await guardedLookup("pinned.example", "x", stubResolver([["127.0.0.1"]]));
        const port = (server.address() as { port: number }).port;
        const got = await new Promise<string>((res, rej) => {
          const s = net.connect({ host: "pinned.example", port, lookup }, () => { res(s.remoteAddress ?? ""); s.destroy(); });
          s.on("error", rej);
        });
        expect(got).toBe("127.0.0.1");
      } finally { server.close(); }
    });
  });
});

describe("HTML sanitising without remote content", async () => {
  const { sanitizeEmailHtml } = await import("../src/content.ts");

  it("removes remote images and CSS URLs but keeps data: images", () => {
    const r = sanitizeEmailHtml('<p style="color:red;background:url(https://t.example/b.png)">x</p><img src="https://t.example/p.png" alt="logo"><img src="data:image/png;base64,AAAA">', { allowRemote: false });
    expect(r.hasRemoteImages).toBe(true); // reported, so the reader can say they were removed
    expect(r.html).not.toContain("t.example");
    expect(r.html).toContain('alt="logo"');
    expect(r.html).toContain("data:image/png;base64,AAAA");
    expect(r.html).toContain("color:red");
  });
});

describe("S/MIME key files and signature trust", async () => {
  const { parseSmime, readSigned, smimeSign } = await import("../src/secure/smime.ts");
  const { makeCert, p12, patchInteger } = await import("./secure-fixtures.ts");
  const forge = (await import("node-forge")).default;
  const stored = (certPem: string, keyPem = "", extraPem = "") => {
    const k = parseSmime([{ name: "c.pem", data: Buffer.from(certPem + keyPem) }]).keys[0]!;
    return { ...k, id: k.fingerprint, publicData: k.publicData + extraPem };
  };
  const entity = Buffer.from("Content-Type: text/plain; charset=utf-8\r\n\r\nHello\r\n");
  const ITER = 65536, OVER_LIMIT = 0x7fffff; // same DER length, so the file stays well-formed

  it("refuses a PKCS#12 MAC iteration count above the limit before deriving any key", () => {
    const c = makeCert({ email: "p12@example.org", keyIndex: 1 });
    const data = patchInteger(p12(c, "pw", "3des", { count: ITER }), ITER, OVER_LIMIT);
    const t = Date.now();
    const r = parseSmime([{ name: "big.p12", data }]);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.keys).toEqual([]);
    expect(r.needsPassword).toBe(false);
    expect(r.errors.join(" ")).toMatch(/iteration count/);
  });

  it("refuses PKCS#12 bag encryption above the limit, even with the right password", () => {
    const c = makeCert({ email: "p12@example.org", keyIndex: 1 });
    const data = patchInteger(p12(c, "pw", "3des", { count: ITER, useMac: false }), ITER, OVER_LIMIT);
    const t = Date.now();
    const r = parseSmime([{ name: "big.p12", data }], "pw");
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.keys).toEqual([]);
    expect(r.errors.join(" ")).toMatch(/iteration count/);
  });

  it("still reads PKCS#12 files with common iteration counts", () => {
    const c = makeCert({ email: "p12@example.org", keyIndex: 1 });
    for (const data of [p12(c, "pw"), p12(c, "pw", "aes256", { count: 10_000 })]) {
      const r = parseSmime([{ name: "ok.p12", data }], "pw");
      expect(r.errors).toEqual([]);
      expect(r.keys[0]).toMatchObject({ hasPrivate: true, emails: ["p12@example.org"] });
    }
  });

  it("refuses an encrypted PEM private key with an iteration count above the limit", () => {
    const c = makeCert({ email: "pem@example.org", keyIndex: 1 });
    const pem = forge.pki.encryptRsaPrivateKey(c.key, "pw", { algorithm: "aes256", count: ITER } as any);
    const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
    const big = `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${patchInteger(der, ITER, OVER_LIMIT).toString("base64")}\n-----END ENCRYPTED PRIVATE KEY-----\n`; // gitleaks:allow (key generated by the test)
    const r = parseSmime([{ name: "k.pem", data: Buffer.from(big) }, { name: "c.pem", data: Buffer.from(c.certPem) }], "pw");
    expect(r.keys.some((k) => k.hasPrivate)).toBe(false);
    expect(r.errors.join(" ")).toMatch(/iteration count/);
    const ok = parseSmime([{ name: "k.pem", data: Buffer.from(pem) }, { name: "c.pem", data: Buffer.from(c.certPem) }], "pw");
    expect(ok.keys[0]).toMatchObject({ hasPrivate: true });
  });

  it("a kept contact certificate vouches only for itself, not for certificates issued with its key", () => {
    const contact = makeCert({ email: "contact@example.org", cn: "Contact", keyUsage: null, keyIndex: 1 });
    const issued = makeCert({ email: "boss@example.org", cn: "Boss", keyIndex: 2, issuer: { cert: contact.cert, key: contact.key } });
    const known = [stored(contact.certPem)];
    const sig = smimeSign(entity, stored(issued.certPem, issued.keyPem, contact.certPem));
    expect(readSigned(sig).verify(entity, known, "boss@example.org").status).toBe("untrusted");
    const own = smimeSign(entity, stored(contact.certPem, contact.keyPem));
    expect(readSigned(own).verify(entity, known, "contact@example.org").status).toBe("valid");
  });

  it("counts a kept certificate only for the addresses it was kept for", () => {
    const multi = makeCert({ email: "sender@example.org", extraEmails: ["other@example.org"], keyIndex: 3 });
    const kept = { ...stored(multi.certPem), emails: ["sender@example.org"] };
    const sig = smimeSign(entity, stored(multi.certPem, multi.keyPem));
    expect(readSigned(sig).verify(entity, [kept], "sender@example.org").status).toBe("valid");
    expect(readSigned(sig).verify(entity, [kept], "other@example.org").status).toBe("untrusted");
    expect(readSigned(sig).verify(entity, [kept], "").status).toBe("untrusted");
  });

  /** A detached signature that claims to have been made at `when`. */
  const signedAt = (c: { cert: any; key: any }, when: Date) => {
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(entity.toString("latin1"));
    p7.addCertificate(c.cert);
    p7.addSigner({ key: c.key, certificate: c.cert, digestAlgorithm: forge.pki.oids.sha256!, authenticatedAttributes: [
      { type: forge.pki.oids.contentType!, value: forge.pki.oids.data }, { type: forge.pki.oids.messageDigest! }, { type: forge.pki.oids.signingTime!, value: when as any },
    ] });
    p7.sign({ detached: true });
    return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), "latin1");
  };

  it("judges the signer's certificate now, not at the signing time the message claims", () => {
    const expired = makeCert({ email: "old@example.org", startDaysAgo: 30, days: -5, keyIndex: 1 });
    const sig = signedAt(expired, new Date(Date.now() - 10 * 86400_000)); // claims a time when it was still valid
    expect(readSigned(sig).verify(entity, [stored(expired.certPem)], "old@example.org").status).toBe("expired");
    // a certificate that starts a minute from now is accepted (clock skew), one that starts in an hour is not
    const soon = makeCert({ email: "new@example.org", startDaysAgo: -1 / 1440, keyIndex: 2 });
    expect(readSigned(signedAt(soon, new Date())).verify(entity, [stored(soon.certPem)], "new@example.org").status).toBe("valid");
    const later = makeCert({ email: "new@example.org", startDaysAgo: -1 / 24, keyIndex: 2 });
    expect(readSigned(signedAt(later, new Date())).verify(entity, [stored(later.certPem)], "new@example.org").status).toBe("expired");
  });

  it("decrypts AuthEnvelopedData (AES-GCM) and notices tampering", async () => {
    const { smimeDecrypt } = await import("../src/secure/smime.ts");
    const { openssl } = await import("./secure-fixtures.ts");
    const me = makeCert({ email: "me@example.org", keyIndex: 1 });
    const mine = [stored(me.certPem, me.keyPem)];
    for (const alg of ["-aes-256-gcm", "-aes-128-gcm"]) {
      const der = openssl(["cms", "-encrypt", alg, "-in", "@in.txt", "-outform", "DER", "@c.pem"], undefined, { "in.txt": "Content-Type: text/plain\r\n\r\nGCM hello\r\n", "c.pem": me.certPem });
      expect(String(smimeDecrypt(der, mine))).toContain("GCM hello");
      const bad = Buffer.from(der); bad[bad.length - 20] ^= 1;
      expect(() => smimeDecrypt(bad, mine)).toThrow(/could not be decrypted/);
    }
    const other = makeCert({ email: "x@example.org", keyIndex: 2 });
    const der = openssl(["cms", "-encrypt", "-aes-256-gcm", "-in", "@in.txt", "-outform", "DER", "@c.pem"], undefined, { "in.txt": "x", "c.pem": other.certPem });
    expect(smimeDecrypt(der, mine)).toBe("no-key");
  });

  it("refuses to decrypt content encrypted with single DES", async () => {
    const { smimeDecrypt } = await import("../src/secure/smime.ts");
    const me = makeCert({ email: "me@example.org", keyIndex: 1 });
    const p7: any = forge.pkcs7.createEnvelopedData();
    p7.addRecipient(me.cert); p7.content = forge.util.createBuffer("x"); p7.encrypt(undefined, forge.pki.oids["des-EDE3-CBC"]);
    p7.encryptedContent.algorithm = forge.pki.oids.desCBC; // what a single-DES message names
    expect(() => smimeDecrypt(Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), "latin1"), [stored(me.certPem, me.keyPem)])).toThrow(/single DES/);
  });
});

describe("invitation to calendar object", async () => {
  const { toCalendarObject } = await import("../src/calendar/ics.ts");
  const invite = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:u1@test", "DTSTART:20261201T100000Z", "SUMMARY:Review",
    "ATTACH;FMTTYPE=application/pdf:https://files.example.org/agenda.pdf", "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.org",
    "BEGIN:VALARM", "ACTION:AUDIO", "TRIGGER:-PT15M", "ATTACH:https://files.example.org/sound.wav", "END:VALARM", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");

  it("drops alarms and attachments but keeps the event", () => {
    const o = toCalendarObject(invite, ["me@example.org"]);
    expect(o).not.toMatch(/VALARM|ATTACH|TRIGGER|^ACTION:/m);
    expect(o).toContain("SUMMARY:Review");
    expect(o).toContain("ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.org");
    expect(o).toMatch(/STATUS:TENTATIVE\r\nEND:VEVENT\r\nEND:VCALENDAR/);
  });
});

describe("folder rights", async () => {
  const { lacksRead, isNoPerm } = await import("../src/acl.ts");

  it("treats unknown rights as readable and lookup-only as not", () => {
    expect(lacksRead(null)).toBe(false);
    expect(lacksRead("lrs")).toBe(false);
    expect(lacksRead("l")).toBe(true);
    expect(lacksRead("")).toBe(true);
  });
  it("recognises a refusal for missing rights", () => {
    expect(isNoPerm({ serverResponseCode: "NOPERM" })).toBe(true);
    expect(isNoPerm({ response: { attributes: [{ section: [{ value: "NOPERM" }] }] } })).toBe(true);
    expect(isNoPerm({ responseText: "[NOPERM] Permission denied" })).toBe(true);
    expect(isNoPerm(new Error("Connection closed"))).toBe(false);
  });
});

describe("mirrored header values", async () => {
  const { toRow, capBytes } = await import("../src/sync.ts");
  const long = "é".repeat(5000);
  const row = toRow({
    uid: 1, internalDate: new Date(), flags: new Set(), size: 1,
    envelope: { subject: long, from: [{ name: long, address: "x@example.org" }], messageId: `<${"a".repeat(600)}@t>`, inReplyTo: "<p@t>" },
    headers: Buffer.from(`References: <${"b".repeat(600)}@t> <ok@t>\r\n`),
  });

  it("cuts long values on a character boundary", () => {
    expect(capBytes("aé", 2)).toBe("a");
    expect(capBytes("abc", 10)).toBe("abc");
    expect(Buffer.byteLength(row.subject)).toBeLessThanOrEqual(1500);
    expect(row.subject).toMatch(/^é+$/);
    expect(Buffer.byteLength(row.from_name)).toBeLessThanOrEqual(1500);
  });
  it("leaves over-long ids out of threading", () => {
    expect(row.message_id).toBeNull();
    expect(row.in_reply_to).toBe("<p@t>");
    expect(row.refs).toEqual(["<ok@t>"]);
  });
});

describe("sign-in tokens and signed calls from Nextcloud", async () => {
  const { claimsProblem, keyFetchAllowed, normalUrl, s2sMessage } = await import("../src/handoff.ts");
  const now = 1_800_000_000;
  const claims = (o: Record<string, unknown> = {}) => ({ uid: "alice", jti: "j1", iat: now, exp: now + 60, aud: "https://mail.example.test", ...o });

  it("accepts well-formed claims", () => {
    expect(claimsProblem(claims(), now, "")).toBeNull();
    expect(claimsProblem(claims(), now, "https://mail.example.test/")).toBeNull();
    expect(claimsProblem(claims({ aud: "https://MAIL.example.test:443/" }), now, "https://mail.example.test")).toBeNull();
  });
  it("requires an audience, and the configured one when NCMAIL_PUBLIC_URL is set", () => {
    expect(claimsProblem(claims({ aud: undefined }), now, "")).toBe("invalid");
    expect(claimsProblem(claims({ aud: "" }), now, "")).toBe("invalid");
    expect(claimsProblem(claims({ aud: "not a url" }), now, "")).toBe("invalid");
    expect(claimsProblem(claims({ aud: ["https://mail.example.test"] }), now, "")).toBe("invalid");
    expect(claimsProblem(claims({ aud: "https://other.example.test" }), now, "https://mail.example.test")).toBe("invalid");
    expect(claimsProblem(claims({ aud: "http://mail.example.test" }), now, "https://mail.example.test")).toBe("invalid");
  });
  it("requires numeric times within two minutes", () => {
    for (const iat of [undefined, null, String(now), NaN, now + 61]) expect(claimsProblem(claims({ iat }), now, ""), String(iat)).toBe("invalid");
    expect(claimsProblem(claims({ exp: String(now + 60) }), now, "")).toBe("invalid");
    expect(claimsProblem(claims({ exp: now + 600 }), now, "")).toBe("expired");
    expect(claimsProblem(claims({ iat: now - 600, exp: now - 540 }), now, "")).toBe("expired");
  });
  it("compares addresses by origin and path", () => {
    expect(normalUrl("https://Mail.Example.test:443/mail/")).toBe("https://mail.example.test/mail");
    expect(normalUrl("ftp://mail.example.test")).toBe("");
  });
  it("fetches the signing key over plain http only from local or private addresses, or when allowed", () => {
    for (const u of ["https://cloud.example.test", "http://localhost:8088", "http://nc.localhost", "http://127.0.0.1:8080", "http://[::1]:8080", "http://10.1.2.3", "http://192.168.0.5", "http://nextcloud"]) expect(keyFetchAllowed(u, {}), u).toBe(true);
    for (const u of ["http://cloud.example.test", "http://203.0.113.7", "ftp://cloud.example.test", ""]) expect(keyFetchAllowed(u, {}), u).toBe(false);
    expect(keyFetchAllowed("http://cloud.example.test", { NCMAIL_HANDOFF_KEY_HTTP: "1" })).toBe(true);
  });
  it("signs the target host", () => {
    const o = { method: "POST", url: "/api/internal/logout", ts: 1, nonce: "n", body: "{}" };
    expect(s2sMessage({ ...o, host: "Mail.Example.test:443" })).toBe(s2sMessage({ ...o, host: "mail.example.test" }));
    expect(s2sMessage({ ...o, host: "mail.example.test" })).not.toBe(s2sMessage({ ...o, host: "other.example.test" }));
    expect(s2sMessage({ ...o, host: "127.0.0.1:4000" }).split("\n").slice(0, 4)).toEqual(["ncmail-s2s-v2", "POST", "127.0.0.1:4000", "/api/internal/logout"]);
  });
});

describe("proxy hops", async () => {
  const { trustProxySetting } = await import("../src/auth.ts");
  it("trusts a number of hops, not every hop", () => {
    expect(trustProxySetting("")).toBe(false);
    expect(trustProxySetting("0")).toBe(false);
    const one = trustProxySetting("1") as (a: string, i: number) => boolean;
    expect([one("127.0.0.1", 0), one("203.0.113.7", 1)]).toEqual([true, false]);
    const two = trustProxySetting("2") as (a: string, i: number) => boolean;
    expect([two("10.0.0.1", 1), two("203.0.113.7", 2)]).toEqual([true, false]);
    expect(trustProxySetting("10.0.0.0/8, 127.0.0.1")).toBe("10.0.0.0/8, 127.0.0.1");
  });
  it("takes the client address from the entry the trusted proxy added", async () => {
    const Fastify = (await import("fastify")).default;
    const app = Fastify({ trustProxy: trustProxySetting("1") });
    app.get("/ip", async (req) => ({ ip: req.ip, host: req.host }));
    const r = await app.inject({ url: "/ip", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.9", "x-forwarded-host": "mail.example.test" } });
    expect(r.json()).toEqual({ ip: "203.0.113.9", host: "mail.example.test" });
    await app.close();
  });
});

describe("browser origin checks with sign-in", async () => {
  const Fastify = (await import("fastify")).default;
  const { installAuth } = await import("../src/auth.ts");
  const app = Fastify();
  beforeAll(async () => {
    const saved = { auth: process.env.NCMAIL_AUTH, nc: process.env.NEXTCLOUD_URL };
    process.env.NCMAIL_AUTH = "nextcloud"; process.env.NEXTCLOUD_URL = "https://cloud.example.test";
    installAuth(app);
    app.post("/api/messages/:id", async () => ({ ok: true }));
    await app.ready();
    return async () => {
      await app.close();
      for (const [k, v] of [["NCMAIL_AUTH", saved.auth], ["NEXTCLOUD_URL", saved.nc]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    };
  });
  // the session id is not a real one, so a request that passes the origin check ends at "Please sign in" (401)
  const post = (remoteAddress: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: "/api/messages/1", remoteAddress, headers: { host: "mail.example.test", cookie: "ncmail_session=x", ...headers } });

  it("refuses a cookie-carrying change with neither Sec-Fetch-Site nor Origin", async () => {
    const r = await post("203.0.113.7");
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe("origin");
    expect((await post("127.0.0.1", { "x-forwarded-for": "203.0.113.7" })).statusCode).toBe(403); // through a proxy on this machine
  });
  it("lets the app's own requests through to the session check", async () => {
    expect((await post("203.0.113.7", { origin: "https://mail.example.test" })).statusCode).toBe(401);
    expect((await post("203.0.113.7", { "sec-fetch-site": "same-origin" })).statusCode).toBe(401);
    expect((await post("127.0.0.1")).statusCode).toBe(401); // tools on the server itself
    expect((await app.inject({ method: "POST", url: "/api/messages/1", remoteAddress: "203.0.113.7", headers: { host: "mail.example.test" } })).statusCode).toBe(401); // no cookie
  });
  it("still refuses other sites", async () => {
    expect((await post("203.0.113.7", { origin: "https://evil.example.test" })).statusCode).toBe(403);
    expect((await post("203.0.113.7", { "sec-fetch-site": "cross-site" })).statusCode).toBe(403);
  });
});

describe("Nextcloud login flow approved as another user", async () => {
  const Fastify = (await import("fastify")).default;
  const { createServer } = await import("node:http");
  const { ncRoutes } = await import("../src/nextcloud/link.ts");
  const revoked: string[] = [];
  const nc = createServer((req, res) => {
    const base = `http://${req.headers.host}`;
    if (req.method === "POST" && req.url === "/index.php/login/v2") return res.end(JSON.stringify({ poll: { token: "t", endpoint: `${base}/index.php/login/v2/poll` }, login: `${base}/login/v2/flow/t` }));
    if (req.method === "POST" && req.url === "/index.php/login/v2/poll") return res.end(JSON.stringify({ loginName: "mallory", appPassword: "minted-for-mallory" }));
    if (req.method === "DELETE" && req.url === "/ocs/v2.php/core/apppassword") { revoked.push(String(req.headers.authorization)); return res.end("{}"); }
    res.writeHead(404).end();
  });
  const app = Fastify();
  beforeAll(async () => {
    await new Promise<void>((r) => nc.listen(0, "127.0.0.1", r));
    const saved = process.env.NEXTCLOUD_URL;
    process.env.NEXTCLOUD_URL = `http://127.0.0.1:${(nc.address() as any).port}`;
    app.decorateRequest("owner", "");
    app.addHook("onRequest", async (req) => { req.owner = "alice"; });
    await app.register(ncRoutes);
    await app.ready();
    return async () => { await app.close(); nc.close(); if (saved === undefined) delete process.env.NEXTCLOUD_URL; else process.env.NEXTCLOUD_URL = saved; };
  });

  it("refuses the result and takes back the app password it produced", async () => {
    const { id } = (await app.inject({ method: "POST", url: "/api/nextcloud/connect" })).json();
    const r = await app.inject({ method: "POST", url: "/api/nextcloud/connect/poll", payload: { id } });
    expect(r.statusCode).toBe(400);
    expect(revoked).toEqual([`Basic ${Buffer.from("mallory:minted-for-mallory").toString("base64")}`]);
  });
});

describe("search query limits", async () => {
  const { checkQuery, MAX_SEARCH_TERMS, MAX_SEARCH_CHARS } = await import("../src/search.ts");
  const status = (q: string) => { try { checkQuery(q); return 200; } catch (e: any) { return e.statusCode; } };

  it("accepts ordinary queries up to the term limit", () => {
    expect(status('from:ada "quarterly report" -newsletter after:2026-01-01')).toBe(200);
    expect(status(Array.from({ length: MAX_SEARCH_TERMS }, (_, i) => `w${i}`).join(" "))).toBe(200);
  });

  it("refuses too many terms or operators, and overlong queries, with a 400", () => {
    expect(status(Array.from({ length: MAX_SEARCH_TERMS + 1 }, (_, i) => `from:w${i}`).join(" "))).toBe(400);
    expect(status("x".repeat(MAX_SEARCH_CHARS + 1))).toBe(400);
  });
});

describe("statement timeout setting", async () => {
  const { timeoutMs } = await import("../src/db.ts");
  it("reads milliseconds, allows 0 (off) and falls back on nonsense", () => {
    expect(timeoutMs(undefined, 30_000)).toBe(30_000);
    expect(timeoutMs("", 30_000)).toBe(30_000);
    expect(timeoutMs("5000", 30_000)).toBe(5000);
    expect(timeoutMs("0", 30_000)).toBe(0);
    expect(timeoutMs("-1", 30_000)).toBe(30_000);
    expect(timeoutMs("soon", 30_000)).toBe(30_000);
  });
});

describe("heavy-sync gate fairness", async () => {
  const { Gate } = await import("../src/sync.ts");
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("lets one owner use every slot while nobody else waits", async () => {
    const g = new Gate(() => 2);
    await g.acquire("a"); await g.acquire("a");
    expect(g.running).toBe(2);
    g.release("a"); g.release("a");
    expect(g.running).toBe(0);
  });

  it("gives a freed slot to a waiting owner who holds none before the same owner's next import", async () => {
    const g = new Gate(() => 2);
    await g.acquire("a"); await g.acquire("a");
    const order: string[] = [];
    const a3 = g.acquire("a").then(() => order.push("a"));
    const b1 = g.acquire("b").then(() => order.push("b"));
    expect(g.waiting).toBe(2);
    g.release("a"); await tick();
    expect(order).toEqual(["b"]);
    g.release("a"); await tick();
    expect(order).toEqual(["b", "a"]);
    await Promise.all([a3, b1]);
    expect(g.running).toBe(2);
  });

  it("skips waiters whose owner already holds a slot while others wait", async () => {
    const g = new Gate(() => 2);
    await g.acquire("a"); await g.acquire("a");
    const order: string[] = [];
    const waits = ["a", "a", "b", "c"].map((o) => g.acquire(o).then(() => order.push(o)));
    g.release("a"); await tick();
    expect(order).toEqual(["b"]);
    g.release("b"); await tick(); // a still holds one, so c goes before a's queued imports
    expect(order).toEqual(["b", "c"]);
    g.release("a"); await tick();
    g.release("c"); await tick();
    expect(order).toEqual(["b", "c", "a", "a"]);
    await Promise.all(waits);
  });
});

describe("key rotation script", async () => {
  const { rotateSecrets } = await import("../scripts/rotate-key.ts");
  const { encrypt } = await import("../src/crypto.ts");

  it("re-encrypts what it can, reports each value it cannot, and keeps going", async () => {
    const current = process.env.SECRET_KEY;
    const oldKey = Buffer.alloc(32, 3).toString("base64");
    process.env.SECRET_KEY = oldKey;
    const underOld = encrypt("old secret");
    process.env.SECRET_KEY = current;
    process.env.SECRET_KEY_OLD = oldKey;
    const rows: Record<string, { pk: string; v: string }[]> = {
      imap_password_enc: [{ pk: "a1", v: "v1:" + Buffer.alloc(40, 1).toString("base64") }, { pk: "a2", v: underOld }, { pk: "a3", v: encrypt("fine") }],
      private_enc: [{ pk: "k1", v: "garbage" }],
    };
    const updates: unknown[][] = [];
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith("update")) { updates.push(params!); return { rows: [] }; }
        const col = Object.keys(rows).find((c) => sql.includes(` ${c} as v`));
        return { rows: col ? rows[col]! : [] };
      },
    };
    const lines: string[] = [];
    try {
      const r = await rotateSecrets(db, (l) => lines.push(l));
      expect(r.changed).toBe(1);
      expect(r.kept).toBe(1);
      expect(r.failed).toEqual([
        { table: "accounts", column: "imap_password_enc", key: "a1" },
        { table: "crypto_keys", column: "private_enc", key: "k1" },
      ]);
      expect(updates.map((u) => u[1])).toEqual(["a2"]);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/accounts\.imap_password_enc where id = a1/);
    } finally { delete process.env.SECRET_KEY_OLD; }
  });
});

describe("reply to list (List-Post)", async () => {
  const { parseListPost } = await import("../src/listunsub.ts");
  const post = (v: string) => parseListPost([{ key: "list-post", line: `List-Post: ${v}` }]);

  it("takes the first mailto address, without its subject or other parts", () => {
    expect(post("<mailto:dev@lists.example.org?subject=hello>")).toBe("dev@lists.example.org");
    expect(post("<https://lists.example.org/post>,\r\n <mailto:dev@lists.example.org>")).toBe("dev@lists.example.org");
  });

  it("offers nothing for lists nobody may post to, web-only lists or no header", () => {
    expect(post("NO (posting not allowed on this list)")).toBeNull();
    expect(post("<https://lists.example.org/post>")).toBeNull();
    expect(post("<mailto:not-an-address>")).toBeNull();
    expect(parseListPost([])).toBeNull();
  });
});

describe("read receipts (RFC 8098)", async () => {
  const { buildMdn, parseReceiptRequest, receiptOffer, encodeHeaderText } = await import("../src/mdn.ts");
  const { simpleParser } = await import("mailparser");
  // as delivered: the receiving server's Return-Path first, then the message's own headers
  const req = (dnt: string, rp?: string) => parseReceiptRequest([
    ...(rp !== undefined ? [{ key: "return-path", line: `Return-Path: ${rp}` }] : []),
    { key: "disposition-notification-to", line: `Disposition-Notification-To: ${dnt}` },
  ]);
  const inbox = { flags: [] as string[], folderSpecial: "\\Inbox", fromMine: false };

  it("reads the receipt address and the envelope sender", () => {
    expect(req("Ann (work) <ann@example.com>, other@example.com", "<bounce@example.com>")).toEqual({ to: "ann@example.com", returnPath: "bounce@example.com" });
    expect(req("ann@example.com", "<>")).toEqual({ to: "ann@example.com", returnPath: "" });
    expect(req("ann@example.com")).toEqual({ to: "ann@example.com", returnPath: null });
    expect(req("not an address", "<a@example.com>")).toBeNull();
    expect(parseReceiptRequest([])).toBeNull();
  });

  it("offers an answer only when the receipt goes to the envelope sender's domain", () => {
    expect(receiptOffer(req("ann@Example.com", "<bounce@example.com>"), inbox)).toBe("ann@Example.com");
    expect(receiptOffer(req("ann@elsewhere.example", "<bounce@example.com>"), inbox)).toBeNull();
    expect(receiptOffer(req("ann@example.com"), inbox)).toBeNull(); // no Return-Path
    expect(receiptOffer(req("ann@example.com", "<>"), inbox)).toBeNull(); // null sender
  });

  it("does not ask again, and never in Junk, Sent or Drafts or for your own mail", () => {
    const r = req("ann@example.com", "<ann@example.com>");
    expect(receiptOffer(r, { ...inbox, flags: ["\\Seen", "$MDNSent"] })).toBeNull();
    for (const folderSpecial of ["\\Junk", "\\Sent", "\\Drafts"]) expect(receiptOffer(r, { ...inbox, folderSpecial })).toBeNull();
    expect(receiptOffer(r, { ...inbox, fromMine: true })).toBeNull();
    expect(receiptOffer(r, { ...inbox, folderSpecial: null })).toBe("ann@example.com");
  });

  it("builds a multipart/report with a note for people and the disposition fields", async () => {
    const raw = buildMdn({ from: { name: "Zoë Example", email: "zoe@example.org" }, to: "ann@example.com", subject: "Plans für Mai",
      originalMessageId: "<abc@example.com>", originalDate: new Date("2026-11-01T10:00:00Z") });
    const text = raw.toString();
    expect(text).toMatch(/^Content-Type: multipart\/report; report-type=disposition-notification; boundary="/m);
    expect(text).not.toMatch(/[^\r]\n/); // CRLF line ends throughout
    const p = await simpleParser(raw);
    expect(p.subject).toBe("Read: Plans für Mai");
    expect(p.from?.value[0]).toEqual({ name: "Zoë Example", address: "zoe@example.org" });
    expect(p.to && !Array.isArray(p.to) ? p.to.value[0]!.address : "").toBe("ann@example.com");
    expect(p.inReplyTo).toBe("<abc@example.com>");
    expect(p.text).toContain('with the subject "Plans für Mai"');
    const report = p.attachments.find((a) => a.contentType === "message/disposition-notification")!.content.toString();
    expect(report).toContain("Reporting-UA: example.org; NCMail\r\n");
    expect(report).toContain("Final-Recipient: rfc822; zoe@example.org\r\n");
    expect(report).toContain("Original-Message-ID: <abc@example.com>\r\n");
    expect(report).toContain("Disposition: manual-action/MDN-sent-manually; displayed\r\n");
  });

  it("encodes header text that is not ASCII in short pieces", () => {
    expect(encodeHeaderText("Plain")).toBe("Plain");
    const enc = encodeHeaderText("ü".repeat(60));
    expect(enc.split("\r\n ").every((w) => w.length <= 75 && /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(w))).toBe(true);
  });
});

describe("images from allowed senders", async () => {
  const { imagesTrustable } = await import("../src/imagesenders.ts");
  const ok = { folderSpecial: "\\Inbox", authWarnings: 0, unverified: false, authenticated: true };

  it("applies only outside Junk, when the sender checks passed and the content is verified", () => {
    expect(imagesTrustable(ok)).toBe(true);
    expect(imagesTrustable({ ...ok, authenticated: false })).toBe(false); // no failed check is not the same as a confirmed sender
    expect(imagesTrustable({ ...ok, folderSpecial: null })).toBe(true);
    expect(imagesTrustable({ ...ok, folderSpecial: "\\Junk" })).toBe(false);
    expect(imagesTrustable({ ...ok, authWarnings: 1 })).toBe(false);
    expect(imagesTrustable({ ...ok, unverified: true })).toBe(false);
  });
});

describe("forward as attachment", async () => {
  const { emlName } = await import("../src/uploads.ts");
  it("names the file after the subject", () => {
    expect(emlName("Re: Plans / May?")).toBe("Re_ Plans _ May_.eml");
    expect(emlName("")).toBe("message.eml");
    expect(emlName("x".repeat(200))).toBe(`${"x".repeat(80)}.eml`);
  });
});

describe("checking a mail server's connection", async () => {
  const net = await import("node:net");
  const { check } = await import("../src/mailprobe.ts");
  /** A tiny stand-in that greets like an IMAP or SMTP server. */
  const fake = (greeting: string) => new Promise<{ port: number; close: () => void }>((resolve) => {
    const srv = net.createServer((sock) => { sock.on("error", () => {}); sock.write(greeting); });
    srv.listen(0, "127.0.0.1", () => resolve({ port: (srv.address() as any).port, close: () => srv.close() }));
  });
  const closedPort = async () => { const s = await fake(""); s.close(); return s.port; };

  it("suggests a usual port that answers when the chosen one does not", async () => {
    const imap = await fake("* OK IMAP ready\r\n");
    try {
      const r = await check("imap", { host: "127.0.0.1", port: await closedPort(), security: "none" }, [{ port: imap.port, security: "none" }]);
      expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/Nothing answers/), suggestion: { port: imap.port, security: "none" } });
    } finally { imap.close(); }
  });

  it("does not suggest a port where another kind of server answers", async () => {
    const smtp = await fake("220 smtp ready\r\n");
    try {
      const r = await check("imap", { host: "127.0.0.1", port: await closedPort(), security: "none" }, [{ port: smtp.port, security: "none" }]);
      expect(r.ok).toBe(false);
      expect(r.suggestion).toBeUndefined();
    } finally { smtp.close(); }
  });

  it("warns about a server that answers without encryption", async () => {
    const smtp = await fake("220 smtp ready\r\n");
    try {
      expect(await check("smtp", { host: "127.0.0.1", port: smtp.port, security: "none" }, [])).toMatchObject({ ok: true, warning: "plain" });
    } finally { smtp.close(); }
  });
});

describe("one folder-list change per account at a time", async () => {
  const { withAccountLock } = await import("../src/sync.ts");
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  it("runs changes to the same account one after another, and other accounts alongside", async () => {
    const log: string[] = [];
    const job = (acct: string, name: string, ms: number) => withAccountLock(acct, async () => { log.push(`${name} start`); await wait(ms); log.push(`${name} end`); });
    await Promise.all([job("a", "sync", 40), job("a", "rename", 1), job("b", "other", 1)]);
    expect(log.indexOf("rename start")).toBeGreaterThan(log.indexOf("sync end"));
    expect(log.indexOf("other end")).toBeLessThan(log.indexOf("sync end"));
  });
  it("keeps going after a change fails", async () => {
    await expect(withAccountLock("c", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withAccountLock("c", async () => "next")).toBe("next");
  });
});

describe("Nextcloud app and mail service versions", async () => {
  const { compareVersions, noteAppVersion, MIN_APP_VERSION } = await import("../src/compat.ts");
  it("compares versions numerically and ignores pre-release tags", () => {
    expect(compareVersions("0.10.0", "0.9.3")).toBe(1);
    expect(compareVersions("0.4.1", "0.4.1-ci")).toBe(0);
    expect(compareVersions("v1.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.4.0", "0.4.1")).toBe(-1);
  });
  it("warns once about an app that is too old, sends no version, or is out of step", () => {
    const warnings: string[] = [];
    const log = { warn: (_: object, m: string) => warnings.push(m) };
    noteAppVersion(undefined, log); noteAppVersion(undefined, log);
    noteAppVersion("0.0.9", log); noteAppVersion("0.0.9", log);
    noteAppVersion("99.0.0", log);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/does not say its version/);
    expect(warnings[1]).toMatch(/too old/);
    expect(warnings[2]).toMatch(/different versions/);
    expect(MIN_APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("second security review", async () => {
  const { senderAuthenticated, parseAuth } = await import("../src/phishing.ts");
  const { oneClickTrusted } = await import("../src/listunsub.ts");
  const { parseReceiptRequest } = await import("../src/mdn.ts");
  const { parseAutoconfig, publicHost } = await import("../src/discover.ts");
  const { extractInlineImages } = await import("../src/inlineImages.ts");
  const net = await import("node:net");
  const { probe } = await import("../src/mailprobe.ts");

  it("loads a trusted sender's images only when the receiving server confirmed the From domain", () => {
    const auth = (s: string) => parseAuth(`mx.example.test; ${s}`, undefined);
    expect(senderAuthenticated(auth("dmarc=pass header.from=bank.example"), "bank.example")).toBe(true);
    expect(senderAuthenticated(auth("dkim=pass header.d=news.bank.example"), "bank.example")).toBe(true);
    expect(senderAuthenticated(auth("spf=pass smtp.mailfrom=bounce@bank.example"), "bank.example")).toBe(true);
    // a forged From: no results at all, or results for the attacker's own domain only
    expect(senderAuthenticated(parseAuth(undefined, undefined), "bank.example")).toBe(false);
    expect(senderAuthenticated(auth("spf=pass smtp.mailfrom=x@attacker.example; dkim=pass header.d=attacker.example; dmarc=none"), "bank.example")).toBe(false);
  });

  it("does not let a planted parent-domain signature vouch for one-click unsubscribe", () => {
    const u = { oneClick: true, http: "https://victim-thirdparty.com/u", signatures: [{ d: "com", covers: true }, { d: "attacker.com", covers: false }] } as any;
    expect(oneClickTrusted(u, { dkimPass: ["attacker.com"] }, "attacker.com")).toBe(false);
    const real = { oneClick: true, http: "https://lists.example.org/u", signatures: [{ d: "example.org", covers: true }] } as any;
    expect(oneClickTrusted(real, { dkimPass: ["example.org"] }, "example.org")).toBe(true);
  });

  it("takes the envelope sender only from a topmost Return-Path, and only printable receipt addresses", () => {
    const dnt = { key: "disposition-notification-to", line: "Disposition-Notification-To: ann@example.com" };
    const rp = { key: "return-path", line: "Return-Path: <bounce@example.com>" };
    expect(parseReceiptRequest([rp, dnt])).toEqual({ to: "ann@example.com", returnPath: "bounce@example.com" });
    expect(parseReceiptRequest([dnt, rp])).toEqual({ to: "ann@example.com", returnPath: null }); // the sender's own, further down
    expect(parseReceiptRequest([{ key: "disposition-notification-to", line: "Disposition-Notification-To: an\u0000n@example.com" }])).toBeNull();
  });

  it("ignores looked-up servers that are addresses or single names (they can only point inwards)", () => {
    for (const h of ["127.0.0.1", "localhost", "10.0.0.5", "a..b.example"]) expect(publicHost(h)).toBe(false);
    expect(publicHost("imap.example.org")).toBe(true);
    const xml = (host: string) => `<clientConfig><incomingServer type="imap"><hostname>${host}</hostname><port>993</port><socketType>SSL</socketType></incomingServer><outgoingServer type="smtp"><hostname>smtp.example.org</hostname><port>465</port><socketType>SSL</socketType></outgoingServer></clientConfig>`;
    expect(parseAutoconfig(xml("127.0.0.1"), "example.org")).toBeNull();
    expect(parseAutoconfig(xml("imap.example.org"), "example.org")?.imap.host).toBe("imap.example.org");
  });

  it("finds pictures in linear time, even in crafted HTML", () => {
    const t = Date.now();
    extractInlineImages(`<img src='data:image/png;base64,A"`.repeat(300_000));
    expect(Date.now() - t).toBeLessThan(2000); // was minutes, freezing the service for everybody
    const r = extractInlineImages(`<p>x</p><img alt="a" src="data:image/png;base64,iVBORw0KGgo="><img src="https://x">`);
    expect(r.images).toHaveLength(1);
    expect(r.html).toMatch(/^<p>x<\/p><img alt="a" src="cid:[0-9a-f]+@ncmail.local"><img src="https:\/\/x">$/);
  });

  it("gives up on a server that floods its greeting", async () => {
    const srv = net.createServer((sock) => { sock.on("error", () => {}); const flood = () => { if (sock.writable && sock.write("220-x\r\n".repeat(500))) setImmediate(flood); }; flood(); sock.on("drain", flood); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    try {
      const r = await probe("smtp", { host: "127.0.0.1", port: (srv.address() as any).port, security: "none" });
      expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/far more than/) });
    } finally { srv.close(); }
  });
});
