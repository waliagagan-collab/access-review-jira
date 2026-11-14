# Access Review for Jira

Quarterly user access reviews for Jira Cloud, with evidence. The app takes a snapshot of
every group on the site (empty ones included), who is in each, which Jira product each group
grants, who sits in an admin group, and whether each person did anything in Jira in a window
you choose. Reviewers mark each person Keep, Remove or Follow up, add notes, and sign the
review off with their name and the time. The evidence is an Excel workbook (Summary, Users,
Groups, Changes) or a CSV. The next review counts who was added, who left, who joined an
admin group and who gained a Jira product; its Changes sheet names them.

"Products" are Jira products only: the grants come from Jira's application roles. A group
that only grants Confluence shows no product, and its members show "No Jira product access".

Read-only: there is no write scope, so the platform itself prevents the app from changing
anything. To act on the Remove list, use Atlassian Administration. Seat Reclaim for Jira can
free the seats of the people on it who are inactive and not admins; it does not read this
app's list. The one scope that is not a Jira read, `report:personal-data` (added 14 November
2026), only sends Atlassian the account IDs the app keeps (see "Personal data reporting"
below).

## Without a licence

The app is paid through Atlassian and free for up to 10 users. In production, when the
licence is missing or not active, `startReview`, `setDecision`, `setDecisionsBulk`,
`completeReview` and `reopenReview` are refused by the resolvers, and the page greys those
buttons out and says why. Listing and opening reviews, the evidence download and deleting a
review keep working, so a customer whose subscription has ended can still take or remove
what the app holds. Development and staging installs are never blocked.

## How the snapshot is built

`roles → groups → members → issues → verify → finalize`, in the background worker
(`src/worker.js`), each step bounded and resumable. Every slice commits a cursor and
re-queues itself with a sequence number, so a duplicate event (the queue delivers at least
once) is dropped; a copy that is already running when another commits writes nothing and
pushes nothing. A rate limit mid-slice saves what was collected and retries after the pause
Jira asks for. A storage call that fails is tried again a few times before the snapshot fails.

Forge allows at most 1,000 queue pushes in one chain, so slices are long: the consumer may
run 300 seconds and stops itself at 240. If a push fails anyway, nothing is lost: the run is
marked paused, and the page's status call queues the next slice as a new chain (the page
says the snapshot is paused and continues while the page is open). Finalize publishes the
review, marks the run complete and only then deletes the scratch data, so it is safe to run
twice. A running snapshot can be cancelled from the page.

| Step | Source |
| --- | --- |
| Which groups grant which Jira product, and Atlassian's seat counts | `GET /rest/api/3/applicationrole` |
| Every group, including empty ones | `GET /rest/api/3/group/bulk` |
| Members of each group (active Atlassian accounts; bots and customers left out) | `GET /rest/api/3/group/member` |
| Who did something recently, and when | the activity engine in `src/lib/jira.js`: a sweep of recently updated issues gives "last seen" dates, then a per-user JQL check for everyone the sweep did not see, across all issues the app can see. The per-user check includes `issue in updatedBy(user, "-Nd")`, which covers comments and edits to any field; the sweep alone cannot, because Jira returns only the most recent part of a busy issue's history and comments |
| That the person using the app is a Jira administrator | `GET /rest/api/3/mypermissions` as that user, before any request is served |

If application roles cannot be read, the review still lists every group and member; it only
cannot say which Jira product each group grants, and says so.

Being named reporter by someone else is not activity; the reporter counts only when it is
also the creator. Before anyone is checked, the per-user query is run once for the admin who
started the snapshot. If Jira rejects it (400), it is tried without the work-log clauses
(Jira rejects those when time tracking is off or hidden); the run then uses that form and
the review carries a warning. If Jira rejects that too, the snapshot fails with Jira's
message. A single person whose query Jira still rejects is marked "Not checked": not active,
not inactive, counted in the review and the Summary sheet, and left out of "Keep all active
non-admins".

Admin groups are recognised by name (`isAdminGroupName` in `src/lib/review.js`): the name
is split into words on anything that is not a letter and on a change from lower to upper
case, and a word that is or ends with "admin", "admins", "administrator(s)",
"administratoren" or "sysadmin(s)" counts. "site-admins", "JiraAdmins" and "itadmins" match;
"badminton-club" and "administrative-assistants" do not. Jira Cloud exposes no API for which
groups hold global permissions, so the page and the evidence file label it as a name rule.

