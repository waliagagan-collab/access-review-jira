# Marketplace listing — Access Review for Jira (draft)

## Name (≤ 60)

Access Review: User Access Audits & SOC 2 Evidence for Jira

## Tagline (≤ 130, no trailing punctuation)

Review who has access to Jira every quarter, with activity evidence, sign-off and an audit-ready export

## Summary (≤ 250)

A snapshot of every user, group and Jira product on your site, with who did anything in Jira recently. Mark each person Keep, Remove or Follow up, sign the review off, and download the evidence for SOC 2 or ISO 27001. Read-only.

## Categories and keywords

- Categories: Security; Administrative tools
- Keywords: Audit, Compliance, User permissions, Reporting

## More details

**Auditors ask the same question every quarter: who has access, and did someone check?**

Access Review answers it in one place.

- **Snapshot.** Every group on the site, including empty ones; who is in each; which Jira product each group grants; who holds an admin group; and whether each person created, changed, commented on or logged work on anything in Jira in the window you choose. Every candidate is checked against all issues the app can see, not a sample.
- **Review.** Mark each person Keep, Remove or Follow up, with notes. Filter by product, group, admins, activity, decision, or "new since the previous review".
- **Sign-off.** Complete the review with your name and the time. Reopen it if needed; the earlier sign-off and who reopened it stay on record.
- **Evidence.** Excel (Summary, Users, Groups, Changes) or CSV, with every decision, reviewer and timestamp.
- **Change tracking.** The next review counts who was added, who left, who joined an admin group and who gained a Jira product, and the evidence file names them.

**Read-only.** No write permission exists, so the app cannot change anything. To act on the Remove list, use Atlassian Administration, or Seat Reclaim for Jira, which removes access with an undo. **Runs on Atlassian;** no servers of ours.

## Highlights (title ≤ 50, description ≤ 220)

Images in `assets/2026-10-13/` (1840x900): highlight-1-review, highlight-2-groups, highlight-3-signed-off. Logo and banner in `assets/`.

1. **Every user, every group, one review** — The snapshot lists everyone in every group with the Jira products their groups grant, who holds an admin group, and their last activity. Mark each person Keep, Remove or Follow up, with a note.
2. **Groups, with what they grant** — Every group on the site at snapshot time, the Jira products it grants, how many members it has, and which groups are empty. Admin groups are marked.
3. **Sign off, then hand over the evidence** — Signing off records who approved the review and when, and locks it. Download an Excel workbook (Summary, Users, Groups, Changes) for your auditor. 12 reviews are kept; a signed-off one goes only when you delete it.

## Pricing (per user per month, graduated)

Free ≤10; 1–100 $1.00; 101–250 $0.60; 251–1000 $0.35; 1001–2500 $0.25; 2501–5000 $0.20; 5001–7500 $0.17; 7501–10000 $0.15; 10001+ $0.12. Multi-instance the same.

## Scope justification

| Scope | Why |
| --- | --- |
| `read:application-role:jira` | Which groups grant which Jira product, and Atlassian's own seat counts. |
| `read:group:jira` | Every group on the site and its members. |
| `read:user:jira` | Active flag and account type, to leave out bots and customers; display name and email at display time. |
| `read:avatar:jira` | Required alongside `read:user:jira` by the group-member endpoint; avatars are not shown. |
| `read:jira-user` | Confirms that the person using the app is a Jira administrator (`/mypermissions`, as that user) before any request is served. |
| `read:jira-work` | Search recently updated issues and read changelog, comment and worklog authors to decide who was active. Issue content is never stored. |
| `storage:app` | Snapshots, decisions and notes in Forge hosted storage. |

No write scopes. Egress: none.

---

## Proposed changes (audit 14 Nov 2026)

Nothing above this line was changed by the audit. Counts are characters. The More details count is
taken the way the listing editor counts it (text without bold or list marks, line breaks included);
this was checked against License Audit for Jira, where the editor showed 984 for the text now live.

### What is live today (public API, 14 Nov 2026)

The text above is not what the Marketplace shows. The edits written into this file on 10 Nov were
never entered, and the More details text above is 1,237 characters, over the limit of 1,000, so it
could not have been. Live now, version 2.6.0 (released 12 Nov):

