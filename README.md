# Access Review for Jira

Quarterly user access reviews for Jira Cloud, with evidence. The app takes a snapshot of
every group on the site (empty ones included), who is in each, which product each group
grants, who sits in an admin group, and whether each person did anything in Jira in a window
you choose. Reviewers mark each person Keep, Remove or Follow up, add notes, and sign the
review off with their name and the time. The evidence is an Excel workbook (Summary, Users,
Groups) or a CSV. The next review shows who was added, who left and who joined an admin group.

Read-only: there is no write scope, so the platform itself prevents the app from changing
anything. To act on the Remove list, use Atlassian Administration or Seat Reclaim for Jira.

## How the snapshot is built

`roles → groups → members → issues → verify → finalize`, in the background worker
(`src/worker.js`), each step bounded and resumable. Every slice commits a cursor and
re-queues itself with a sequence number, so a duplicate event (the queue delivers at least
once) is dropped rather than run twice. A rate limit mid-slice saves what was collected and
retries after the pause Jira asks for.

| Step | Source |
| --- | --- |
| Which groups grant which product, and Atlassian's seat counts | `GET /rest/api/3/applicationrole` |
| Every group, including empty ones | `GET /rest/api/3/group/bulk` |
| Members of each group (active Atlassian accounts; bots and customers left out) | `GET /rest/api/3/group/member` |
| Who did something recently, and when | the activity engine in `src/lib/jira.js`, shared with License Audit for Jira: a sweep of recently updated issues, then an exhaustive per-user JQL check for everyone the sweep could not vouch for, across all issues the app can see |
| That the person using the app is a Jira administrator | `GET /rest/api/3/mypermissions` as that user, before any request is served |

If application roles cannot be read, the review still lists every group and member; it only
cannot say which product each group grants, and says so.

Admin groups are recognised by name: "admin", "admins", "administrator(s)" or "sysadmin" as
a whole word (`isAdminGroupName` in `src/lib/review.js`), the same rule Seat Reclaim uses,
because Jira Cloud exposes no API for global permissions. The page and the evidence file
label it as a name rule.

## Storage

Per review: account IDs, group IDs and names, product names, activity bands, and each
decision with its note, the deciding admin's account ID and the time. Names and emails are
never stored; they are resolved from Jira at read time. The last 12 reviews are kept.

Everything that grows with the site is split to stay inside the storage value limit: users
and activity in 64 shards while a snapshot runs, groups in pages of 250, review rows in pages
of 100, decisions in 64 shards per review. Reviews saved by earlier versions (groups inline,
16 decision shards) still open. Two admins deciding on the same review at the same moment can
collide inside one shard; the later write wins and the page shows it. Exercised to a few
thousand users; past roughly 20,000 users a user shard can approach the limit.

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
