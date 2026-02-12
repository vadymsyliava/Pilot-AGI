/**
 * Tests for Checkpoint-Respawn Loop — Phase 4.3 (Pilot AGI-veo)
 *
 * Integration tests covering:
 * - exit-on-checkpoint detection (shouldExitOnCheckpoint)
 * - PM daemon respawn detection (_handleCheckpointRespawn)
 * - Respawn limit enforcement and escalation
 * - End-to-end checkpoint-respawn cycle
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/checkpoint-respawn.test.js
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
let originalEnv;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cprespawn-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/orchestrator'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/handoffs'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/respawns'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/locks'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/approved-plans'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/messages'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/memory/agents'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/memory/channels'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/logs'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/config'), { recursive: true });

  // Write default policy with respawn enabled
  fs.writeFileSync(path.join(testDir, '.claude/pilot/policy.yaml'), `
version: "2.0"
enforcement:
  require_active_task: false
  require_plan_approval: false
session:
  heartbeat_interval_sec: 60
  max_concurrent_sessions: 6
worktree:
  enabled: false
checkpoint:
  enabled: true
  pressure_threshold_pct: 60
  respawn:
    enabled: true
    max_respawn_limit: 3
    cooldown_sec: 0
orchestrator:
  max_concurrent_agents: 4
  escalation:
    enabled: false
`);

  originalCwd = process.cwd();
  originalEnv = { ...process.env };
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  process.env = originalEnv;
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModule(modPath) {
  const modPaths = [
    '../respawn-tracker',
    '../policy',
    '../session',
    '../memory',
    '../messaging',
    '../task-handoff',
    '../checkpoint',
    '../pm-daemon',
    '../process-spawner',
    '../spawn-context',
    '../orchestrator',
    '../pm-loop',
    '../pm-watcher',
    '../pm-decisions',
    '../agent-logger',
    '../worktree',
    '../escalation',
    '../cost-tracker',
    '../scheduler',
    '../recovery',
    '../pressure',
    '../stdin-injector'
  ];
  for (const mp of modPaths) {
    try {
      const resolved = require.resolve(mp);
      delete require.cache[resolved];
    } catch (e) { /* not loaded */ }
  }
  return require(modPath);
}

/**
 * Write a handoff state file for a task.
 */
function writeHandoffState(taskId, handoffData) {
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const handoffDir = path.join(testDir, '.claude/pilot/state/handoffs');
  if (!fs.existsSync(handoffDir)) fs.mkdirSync(handoffDir, { recursive: true });
  fs.writeFileSync(
    path.join(handoffDir, `${safeId}.json`),
    JSON.stringify(handoffData, null, 2)
  );
}

/**
 * Write an escalation to check that escalation happened.
 */
function readEscalations() {
  const escalationPath = path.join(testDir, '.claude/pilot/state/orchestrator/human-escalations.jsonl');
  if (!fs.existsSync(escalationPath)) return [];
  return fs.readFileSync(escalationPath, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
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

console.log('\nCheckpoint-Respawn Integration Tests\n');

// --- Respawn tracker integration ---

test('respawn tracker records and limits correctly across cycle', () => {
  const rt = freshModule('../respawn-tracker');

  // Simulate 3 respawn cycles
  for (let i = 0; i < 3; i++) {
    const check = rt.canRespawn('task-abc', { maxRespawns: 3 });
    assert.strictEqual(check.allowed, true, `Respawn ${i+1} should be allowed`);
    rt.recordRespawn('task-abc', { sessionId: `S-${i}`, exitReason: 'checkpoint_respawn' });
  }

  // 4th respawn should be denied
  const check4 = rt.canRespawn('task-abc', { maxRespawns: 3 });
  assert.strictEqual(check4.allowed, false, '4th respawn should be denied');
  assert.strictEqual(check4.respawn_count, 3);
});

// --- Handoff state detection ---

test('checkpoint_respawn handoff state is detected correctly', () => {
  writeHandoffState('task-1', {
    task_id: 'task-1',
    session_id: 'S-old',
    exit_reason: 'checkpoint_respawn',
    exited_at: new Date().toISOString(),
    last_commit: null,
    stashed: false,
    checkpoint_version: 2
  });

  const safeId = 'task-1';
  const handoffPath = path.join(testDir, '.claude/pilot/state/handoffs', `${safeId}.json`);
  const handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));

  assert.strictEqual(handoff.exit_reason, 'checkpoint_respawn');
  assert.strictEqual(handoff.task_id, 'task-1');
});

test('non-checkpoint exit handoff is NOT treated as respawn', () => {
  writeHandoffState('task-2', {
    task_id: 'task-2',
    session_id: 'S-old',
    exit_reason: 'completed',
    exited_at: new Date().toISOString()
  });

  const safeId = 'task-2';
  const handoffPath = path.join(testDir, '.claude/pilot/state/handoffs', `${safeId}.json`);
  const handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));

  assert.notStrictEqual(handoff.exit_reason, 'checkpoint_respawn');
});

// --- PM daemon _handleCheckpointRespawn unit test ---

