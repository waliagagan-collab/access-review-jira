/**
 * Pure rules for an access review. No Forge imports, so everything here runs
 * in the browser, in resolvers and under plain Node tests.
 *
 * A review is a snapshot: every user who holds a seat or sits in a group,
 * with their products, groups, whether they sit in an admin group, and
 * whether they did anything in Jira in the window. Reviewers mark each person
 * Keep, Remove or Flag, then sign the review off. The next review shows what
 * changed.
 */

/**
 * Groups that confer administration, recognised by name. The name is split
 * into words on anything that is not a letter and on a change from lower to
 * upper case, and a word that is or ends with "admin", "admins",
 * "administrator(s)", "administratoren" or "sysadmin(s)" counts. So
 * "site-admins", "jira-administrators", "JiraAdmins" and "itadmins" count,
 * and "badminton-club" and "administrative-assistants" do not. Jira Cloud has
 * no API that says which groups hold global permissions, so this is a name
 * rule, and the page and the evidence file label it as one.
 */
const ADMIN_WORDS = ['admin', 'admins', 'administrator', 'administrators', 'administratoren'];
export const isAdminGroupName = (name) =>
  String(name ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .some((word) => ADMIN_WORDS.some((w) => word.toLowerCase().endsWith(w)));

export const DECISIONS = ['keep', 'remove', 'flag'];
export const DECISION_WORDS = { keep: 'Keep', remove: 'Remove', flag: 'Follow up' };

/** Pure: whatever the page sends -> a decision, or null to clear it. */
export const normaliseDecision = (d) => (DECISIONS.includes(String(d)) ? String(d) : null);

export const MAX_NOTE = 500;
export const normaliseNote = (n) => String(n ?? '').trim().slice(0, MAX_NOTE);

export const NOT_CHECKED = 'Not checked';

/**
 * A person whose Atlassian account was closed. The weekly personal data
 * report (lib/personal-data.js) replaces their account ID in a review with a
 * marker that holds only where their row is in the review (`~closed:2.17` is
 * page 2, row 17), so every row stays its own and keeps its decision. An
 * account ID never starts with `~`.
 */
export const CLOSED_PREFIX = '~closed:';
export const closedMarker = (page, index) => `${CLOSED_PREFIX}${page}.${index}`;
export const isClosedAccount = (id) => typeof id === 'string' && id.startsWith(CLOSED_PREFIX);
/** What the page and the evidence file show for that person, and for an admin whose account was closed. */
export const CLOSED_ACCOUNT_NAME = 'Closed account';

/**
 * Pure: a user record from the scan -> a review row.
 *   groupsAll  - { groupId -> { name, products, admin } } for every group on the site
 *   activity   - { active: boolean, at?: ISO string, bucket?, label?, severity?, unchecked? }
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
  // Jira rejected this person's activity query: neither active nor inactive.
  if (activity?.unchecked) {
    row.unchecked = true;
    row.label = NOT_CHECKED;
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

/**
 * Pure: mark each current row with what changed for that person since the
 * previous review. Rows carry their own flags, so there is no cap. Someone
 * who sits in an admin group now and was absent or not an admin before is a
 * new admin, whether or not the account itself is new.
 */
export function flagChanges(current, previous) {
  const prev = new Map((previous ?? []).map((r) => [r.accountId, r]));
  return (current ?? []).map((r) => {
    const p = prev.get(r.accountId);
    const flags = {};
    if (!p) flags.newSinceLast = true;
    if (r.admin && !p?.admin) flags.becameAdmin = true;
    const gained = p ? (r.products ?? []).filter((x) => !(p.products ?? []).includes(x)) : [];
    if (gained.length) flags.gainedProducts = gained;
    return Object.keys(flags).length ? { ...r, ...flags } : r;
  });
}

const CAP = 500;

/**
 * Pure: what changed since the previous review, by account id. The lists are
 * capped so the review record stays small (rows carry their own flags); the
 * counts are always exact.
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
    if (r.admin && !p?.admin) becameAdmin.push(id);
    if (!p) {
      added.push(id);
      continue;
    }
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
 *   activity  - 'active' | 'inactive' | 'unchecked' (Jira rejected the activity query)
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
      (!activity || (activity === 'active' ? r.active : activity === 'unchecked' ? Boolean(r.unchecked) : !r.active && !r.unchecked)) &&
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

/**
 * Pure: the earlier sign-offs of a review, oldest first. Each entry says who
 * signed off, when, with which totals, and who reopened it and when. A review
 * reopened before this history was kept still has that one sign-off in its
 * live fields; it is read from there.
 */
export function signoffHistory(meta) {
  if (Array.isArray(meta?.signoffs)) return meta.signoffs;
  if (meta?.status !== 'complete' && meta?.completedAt) {
    return [
      {
        completedAt: meta.completedAt,
        completedBy: meta.completedBy ?? null,
        stats: meta.stats ?? null,
        reopenedAt: meta.reopenedAt ?? null,
        reopenedBy: meta.reopenedBy ?? null,
      },
    ];
  }
  return [];
}

/**
 * Pure: a review record as the page and the evidence file should see it. The
 * sign-off fields are filled only while the review is signed off; earlier
 * sign-offs are in `signoffs`.
 */
export function withSignoffs(meta) {
  if (!meta) return meta;
  const signoffs = signoffHistory(meta);
  return meta.status === 'complete'
    ? { ...meta, signoffs }
    : { ...meta, signoffs, completedAt: null, completedBy: null, stats: null };
}

/** Pure: which rows "Keep all active non-admins" marks. Rows that were not checked are never among them. */
export const isActiveNonAdmin = (r) => Boolean(r?.active) && !r?.admin && !r?.unchecked;
