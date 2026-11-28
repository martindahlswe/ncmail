# Accessibility

NCMail aims at [WCAG 2.2](https://www.w3.org/TR/WCAG22/) level AA. This page says what is checked, how, and what is
still open.

## What the tests check

Every pull request runs these in Chromium, Firefox and WebKit (`pnpm test:e2e`):

- **Automated checks** with [axe-core](https://github.com/dequelabs/axe-core) (WCAG 2.0, 2.1 and 2.2, A and AA) of the inbox,
  an open message, the composer and the settings, in the light and the dark theme, and of the Nextcloud admin **Mail** page
  with its add-server dialog (`e2e/tests/a11y.spec.ts`, `e2e/tests/admin.spec.ts`). The text of a message is the sender's own
  HTML, shown in a sandboxed frame, so it is left out.
- **Keyboard-only use** (`e2e/tests/keyboard.spec.ts`):
  - every stop in the tab order shows a focus ring;
  - **Skip to messages** is the first stop and leads past the search tips and the folders;
  - `j` and `k` open the next and previous message and move the focus with them;
  - dialogs take the focus, keep it while open, close with Escape and give it back to the button that opened them;
  - a message can be written and sent without the mouse.

## Using NCMail with the keyboard

Press `?` for every shortcut. The main ones:

| Keys | What they do |
| --- | --- |
| `j` / `k` (or the arrow keys) | Next / previous message |
| `Enter` | Open the first message |
| `Shift` + arrows, `x` | Select several messages / select this one |
| `r`, `a`, `f` | Reply, reply to all, forward |
| `e`, `#`, `s`, `u`, `!` | Archive, delete, star, mark unread, junk |
| `c` | New message; `Ctrl+Enter` (`⌘+Enter` on a Mac) sends it |
| `g` then `i`, `s`, `d`, `a`, `t`, `j` | Go to the inbox, Sent, Drafts, Archive, Trash, Junk |
| `Escape` | Close a dialog, clear the selection or the search |

Everything that can be dragged can also be done without dragging:
- messages onto a folder: **Move to** in the toolbar and the right-click menu (or `e` to archive);
- files: the attach button, or paste;
- column widths: focus the divider and use the arrow keys.

In Safari, Tab only reaches text fields until you turn on **Settings > Advanced > Press Tab to highlight each item**
(or use Option+Tab).

## Found and fixed in the audit before the first release

- **Column dividers** now tell screen readers their width (they were movable separators without a value).
- **Avatar initials** have 4.5:1 contrast on every colour (some were 3.6:1).
- The **numbered list button**'s name matches what it shows.
- **Dialogs** now take the focus and hold it, and give it back when they close. Before, the shortcuts and settings dialogs
  left it on the page behind them.
- **Skip to messages** link.
- The **search tips** stay open while you Tab through them. Before, they closed under the focus.
- The **composer's formatting buttons** keep the focus while the editor updates. Before, they were rebuilt on each update, and Tab could drop the focus to the page.
- **`j` / `k`** move the focus to the opened row, so Tab goes on into the message.
- The admin page's colours fall back to readable ones where Nextcloud's theme variables are missing.

## Still to do

- A pass with screen readers (VoiceOver and NVDA), listening to announcements such as new mail, sending, and the results of
  bulk actions. Automated checks cannot judge these.
- The message list has two tab stops per message (its checkbox and the message itself). With the arrow keys and `j`/`k` that
  is rarely in the way, but one stop per row would be better.

Report accessibility problems as [issues](https://github.com/martindahlswe/ncmail/issues).
