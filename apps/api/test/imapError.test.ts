import { describe, expect, it } from "vitest";
import { describeImapError, serverText } from "../src/imapError.ts";

/** imapflow reports every refusal as "Command failed"; people see the reason instead. */
const refusal = (responseText: string, serverResponseCode?: string) =>
  Object.assign(new Error("Command failed"), { responseStatus: "NO", responseText, serverResponseCode });

describe("mail server errors in plain words", () => {
  it("drops the protocol noise from the server's text", () => {
    expect(serverText(refusal("[SERVERBUG] Internal error occurred. Refer to server log for more information. [2026-11-27 21:45:47] (0.011 + 0.000 + 0.010 secs)."))).toBe("Internal error occurred. Refer to server log for more information.");
    expect(serverText(refusal("A7 NO [OVERQUOTA] Quota exceeded (mailbox for user is full) (0.002 + 0.000 secs)."))).toBe("Quota exceeded (mailbox for user is full)");
  });

  it("explains the known reasons, adding the server's words when they say more", () => {
    expect(describeImapError(refusal("[SERVERBUG] Internal error occurred. Refer to server log for more information. (0.011 secs).", "SERVERBUG")))
      .toBe("The mail server had an internal error with this folder. Its administrator can find the details in the mail server's log.");
    expect(describeImapError(refusal("Quota exceeded (mailbox for user is full)", "OVERQUOTA")))
      .toBe("The mailbox is full: it is over its storage quota on the mail server. (The mail server said: Quota exceeded (mailbox for user is full))");
    expect(describeImapError(refusal("Permission denied", "NOPERM"))).toMatch(/^You do not have permission/);
    expect(describeImapError(Object.assign(new Error("Command failed"), { authenticationFailed: true, responseText: "[AUTHENTICATIONFAILED] Authentication failed." })))
      .toMatch(/did not accept the sign-in/);
  });

  it("quotes the server for other refusals, and never says only \"Command failed\"", () => {
    expect(describeImapError(refusal("Mailbox is locked by another process"), "open this folder")).toBe("The mail server refused to open this folder: Mailbox is locked by another process");
    expect(describeImapError(refusal(""), "open this folder")).toBe("The mail server refused to open this folder.");
    expect(describeImapError(Object.assign(new Error("Connection closed"), { code: "EConnectionClosed" }))).toMatch(/connection to the mail server was lost/);
  });
});
