import api from '@forge/api';
import { kvs } from '@forge/kvs';
import { Queue } from '@forge/events';
import { TIMING } from '../src/lib/store.js';

/**
 * In-memory stand-ins for Forge storage, the queue and the Jira API, so the
 * storage layer, the resolvers and the worker run under plain Node.
 *
 *   data    - the stored values, by key
 *   pushed  - every queue event body, in order
 *   hooks   - beforeGet/beforeSet(key, value) run before a storage call lands;
 *             failStorage = n makes the next n storage calls fail;
 *             failPush = Error makes queue pushes fail; admin = false makes
 *             the caller a non-admin
 *   jira    - (path) => response, set per test
 *   writes  - every [key, value] handed to kvs.set, in order
 *   reported, closed - the accounts handed to privacy.reportPersonalData, and
 *             the account IDs it answers as closed
 */
export function installFakes() {
  const data = new Map();
  const pushed = [];
  const hooks = { beforeGet: null, beforeSet: null, failStorage: 0, failPush: null, admin: true, jira: null, calls: [], writes: [], reported: [], closed: [] };
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  // Every storage call yields once, so calls made side by side interleave.
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  const maybeFail = () => {
    if (hooks.failStorage > 0) {
      hooks.failStorage -= 1;
      throw new Error('storage unavailable');
    }
  };

  kvs.get = async (key) => {
    await turn();
    maybeFail();
    await hooks.beforeGet?.(key);
    return clone(data.get(key));
  };
  kvs.set = async (key, value, options) => {
    await turn();
    maybeFail();
    await hooks.beforeSet?.(key, value);
    if (options?.keyPolicy === 'FAIL_IF_EXISTS' && data.has(key)) {
      const err = new Error('KEY_ALREADY_EXISTS');
      err.responseDetails = { status: 409 };
      throw err;
    }
    hooks.writes.push([key, clone(value)]);
    data.set(key, clone(value));
  };
  kvs.delete = async (key) => {
    await turn();
    maybeFail();
    data.delete(key);
  };
  // Key prefix queries in key order, page by page, as the personal data report walks the store.
  kvs.query = () => {
    const q = {};
    const builder = {
      where: (field, clause) => ((q.prefix = String(clause?.values?.[0] ?? '')), builder),
      limit: (n) => ((q.limit = n), builder),
      cursor: (c) => ((q.cursor = c), builder),
      async getMany() {
        await turn();
        maybeFail();
        const keys = [...data.keys()].filter((k) => k.startsWith(q.prefix ?? '') && (!q.cursor || k > q.cursor)).sort();
        const page = keys.slice(0, q.limit ?? 10);
        return {
          results: page.map((key) => ({ key, value: clone(data.get(key)) })),
          ...(keys.length > page.length ? { nextCursor: page.at(-1) } : {}),
        };
      },
    };
    return builder;
  };
  // privacy.reportPersonalData: every call's accounts are kept in
  // hooks.reported; those listed in hooks.closed are answered as closed.
  api.privacy.reportPersonalData = async (accounts) => {
    hooks.reported.push(...accounts);
    return accounts.filter((a) => hooks.closed.includes(a.accountId)).map((a) => ({ accountId: a.accountId, status: 'closed' }));
  };

  Queue.prototype.push = async function push(event) {
    if (hooks.failPush) throw hooks.failPush;
    pushed.push(clone(event.body));
    return { jobId: 'job' };
  };

  const pathOf = (route) => String(route?.value ?? route);
  api.asApp = () => ({
    requestJira: async (route) => {
      const path = pathOf(route);
      hooks.calls.push(path);
      if (!hooks.jira) throw new Error(`no fake Jira for ${path}`);
      return hooks.jira(path);
    },
  });
  api.asUser = () => ({
    requestJira: async () => ok({ permissions: { ADMINISTER: { havePermission: hooks.admin !== false } } }),
  });

  // Tests do not wait for real back-offs.
  TIMING.retryMs = 1;
  TIMING.lockWaitMs = 1;

  return { data, pushed, hooks };
}

export const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
export const refuse = (status, body = {}, headers = {}) => ({
  ok: false,
  status,
  headers: { get: (name) => headers[name] ?? null },
  json: async () => body,
});

/** Call a resolver the way Forge does. */
export const call = (handler, functionKey, payload = {}, { accountId = 'admin-1', license, environmentType = 'DEVELOPMENT' } = {}) =>
  handler({ call: { functionKey, payload }, context: { environmentType } }, { principal: { accountId }, license });

const query = (path) => new URLSearchParams(path.slice(path.indexOf('?') + 1));

/**
 * A small Jira site.
 *   groups   - [{ groupId, name, members: [accountId] }]
 *   roles    - /applicationrole rows
 *   swept    - issues the sweep returns
 *   active   - (accountId, jql) => true when the per-user query finds something
 *   rejects  - (accountId, jql) => true when Jira answers 400 to that query
 */
export function fakeSite({ groups = [], roles = [], swept = [], active = () => false, rejects = () => false, names = {} } = {}) {
  return (path) => {
    if (path.startsWith('/rest/api/3/applicationrole')) return ok(roles);
    if (path.startsWith('/rest/api/3/group/bulk')) {
      const startAt = Number(query(path).get('startAt') ?? 0);
      const values = groups.slice(startAt, startAt + 100).map(({ groupId, name }) => ({ groupId, name }));
      return ok({ values, isLast: startAt + values.length >= groups.length });
    }
    if (path.startsWith('/rest/api/3/group/member')) {
      const q = query(path);
      const group = groups.find((g) => g.groupId === q.get('groupId'));
      if (!group) return refuse(404);
      const startAt = Number(q.get('startAt') ?? 0);
      const values = group.members.slice(startAt, startAt + 50).map((accountId) => ({ accountId, accountType: 'atlassian', active: true }));
      return ok({ values, isLast: startAt + values.length >= group.members.length });
    }
    if (path.startsWith('/rest/api/3/search/jql')) {
      const jql = query(path).get('jql') ?? '';
      if (jql.startsWith('updated >=')) return ok({ issues: swept, isLast: true });
      const accountId = /CHANGED BY "([^"]+)"/.exec(jql)?.[1];
      if (rejects(accountId, jql)) return refuse(400, { errorMessages: ["Field 'worklogAuthor' does not exist or you do not have permission to view it."] });
      return ok({ issues: active(accountId, jql) ? [{ id: '1' }] : [] });
    }
    if (path.startsWith('/rest/api/3/user/bulk')) {
      const ids = query(path).getAll('accountId');
      return ok({ values: ids.filter((id) => names[id] !== null).map((id) => ({ accountId: id, displayName: names[id] ?? `Name of ${id}`, emailAddress: `${id}@example.com` })) });
    }
    return refuse(404);
  };
}

/** Deliver queued events to the worker until none are left. */
export async function drain(handler, pushed, { max = 50 } = {}) {
  let delivered = 0;
  while (pushed.length && delivered < max) {
    const body = pushed.shift();
    await handler({ body });
    delivered += 1;
  }
  return delivered;
}
