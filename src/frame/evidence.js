/**
 * Pure: a decorated review -> the three sheets of the evidence workbook. No
 * Forge imports, so the same code is tested under plain Node.
 */
const DECISION_WORDS = { keep: 'Keep', remove: 'Remove', flag: 'Follow up' };
export const day = (iso) => (iso ? String(iso).slice(0, 10) : '');
export const stamp = (iso) => (iso ? String(iso).slice(0, 16).replace('T', ' ') + ' UTC' : '');

const activity = (r) => (r.active ? (r.lastActivityAt ? `Active (last seen ${day(r.lastActivityAt)})` : 'Active in the window') : `No activity${r.label ? ` (${r.label})` : ''}`);

/** Pure: a decorated review -> the three sheets of the evidence workbook. */
export function sheetsOf(review, rows, stats) {
  const summary = [
    ['Item', 'Value'],
    ['Review', `Access review ${day(review.startedAt)}`],
    ['Site snapshot taken', stamp(review.generatedAt)],
    ['Started by', review.startedByName ?? ''],
    ['Status', review.status === 'complete' ? 'Signed off' : 'Open'],
    ['Signed off at', stamp(review.completedAt)],
    ['Signed off by', review.completedByName ?? ''],
    ['Activity window (days)', review.days ?? ''],
    ['Users reviewed', review.counts?.users ?? rows.length],
    ['Admins', review.counts?.admins ?? ''],
    ['Users with no activity in the window', review.counts?.inactive ?? ''],
    ['Users with no product access', review.counts?.noAccess ?? ''],
    ['Decisions: keep', stats?.keep ?? ''],
    ['Decisions: remove', stats?.remove ?? ''],
    ['Decisions: follow up', stats?.flag ?? ''],
    ['Undecided', stats?.undecided ?? ''],
    ['Previous review signed off', stamp(review.previousCompletedAt)],
    ['Users added since previous review', review.changes?.counts?.added ?? ''],
    ['Users gone since previous review', review.changes?.counts?.removed ?? ''],
    ['New admins since previous review', review.changes?.counts?.becameAdmin ?? ''],
    ['Products (seats Atlassian counts)', (review.products ?? []).map((p) => `${p.name}: ${p.userCount ?? '—'}`).join('; ')],
    ['Warnings', (review.warnings ?? []).join(' ')],
  ];
  const users = [
    ['Display name', 'Email', 'Account ID', 'Products', 'Groups', 'Admin', 'Activity', 'Decision', 'Note', 'Decided by', 'Decided at (UTC)', 'New since previous review'],
    ...rows.map((r) => [
      r.displayName,
      r.email ?? '',
      r.accountId,
      (r.products ?? []).join(' / ') || 'none',
      (r.groupNames ?? []).join(' / '),
      r.admin ? 'Yes' : 'No',
      activity(r),
      DECISION_WORDS[r.decision] ?? 'Undecided',
      r.note ?? '',
      r.decidedByName ?? '',
      stamp(r.decidedAt),
      r.newSinceLast ? 'Yes' : '',
    ]),
  ];
  const groups = [
    ['Group', 'Grants', 'Admin group', 'Members (all accounts)', 'Members in this review', 'Empty'],
    ...(review.groups ?? []).map((g) => [
      g.name,
      (g.products ?? []).join(' / ') || '',
      g.admin ? 'Yes' : 'No',
      g.members ?? 0,
      g.licensedMembers ?? 0,
      g.empty ? 'Yes' : '',
    ]),
  ];
  return [
    { name: 'Summary', table: summary },
    { name: 'Users', table: users },
    { name: 'Groups', table: groups },
  ];
}
