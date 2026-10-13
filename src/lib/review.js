/**
 * Pure rules for an access review. No Forge imports, so everything here runs
 * in the browser, in resolvers and under plain Node tests.
 *
 * A review is a snapshot: every user who holds a seat or sits in a group,
 * with their products, groups, whether they are an admin, and whether they
 * did anything in Jira in the window. Reviewers mark each person Keep, Remove
 * or Flag, then sign the review off. The next review shows what changed.
 */

/** Groups that confer administration, recognised by name. Deliberately broad. */
export const isAdminGroupName = (name) => /admin/i.test(String(name ?? ''));

export const DECISIONS = ['keep', 'remove', 'flag'];
export const DECISION_WORDS = { keep: 'Keep', remove: 'Remove', flag: 'Follow up' };

/** Pure: whatever the page sends -> a decision, or null to clear it. */
export const normaliseDecision = (d) => (DECISIONS.includes(String(d)) ? String(d) : null);

export const MAX_NOTE = 500;
export const normaliseNote = (n) => String(n ?? '').trim().slice(0, MAX_NOTE);

/**
 * Pure: a user record from the scan -> a review row.
 *   groupsAll  - { groupId -> { name, products, admin } } for every group on the site
 *   activity   - { active: boolean, at?: ISO string, bucket?, label?, severity? }
 */
export function buildRow(accountId, user, groupsAll, activity) {
  const groups = [...new Set(user?.groups ?? [])].filter((id) => groupsAll?.[id]);
  const products = [...new Set(groups.flatMap((id) => groupsAll[id]?.products ?? []))].sort();
  const admin = groups.some((id) => groupsAll[id]?.admin);
  const row = { accountId, products, groups, admin, active: Boolean(activity?.active) };
  if (activity?.at) row.lastActivityAt = activity.at;
  if (!activity?.active) {
    row.bucket = activity?.bucket ?? null;
    row.label = activity?.label ?? null;
    row.severity = activity?.severity ?? 0;
  }
  return row;
}

/** Pure: admins first, then longest inactive, then by account id so paging is stable. */
export const sortRows = (rows) =>
  [...rows].sort(
    (a, b) =>
      Number(b.admin) - Number(a.admin) ||
      (b.severity ?? 0) - (a.severity ?? 0) ||
      String(a.accountId).localeCompare(String(b.accountId))
  );

/** Pure: one line per group, for the Groups tab and the evidence file. */
export function groupSummary(groupsAll, rows) {
  const members = {};
  for (const r of rows ?? []) for (const g of r.groups ?? []) members[g] = (members[g] ?? 0) + 1;
  return Object.entries(groupsAll ?? {})
    .map(([id, g]) => ({
      id,
      name: g.name ?? id,
      products: g.products ?? [],
      admin: Boolean(g.admin),
      members: g.members ?? 0, // every active account in the group, bots included
      licensedMembers: members[id] ?? 0, // people in this review
      empty: !(g.members > 0),
    }))
    .sort((a, b) => Number(b.admin) - Number(a.admin) || b.licensedMembers - a.licensedMembers || a.name.localeCompare(b.name));
}

const CAP = 500;

/**
 * Pure: what changed since the previous review, by account id. Lists are
 * capped so the review record stays small; the counts are always exact.
 */
export function diffReviews(current, previous) {
  const prev = new Map((previous ?? []).map((r) => [r.accountId, r]));
  const cur = new Map((current ?? []).map((r) => [r.accountId, r]));
  const added = [];
  const removed = [];
  const becameAdmin = [];
  const gainedProducts = [];
  for (const [id, r] of cur) {
    const p = prev.get(id);
    if (!p) {
      added.push(id);
      continue;
    }
    if (r.admin && !p.admin) becameAdmin.push(id);
    const gained = (r.products ?? []).filter((x) => !(p.products ?? []).includes(x));
    if (gained.length) gainedProducts.push({ accountId: id, products: gained });
  }
  for (const id of prev.keys()) if (!cur.has(id)) removed.push(id);
  const cap = (xs) => xs.slice(0, CAP);
  return {
    counts: { added: added.length, removed: removed.length, becameAdmin: becameAdmin.length, gainedProducts: gainedProducts.length },
    added: cap(added),
    removed: cap(removed),
    becameAdmin: cap(becameAdmin),
    gainedProducts: cap(gainedProducts),
  };
}

/** Pure: how far the review has got. */
export function decisionStats(rows, decisions) {
  const stats = { total: 0, keep: 0, remove: 0, flag: 0, undecided: 0 };
  for (const r of rows ?? []) {
    stats.total += 1;
    const d = decisions?.[r.accountId]?.decision;
    if (d && stats[d] !== undefined) stats[d] += 1;
    else stats.undecided += 1;
  }
  return stats;
}

const norm = (s) => String(s ?? '').toLowerCase();

/**
 * Pure: the page's filters over decorated rows (names and decisions attached).
 *   query     - name or email
 *   product   - product name, or 'none' for users with no product access
 *   group     - group id
 *   adminOnly - admins only
 *   activity  - 'active' | 'inactive'
 *   decision  - 'keep' | 'remove' | 'flag' | 'undecided'
 *   newOnly   - only users not in the previous review
 */
export function filterReviewRows(rows, { query = '', product = null, group = null, adminOnly = false, activity = null, decision = null, newOnly = false } = {}) {
  const q = norm(query).trim();
  return (rows ?? []).filter(
    (r) =>
      (!q || norm(r.displayName).includes(q) || norm(r.email).includes(q)) &&
      (!product || (product === 'none' ? !(r.products ?? []).length : (r.products ?? []).includes(product))) &&
      (!group || (r.groups ?? []).includes(group)) &&
      (!adminOnly || r.admin) &&
      (!activity || (activity === 'active' ? r.active : !r.active)) &&
      (!decision || (decision === 'undecided' ? !r.decision : r.decision === decision)) &&
      (!newOnly || r.newSinceLast)
  );
}

/** Pure: "Q4 2026" for a date, the way reviews are usually named. */
export function quarterName(iso) {
  const d = new Date(iso ?? Date.now());
  if (Number.isNaN(d.getTime())) return '';
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

/** Pure: the words shown in the Activity column and the evidence file. */
export function activityText(r) {
  if (r?.active) return r.lastActivityAt ? `Active · last seen ${String(r.lastActivityAt).slice(0, 10)}` : 'Active in the window';
  return r?.label ? `No activity · ${r.label}` : 'No activity in the window';
}
