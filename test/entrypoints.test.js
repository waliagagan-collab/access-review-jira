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
