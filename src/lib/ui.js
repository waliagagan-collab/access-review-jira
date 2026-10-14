/**
 * Pure helpers for the admin page. No Forge imports, so the same rules run in
 * the browser, in resolvers and under plain Node tests.
 */

const DEFAULT_SHARDS = 64; // matches store.js; the scan record carries the real figure

/**
 * Pure: how far along a snapshot is, for the progress bar. Listing groups,
 * members and the activity sweep have no known total, so they show as
 * indeterminate; the per-user check walks a fixed number of shards, so it
 * shows real progress.
 */
export function scanProgress(state) {
  const shards = Number(state?.shards) || DEFAULT_SHARDS;
  switch (state?.phase) {
    case 'roles':
      return { value: 0.02, indeterminate: true };
    case 'groups':
      return { value: 0.05, indeterminate: true };
    case 'members':
      return { value: 0.1, indeterminate: true };
    case 'issues':
      return { value: 0.3, indeterminate: true };
    case 'verify': {
      const done = Math.min(shards, Math.max(0, Number(state.verifyShard) || 0));
      return { value: 0.5 + 0.45 * (done / shards), indeterminate: false };
    }
    case 'finalize':
      return { value: 0.97, indeterminate: false };
    default:
      return { value: 0, indeterminate: true };
  }
}

/**
 * Pure: show the one-time request for a Marketplace review? Only once the app
 * has shown its value (`earned`: a review signed off), and never again after
 * an admin closes it. Closing is remembered per site in settings, so the
 * prompt is seen once, not once per admin.
 */
export const showReviewPrompt = ({ earned, hidden }) => Boolean(earned) && !hidden;
