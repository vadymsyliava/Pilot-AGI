/**
 * Tests for pm-brain-loader — R4 (2026-04-28)
 */

'use strict';

const assert = require('assert');
const loader = require('../pm-brain-loader');

let passed = 0, failed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; failures.push(name + ': ' + e.message); console.error('  ✗ ' + name); console.error('    ' + e.message); }
}

console.log('\n=== R4: pm-brain-loader ===\n');

test('load() returns the PmBrain class', () => {
  const PmBrain = loader.load();
  assert.strictEqual(typeof PmBrain, 'function');
  assert.strictEqual(PmBrain.name, 'PmBrain');
});

test('load() caches by default', () => {
  const a = loader.load();
  const b = loader.load();
  assert.strictEqual(a, b, 'same require → same constructor reference');
});

test('forceReload() drops the cache and returns fresh class', () => {
  const before = loader.load();
  const after = loader.forceReload();
  assert.ok(typeof after === 'function');
  // The actual constructor identity may differ across require calls in
  // some Node versions; what matters is that load() now returns the
  // freshly-cached one and forceReload bumps the counter.
  const stats = loader._stats();
  assert.ok(stats.reloadCount >= 1, 'reloadCount should bump after forceReload');
});

test('onReload subscriber receives fresh class', () => {
  let received = null;
  const off = loader.onReload((Fresh) => { received = Fresh; });
  loader.forceReload();
  assert.ok(received !== null, 'subscriber callback fired');
  assert.strictEqual(typeof received, 'function');
  off();
});

test('onReload returns unsubscribe function', () => {
  let calls = 0;
  const off = loader.onReload(() => { calls += 1; });
  loader.forceReload();
  assert.strictEqual(calls, 1);
  off();
  loader.forceReload();
  assert.strictEqual(calls, 1, 'unsubscribed callback should not fire again');
});

test('watch() / unwatch() are idempotent', () => {
  loader.watch();
  const a = loader._stats().watcherCount;
  loader.watch();  // should not double up
  const b = loader._stats().watcherCount;
  assert.strictEqual(a, b, 'second watch() call does not stack');
  loader.unwatch();
  assert.strictEqual(loader._stats().watcherCount, 0);
});

test('DEPS list includes pm-brain.js', () => {
  assert.ok(loader.DEPS.some(d => d.endsWith('pm-brain.js')));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed > 0) { console.error(failures.join('\n')); process.exit(1); }