- Name (59): `Access Review: User Access Audits & SOC 2 Evidence for Jira`
- Tagline (103): `Review who has access to Jira every quarter, with activity evidence, sign-off and an audit-ready export`
- Summary (225): `A snapshot of every user, group and product on your site, with each person's last activity in Jira. Mark each person Keep, Remove or Follow up, sign the review off, and download the evidence for SOC 2 or ISO 27001. Read-only.`
- More details (973 without line breaks): the older text: "which product each group grants", "Reopen it if needed.", "Excel (Summary, Users, Groups) or CSV", "who became an admin and who gained a product", "use Atlassian Administration or Seat Reclaim for Jira".
- Highlight 1 (35 / 188): `Every user, every group, one review`: `The snapshot lists everyone in every group with the products their groups grant, who holds an admin group, and their last activity. Mark each person Keep, Remove or Follow up, with a note.`
- Highlight 2 (28 / 143): `Groups, with what they grant`: `Every group on the site at snapshot time, the products it grants, how many members it has, and which groups are empty. Admin groups are marked.`
- Highlight 3 (37 / 173): `Sign off, then hand over the evidence`: `Signing off records who approved the review and when, and locks it. Download an Excel workbook (Summary, Users, Groups) for your auditor. The last 12 reviews stay available.`
- Gallery: no screenshots. Video: YouTube `vaoHtgPWyWc`. Release summary: `Minor version update`.
- Categories: Security and compliance; Administrative tools. Keywords: Audit, Compliance, User permissions, Reporting.
- "Stores personal data": No.

### Name: no change

`Access Review: User Access Audits & SOC 2 Evidence for Jira` (59/60). Inside the rules.

### Tagline (119/130)

`Quarterly user access review for Jira: users, groups, admin groups and inactive users, with sign-off and SOC 2 evidence`

Why: "audit-ready" goes; "user access review", "groups", "admin groups" and "inactive users" are
words admins search for.

### Summary (248/250)

`User access review for Jira: a snapshot of every group, who is in it, the Jira products it grants, admin groups and inactive users. Mark each person Keep, Remove or Follow up, sign off, and download Excel evidence for SOC 2 or ISO 27001. Read-only.`

Why: the app lists everyone who is in a group, not "every user"; it reads Jira products only; it
gives a last-seen date for some people and a band ("180–365 days") for the rest, not "each
person's last activity".

### More details (966/1000)

**Auditors ask every quarter: who has access, and did someone check?**

- **Snapshot.** Every group, empty ones too; who is in each; which Jira product it grants; who is in an admin group (recognised by name); and whether each person created, changed, commented on or logged work on an issue in the last 30 to 365 days. Inactive means a search of all issues the app can see found nothing.
- **Review.** Mark each person Keep, Remove or Follow up, with a note.
- **Sign-off.** Sign with your name and the time. A reopened review keeps its earlier sign-off on record.
- **Evidence.** Excel (Summary, Users, Groups, Changes) or CSV. The next review's file names who was added, who left, who joined an admin group or gained a Jira product.

**Read-only.** No write permission. Stored with Atlassian: account IDs, groups, activity, decisions and notes; no names or emails. **Runs on Atlassian.** Free for up to 10 users.

Seat Reclaim for Jira frees the seats of inactive users after you confirm, with undo.

Link "Seat Reclaim for Jira" to
`https://marketplace.atlassian.com/apps/1825851557/seat-reclaim-remove-inactive-users-free-licenses-for-jira`.

Why: fits the limit; says admin groups are a name rule; says what is stored; no longer says Seat
Reclaim acts on the Remove list (it frees seats of inactive users who are not admins, from its own
scan).

### Highlights (title ≤ 50, description ≤ 220)

1. Title (41): `Keep, Remove or Follow up for each person`
   Description (197): `Everyone in every group, with the Jira products their groups grant, whether they are in an admin group, and their activity in the window. Mark each person Keep, Remove or Follow up, and add a note.`
   Image: the Review tab, open review, shot again (screen 1 in `audit-2026-11-14.md`).
2. Title (30): `Every group and what it grants`
   Description (171): `Every group on the site at snapshot time, the Jira products it grants, how many members it has, and which groups are empty. Admin groups are recognised by name and marked.`
   Image: the Groups tab with product-granting groups in view, shot again (screen 2).
3. Title (37): `Sign off, then hand over the evidence` (no change)
   Description (214): `Signing off records who approved the review and when, and locks it. Download an Excel workbook (Summary, Users, Groups, Changes) for your auditor. 12 reviews are kept; a signed-off one goes only when you delete it.`
   Image: a signed-off review with the "Evidence file for … Download Excel" row in view, shot again (screen 3).

