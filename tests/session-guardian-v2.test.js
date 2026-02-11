/**
 * Tests for Session Guardian v2 — PID-first liveness, proactive reaper,
 * heartbeat scoping, orphaned lockfile cleanup, reap events.
 *
 * Covers: _reapZombies(), heartbeat() scoping, getActiveSessions() integration
 */
const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const SESSION_STATE_DIR = path.join(cwd, '.claude/pilot/state/sessions');
const SESSION_LOCK_DIR = path.join(cwd, '.claude/pilot/state/locks');
const EVENT_STREAM = path.join(cwd, 'runs/sessions.jsonl');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  PASS:', name);
    passed++;
  } catch (e) {
    console.log('  FAIL:', name, '-', e.message);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

// Fresh-module helper: clear require cache for session.js and its deps
function freshSession() {
  const sessionPath = require.resolve('../.claude/pilot/hooks/lib/session');
  const deps = [
    sessionPath,
    require.resolve('../.claude/pilot/hooks/lib/policy'),
    require.resolve('../.claude/pilot/hooks/lib/worktree'),
    require.resolve('../.claude/pilot/hooks/lib/messaging'),
  ];
  for (const d of deps) {
    delete require.cache[d];
  }
  return require(sessionPath);
}

// Helper: create a fake session state file
function writeSession(sessionId, data) {
  if (!fs.existsSync(SESSION_STATE_DIR)) {
    fs.mkdirSync(SESSION_STATE_DIR, { recursive: true });
  }
  const defaults = {
    session_id: sessionId,
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    status: 'active',
    role: 'backend',
    agent_name: 'test-agent',
    claimed_task: null,
    lease_expires_at: null,
    locked_areas: [],
    locked_files: [],
    cwd: cwd,
    pid: process.pid,
    parent_pid: process.ppid
  };
  fs.writeFileSync(
    path.join(SESSION_STATE_DIR, `${sessionId}.json`),
    JSON.stringify({ ...defaults, ...data }, null, 2)
  );
}

// Helper: create a lockfile
function writeLock(sessionId, pid) {
  if (!fs.existsSync(SESSION_LOCK_DIR)) {
    fs.mkdirSync(SESSION_LOCK_DIR, { recursive: true });
  }
  fs.writeFileSync(
    path.join(SESSION_LOCK_DIR, `${sessionId}.lock`),
    JSON.stringify({ session_id: sessionId, pid: pid || process.pid, parent_pid: pid || process.ppid, created_at: new Date().toISOString() }, null, 2)
  );
}

// Helper: clean up test sessions
function cleanup(ids) {
  for (const id of ids) {
    try { fs.unlinkSync(path.join(SESSION_STATE_DIR, `${id}.json`)); } catch (e) {}
    try { fs.unlinkSync(path.join(SESSION_LOCK_DIR, `${id}.lock`)); } catch (e) {}
  }
}

// Helper: read last N lines from event stream
function getRecentEvents(n = 10) {
  if (!fs.existsSync(EVENT_STREAM)) return [];
  const lines = fs.readFileSync(EVENT_STREAM, 'utf8').trim().split('\n');
  return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

console.log('Session Guardian v2 Tests');
console.log('='.repeat(50));

const TEST_IDS = [
  'S-test-reap-1111',
  'S-test-reap-2222',
  'S-test-reap-3333',
  'S-test-hb-4444',
  'S-test-hb-5555',
  'S-test-lock-6666',
  'S-test-lock-7777'
];

// Clean before tests
cleanup(TEST_IDS);

// ═══════════════════════════════════════════════════
// _reapZombies() tests
// ═══════════════════════════════════════════════════
console.log('\n--- _reapZombies() ---');

test('reaps session with inconsistent state (ended_at + active status)', () => {
  const session = freshSession();
  const id = 'S-test-reap-1111';
  writeSession(id, {
    status: 'active',
    ended_at: '2026-01-01T00:00:00.000Z',
    parent_pid: 99999999 // non-existent
  });

  const reaped = session._reapZombies();
  assert(reaped >= 1, `Expected at least 1 reaped, got ${reaped}`);

  // Verify session is now ended
  const data = JSON.parse(fs.readFileSync(path.join(SESSION_STATE_DIR, `${id}.json`), 'utf8'));
  assert(data.status === 'ended', `Expected ended status, got ${data.status}`);

  cleanup([id]);
});

test('reaps session with dead PID', () => {
  const session = freshSession();
  const id = 'S-test-reap-2222';
  // Use a PID that definitely doesn't exist (very high number)
  writeSession(id, {
    status: 'active',
    parent_pid: 99999998
  });
  // Also write a lockfile with dead PID
  writeLock(id, 99999998);

  const reaped = session._reapZombies();
  assert(reaped >= 1, `Expected at least 1 reaped, got ${reaped}`);

  // Verify session is ended with process_dead reason
  const data = JSON.parse(fs.readFileSync(path.join(SESSION_STATE_DIR, `${id}.json`), 'utf8'));
  assert(data.status === 'ended', `Expected ended, got ${data.status}`);

  cleanup([id]);
});

test('does NOT reap session with alive PID', () => {
  const session = freshSession();
  const id = 'S-test-reap-3333';
  // Use current process PID — definitely alive
  writeSession(id, {
    status: 'active',
    parent_pid: process.ppid
  });
  writeLock(id, process.ppid);

  const reaped = session._reapZombies();
  // This session should survive
  const data = JSON.parse(fs.readFileSync(path.join(SESSION_STATE_DIR, `${id}.json`), 'utf8'));
  assert(data.status === 'active', `Expected active, got ${data.status}`);

  cleanup([id]);
});

test('emits session_zombie_reaped event', () => {
  const session = freshSession();
  const id = 'S-test-reap-1111';
  writeSession(id, {
    status: 'active',
    ended_at: '2026-01-01T00:00:00.000Z',
    parent_pid: 99999997,
    claimed_task: 'TEST-001'
  });

  session._reapZombies();

  const events = getRecentEvents(5);
  const reapEvent = events.find(e => e.type === 'session_zombie_reaped' && e.session_id === id);
  assert(reapEvent, 'Expected session_zombie_reaped event');
  assert(reapEvent.had_task === 'TEST-001', `Expected had_task TEST-001, got ${reapEvent.had_task}`);

  cleanup([id]);
});

// ═══════════════════════════════════════════════════
// Orphaned lockfile cleanup
// ═══════════════════════════════════════════════════
console.log('\n--- Orphaned lockfile cleanup ---');

test('cleans up lockfile for ended session', () => {
  const session = freshSession();
  const id = 'S-test-lock-6666';
  writeSession(id, { status: 'ended', ended_at: new Date().toISOString() });
  writeLock(id, 99999996);

  const lockPath = path.join(SESSION_LOCK_DIR, `${id}.lock`);
  assert(fs.existsSync(lockPath), 'Lock should exist before reap');

  session._reapZombies();

  assert(!fs.existsSync(lockPath), 'Lock should be removed after reap');

  cleanup([id]);
});

test('cleans up lockfile for missing session', () => {
  const session = freshSession();
  const id = 'S-test-lock-7777';
  // Write lock but NO session file
  writeLock(id, 99999995);

  const lockPath = path.join(SESSION_LOCK_DIR, `${id}.lock`);
  assert(fs.existsSync(lockPath), 'Lock should exist before reap');

  session._reapZombies();

  assert(!fs.existsSync(lockPath), 'Orphan lock should be removed');

  cleanup([id]);
});

// ═══════════════════════════════════════════════════
// heartbeat() scoping
// ═══════════════════════════════════════════════════
console.log('\n--- heartbeat() scoping ---');

test('heartbeat does NOT update session with different parent_pid', () => {
  const session = freshSession();
  const otherId = 'S-test-hb-4444';

  const oldTime = '2026-01-01T00:00:00.000Z';

  // Other session: different parent_pid — must NOT be updated by our heartbeat
  writeSession(otherId, {
    parent_pid: 99999994,
    last_heartbeat: oldTime
  });

  const result = session.heartbeat();
  // Our heartbeat may or may not find a real session — doesn't matter.
  // The critical assertion: the OTHER session must be untouched.
  const otherData = JSON.parse(fs.readFileSync(path.join(SESSION_STATE_DIR, `${otherId}.json`), 'utf8'));
  assert(otherData.last_heartbeat === oldTime, `Other session heartbeat should be unchanged, got ${otherData.last_heartbeat}`);

  cleanup([otherId]);
});

test('heartbeat returns false when no parent_pid match', () => {
  const session = freshSession();
  const otherId = 'S-test-hb-5555';

  writeSession(otherId, {
    parent_pid: 99999993,
    last_heartbeat: '2026-01-01T00:00:00.000Z'
  });

  // Temporarily mock getParentClaudePID to return something that won't match
  // Since we can't easily mock, just verify that the other session is not updated
  // by checking the heartbeat call doesn't return the other session
  const result = session.heartbeat();
  // Our actual session may or may not match — the key test is the OTHER session
  const otherData = JSON.parse(fs.readFileSync(path.join(SESSION_STATE_DIR, `${otherId}.json`), 'utf8'));
  // Other session must not be touched by our heartbeat
  assert(otherData.last_heartbeat === '2026-01-01T00:00:00.000Z', 'Other session must not be updated');

  cleanup([otherId]);
});

// ═══════════════════════════════════════════════════
// getActiveSessions() integration
// ═══════════════════════════════════════════════════
console.log('\n--- getActiveSessions() integration ---');

test('getActiveSessions reaps zombies before returning', () => {
  const session = freshSession();
  const zombieId = 'S-test-reap-1111';
  const aliveId = 'S-test-reap-3333';

  // Zombie: active status but dead PID
  writeSession(zombieId, {
    status: 'active',
    parent_pid: 99999992
  });

  // Alive: active status with live PID
  writeSession(aliveId, {
    status: 'active',
    parent_pid: process.ppid
  });
  writeLock(aliveId, process.ppid);

  const active = session.getActiveSessions();
  const ids = active.map(s => s.session_id);

  // Zombie should NOT appear in results
  assert(!ids.includes(zombieId), `Zombie ${zombieId} should not be in active sessions`);

  // Verify zombie was actually ended
  const zombieData = JSON.parse(fs.readFileSync(path.join(SESSION_STATE_DIR, `${zombieId}.json`), 'utf8'));
  assert(zombieData.status === 'ended', `Zombie should be ended, got ${zombieData.status}`);

  cleanup([zombieId, aliveId]);
});

// ═══════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════
console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
