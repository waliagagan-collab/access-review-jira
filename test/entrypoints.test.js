import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// These two modules are the app's only entry points. Before this test existed,
// `new Resolver()` threw at module load in the deployed bundle and every single
// invocation failed — the UI showed a dead button and no error. Nothing caught
// it because no test ever imported the entry points.
test('the resolver entry point loads and exports a handler', async () => {
  const mod = await import('../src/index.js');
  assert.equal(typeof mod.handler, 'function');
});

test('the queue worker entry point loads and exports a handler', async () => {
  const mod = await import('../src/worker.js');
  assert.equal(typeof mod.handler, 'function');
});

test('every resolver key the frontend and the export frame call is defined', () => {
  const backend = read('../src/index.js');
  for (const file of ['../src/frontend/index.jsx', '../src/frame/index.js']) {
    const invoked = [...new Set([...read(file).matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]))];
    assert.ok(invoked.length > 0, `${file} should invoke at least one resolver`);
    for (const key of invoked) {
      assert.ok(backend.includes(`define('${key}'`), `resolver must define '${key}'`);
    }
  }
});

test('every resolver goes through the admin gate', () => {
  const backend = read('../src/index.js');
  assert.ok(!/resolver\.define\('/.test(backend), 'resolvers must be defined through the admin-only helper');
  assert.ok(backend.includes('const define = (key, fn) => resolver.define(key, adminOnly(fn));'));
});

test('the app is read-only: no write scope, and no write call anywhere', () => {
  const manifest = read('../manifest.yml');
  const scopes = [...manifest.matchAll(/^\s+- ((?:read|write|manage|delete|storage):[\w:-]+)/gm)].map((m) => m[1]);
  assert.ok(scopes.length >= 6);
  assert.ok(scopes.every((s) => s.startsWith('read:') || s === 'storage:app'), `unexpected scope in ${scopes}`);
  for (const file of ['../src/lib/jira.js', '../src/worker.js', '../src/index.js']) {
    assert.ok(!/method: '(DELETE|POST|PUT|PATCH)'/.test(read(file)), `${file} must stay read-only`);
  }
});

test('table cell keys are prefixed strings, so two cells in a row can never share a key', () => {
  // DynamicTable uses cell keys as React keys. Two cells keyed with the same
  // number rendered a duplicate cell and shifted the row (found in Seat Reclaim).
  const ui = read('../src/frontend/index.jsx');
  assert.ok(!/key:\s*[^,`'"\n]*\?\s*1\s*:\s*0\s*,/.test(ui), 'no bare 1/0 cell keys');
  assert.ok(!/key:\s*(r\.severity|g\.members|g\.licensedMembers|r\.counts)[^,`]*,/.test(ui), 'no bare numeric cell keys');
});

test('the page sends decisions one at a time and lets the server pick and count', () => {
  const ui = read('../src/frontend/index.jsx');
  assert.ok(ui.includes('sending.current = sending.current.then(send, send)'), 'decisions are queued');
  assert.ok(ui.includes("invoke('setDecisionsBulk', { reviewId: review.id, decision: 'keep' })"), 'bulk keep sends no account list');
  assert.ok(ui.includes('expectedUndecided: liveStats.undecided'), 'sign-off sends the count the admin saw');
  assert.ok(/onClick=\{\(\) => setConfirmOpen\(true\)\} isDisabled=\{busy \|\| loading \|\|/.test(ui), 'no sign-off while rows are loading');
  assert.ok(ui.includes("invoke('cancelScan')"), 'a running snapshot can be cancelled');
  assert.ok(ui.includes('gained a Jira product') && !ui.includes('gained a product'), 'the changes line says Jira product, as the rest of the page does');
  assert.ok(ui.includes('setStatusError(true)') && ui.includes('Could not load your reviews'), 'a failed status call is shown, not hidden');
});

test('the page shows a closed account plainly and offers no note for it', () => {
  const ui = read('../src/frontend/index.jsx');
  assert.ok(ui.includes('Atlassian account closed. Its account ID and any note were erased.'));
  assert.match(ui, /\{!isClosedAccount\(r\.accountId\) && \(\s*<Button spacing="compact" appearance="subtle" onClick=\{\(\) => openNote\(r\)\}/);
});

test('the page and the evidence frame use the same event names and the same date helpers', () => {
  const ui = read('../src/frontend/index.jsx');
  const frame = read('../src/frame/index.js');
  const evidence = read('../src/frame/evidence.js');
  assert.ok(ui.includes('events.emit(OPEN_REVIEW_EVENT'));
  assert.ok(ui.includes('events.on(FRAME_READY_EVENT'));
  assert.ok(frame.includes('events.on(OPEN_REVIEW_EVENT'));
  assert.ok(frame.includes('events.emit(FRAME_READY_EVENT'));
  assert.ok(ui.includes('utcDay(iso)') && evidence.includes('export const day = utcDay'));
});

test('the queue consumer has room for long slices', () => {
  const manifest = read('../manifest.yml');
  assert.match(manifest, /timeoutSeconds: 300/);
  const worker = read('../src/worker.js');
  assert.match(worker, /softBudgetMs: 240_000/);
});

test('the personal data report runs from an hourly trigger, with the one new scope', async () => {
  const manifest = read('../manifest.yml');
  const mod = await import('../src/privacy.js');
  assert.equal(typeof mod.scheduled, 'function');
  assert.match(manifest, /scheduledTrigger:\n(?:\s+#.*\n)*\s+- key: personal-data-report\n\s+function: personal-data\n\s+interval: hour/);
  assert.match(manifest, /- key: personal-data\n\s+handler: privacy\.scheduled\n(?:\s+#.*\n)*\s+timeoutSeconds: 60/);
  const scopes = [...manifest.split('scopes:')[1].matchAll(/^\s+- ([\w:.-]+)/gm)].map((m) => m[1]);
  assert.deepEqual(scopes, ['read:jira-user', 'read:jira-work', 'read:application-role:jira', 'read:group:jira', 'read:user:jira', 'read:avatar:jira', 'storage:app', 'report:personal-data']);
});