### Gallery (caption ≤ 220): five images, none live today

| Order | Screen | Caption |
| --- | --- | --- |
| 1 | Open review with the "Since the review signed off on …" box (screen 4) | (157) `Each review is a dated snapshot. It counts who was added, who left, who joined an admin group and who gained a Jira product since the last signed-off review.` |
| 2 | How it works, opened (screen 5) | (102) `How the snapshot and the sign-off work, as shown on the page. Read-only: nothing on your site changes.` |
| 3 | The evidence workbook open in Excel (screen 6) | (116) `The evidence file in Excel: Summary, Users, Groups and Changes sheets, with every decision, note, reviewer and time.` |
| 4 | Past reviews tab (screen 7, or `ar-5-past.png` as it is) | (101) `Past reviews with status, sign-off date and decisions. Open one and the evidence download follows it.` |
| 5 | Review tab filtered to "No activity in the window" (screen 8) | (135) `Mark each person Keep, Remove or Follow up, with a note. People in admin groups and people with no activity in the window are labelled.` |

### Release summary for the next production version (69/80)

`Clearer wording on the review page, warnings and subscription message`

### Categories, keywords, pricing: no change

The listing has "Security and compliance" and "Administrative tools" (this file says "Security"),
and the four keywords above. Prices match the Pricing line above.

### Privacy & Security tab

- Scope table above: matches the manifest and the code. No change.
- "Stores personal data" is answered No. The app keeps, in Forge hosted storage, the account IDs of
  the people in each review and of the admins who start, decide, sign off and reopen, and the notes
  admins type about people. Atlassian's user privacy guide says all apps that store personal data
  must use the personal data reporting API; the notes are personal data on any reading, and the
  10 November audit read the rule as covering stored account IDs too. Proposed answer: Yes, with
  this text (210):
  `Account IDs of the people in each review and of the admins who decide and sign off, and the notes admins type. Kept in Forge hosted storage on Atlassian. Names and emails are read when shown and are not stored.`
  Change it together with the scope decision in `audit-2026-11-14.md` (finding A9), not before.

### 13 Nov drafts (growth/listing-screenshots-2026-11-13/listing-changes.md): what to use

- Tagline draft: usable, but the one above adds "groups" and "inactive users".
- Summary draft: do not use ("each person's last activity").
- Family link draft ("To act on the Remove list, Seat Reclaim for Jira frees those seats…"): do not use; see More details above.
- Images `ar-1` to `ar-4`: do not upload; `ar-5-past.png` can be used. Reasons in `audit-2026-11-14.md`.

---

## Personal data reporting (14 Nov 2026)

The app now reports the account IDs it keeps to Atlassian once a week and erases those of closed accounts (scope `report:personal-data`, hourly scheduled trigger; details in the README and in `privacy-security.md`). This settles finding A9 of the 14 Nov audit. Deployed to development only. Nothing below has been entered on the Marketplace.

- **The next production deploy is a major version.** The new scope makes it one (Forge lint: "major version upgrade ... scope modification"). Customers approve the new scope when they update. Make the Marketplace version for that major version after the deploy.
- **Privacy & Security tab:**
  - "Does your app store personal data?": **Yes** (it stores Atlassian account IDs and the notes admins type about people), and tick the Personal Data Reporting API acknowledgment: the app calls it. The public API reported "Stores personal data: No" on 14 Nov.
  - "Data stored" and the data residency answer for in-scope End-User Data: use the paragraph under "Data stored" in `privacy-security.md`. It replaces the shorter text proposed above under "Privacy & Security tab", and adds the lists of changes, the snapshot's working data and the weekly report.
  - Scope list: the new line for `report:personal-data` is at the end of `privacy-security.md` (it shows only at submit time for the new version).
- **Suggested release summary (55/80):** Weekly personal data report: closed accounts are erased
- **Suggested release notes:** Once a week the app reports the account IDs it keeps to Atlassian and erases those of accounts that were closed. Reviews keep the person's row and decision, shown as "Closed account", without the account ID or any note about them; an admin whose account was closed shows as "Closed account". Totals stay; the next snapshot counts again. New permission: report personal data.
- **Website:** the privacy page needs the matching text at the next website deploy: the weekly report and its permission, and that closed accounts are erased from kept reviews (the row and decision stay). The L11 sentence about deleting older reviews is still to fix as well.
