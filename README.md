# Seat Reclaim for Jira

Finds licensed Jira users who have done nothing in a chosen period, then frees their
seats safely: the admin reviews the list, confirms, and the app takes each person out of
the groups that give them a product. Every change is logged and can be undone.

It reuses the activity engine from License Audit for Jira (same rules for what counts as
activity, same exhaustive per-user check). See `src/lib/jira.js`.

## How a seat is reclaimed

A Jira Cloud seat comes from membership of a product's access group. Removing a user from
every group that grants a product frees that seat at once (proved on the demo site on
10 October 2026: Product Discovery 34,999 → 34,998 → 34,999 seats left).

| Rule | Where |
| --- | --- |
| Never remove anyone from an admin group (`/admin/i`); those products stay | `planReclaim` |
| Never act on the person running the app, or on the protected list | `protectedReasonFor` |
| Re-read the user's groups live before acting; the scan is a snapshot | `reclaim` resolver |
| Only leave groups that actually free a product | `planReclaim` |
| Log exactly which groups were left; undo rejoins exactly those | `saveEntry`, `undo` |
| Group changes run as the signed-in admin (`asUser`), never as the app | `src/lib/reclaim.js` |

Jira requires a **site admin** for group membership changes. A Jira admin who is not a
site admin can scan and review, and gets a clear message if they try to reclaim.

## Permissions

Read scopes as License Audit, plus one write scope, `manage:jira-configuration`, used only
for `DELETE` and `POST /rest/api/3/group/user`. A test enforces that this is the only write
scope and that no other module makes write calls.

## Storage

Account IDs, group IDs, products and inactivity bands. Names and emails are looked up at
read time. The action log and protected list hold IDs only.

## Commands

```bash
npm test                 # unit tests
npm run deploy           # build the CSV frame and deploy to development
forge install --site one-atlas-afgn.atlassian.net --product jira --environment development
```
