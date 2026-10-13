# Marketplace listing — Access Review for Jira (draft)

## Name (≤ 60)

Access Review: User Access Audits & SOC 2 Evidence for Jira

## Tagline (≤ 130, no trailing punctuation)

Review who has access to Jira every quarter, with activity evidence, sign-off and an audit-ready export

## Summary (≤ 250)

A snapshot of every user, group and product on your site, with who did anything in Jira recently. Mark each person Keep, Remove or Follow up, sign the review off, and download the evidence for SOC 2 or ISO 27001. Read-only.

## Categories and keywords

- Categories: Security; Administrative tools
- Keywords: Audit, Compliance, User permissions, Reporting

## More details

**Auditors ask the same question every quarter: who has access, and did someone check?**

Access Review answers it in one place.

- **Snapshot.** Every group on the site, including empty ones; who is in each; which product each group grants; who holds an admin group; and whether each person created, changed, commented on or logged work on anything in Jira in the window you choose. Every candidate is checked against all issues, not a sample.
- **Review.** Mark each person Keep, Remove or Follow up, with notes. Filter by product, group, admins, activity, decision, or "new since the previous review".
- **Sign-off.** Complete the review with your name and the time. Reopen it if needed.
- **Evidence.** Excel (Summary, Users, Groups) or CSV, with every decision, reviewer and timestamp.
- **Change tracking.** The next review shows who was added, who left, who became an admin and who gained a product.

**Read-only.** No write permission exists, so the app cannot change anything. To act on the Remove list, use Atlassian Administration, or Seat Reclaim for Jira, which removes access with an undo. **Runs on Atlassian;** no servers of ours.

## Pricing (per user per month, graduated)

Free ≤10; 1–100 $1.00; 101–250 $0.60; 251–1000 $0.35; 1001–2500 $0.25; 2501–5000 $0.20; 5001–7500 $0.17; 7501–10000 $0.15; 10001+ $0.12. Multi-instance the same.

## Scope justification

| Scope | Why |
| --- | --- |
| `read:application-role:jira` | Which groups grant which product, and Atlassian's own seat counts. |
| `read:group:jira` | Every group on the site and its members. |
| `read:user:jira` | Active flag and account type, to leave out bots and customers; display name and email at display time. |
| `read:avatar:jira` | Required alongside `read:user:jira` by the group-member endpoint; avatars are not shown. |
| `read:jira-user` | Fall back to the site directory if application roles are unreadable. |
| `read:jira-work` | Search recently updated issues and read changelog, comment and worklog authors to decide who was active. Issue content is never stored. |
| `storage:app` | Snapshots, decisions and notes in Forge hosted storage. |

No write scopes. Egress: none.