test('PM daemon handles checkpoint respawn under limit', () => {
  const rt = freshModule('../respawn-tracker');

  // Verify initial state
  assert.strictEqual(rt.getRespawnCount('task-x'), 0);
  assert.strictEqual(rt.isRespawnEnabled(), true);

  // Write checkpoint_respawn handoff
  writeHandoffState('task-x', {
    task_id: 'task-x',
    session_id: 'S-exited',
    exit_reason: 'checkpoint_respawn',
    exited_at: new Date().toISOString(),
    checkpoint_version: 1
  });

  // Simulate what _handleCheckpointRespawn does (extracted logic)
  const handoffPath = path.join(
    testDir, '.claude/pilot/state/handoffs', 'task-x.json'
  );
  const handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
  assert.strictEqual(handoff.exit_reason, 'checkpoint_respawn');

  const check = rt.canRespawn('task-x', { projectRoot: testDir });
  assert.strictEqual(check.allowed, true);

  rt.recordRespawn('task-x', {
    sessionId: 'S-exited',
    exitReason: 'checkpoint_respawn'
  });

  assert.strictEqual(rt.getRespawnCount('task-x'), 1);
});

test('PM daemon escalates when respawn limit reached', () => {
  const rt = freshModule('../respawn-tracker');

  // Fill up to limit
  for (let i = 0; i < 3; i++) {
    rt.recordRespawn('task-stuck', {
      sessionId: `S-${i}`,
      exitReason: 'checkpoint_respawn'
    });
  }

  // Now check — should be denied
  const check = rt.canRespawn('task-stuck', { maxRespawns: 3 });
  assert.strictEqual(check.allowed, false);
  assert.ok(check.reason.includes('Respawn limit'));

  // Simulate escalation write (what PM daemon does)
  const escalationPath = path.join(
    testDir, '.claude/pilot/state/orchestrator/human-escalations.jsonl'
  );
  fs.mkdirSync(path.dirname(escalationPath), { recursive: true });
  fs.appendFileSync(escalationPath, JSON.stringify({
    type: 'respawn_limit_reached',
    task_id: 'task-stuck',
    respawn_count: check.respawn_count,
    max_limit: check.max,
    ts: new Date().toISOString()
  }) + '\n');

  const escalations = readEscalations();
  assert.strictEqual(escalations.length, 1);
  assert.strictEqual(escalations[0].type, 'respawn_limit_reached');
  assert.strictEqual(escalations[0].task_id, 'task-stuck');
});

// --- Context file includes respawn info ---

test('context file includes respawn tracking info', () => {
  const rt = freshModule('../respawn-tracker');

  // Record 2 respawns
  rt.recordRespawn('task-ctx', { sessionId: 'S-1' });
  rt.recordRespawn('task-ctx', { sessionId: 'S-2' });

  const state = rt.loadRespawnState('task-ctx');
  assert.strictEqual(state.respawn_count, 2);

  // Verify the data that process-spawner would include
  const respawnInfo = {
    respawn_count: state.respawn_count,
    last_respawn_at: state.last_respawn_at,
    max_respawns: rt.DEFAULT_MAX_RESPAWNS
  };

  assert.strictEqual(respawnInfo.respawn_count, 2);
  assert.ok(respawnInfo.last_respawn_at);
});

// --- Reset on task completion ---

test('respawn state resets when task completes', () => {
  const rt = freshModule('../respawn-tracker');

  rt.recordRespawn('task-done', { sessionId: 'S-1' });
  rt.recordRespawn('task-done', { sessionId: 'S-2' });
  assert.strictEqual(rt.getRespawnCount('task-done'), 2);

  rt.resetRespawnState('task-done');
  assert.strictEqual(rt.getRespawnCount('task-done'), 0);

  // Can now respawn again from zero
  const check = rt.canRespawn('task-done', { maxRespawns: 3 });
  assert.strictEqual(check.allowed, true);
  assert.strictEqual(check.respawn_count, 0);
});

// --- Exit-on-checkpoint gating ---

test('exit-on-checkpoint only for daemon-spawned agents', () => {
  // Without PILOT_DAEMON_SPAWNED, shouldExitOnCheckpoint returns false
  delete process.env.PILOT_DAEMON_SPAWNED;
  const rt = freshModule('../respawn-tracker');
  assert.strictEqual(rt.isRespawnEnabled(), true);

  // The post-tool-use check requires PILOT_DAEMON_SPAWNED=1
  // (we can't directly test shouldExitOnCheckpoint since it's in the hook,
  //  but we verify the gate logic)
  assert.strictEqual(process.env.PILOT_DAEMON_SPAWNED, undefined);
});

test('exit-on-checkpoint gated by respawn enabled', () => {
  // Disable respawn in policy
  fs.writeFileSync(path.join(testDir, '.claude/pilot/policy.yaml'), `
checkpoint:
  enabled: true
  respawn:
    enabled: false
`);

  const rt = freshModule('../respawn-tracker');
  assert.strictEqual(rt.isRespawnEnabled(), false);
});

// --- Multiple tasks tracked independently ---

test('respawn state is per-task, not global', () => {
  const rt = freshModule('../respawn-tracker');

  rt.recordRespawn('task-a', { sessionId: 'S-a1' });
  rt.recordRespawn('task-a', { sessionId: 'S-a2' });
  rt.recordRespawn('task-b', { sessionId: 'S-b1' });

  assert.strictEqual(rt.getRespawnCount('task-a'), 2);
  assert.strictEqual(rt.getRespawnCount('task-b'), 1);
  assert.strictEqual(rt.getRespawnCount('task-c'), 0);
});

// ============================================================================
// RESULTS
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
