import { privacy } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { runSlice, kvsStore } from './lib/privacy.js';
import { SOURCES, busy } from './lib/personal-data.js';

/**
 * The hourly scheduled trigger of the weekly personal data report (see
 * lib/privacy.js; what is reported and erased is in lib/personal-data.js).
 * Each run does one slice of the report, or nothing when this week's report
 * is done. It runs whatever the licence says: erasing what the app keeps
 * about closed accounts is owed either way. The app keeps no names or
 * emails, so an account whose profile changed needs nothing. Its one log
 * line names the step, whether it ran and, when it ends a report, the
 * totals; never an account.
 */
export async function scheduled() {
  try {
    const res = await runSlice({ store: kvsStore(kvs, WhereConditions), report: privacy.reportPersonalData, sources: SOURCES, busy });
    // When this run ended the week's report, the line gives its totals.
    const totals = res.last
      ? `, accounts ${res.last.accounts}, closed ${res.last.closed}, values changed ${res.last.erased}, skipped ${res.last.skipped}`
      : '';
    console.log(`Personal data report: ${res.ran ? 'ran' : 'did not run'}, step ${res.phase}${res.error ? `, error: ${res.error}` : ''}${totals}`);
  } catch (err) {
    console.log(`Personal data report: failed, ${String(err?.message ?? err).slice(0, 300)}`);
  }
  return { statusCode: 200 };
}
