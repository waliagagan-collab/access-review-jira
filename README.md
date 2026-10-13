# Access Review for Jira

Quarterly user access reviews for Jira Cloud, with evidence. The app takes a snapshot of
every group on the site (empty ones included), who is in each, which product each group
grants, who holds an admin group, and whether each person did anything in Jira in a window
you choose. Reviewers mark each person Keep, Remove or Follow up, add notes, and sign the
review off with their name and the time. The evidence is an Excel workbook (Summary, Users,
Groups) or a CSV. The next review shows who was added, who left and who became an admin.

Read-only: there is no write scope, so the platform itself prevents the app from changing
anything. To act on the Remove list, use Atlassian Administration or Seat Reclaim for Jira.

## How the snapshot is built

`roles → groups → members → issues → verify → finalize`, in the background worker
(`src/worker.js`), each step bounded and resumable.

| Step | Source |
| --- | --- |
| Which groups grant which product, and Atlassian's seat counts | `GET /rest/api/3/applicationrole` |
| Every group, including empty ones | `GET /rest/api/3/group/bulk` |
| Members of each group (active Atlassian accounts; bots and customers left out) | `GET /rest/api/3/group/member` |
| Who did something recently, and when | the License Audit activity engine (`src/lib/jira.js`): a sweep of recently updated issues, then an exhaustive per-user JQL check for everyone the sweep could not vouch for |

Admin groups are recognised by name (`/admin/i`), the same rule Seat Reclaim uses, because
Jira Cloud exposes no API for global permissions.

## Storage

Per review: account IDs, group IDs, product names, activity bands, decisions and notes.
Names and emails are resolved from Jira at read time. The last 12 reviews are kept.

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
