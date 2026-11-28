# Big mailboxes and many users

- The first sync of a folder brings in the last 24 months (Settings > account > Sync and search, or `NCMAIL_INITIAL_SYNC_MONTHS`; 0 = everything). Older mail stays on the server: **search still finds it** (it searches the server and adds the newest matches), the list ends with "Load 5,000 more", and "Load them all now" is in the settings.
- Big imports run `NCMAIL_MAX_HEAVY_SYNCS` at a time (default 2); the rest wait and the folder says so. Turns are fair between users: while someone else waits, one user holds at most one slot. Older-mail searches run `NCMAIL_MAX_OLDER_SEARCHES` at a time (default 4).
- One service instance per database is the supported setup: it serves many users, and two instances on one database can work against each other (see [deployment.md](deployment.md#run-the-service)). Give that one instance more CPU and memory, and keep PostgreSQL on fast storage, rather than adding instances.

## Measured

All on one laptop (Apple silicon), with the mail server and PostgreSQL in Docker on the same machine, so the mail server
competed with the service for the same CPU.

**A 110,000-message mailbox** (66,300 in the inbox): list pages take 2 to 3 ms, also 50,000 rows deep, and the first list
paints in 45 ms. More in [design.md](design.md#6-performance).

**A 500,000-message mailbox** (331,500 in the inbox), mirrored whole:

| | Direct | Through a 100 ms round trip |
| --- | --- | --- |
| First inbox page after adding the account | 1.1 s | 2.9 s |
| Whole inbox mirrored | about 3 minutes | about 5 minutes |
| List pages, also 200,000 rows deep | 4-8 ms | 4-22 ms |
| Searches (typical) | 10-260 ms | 15-300 ms |
| Opening a message that is not cached yet | 0.9 s | 1.3 s |
| Service memory / database | under 100 MB / about 600 MB | under 100 MB / about 550 MB |

**Fifty users connecting at the same moment**, each with a 5,444-message mailbox (272,200 messages in all, over six years),
then browsing, opening, searching and marking mail for 90 seconds:

- With the default 24-month window, every inbox was ready after 49 s (half of them within 21 s). Opening a message took
  26 ms (p50) and 232 ms (p95), listing the inbox 14 ms and 308 ms, searching 298 ms and 5.7 s (searches that also asked the
  mail server for older mail). No errors.
- At the peak the service used about 250 MB of memory and one CPU core at about 80%, with 12 database connections and 150
  IMAP connections open. The database was 282 MB.
- Mirroring everything instead (`NCMAIL_INITIAL_SYNC_MONTHS=0`) took 145 s until every inbox was ready, with a database of
  480 MB and slower worst cases while the imports ran. The 24-month default is why the first sync stays short.
