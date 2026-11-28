/** What setup.ts seeds, shared with the tests. */
export const E2E_PORT = 4200;
export const E2E_USER = "u05@example.test"; // a test-stack user no API test uses
export const MAILPIT = "http://127.0.0.1:18025";

/** A long message laid out like a team notification: a table with two narrow columns and one wide one that wraps, and a
 *  last block whose text sticks out of its fixed height (the case that made the reader's frame scroll and jump). */
export function tableMessage() {
  const words = "Status of the work this week, with the details that matter and a few that do not, written out at length ";
  const items = Array.from({ length: 16 }, (_, i) => `<li>Point ${i + 1}: ${words.repeat(1 + (i % 3))}</li>`).join("");
  return `<table border="1" cellpadding="6" style="border-collapse:collapse;width:100%"><tr>` +
    `<td valign="top" width="110">26 Nov 2026</td><td valign="top" width="110">Moderator</td><td><ul>${items}</ul></td>` +
    `</tr></table><div style="height:18px">${words.repeat(4)}</div>`;
}

export const SEED = [
  { subject: "Weekly status: a long table", from: "Team Bot <bot@example.org>", html: tableMessage() },
  { subject: "Lunch on Friday?", from: "Alex Example <alex@example.org>", text: "Shall we try the new place on Friday at noon?" },
  { subject: "Invoice 1042", from: "Billing <billing@example.org>", text: "Please find the details of invoice 1042 below." },
  { subject: "Holiday plans", from: "Sam Example <sam@example.org>", text: "Are you around in the last week of December?" },
];