## Storage

Per review: account IDs, group IDs and names, Jira product names and Atlassian's seat counts,
each person's activity band or last-activity time, each decision with its note, the deciding
admin's account ID and the time, the account IDs and times of who started the snapshot, who
signed off and who reopened, and the account IDs of who was added, who left, who joined an
admin group and who gained a Jira product since the review before (up to 500 of each). Names
and emails are never stored; they are resolved from Jira at read time. The account IDs are
reported to Atlassian once a week, and those of closed accounts are erased (see "Personal
data reporting" below).

12 reviews are kept. A new snapshot removes the oldest review that is not signed off. A
signed-off review is never removed automatically: when all 12 are signed off, starting a new
review is refused until an admin downloads and deletes one.

Reopening a signed-off review moves that sign-off (who, when, the totals) into the review's
`signoffs` history together with who reopened it and when. The page and the Summary sheet
list the history. A review reopened by an earlier version has the old sign-off in its live
fields; it is read as one history entry.

Everything that grows with the site is split to stay inside the storage value limit: users
and activity in 64 shards while a snapshot runs, groups in pages of 250, product-granting
groups in pages of 1,000, review rows in pages of 100, decisions in 64 shards per review.
Reviews saved by earlier versions (groups inline, 16 decision shards) still open.

A decision shard is read, changed and written under a lock (`withLock` in
`src/lib/store.js`): a key written with `FAIL_IF_EXISTS`, with the time in its value. A lock
older than 15 seconds is treated as left by an invocation that died and is taken over; a
key's TTL is not relied on. The page also sends decisions one at a time. Sign-off marks the
review signed off, then counts once every shard lock has been passed, so the stored totals
match the stored decisions; the page sends the undecided count the admin saw and the server
refuses to sign if its own count differs.

## Personal data reporting

Atlassian asks every app that keeps account IDs to report them, so it can say which
accounts were closed. This app does it with Forge's `privacy.reportPersonalData`, which
needs the scope `report:personal-data` (added 14 November 2026; it makes the next
production deploy a major version).

**When.** An hourly scheduled trigger (`personal-data-report`, function `personal-data`)
runs one slice of the report, at most 40 seconds, or nothing when this week's report is
done. A new report starts 7 days after the last report call of the one before, so no
account is reported more often than once in 7 days. It runs whatever the licence says. On
most sites a report is done in one run. The engine is `src/lib/privacy.js`, shared with the
other apps and copied unchanged; what this app keeps is in `src/lib/personal-data.js`.

**What is reported.** Every account ID the app keeps, 90 per call:

| Stored value | Account IDs in it |
| --- | --- |
| `review:{id}:rows:{i}`, a page of a review | each person in the review |
| `review:{id}:decisions:{s}`, the decisions | each person decided on, the admin who decided; any account ID typed into a note |
| `review:{id}:meta`, the review record | who started it, signed it off and reopened it, and the same for each earlier sign-off; who was added, gone, joined an admin group or gained a Jira product since the review before |
| `scan:state`, the snapshot in progress or the last one | the admin who started it; any account ID quoted in a Jira error text it kept |
| `scan:{run}:users:{s}` and `scan:{run}:active:{s}`, working data of a snapshot | every group member, and what each did |

The group and grant pages of a snapshot and of a review (group IDs, names, Jira products,
counts), `reviews:index` (review IDs), the locks (`scan:state:lock`,
`review:{id}:decisions:{s}:lock`: a token and a time), `action:started` (a time) and
`settings` (the day the review request was closed) hold no account ID. Names and emails are
never stored, so an account whose profile changed needs nothing.

**What is erased for a closed account.** A signed-off review is evidence an admin signed,
so nothing is taken out of it; only what names the person goes:

- The person's row stays, with its Jira products, groups, activity and change flags. The
  account ID is replaced by a marker that holds only the row's place in the review
  (`~closed:<page>.<row>`, `closedMarker` in `src/lib/review.js`). Each row keeps its own
  marker, so rows stay apart and each keeps its decision. The page and the Excel and CSV
  files show the row as "Closed account", with no email and an empty Account ID, and the
  Summary sheet counts the users whose account was closed since the snapshot.
- Their decision stays, with who decided and when, under the marker of their row. The note
  an admin wrote about them is erased.
- An admin whose account was closed is cleared to null where they started, decided, signed
  off or reopened, with a flag (`startedByClosed`, `byClosed`, `completedByClosed`,
  `reopenedByClosed`), so the page and the evidence file say "Closed account".
- They leave the record's lists of who was added, gone, joined an admin group or gained a
  Jira product. The counts stay. The Changes sheet names the others and says how many more
  are not listed.
- An account ID quoted in a note or in a stored Jira error text becomes "(closed account)".
- The review's totals (users, admin groups, inactive, decisions at each sign-off) stay as
  they were counted.

Open reviews are treated the same way, for two reasons: many are signed off later, and a
reopened review carries the totals of its earlier sign-offs. With every row kept, the rows,
the decisions and those totals always agree, and the evidence of a review signed off later
lists everyone the snapshot found. An open review's closed row can still be decided
(without a note), so it need not stay undecided; "Keep all active non-admins" leaves it
alone. Its seat is gone, and the next snapshot does not list the person.

A snapshot still running is working data, not evidence: the closed account is taken out of
it, and the review it makes does not list them. When the next snapshot compares itself with
the last signed-off review, a closed account's row there is not counted as someone who left,
and it never matches anyone, so nobody is counted as added because of it. **The next
snapshot counts again.**

A decision moves to its marker before the row that names the marker changes, and the record
keeps its lists of changes until the rows have taken their flags from them (reviews saved
before rows carried their own flags). A run cut short in between is ended by the next one,
which finds the same markers, because a row's place never changes.

**While the app is writing.** A snapshot writes its state, its working data and, at the end,
a review; a sign-off, a reopen, a bulk decision, a delete, and starting or cancelling a
snapshot write from what they read a moment before. So erasing waits while a snapshot is
running and has moved in the last 20 minutes, and for a minute after one of those changes
starts (each is one resolver call, which Forge stops after 25 seconds; each notes when it
started in `action:started`). The report asks before each value it changes (`busy` in
`src/lib/personal-data.js`) and again before it changes a review's rows or record; each
value is read again just before it is written. A single decision needs no note: it is
written under its shard's lock (`withLock`), and erasing takes the same lock, as it does
the scan state's. A snapshot that has not moved for 20 minutes does not hold erasing back;
if it goes on later it finds fewer people to list, and a snapshot whose starter was erased
skips the first activity check, which runs for the starter.

A page left open since before the report can still send a decision for a closed person's
old account ID. It is written, has no row, and the next weekly report deletes it.

The report's own working values (`pdr:state`, `pdr:lock`, and the gathered, closed and
changed IDs under `pdr:ids:`, `pdr:closed:` and `pdr:updated:`) are deleted when a report
ends, except the state with the totals of the last report. The log line of each run names
the step and, at the end, the totals; never an account ID.

