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
app's list.

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
admin's account ID and the time, and the account IDs and times of who started the snapshot,
who signed off and who reopened. Names and emails are never stored; they are resolved from
Jira at read time.

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
