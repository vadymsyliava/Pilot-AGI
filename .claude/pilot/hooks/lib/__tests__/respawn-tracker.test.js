/**
 * Tests for Respawn Tracker — Phase 4.3 (Pilot AGI-veo)
 *
 * Tests:
 * - Record respawn increments count and appends history
 * - canRespawn checks limit enforcement
 * - canRespawn checks cooldown enforcement
 * - getRespawnCount returns correct count
 * - resetRespawnState cleans up
 * - History bounded at 20 entries
 * - Policy loading for max respawns and cooldown
 * - isRespawnEnabled reads policy
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/respawn-tracker.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// ============================================================================
// TEST INFRASTRUCTURE
// ============================================================================

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'respawn-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/respawns'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });

  // Write policy.yaml with respawn config
  fs.writeFileSync(path.join(testDir, '.claude/pilot/policy.yaml'), `
checkpoint:
  enabled: true
  pressure_threshold_pct: 60
  respawn:
    enabled: true
    max_respawn_limit: 5
    cooldown_sec: 2
`);

  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModule() {
  // Clear require cache for modules under test
  const modPaths = [
    '../respawn-tracker',
    '../policy',
    '../session',
    '../memory',
    '../messaging'
  ];
  for (const modPath of modPaths) {
    try {
      const resolved = require.resolve(modPath);
      delete require.cache[resolved];
    } catch (e) { /* not loaded */ }
  }
  return require('../respawn-tracker');
}