`test/privacy.test.js` is the shared report engine's own test, copied with it.
`test/personal-data.test.js` lists every key the app writes and fails if one holds an
account ID no source reads; on the fake site it runs snapshots, decisions with notes, bulk
decisions, sign-offs, reopens, a paused snapshot and a failed one, then weekly reports:
every account ID written is found, closed accounts are erased and nobody else is touched,
signed-off and open reviews keep every row and total, a run cut short is ended with the same
markers, erasing waits for a snapshot and for a change in flight, and the page, the evidence
file, Past reviews and the next snapshot read the markers sensibly.

## Large sites

Run on demo sites of up to 17 users only. Past roughly 20,000 users a user shard can
approach the storage limit, and the review table sends every row to the page, which has not
been tried on a large review.

## Commands

```bash
npm test                 # unit tests
npm run deploy           # build the export frame and deploy to development
forge install --site one-atlas-afgn.atlassian.net --product jira --environment development
```

App id `37b81c92-ff57-40a7-8706-f459ac83d2d1` (Developer Space TELCOMA Global). Development page on
the demo site: `/jira/settings/apps/37b81c92-ff57-40a7-8706-f459ac83d2d1/6f88fbf6-322e-499b-8168-f46ddf9d12bb`.

## Next

- Rovo agent (read-only: "who has access to X", "what changed since the last review").
- Confluence edition: same review over Confluence groups (`/wiki/rest/api/group?accessType=…`).
