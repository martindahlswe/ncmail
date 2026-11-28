# Features in detail

## Right-click menus

Right-click (or press the menu key) on: a **message** (reply, reply to list, forward, forward as attachment, mark, star, snooze, label, move/copy with a type-to-filter, archive, spam, delete, source; it acts on the whole selection if you click inside one), the **list background** (refresh, select all, sort), a **folder** (open, refresh, mark all as read, empty Trash / delete all junk, new folder inside, rename, delete, sharing, expand or collapse subfolders), a **label** or **saved search** in the sidebar, the **sender** of a message (write to, copy address, find their mail, add to contacts), an **attachment** (preview, download, save to Nextcloud) and a **recipient** in the composer (copy, remove).

## Selecting messages

Click opens a message. **⌘/Ctrl-click** adds or removes a message from the selection (the message that is open counts as the first one), **Shift-click** selects the range from the last one clicked, and **Shift+↓/↑** extends the selection from the open message. ⌘/Ctrl+A selects everything loaded, and the checkbox on each row works the same way. Bulk actions (read, star, archive, move, copy, label, delete) apply to the whole selection, and dragging any selected message to a folder moves them all.

## Organising mail

- **Folders** are made on your mail server, so your other mail apps show them too. **+** next to the account name (or right-click it) creates a folder at the top; **New folder inside…** in a folder's right-click menu creates a subfolder. **Rename…** keeps the folder's mail and subfolders, and filters that file mail into it are changed to the new name. **Delete folder…** moves the folder, with its subfolders and mail, into Trash (Undo puts it back); in Trash, or on an account without Trash, it is **Delete permanently…** and asks first. Inbox, Sent, Drafts, Trash, Junk and Archive cannot be renamed or deleted. In someone else's shared folder these appear only where the server allows them (RFC 4314 rights `k` for subfolders, `x` for rename and delete). If a filter still files mail into a folder you deleted, Mail says so, because the filter would create the folder again.
- **Snooze** (clock button in the toolbar or on selected messages) moves mail to a Snoozed folder on your server and brings it back, unread, at the time you choose. Undo works.
- **Send later** (clock next to Send): pick a time up to a year ahead. Scheduled messages wait on the server (Scheduled in the sidebar lets you send or cancel them), so closing the app does not matter.
- **Labels** are IMAP keywords on the messages, so other clients keep them; click a label in the sidebar to see it across folders (`label:name` works in search). **Saved searches** appear in the sidebar.
- **Filters and out-of-office** are written as a Sieve script and uploaded to your mail server (ManageSieve, usually port 4190), so they keep working while the app is closed. A "send a copy to" rule forwards mail automatically, so the editor warns about it.
- **Forward as attachment** (in the message's ... menu and its right-click menu; for several selected messages, right-click the selection): opens a new message with the original attached whole as a `.eml` file named after its subject, instead of quoting it. The attachment is taken from your mail server when the message is sent (or the draft saved), counts towards the attachment size limit, and can be removed like any other.
- **Reply to list** (`l`, next to Reply all, and in the ... and right-click menus) appears on mail from a mailing list that names its posting address (List-Post). It writes to the list, with the usual subject and quote. In the right-click menu it shows once the message has been opened or hovered.
- **View source and headers**, **Print** and **Download .eml** are in the message's ... menu; images, PDFs, text, audio and video attachments open in a preview (scripts and HTML never run).
- **Unsubscribe** (next to Details in a message from a mailing list): when the list supports it (RFC 8058) and a DKIM signature that passed covers the List-Unsubscribe headers and belongs to the sender's domain or the unsubscribe address's, Mail tells the list in one click. Otherwise it mails the list's first unsubscribe address (only that one, with the subject and text "unsubscribe") from the address the list writes to, or opens the list's own page in a new tab. You confirm first. Mail in Junk gets no Unsubscribe: answering spam only confirms your address.
- **Templates** for messages you send often: **Templates** in the composer inserts one where the cursor is (and fills an empty subject), and saves the message you are writing as a new one (without your signature). Rename or remove them under Settings > General. They belong to you, not to one account.
- **All inboxes** (sidebar, when you have more than one account) lists every account's inbox in one stream, with the account on each row. Bulk actions work across accounts; Move, Copy and Labels are per account, so they are hidden there.

## Writing

- **Pictures in the text**: paste or drop a picture into the message, or use **Picture** in the formatting bar. Dropping it anywhere else in the composer (or dropping other files) attaches it instead. Pictures go out as inline parts of the message (`cid:`), which mail programs show reliably, and reopened drafts, undo send and replies or forwards of a message with inline pictures keep them. Pictures larger than 1600 pixels or 1.5 MB are scaled down first; together with the attachments they must fit the attachment limit. Pictures from the internet are never loaded into the composer, so quoting a message drops its remote images.
- **Pictures in signatures** work the same way (Settings > (account) > Sender addresses > Edit signature). They are stored with the sender address, so they are kept small: at most 400 pixels and 100 KB, scaled down if needed.
- **HTML signatures**: paste a signature's HTML source (from a signature generator, or saved from another mail program) into the signature box, or copy a formatted signature from a web page. It is kept exactly as it is, tables, colours and fonts included, with a preview. **Edit as HTML** opens the source of any signature. Scripts, forms, event handlers and styles that load things are removed when it is saved. In messages it shows as one block (change it in the settings, or delete it from the message), and it is sent unchanged. Its plain-text version is used for the plain-text part when you set one.
- **Which signature is used**: new messages, replies and forwards start with the sender address's rich signature (the HTML one when it was entered as HTML), or its plain-text one when there is no rich one. Switching the From address swaps it. Reopened drafts keep the one they have.
- **Forgotten attachments**: when the text you wrote (not the quoted message or your signature) mentions an attachment ("attached", "enclosed", "bifogad", "bilaga", "Anhang", "pièce jointe", "adjunto", "allegato" and similar words in a few languages) but nothing is attached, Send asks "Send without an attachment?" first.
- **Read receipts**: **Options** (the ... button next to Security) > **Ask for a read receipt** asks the recipients' mail programs to confirm when they open the message (a `Disposition-Notification-To` header with your sender address). It applies to Send, Send later and undo send, and a draft remembers it. Settings > General > Writing can turn it on for every new message. Many people and programs never send receipts, so no receipt does not mean it was not read.

## Sender addresses

One account (one login) can send as several addresses, for example `me@example.com` and `me@another.com` when your mail server allows it. Add them under Settings > (account) > **Sender addresses**. Each has its own name, signature and optional **Reply-To** address; one is the **default**, which new messages start from. The composer's From line lets you pick any address of any account.

Mail goes out with the chosen address in From and as the SMTP envelope sender, plus its Reply-To when one is set. Replies and forwards start from the address the message reached: the one in To or Cc, else the one the server delivered it to (Delivered-To, X-Original-To, so Bcc and forwarded mail work too), else the default. Replying to your own sent mail goes to its recipients, from the address you sent it from.

## Shared folders

On mail servers that support sharing (IMAP ACLs, RFC 4314; for example Dovecot with the `acl` plugin, or Cyrus), folders other people share with you appear in the sidebar under **Shared with you**, grouped by owner. Mail asks the server what you may do in each one and offers only that: in a read-only folder there is no Delete, Move, Archive, Star, Labels or Snooze, and you cannot drop messages into a folder you may not add to. Right-click a shared folder to see who shared it and your access. Someone else's folders never act as your Sent, Drafts or Trash. A shared folder that the server lists but refuses to open (it happens after a shared mailbox is renamed: the server keeps announcing the old name) is left out while it holds no mail, and comes back by itself once it opens.

**Public folders** (a shared namespace, for example Dovecot's `public` namespace or Cyrus's `shared.*`) appear under **Public folders**, with the same rule: Mail offers only what the server allows you there.

To share one of your own folders, right-click it and choose **Sharing…**: enter the other person's user name on the mail server and choose **Can read** or **Can read and change** (marking, adding, moving and deleting messages). Neither lets them share it further or create folders. **Sharing…** also appears on any folder where the server lets you manage access, such as a public folder you look after. Access set centrally by the mail server's administrator (for example Dovecot's global ACLs) is shown as it is and takes precedence; Mail never shares anything itself beyond what the server allows. Servers cache permissions, so a change can take a few minutes to show for the other person.

## Conversations

Messages are grouped by their reply headers (Message-ID, In-Reply-To, References), also across folders and when the message they answer never arrived. Mail that has no reply headers at all, as some mailing lists, older mail programs and ticket systems send it, is grouped by subject only when all of these hold: one of the two is a reply or forward ("Re:", "AW:", "SV:", "Fwd:" and the like), the subjects match without those prefixes and are not generic ("Hello", "Invoice", "Meeting"...), the messages are at most 60 days apart, and they share someone besides you. Two first messages with the same subject stay apart. This applies to mail synced from now on; mail already grouped keeps its conversations.

## Search

Type in the search box. Free words are matched against sender, recipients and subject; operators narrow it down:

| Operator | Example | Meaning |
| --- | --- | --- |
| `from:` `to:` `cc:` | `from:anna` | Address or name contains |
| `subject:` | `subject:"audit findings"` | Subject contains |
| `has:attachment` | | Has an attachment |
| `is:` | `is:unread`, `is:starred`, `is:read`, `is:answered` | State |
| `label:` | `label:work` | Has the label |
| `before:` `after:` | `after:2026-01-01` | Date (YYYY-MM-DD) |
| `in:` | `in:archive` | In a folder (Trash and Junk are skipped unless you name them) |

A leading `-` negates an operator. Search covers mail you have synced and, when the first sync was limited to a time window, **older mail still on the server**: it asks the server and adds the newest matches. Turn on **Search inside message text** in the account's *Sync and search* settings to search bodies too. A search may have up to 30 words and operators.

## Trust

**Phishing cues** appear above a message when something looks wrong: the receiving server's SPF / DKIM / DMARC verdict (from its Authentication-Results header), a sender domain that imitates one you correspond with or a well-known brand, a display name that contains someone else's address or belongs to a contact who uses another address, and links whose text names a different site than they go to (outlined in red, and they ask before opening). People you have written to are not second-guessed. The checks are hints, not proof.

**Images from senders you trust:** remote images are blocked until you choose **Load images** under the message. Next to it, **Always from (address)** or **Always from everyone at (domain)** loads them automatically from then on, also when printing. The list is kept per Nextcloud user (on every device) and can be seen and cleared under Settings > General > Speed and privacy. It never applies to mail in Junk, to a message that failed the sender checks (SPF / DKIM / DMARC above), or to encrypted mail that is not verified.

**Read receipts:** when a message asks to be told that you read it (Disposition-Notification-To), a note above it offers **Send a read receipt** or **Don't send**. Either answer is remembered on the message (the `$MDNSent` keyword, which other mail programs understand too), so you are not asked again. The receipt (RFC 8098) is sent from the address the message reached and says only that the message was displayed. Nothing is ever sent without asking. Settings > General > Reading can switch the question off (**Never send**). There is no note for mail in Junk, or when the receipt would go to a different domain than the one the message came from (Return-Path), a common trick to confirm addresses.

## Signing and encryption

Settings > (account) > Security takes PGP keys (`.asc .gpg .pgp .key .pub`) and S/MIME material (`.p12 .pfx`, `.pem .crt .cer .der` with an optional separate key file, `.p7b`). A key with a private part is only accepted, and only shown, for a sender address it was issued for. Other people's public keys and certificates are kept as contacts. Private keys are stored encrypted with `SECRET_KEY`. S/MIME signing, encryption and decryption need RSA certificates (ECDSA certificates can still verify signatures). Encrypted S/MIME mail is read in both forms, CBC (EnvelopedData) and AES-GCM (AuthEnvelopedData); content encrypted with single DES is not decrypted. A signer's certificate must be valid now (within five minutes), whatever signing time the message claims. Key files whose password protection asks for more than 1,000,000 iterations are refused.

"Trust this certificate" on a signed message keeps the signer's certificate for the sender's address only, and a certificate kept that way never replaces one you imported for that address. A kept certificate vouches only for itself, not for certificates issued with its key. S/MIME-encrypted mail that is not also signed by the sender is shown as "encrypted, but not verified" (S/MIME encryption alone does not detect changes), and its remote images are removed. When an encrypted message has Bcc recipients, each of them gets a copy encrypted only for them, sent separately, so the To and Cc recipients cannot see who else received it; Sent keeps the To/Cc copy. A draft of a message marked for encryption is saved encrypted to your own key, when you have one for the sending address that can decrypt (otherwise it is saved as before, without encryption, and the composer says so); its headers stay readable, as on a sent message.

## Contacts and Files

Opened inside Nextcloud, Mail is connected to your Nextcloud automatically (Nextcloud creates an app password for it; Mail never sees yours). Settings > Nextcloud shows the state and can disconnect it.

- **Contacts:** recipient suggestions include your Nextcloud contacts, and "Add to contacts" saves a sender.
- **Files:** "From Nextcloud" attaches a file when writing, and every attachment (or all of them) can be saved to a Nextcloud folder. Existing files are never overwritten.

## Calendar invitations

Settings > (account) > Calendar connects a Nextcloud calendar (address, user, app password). Invitations that arrive in the inbox are added to it as tentative entries with your answer left open; you accept or decline in the Calendar app, and Nextcloud sends the reply to the organizer (it needs working outgoing mail in Nextcloud). Updates and cancellations are applied automatically only when they are sent by the event's organizer (others can still be applied with the button), and entries you delete are not re-added. Alarms and attachments in an invitation are not copied to the calendar. The message shows the invitation with an "Add to calendar" button when needed.

Your answer in the calendar is carried back (checked every minute, when you open the message, and on Refresh): any answer marks the invitation as read, declining also moves it to Archive, and the message banner shows what you answered.

## From Nextcloud

- The **unread count** appears on Mail's menu entry (refreshed at most once a minute).
- **Nextcloud's search box** also finds mail you have synced.
- **Notifications**: new unread mail in your inboxes appears in Nextcloud's notifications (sender and subject), and opening one shows the message. A notification goes away once the message is read, moved out of the inbox or deleted; more than three at once become one "N new messages". Only mail that arrives after an account was added counts: adding an account or loading older mail never notifies. Nextcloud picks new mail up with its background jobs, so it shows within a minute when those run by cron (with AJAX background jobs, only while someone has Nextcloud open). Switch it off under Settings > General.
- **Send by mail** in Files (in a file's menu, and for several selected files): opens a new message with the files attached. Up to 20 files, each at most the attachment size limit.
- **Create a task, Create an event, Share to Talk** (in a message's More menu, each shown only when your Nextcloud has it): a task goes into one of your task lists (Tasks), an event into one of your calendars (Calendar), both with the sender, date, subject and a link back to the message; Share to Talk posts the sender, subject and, if you like, the opening lines to a conversation you can write to, with your own note (an "@" in the mail's text is posted as "＠", so it cannot mention anyone in the conversation). Everything is done as you, through the connection Nextcloud set up for Mail.
- **Write an email** in Nextcloud's contacts menu (the people icon in the header, and on avatars): opens a new message to that person.
- **Links**: `/apps/ncmail/?message=<id>` opens a message, `/apps/ncmail/?compose=name@example.com&subject=Hi&body=Hello` opens a new draft, and `/apps/ncmail/?attach=["/Documents/report.pdf"]` (a URL-encoded JSON list of paths in your files) opens one with those files attached.
- **Theme**: Mail follows the instance's theme (admin branding, colours, theme apps) and its light or dark setting.
