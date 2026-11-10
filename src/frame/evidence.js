import { utcDay, utcStamp } from '../lib/ui.js';

/**
 * Pure: a decorated review -> the sheets of the evidence workbook. No Forge
 * imports, so the same code is tested under plain Node.
 */
const DECISION_WORDS = { keep: 'Keep', remove: 'Remove', flag: 'Follow up' };
// Dates and times are UTC, from the same helpers the page uses.
export const day = utcDay;
export const stamp = utcStamp;

/** Pure: "2026-10-13-0240", the snapshot's UTC day and time, for file names. */
export const fileStamp = (iso) => {
  const s = utcStamp(iso);
  return s ? `${s.slice(0, 10)}-${s.slice(11, 13)}${s.slice(14, 16)}` : '';
};

const activity = (r) => {
  if (r.unchecked) return 'Not checked';
  if (!r.active) return `No activity${r.label ? ` (${r.label})` : ''}`;
  return r.lastActivityAt ? `Active (last seen ${day(r.lastActivityAt)})` : 'Active in the window';
};

const totals = (s) =>
  s ? `${s.keep ?? 0} keep, ${s.remove ?? 0} remove, ${s.flag ?? 0} follow up, ${s.undecided ?? 0} undecided` : 'totals not recorded';

/** Pure: one earlier sign-off in words: who signed, when, the totals, and who reopened it and when. */
export const signoffLine = (s) =>
  `Signed off ${stamp(s.completedAt)} by ${s.completedByName ?? '(unknown)'} (${totals(s.stats)}). ` +
  `Reopened ${stamp(s.reopenedAt)} by ${s.reopenedByName ?? '(unknown)'}.`;

/** Pure: who changed since the previous signed-off review, one line per person. */
function changesTable(review, rows) {
  const head = ['Change', 'Display name', 'Email', 'Account ID', 'Detail'];
  if (!review.changes) return [head, ['No earlier signed-off review to compare with', '', '', '', '']];
  const counts = review.changes.counts ?? {};
  const person = (r) => [r.displayName ?? '(unknown)', r.email ?? '', r.accountId];
  const more = (label, total, listed) => (total > listed ? [[label, '', '', '', `${total - listed} more not listed`]] : []);

  const gone = review.gone ?? [];
  // Reviews saved before rows carried their gained products keep a list in the record.
  const gainedBefore = new Map((review.changes.gainedProducts ?? []).map((g) => [g.accountId, g.products ?? []]));
  const gained = rows
    .map((r) => [r, r.gainedProducts ?? gainedBefore.get(r.accountId) ?? []])
    .filter(([, products]) => products.length);

  return [
    head,
    ...gone.map((g) => ['Gone', ...person(g), 'In the previous review, not in this one']),
    ...more('Gone', counts.removed ?? 0, gone.length),
    ...rows.filter((r) => r.newSinceLast).map((r) => ['Added', ...person(r), 'Not in the previous review']),
    ...gained.map(([r, products]) => ['Gained a Jira product', ...person(r), products.join(' / ')]),
    ...more('Gained a Jira product', counts.gainedProducts ?? 0, gained.length),
    ...rows.filter((r) => r.becameAdmin).map((r) => ['Joined an admin group (by name)', ...person(r), '']),
  ];
}

/** Pure: a decorated review -> the sheets of the evidence workbook. */
export function sheetsOf(review, rows, stats) {
  const signedOff = review.status === 'complete';
  const summary = [
    ['Item', 'Value'],
    ['Review', `Access review ${day(review.startedAt)}`],
    ['Site snapshot taken', stamp(review.generatedAt)],
    ['Started by', review.startedByName ?? ''],
    ['Status', signedOff ? 'Signed off' : 'Open'],
    // An open review has no sign-off, even if it was signed off and reopened before.
    ['Signed off at', signedOff ? stamp(review.completedAt) : ''],
    ['Signed off by', signedOff ? (review.completedByName ?? '') : ''],
    ...(review.signoffs ?? []).map((s, i) => [`Earlier sign-off ${i + 1}`, signoffLine(s)]),
    ['Activity window (days)', review.days ?? ''],
    ['Users reviewed', review.counts?.users ?? rows.length],
    ['In admin groups', review.counts?.admins ?? ''],
    ['Users with no activity in the window', review.counts?.inactive ?? ''],
    ['Users whose activity was not checked', review.counts?.unchecked ?? 0],
    ['Users with no Jira product access', review.counts?.noAccess ?? ''],
    ['Decisions: keep', stats?.keep ?? ''],
    ['Decisions: remove', stats?.remove ?? ''],
    ['Decisions: follow up', stats?.flag ?? ''],
    ['Undecided', stats?.undecided ?? ''],
    ['Previous review signed off', stamp(review.previousCompletedAt)],
    ['Users added since previous review', review.changes?.counts?.added ?? ''],
    ['Users gone since previous review', review.changes?.counts?.removed ?? ''],
    ['New admins since previous review', review.changes?.counts?.becameAdmin ?? ''],
    ['Users who gained a Jira product since previous review', review.changes?.counts?.gainedProducts ?? ''],
    ['Jira products (seats Atlassian counts)', (review.products ?? []).map((p) => `${p.name}: ${p.userCount ?? '—'}`).join('; ')],
    ['Warnings', (review.warnings ?? []).join(' ')],
  ];
  const users = [
    ['Display name', 'Email', 'Account ID', 'Jira products', 'Groups', 'In an admin group (by name)', 'Activity', 'Decision', 'Note', 'Decided by', 'Decided at (UTC)', 'New since previous review'],
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
    ['Group', 'Grants (Jira products)', 'Admin group (by name)', 'Members (all accounts)', 'Members in this review', 'Empty'],
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
    { name: 'Changes', table: changesTable(review, rows) },
  ];
}
