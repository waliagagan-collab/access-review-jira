import api, { route } from '@forge/api';

/**
 * Server-side authorization for every resolver.
 *
 * The admin page is only rendered for Jira administrators, but a resolver
 * can be invoked directly, so where the module appears is not an
 * authorization control. Every resolver asks Jira, as the calling user,
 * whether that user holds the global ADMINISTER permission, and refuses
 * otherwise. Any failure to confirm (network, 5xx, odd response) refuses too.
 */

export const NOT_ADMIN_MESSAGE =
  'Only Jira administrators can use Access Review. Ask a Jira admin to open it.';
export const CHECK_FAILED_MESSAGE =
  'Could not confirm that you are a Jira administrator. Refresh the page and try again.';

/** Pure: a /mypermissions?permissions=ADMINISTER body -> is this a Jira admin? */
export const isJiraAdmin = (body) => body?.permissions?.ADMINISTER?.havePermission === true;

/** Asks Jira as the calling user. Never throws. */
export async function checkAdmin() {
  try {
    const res = await api
      .asUser()
      .requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`, {
        headers: { Accept: 'application/json' },
      });
    if (res.status === 401 || res.status === 403) return { allowed: false, reason: 'not-admin' };
    if (!res.ok) return { allowed: false, reason: 'check-failed' };
    const body = await res.json();
    return isJiraAdmin(body) ? { allowed: true } : { allowed: false, reason: 'not-admin' };
  } catch {
    return { allowed: false, reason: 'check-failed' };
  }
}

/** Pure: the response a refused resolver returns. */
export const refusal = (reason) => ({
  ok: false,
  forbidden: true,
  error: reason === 'not-admin' ? NOT_ADMIN_MESSAGE : CHECK_FAILED_MESSAGE,
});

/** Wraps a resolver so it runs only for a confirmed administrator. */
export const adminOnly =
  (fn, check = checkAdmin) =>
  async (request) => {
    const gate = await check(request);
    return gate?.allowed === true ? fn(request) : refusal(gate?.reason);
  };
