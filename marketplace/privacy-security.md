# Privacy & Security tab: Access Review for Jira (draft answers)

Draft answers for the personal data parts of the Marketplace Privacy & Security tab, checked against manifest.yml and src/ on 14 November 2026, when the weekly personal data report was added. Nothing here has been entered on the Marketplace. The tab is private, so the answers already there could not be read; answers this file does not mention stay as they are (see `listing.md`, "Privacy & Security tab" under the 14 Nov audit's proposed changes). A line starting with CHECK: needs a fact or a decision the code cannot settle.

## Data the app stores

Where: Forge hosted storage (Forge key-value storage, `@forge/kvs`) on the customer's site. Nothing is stored anywhere else.

| What | Personal data | Kept until |
| --- | --- | --- |
| A review's rows: for each person in a group at snapshot time, the account ID, the Jira products their groups grant, the IDs of their groups, whether they are in an admin group, and their activity (a last-seen time, or a band such as "180–365 days"), with flags for what changed since the review before (`review:{id}:rows:{i}`) | Yes: account IDs of everyone in the review | The review is deleted by an admin, or a new snapshot removes the oldest review that is not signed off (12 are kept; a signed-off one is never removed automatically), or uninstall. For an account Atlassian reports closed, the weekly personal data report replaces the account ID with a marker that holds only the row's place; the row and its decision stay |
| The decisions: for each person decided on, Keep, Remove or Follow up, the note an admin typed (up to 500 characters), the account ID of the admin who decided, and the time (`review:{id}:decisions:{s}`) | Yes: account IDs of the person and of the admin; the note is free text about the person | As the review. For a closed account the note is erased and the decision moves to the row's marker; a closed admin's account ID is cleared |
| The review record: when it was taken and its window, the account IDs of the admins who started it, signed it off and reopened it (and of each earlier sign-off), the totals, Atlassian's seat counts, fixed warning sentences, and the account IDs of who was added, who left, who joined an admin group and who gained a Jira product since the review before, up to 500 of each, with their counts (`review:{id}:meta`) | Yes: account IDs of admins and of the people in the lists of changes | As the review. A closed admin's account ID is cleared; a closed account leaves the lists; the counts and totals stay |
| A review's groups: group ID, name, the Jira products it grants, member counts (`review:{id}:groups:{i}`); the list of reviews, review IDs only (`reviews:index`) | No | As the review |
| The snapshot in progress or the last one: phase, cursors (group IDs, positions, a Jira page token), counters, times, fixed warning sentences, an error text if it failed, and the account ID of the admin who started it (`scan:state`) | Yes: the account ID of the admin who started it. An error text from Jira can quote an account ID | Overwritten by the next snapshot, or uninstall |
| Working data while a snapshot runs: each group member's account ID with their products and groups, and what each did (`scan:{run}:users:`, `scan:{run}:active:`); the groups and which group grants which product (`scan:{run}:groups:`, `scan:{run}:grants:`) | Yes: account IDs of every group member | Deleted when the snapshot ends, fails or is cancelled, or when the next one starts |
| Locks that keep two saves of the same value apart: a token and a time (`scan:state:lock`, `review:{id}:decisions:{s}:lock`) | No | Deleted when the save ends; free after 15 seconds |
| When a snapshot, a bulk decision, a sign-off, a reopen or a delete last started, a time only (`action:started`) | No | Overwritten by the next one, or uninstall |
| Settings: the date an admin closed the one-time review request (`settings`) | No | Uninstall |
| Personal data report: where this week's report is, and the totals of the last one (`pdr:state`, positions and counts only); the account IDs gathered for it (`pdr:ids:<n>`), the closed ones among them (`pdr:closed:<n>`) and those Atlassian says changed their profile (`pdr:updated:<n>`); a lock so two runs never overlap (`pdr:lock`) | Yes, while a report runs: the gathered, closed and changed account IDs | `pdr:ids:`, `pdr:closed:` and `pdr:updated:` are deleted when the report ends, normally within the hour it started. The lock is deleted when a run ends, and is free after 2 minutes if a run was stopped. The totals stay until the next report |

Read but never stored: display names and email addresses (where a user's profile lets apps see them), read from Jira when a review is shown or the evidence file is built; the issue data Jira returns to the activity search (comment text, changed field values), of which only who acted and when is used.
Changes the app makes on the site: none. Every Jira scope is read-only.
Queue events and scheduled triggers: each queue event of a snapshot carries only the run ID and a sequence number. An hourly scheduled trigger runs the weekly personal data report (below), whatever the licence says.

**Data stored** (the paragraph on the tab, to replace the one there): Account IDs of the people in each access review, with the Jira products and groups they had, whether they were in an admin group and their activity in the window; each decision (Keep, Remove or Follow up), the note an admin typed about the person, the account ID of the admin who decided, and the time; the account IDs of the admins who started, signed off and reopened each review; the account IDs of who was added, who left, who joined an admin group and who gained a Jira product since the review before; group IDs and names, Atlassian's seat counts and the progress of a snapshot. While a snapshot runs, the account ID of each group member (deleted when it ends). Display names and email addresses are never stored; they are read from Jira when a review is viewed or downloaded. No issue content is stored. The account IDs are reported to Atlassian once a week; for a closed account the ID and any note about the person are erased, and signed-off reviews keep the row and decision without them. Uninstalling the app deletes all of it.

## Personal data

- App stores personal data: **Yes**. Atlassian account IDs of: everyone in each kept review; the admins who decided, started, signed off and reopened a review; while a snapshot runs, every group member. Notes admins type about people are free text and may hold personal data.
- Processes personal data without storing it: display names and email addresses, read from Jira when a review is shown or the evidence file is built. They stay in Atlassian's cloud and the admin's browser.
- Developer console, Distribution, "Does your app store personal data?": Yes (account IDs are kept longer than 24 hours). On the Marketplace form the same Yes ticks the Personal Data Reporting API acknowledgment, which is true: the app calls it.
- Closed Atlassian accounts: the app uses Forge's personal data reporting API (`privacy.reportPersonalData`, scope `report:personal-data`). Once a week it reports every account ID it keeps, 90 per call; a new report starts 7 days after the last call of the one before, so no account is reported more often than once in 7 days. For each account Atlassian reports closed it erases the account ID everywhere it keeps it. A review is evidence an admin signed, so the person's row and decision stay, with the account ID replaced by a marker that holds no personal data and shows as "Closed account"; the note an admin wrote about the person is erased. Where the closed account is an admin who started, decided, signed off or reopened a review, the account ID is cleared and the page and the evidence file show "Closed account". The account leaves the lists of changes since the review before (the counts stay), an account ID quoted in a note or a stored error text becomes "(closed account)", and it is taken out of the working data of a running snapshot. The totals already shown stay; the next snapshot counts again. Erasing waits while a snapshot is running, and for a minute after a sign-off, a reopen, a bulk decision, a delete, or a snapshot being started or cancelled. The app keeps no names or emails, so an "updated" answer needs nothing.
- CHECK: the GDPR and CCPA answers already on the tab. This change does not alter whether TELCOMA Global is a processor.

## Retention and deletion

- Everything in the table is kept while the app is installed, unless the table says otherwise.
- On uninstall: Atlassian deletes the app's Forge storage for that site under Forge's data deletion rules. We keep no copy and have no access to it from outside the app.
- Closed accounts: erased by the weekly personal data report that names them, normally within the hour of that report's call to Atlassian; if a snapshot or one of the changes above is running, once it ends.
- On request: an admin can delete any review under Past reviews, signed off or not, which deletes its rows, decisions and notes; uninstalling deletes everything.

## Outside Atlassian

Unchanged by this change. The app makes no requests outside Atlassian (manifest.yml declares no `permissions.external` and no `remotes`). The weekly report goes to Atlassian's own personal data reporting service.

## Logging

- Logs End-User Data: No. The code logs only this line, from the hourly trigger: "Personal data report:" with whether it ran, the step it reached, the error message if a call failed (an HTTP status or a fixed sentence), and at the end of a report its totals (how many accounts, closed, values changed, skipped). No account ID, name, email or note is logged.
- Shares logs with third parties: No.

## Scope justifications

One line per scope, in manifest.yml order, ready to paste. The first seven are those of the scope table in `listing.md`; the last is new.

- `read:jira-user`: Confirms that the person using the app is a Jira administrator (`/mypermissions`, as that user) before any request is served.
- `read:jira-work`: Search recently updated issues and read changelog, comment and worklog authors to decide who was active, and ask Jira per user whether they did anything in the window. Issue content is never stored.
- `read:application-role:jira`: Which groups grant which Jira product, and Atlassian's own seat counts.
- `read:group:jira`: Every group on the site and its members.
- `read:user:jira`: Active flag and account type, to leave out bots and customers; display name and email at display time.
- `read:avatar:jira`: Required alongside `read:user:jira` by the group-member endpoint; avatars are not shown.
- `storage:app`: Snapshots, decisions and notes in Forge hosted storage.
- `report:personal-data`: Report the account IDs the app keeps to Atlassian once a week (privacy.reportPersonalData), so the data of accounts Atlassian reports closed is erased.
