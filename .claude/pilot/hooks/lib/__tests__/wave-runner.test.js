/**
 * Tests for WaveRunner — Sprint 3 T5 (M1.5)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/wave-runner.test.js
 */

'use strict';

const assert = require('assert');
const { WaveRunner } = require('../wave-runner');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push(`  ✗ ${name}\n    ${e.stack || e.message}`);
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

// Stub orchestrator that returns success for everything.
function makeStubOrch(returns = {}) {
  const calls = [];
  return {
    calls,
    sendTaskToAgent(role, task, pm, opts) {
      calls.push({ role, task, pm, opts });
      const fn = returns[task.id];
      return fn ? fn() : { success: true, assigned_to: 's-' + role, task_id: task.id };
    }
  };
}

console.log('\n=== WaveRunner Tests ===\n');

test('empty waves → isComplete immediately', () => {
  const r = new WaveRunner([], 'pm-1', { _orchestrator: makeStubOrch() });
  assert.strictEqual(r.isComplete(), true);
  assert.deepStrictEqual(r.dispatchCurrentWave(), []);
});

test('dispatchCurrentWave sends all tasks in wave 1', () => {
  const orch = makeStubOrch();
  const r = new WaveRunner([
    [{ id: 't1', role: 'frontend' }, { id: 't2', role: 'backend' }],
    [{ id: 't3', role: 'review' }]
  ], 'pm-1', { _orchestrator: orch });

  const out = r.dispatchCurrentWave();
  assert.strictEqual(orch.calls.length, 2);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(orch.calls[0].role, 'frontend');
  assert.strictEqual(orch.calls[1].role, 'backend');
});

test('blocks wave 2 until wave 1 fully completes', () => {
  const orch = makeStubOrch();
  const r = new WaveRunner([
    [{ id: 't1', role: 'frontend' }, { id: 't2', role: 'backend' }],
    [{ id: 't3', role: 'review' }]
  ], 'pm-1', { _orchestrator: orch });

  r.dispatchCurrentWave();
  assert.strictEqual(r.isInFlight(), true);

  // Calling dispatchCurrentWave again is a no-op while wave 1 is in flight.
  r.dispatchCurrentWave();
  assert.strictEqual(orch.calls.length, 2);

  // Mark only t1 complete; wave 2 still blocked.
  r.markComplete('t1');
  r.dispatchCurrentWave();
  assert.strictEqual(orch.calls.length, 2);

  // Mark t2 complete → wave advances; next dispatchCurrentWave fires t3.
  r.markComplete('t2');
  r.dispatchCurrentWave();
  assert.strictEqual(orch.calls.length, 3);
  assert.strictEqual(orch.calls[2].task.id, 't3');
});

test('all-failed wave advances rather than deadlocking', () => {
  const orch = makeStubOrch({
    t1: () => ({ success: false, error: 'no agent' }),
    t2: () => ({ success: false, error: 'no agent' })
  });
  const r = new WaveRunner([
    [{ id: 't1', role: 'frontend' }, { id: 't2', role: 'backend' }],
    [{ id: 't3', role: 'review' }]
  ], 'pm-1', { _orchestrator: orch });

  r.dispatchCurrentWave();
  // currentWaveIndex auto-advanced to 1 because nothing landed in pending.
  assert.strictEqual(r.failed.size, 2);
  assert.strictEqual(r.isInFlight(), false);
  // Wave 2 dispatchable now.
  r.dispatchCurrentWave();
  assert.strictEqual(orch.calls.length, 3);
});

test('snapshot reflects state', () => {
  const r = new WaveRunner([
    [{ id: 't1', role: 'frontend' }],
    [{ id: 't2', role: 'review' }]
  ], 'pm-1', { _orchestrator: makeStubOrch() });
  r.dispatchCurrentWave();
  r.markComplete('t1');
  const snap = r.snapshot();
  assert.strictEqual(snap.totalWaves, 2);
  assert.strictEqual(snap.currentWaveIndex, 1);
  assert.deepStrictEqual(snap.completed, ['t1']);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