// ============================================================================
// TESTS
// ============================================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  setup();
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${e.message}`);
  } finally {
    teardown();
  }
}

console.log('\nRespawn Tracker Tests\n');

// --- recordRespawn ---

test('recordRespawn increments count and appends history', () => {
  const rt = freshModule();

  const state1 = rt.recordRespawn('task-1', {
    sessionId: 'S-abc',
    exitReason: 'checkpoint_respawn',
    pressurePct: 62
  });

  assert.strictEqual(state1.respawn_count, 1);
  assert.strictEqual(state1.history.length, 1);
  assert.strictEqual(state1.history[0].session_id, 'S-abc');
  assert.strictEqual(state1.history[0].exit_reason, 'checkpoint_respawn');
  assert.strictEqual(state1.history[0].pressure_pct, 62);

  const state2 = rt.recordRespawn('task-1', {
    sessionId: 'S-def',
    exitReason: 'checkpoint_respawn'
  });

  assert.strictEqual(state2.respawn_count, 2);
  assert.strictEqual(state2.history.length, 2);
});

test('recordRespawn creates state file on disk', () => {
  const rt = freshModule();

  rt.recordRespawn('Pilot AGI-abc', { sessionId: 'S-1' });

  const statePath = rt.getStatePath('Pilot AGI-abc');
  assert.ok(fs.existsSync(statePath), 'State file should exist');

  const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.strictEqual(data.task_id, 'Pilot AGI-abc');
  assert.strictEqual(data.respawn_count, 1);
});

test('recordRespawn bounds history at 20 entries', () => {
  const rt = freshModule();

  for (let i = 0; i < 25; i++) {
    rt.recordRespawn('task-1', { sessionId: `S-${i}` });
  }

  const state = rt.loadRespawnState('task-1');
  assert.strictEqual(state.respawn_count, 25);
  assert.strictEqual(state.history.length, 20, 'History should be bounded at 20');
});

// --- canRespawn ---

test('canRespawn allows when under limit', () => {
  const rt = freshModule();

  const check = rt.canRespawn('task-1', { maxRespawns: 5 });
  assert.strictEqual(check.allowed, true);
  assert.strictEqual(check.respawn_count, 0);
  assert.strictEqual(check.max, 5);
});

test('canRespawn denies when at limit', () => {
  const rt = freshModule();

  // Record 5 respawns
  for (let i = 0; i < 5; i++) {
    rt.recordRespawn('task-1', { sessionId: `S-${i}` });
  }

  const check = rt.canRespawn('task-1', { maxRespawns: 5 });
  assert.strictEqual(check.allowed, false);
  assert.ok(check.reason.includes('Respawn limit reached'));
  assert.strictEqual(check.respawn_count, 5);
});

test('canRespawn denies during cooldown', () => {
  const rt = freshModule();

  rt.recordRespawn('task-1', { sessionId: 'S-1' });

  // Check immediately (within cooldown)
  const check = rt.canRespawn('task-1', {
    maxRespawns: 10,
    cooldownMs: 60000 // 60s cooldown
  });

  assert.strictEqual(check.allowed, false);
  assert.ok(check.reason.includes('Cooldown active'));
});

test('canRespawn allows after cooldown expires', () => {
  const rt = freshModule();

  // Write state with old timestamp
  rt.saveRespawnState('task-1', {
    task_id: 'task-1',
    respawn_count: 1,
    history: [{ at: new Date(Date.now() - 10000).toISOString() }],
    created_at: new Date(Date.now() - 10000).toISOString(),
    last_respawn_at: new Date(Date.now() - 10000).toISOString() // 10s ago
  });

  const check = rt.canRespawn('task-1', {
    maxRespawns: 10,
    cooldownMs: 5000 // 5s cooldown (already past)
  });

  assert.strictEqual(check.allowed, true);
});

test('canRespawn reads limit from policy.yaml', () => {
  const rt = freshModule();

  // Record 5 respawns (policy says max 5)
  for (let i = 0; i < 5; i++) {
    rt.recordRespawn('task-1', { sessionId: `S-${i}` });
  }

  const check = rt.canRespawn('task-1'); // No override — reads policy
  assert.strictEqual(check.allowed, false);
  assert.strictEqual(check.max, 5);
});

// --- getRespawnCount ---

test('getRespawnCount returns 0 for unknown task', () => {
  const rt = freshModule();
  assert.strictEqual(rt.getRespawnCount('nonexistent'), 0);
});

test('getRespawnCount returns correct count', () => {
  const rt = freshModule();
  rt.recordRespawn('task-1', { sessionId: 'S-1' });
  rt.recordRespawn('task-1', { sessionId: 'S-2' });
  assert.strictEqual(rt.getRespawnCount('task-1'), 2);
});

// --- resetRespawnState ---

test('resetRespawnState cleans up state file', () => {
  const rt = freshModule();

  rt.recordRespawn('task-1', { sessionId: 'S-1' });
  assert.strictEqual(rt.getRespawnCount('task-1'), 1);

  rt.resetRespawnState('task-1');
  assert.strictEqual(rt.getRespawnCount('task-1'), 0);

  const statePath = rt.getStatePath('task-1');
  assert.ok(!fs.existsSync(statePath), 'State file should be deleted');
});

// --- isRespawnEnabled ---

test('isRespawnEnabled returns true when policy says enabled', () => {
  const rt = freshModule();
  assert.strictEqual(rt.isRespawnEnabled(), true);
});

test('isRespawnEnabled returns false when policy says disabled', () => {
  fs.writeFileSync(path.join(testDir, '.claude/pilot/policy.yaml'), `
checkpoint:
  enabled: true
  respawn:
    enabled: false
`);

  const rt = freshModule();
  assert.strictEqual(rt.isRespawnEnabled(), false);
});

test('isRespawnEnabled returns false when no respawn config', () => {
  fs.writeFileSync(path.join(testDir, '.claude/pilot/policy.yaml'), `
checkpoint:
  enabled: true
`);

  const rt = freshModule();
  // No respawn key → defaults to false (safe default)
  assert.strictEqual(rt.isRespawnEnabled(), false);
});

// --- loadRespawnState ---

test('loadRespawnState returns null for nonexistent task', () => {
  const rt = freshModule();
  assert.strictEqual(rt.loadRespawnState('nonexistent'), null);
});

test('loadRespawnState returns null for corrupt file', () => {
  const rt = freshModule();
  const statePath = rt.getStatePath('task-corrupt');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, 'not json');
  assert.strictEqual(rt.loadRespawnState('task-corrupt'), null);
});

// ============================================================================
// RESULTS
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
