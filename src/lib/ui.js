/**
 * Pure helpers for the admin page: seat prices, the yearly-cost summary,
 * search and filters, and the scan progress estimate. No Forge imports, so
 * the same rules run in the browser, in resolvers and under plain Node tests.
 */

export const MAX_SEAT_PRICE = 1_000_000;
export const MAX_PRICED_PRODUCTS = 20;

/**
 * Pure: whatever the page sends -> { productName: price } with only sane,
 * positive numbers. Anything else is dropped rather than stored.
 */
export function normaliseSeatCosts(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [rawName, rawValue] of Object.entries(input)) {
    if (Object.keys(out).length >= MAX_PRICED_PRODUCTS) break;
    const name = String(rawName).trim().slice(0, 100);
    const value = Number(String(rawValue ?? '').replace(/[, ]/g, ''));
    if (!name || !Number.isFinite(value) || value <= 0 || value > MAX_SEAT_PRICE) continue;
    out[name] = Math.round(value * 100) / 100;
  }
  return out;
}

/**
 * Pure: inactive seats per product x the yearly price of one seat.
 * Returns null when no priced product has inactive seats, so the page can
 * ask for prices instead of showing a misleading zero.
 */
export function yearlySaving(inactiveByProduct, seatCosts) {
  let total = 0;
  let priced = false;
  for (const [product, count] of Object.entries(inactiveByProduct ?? {})) {
    const price = Number(seatCosts?.[product]);
    if (!(price > 0) || !(count > 0)) continue;
    total += count * price;
    priced = true;
  }
  return priced ? Math.round(total) : null;
}

/** Pure: whole-number money with thousands separators. */
export const fmtMoney = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');

const norm = (s) => String(s ?? '').toLowerCase();

/**
 * Pure: search and filters over the full list.
 *   query   - matches display name or email, case-insensitive
 *   product - keep rows holding this product (null = all)
 *   band    - keep rows in this inactivity band (null = all)
 */
export function filterRows(rows, { query = '', product = null, band = null } = {}) {
  const q = norm(query).trim();
  return (rows ?? []).filter(
    (r) =>
      (!q || norm(r.displayName).includes(q) || norm(r.email).includes(q)) &&
      (!product || (r.products ?? []).includes(product)) &&
      (!band || r.bucket === band)
  );
}

/** Pure: the inactivity bands present, longest-inactive first, for the band filter. */
export function bandOptions(rows) {
  const seen = new Map();
  for (const r of rows ?? []) {
    if (r?.bucket && !seen.has(r.bucket)) seen.set(r.bucket, { value: r.bucket, label: r.label ?? r.bucket, severity: r.severity ?? 0 });
  }
  return [...seen.values()]
    .sort((a, b) => b.severity - a.severity || a.label.localeCompare(b.label))
    .map(({ value, label }) => ({ value, label }));
}

const SHARDS = 16; // matches store.js; verify walks the shards in order

/**
 * Pure: how far along a scan is, for the progress bar. Listing users and the
 * activity sweep have no known total, so they show as indeterminate; the
 * per-user check walks a fixed number of shards, so it shows real progress.
 */
export function scanProgress(state) {
  switch (state?.phase) {
    case 'roles':
      return { value: 0.02, indeterminate: true };
    case 'members':
    case 'directory':
      return { value: 0.1, indeterminate: true };
    case 'issues':
    case 'content':
      return { value: 0.3, indeterminate: true };
    case 'verify': {
      const done = Math.min(SHARDS, Math.max(0, Number(state.verifyShard) || 0));
      return { value: 0.5 + 0.45 * (done / SHARDS), indeterminate: false };
    }
    case 'finalize':
      return { value: 0.97, indeterminate: false };
    default:
      return { value: 0, indeterminate: true };
  }
}

/**
 * Pure: show the one-time request for a Marketplace review? Only once the app
 * has shown its value (`earned`: a report with at least one inactive user, or
 * a seat actually freed), and never again after an admin closes it. Closing
 * is remembered per site in settings, so the prompt is seen once, not once
 * per admin.
 */
export const showReviewPrompt = ({ earned, hidden }) => Boolean(earned) && !hidden;
