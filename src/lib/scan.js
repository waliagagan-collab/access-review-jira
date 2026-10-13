/**
 * Pure scan-state rules. No Forge imports, so this module is testable under
 * plain Node and usable from any entry point.
 */

export const ALLOWED_DAYS = [30, 60, 90, 180, 365];
export const DEFAULT_DAYS = 90;

/** No cursor movement for this long means the queue lost the event. */
export const STALE_AFTER_MS = 20 * 60 * 1000;

export const normaliseDays = (value) =>
  ALLOWED_DAYS.includes(Number(value)) ? Number(value) : DEFAULT_DAYS;

/** A running scan whose cursor has not moved in a long time is stuck. */
export const isStale = (state, at = Date.now()) =>
  state?.status === 'running' &&
  at - Date.parse(state.updatedAt ?? state.startedAt ?? 0) > STALE_AFTER_MS;

/**
 * Paid-app gate. Licensing only applies to PRODUCTION installs — development
 * and staging installs carry no licence unless one is simulated with
 * `forge install --license …` — so the gate must never lock a test site.
 *
 * In production the Forge `license` object is authoritative: `active` is the
 * single field that says whether the customer may use the app. An absent
 * object in production means "not licensed", not "unknown".
 */
export function licenseGate(license, environmentType) {
  const production = String(environmentType ?? '').toUpperCase() === 'PRODUCTION';
  if (!production) {
    // Surface a simulated inactive licence so the gate can be tested, but
    // never block a non-production site that simply has no licence object.
    if (license && license.active === false) {
      return { allowed: false, reason: 'simulated-inactive' };
    }
    return { allowed: true, reason: 'non-production' };
  }
  if (!license) return { allowed: false, reason: 'missing' };
  if (license.active === true) {
    return { allowed: true, reason: license.isEvaluation ? 'trial' : 'active' };
  }
  return { allowed: false, reason: 'inactive' };
}

/** What to tell the admin when the gate refuses. */
export function licenseMessage(gate, license) {
  if (gate.allowed) return null;
  if (gate.reason === 'simulated-inactive') {
    return 'This test install is simulating an inactive licence.';
  }
  if (license?.trialEndDate && Date.parse(license.trialEndDate) < Date.now()) {
    return 'Your free trial of Access Review has ended. Subscribe in Jira → Apps → Manage apps to keep running reviews.';
  }
  return 'Access Review needs an active subscription. Start a free 30-day trial in Jira → Apps → Manage apps.';
}
