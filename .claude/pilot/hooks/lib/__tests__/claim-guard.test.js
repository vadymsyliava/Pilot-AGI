/**
 * Tests for double-claim prevention: ownership checks, liveness fallback, release guards.
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/claim-guard.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let testDir;
const origCwd = process.cwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'claim-guard-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/locks'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/messages/cursors'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/messages/archive'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/messages/nudge'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/memory/channels'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/memory/agents'), { recursive: true });
  fs.mkdirSync(path.join(testDir, 'runs'), { recursive: true });

  // Agent registry
  fs.writeFileSync(path.join(testDir, '.claude/pilot/agent-registry.json'), JSON.stringify({
    version: '1.1', agents: {}
  }));

  // Policy
  fs.writeFileSync(path.join(testDir, '.claude/pilot/policy.yaml'), [
    'version: "1.0"',
    'session:',
    '  heartbeat_interval_sec: 60',
    '  max_agents: 6'
  ].join('\n'));

  // Memory index
  fs.writeFileSync(path.join(testDir, '.claude/pilot/memory/index.json'), JSON.stringify({
    version: 1, channels: {}
  }));

  process.cwd = () => testDir;

  // Clear require cache for session and its deps
  for (const key of Object.keys(require.cache)) {
    if (key.includes('session.js') || key.includes('policy.js') || key.includes('messaging.js') || key.includes('worktree.js')) {
      delete require.cache[key];
    }
  }
}

function teardown() {
  process.cwd = origCwd;
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshSession() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('session.js') || key.includes('policy.js') || key.includes('messaging.js') || key.includes('worktree.js')) {
      delete require.cache[key];
    }
  }
  return require('../session');
}

function writeSession(session, id, data) {
  const stateDir = path.join(testDir, '.claude/pilot/state/sessions');
  fs.writeFileSync(path.join(stateDir, `${id}.json`), JSON.stringify(data, null, 2));
}

// ──────────────────── Test Helpers ────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

// ──────────────────── Tests ────────────────────

console.log('\n=== claim-guard.test.js — Double-claim prevention ===\n');

// ── releaseTask ownership ──
console.log('releaseTask ownership check:');

setup();
(() => {
  const session = freshSession();

  const agentA = 'S-test-aaaa';
  const agentB = 'S-test-bbbb';

  writeSession(session, agentA, {
    session_id: agentA,
    status: 'active',
    claimed_task: 'TASK-1',
    claimed_at: new Date().toISOString(),
    lease_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    last_heartbeat: new Date().toISOString(),
    locked_areas: [],
    locked_files: []
  });

  writeSession(session, agentB, {
    session_id: agentB,
    status: 'active',
    claimed_task: null,
    last_heartbeat: new Date().toISOString(),
    locked_areas: [],
    locked_files: []
  });

  test('agent cannot release another agent\'s task', () => {
    const result = session.releaseTask(agentA, { callerSessionId: agentB });
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('cannot release'));
  });

  test('agent can release its own task', () => {
    const result = session.releaseTask(agentA, { callerSessionId: agentA });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.released_task, 'TASK-1');
  });
})();
teardown();

setup();
(() => {
  const session = freshSession();

  const agentA = 'S-test-aaaa';

  writeSession(session, agentA, {
    session_id: agentA,
    status: 'active',
    claimed_task: 'TASK-2',
    claimed_at: new Date().toISOString(),
    lease_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    last_heartbeat: new Date().toISOString(),
    locked_areas: [],
    locked_files: []
  });

  test('PM override allows releasing another session\'s task', () => {
    const result = session.releaseTask(agentA, { callerSessionId: 'S-pm-0000', pmOverride: true });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.released_task, 'TASK-2');
  });
})();
teardown();

setup();
(() => {
  const session = freshSession();

  const agentA = 'S-test-aaaa';

  writeSession(session, agentA, {
    session_id: agentA,
    status: 'active',
    claimed_task: 'TASK-3',
    claimed_at: new Date().toISOString(),
    lease_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    last_heartbeat: new Date().toISOString(),
    locked_areas: [],
    locked_files: []
  });

  test('legacy callers (no opts) can still release tasks', () => {
    // Simulates orchestrator/PM calling releaseTask(sessionId) without opts
    const result = session.releaseTask(agentA);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.released_task, 'TASK-3');
  });
})();
teardown();

// ── isTaskClaimed / getClaimedTaskIds with stale heartbeat but live process ──
console.log('\nisTaskClaimed liveness fallback:');

setup();
(() => {
  const session = freshSession();

  const agentA = 'S-test-aaaa';
  const staleTime = new Date(Date.now() - 200 * 1000).toISOString(); // 200s ago (stale by heartbeat)

  writeSession(session, agentA, {
    session_id: agentA,
    status: 'active',
    claimed_task: 'TASK-4',
    claimed_at: new Date().toISOString(),
    lease_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    last_heartbeat: staleTime,
    locked_areas: [],
    locked_files: [],
    // Use current process PID so isSessionAlive returns true
    pid: process.pid,
    parent_pid: process.ppid
  });

  // Write lock file with current PID so isSessionAlive finds it
  const lockDir = path.join(testDir, '.claude/pilot/state/locks');
  fs.writeFileSync(path.join(lockDir, `${agentA}.lock`), JSON.stringify({
    pid: process.pid,
    parent_pid: process.ppid
  }));

  test('isTaskClaimed sees claim with stale heartbeat but alive process', () => {
    const claim = session.isTaskClaimed('TASK-4');
    assert.ok(claim, 'Should find the claim despite stale heartbeat');
    assert.strictEqual(claim.session_id, agentA);
  });

  test('getClaimedTaskIds includes task with stale heartbeat but alive process', () => {
    const claimed = session.getClaimedTaskIds('S-other');
    assert.ok(claimed.includes('TASK-4'), 'Should include TASK-4');
  });

  test('claimTask rejects when task is claimed by alive session with stale heartbeat', () => {
    // Create another session trying to steal the task
    const agentB = 'S-test-bbbb';
    writeSession(session, agentB, {
      session_id: agentB,
      status: 'active',
      claimed_task: null,
      last_heartbeat: new Date().toISOString(),
      locked_areas: [],
      locked_files: []
    });

    const result = session.claimTask(agentB, 'TASK-4');
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('already claimed'));
  });
})();
teardown();

// ── Ended sessions are skipped ──
console.log('\nEnded session handling:');

setup();
(() => {
  const session = freshSession();

  const agentA = 'S-test-aaaa';

  writeSession(session, agentA, {
    session_id: agentA,
    status: 'active',
    claimed_task: 'TASK-5',
    claimed_at: new Date().toISOString(),
    lease_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    last_heartbeat: new Date().toISOString(),
    ended_at: new Date().toISOString(), // Session ended
    locked_areas: [],
    locked_files: []
  });

  test('isTaskClaimed returns null for ended session', () => {
    const claim = session.isTaskClaimed('TASK-5');
    assert.strictEqual(claim, null);
  });

  test('getClaimedTaskIds excludes ended sessions', () => {
    const claimed = session.getClaimedTaskIds('S-other');
    assert.ok(!claimed.includes('TASK-5'));
  });
})();
teardown();

// ── Double-claim prevention end-to-end ──
console.log('\nDouble-claim prevention (end-to-end):');

setup();
(() => {
  const session = freshSession();

  const agentA = 'S-test-aaaa';
  const agentB = 'S-test-bbbb';

  writeSession(session, agentA, {
    session_id: agentA,
    status: 'active',
    claimed_task: null,
    last_heartbeat: new Date().toISOString(),
    locked_areas: [],
    locked_files: [],
    pid: process.pid,
    parent_pid: process.ppid
  });

  writeSession(session, agentB, {
    session_id: agentB,
    status: 'active',
    claimed_task: null,
    last_heartbeat: new Date().toISOString(),
    locked_areas: [],
    locked_files: []
  });

  // Write lock file for agentA
  const lockDir = path.join(testDir, '.claude/pilot/state/locks');
  fs.writeFileSync(path.join(lockDir, `${agentA}.lock`), JSON.stringify({
    pid: process.pid,
    parent_pid: process.ppid
  }));

  test('agent A claims task successfully', () => {
    const result = session.claimTask(agentA, 'TASK-6');
    assert.strictEqual(result.success, true);
  });

  test('agent B cannot claim same task', () => {
    const result = session.claimTask(agentB, 'TASK-6');
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('already claimed'));
  });

  test('agent B cannot release agent A\'s task via release-task', () => {
    const result = session.releaseTask(agentA, { callerSessionId: agentB });
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('cannot release'));
  });

  test('task remains claimed by A after B\'s failed attempts', () => {
    const claim = session.isTaskClaimed('TASK-6');
    assert.ok(claim);
    assert.strictEqual(claim.session_id, agentA);
  });
})();
teardown();

// ── Results ──
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
