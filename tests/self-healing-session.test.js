/**
 * Tests for Phase 3.8 Self-Healing session fixes:
 * - isSessionActive rejects sessions with ended_at
 * - getActiveSessions filters out ended sessions
 * - heartbeat() skips sessions with ended_at
 * - cleanupStaleSessions fixes zombie sessions (status=active + ended_at)
 */
const fs = require('fs');
const path = require('path');

// Clear require cache for fresh module state
const modulesToClear = [
  '../.claude/pilot/hooks/lib/session',
  '../.claude/pilot/hooks/lib/messaging',
  '../.claude/pilot/hooks/lib/policy'
];
modulesToClear.forEach(m => {
  try { delete require.cache[require.resolve(m)]; } catch(e) {}
});

const session = require('../.claude/pilot/hooks/lib/session');

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
  if (!condition) throw new Error(msg);
}

const cwd = process.cwd();
const stateDir = path.join(cwd, '.claude/pilot/state/sessions');

// Helper to create a test session file
function createTestSession(id, overrides = {}) {
  const data = {
    session_id: id,
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    status: 'active',
    role: null,
    agent_name: `agent-${id.slice(-4)}`,
    claimed_task: null,
    lease_expires_at: null,
    locked_areas: [],
    locked_files: [],
    cwd: cwd,
    pid: process.pid,
    parent_pid: process.ppid,
    ...overrides
  };
  const fp = path.join(stateDir, `${id}.json`);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
  return { data, fp };
}

function cleanupTestSession(id) {
  const fp = path.join(stateDir, `${id}.json`);
  try { fs.unlinkSync(fp); } catch(e) {}
}

console.log('Self-Healing Session Tests (Phase 3.8)');
console.log('='.repeat(50));

// ═══════════════════════════════════════════════════
// isSessionActive — ended_at check
// ═══════════════════════════════════════════════════
console.log('\n--- isSessionActive: ended_at guard ---');

test('isSessionActive returns false for session with ended_at', () => {
  // Access the internal function via getAllSessionStates + filter pattern
  // We test indirectly through getActiveSessions
  const testId = 'S-test-heal-001';
  createTestSession(testId, {
    ended_at: new Date().toISOString(),
    end_reason: 'stale'
  });

  const active = session.getActiveSessions('S-never-match');
  const found = active.find(s => s.session_id === testId);
  assert(!found, 'Session with ended_at should NOT appear in active sessions');

  cleanupTestSession(testId);
});

test('isSessionActive returns true for normal active session', () => {
  const testId = 'S-test-heal-002';
  createTestSession(testId);

  const active = session.getActiveSessions('S-never-match');
  const found = active.find(s => s.session_id === testId);
  assert(found, 'Normal active session should appear in active sessions');

  cleanupTestSession(testId);
});

test('zombie session (status=active + ended_at) is filtered out', () => {
  const testId = 'S-test-heal-003';
  // This is the exact bug: status is active but ended_at is set
  createTestSession(testId, {
    status: 'active',
    ended_at: '2026-02-11T03:43:06.335Z',
    end_reason: 'stale'
  });

  const active = session.getActiveSessions('S-never-match');
  const found = active.find(s => s.session_id === testId);
  assert(!found, 'Zombie session (active + ended_at) should NOT appear in active sessions');

  cleanupTestSession(testId);
});

// ═══════════════════════════════════════════════════
// getActiveSessions — ended_at early exit
// ═══════════════════════════════════════════════════
console.log('\n--- getActiveSessions: ended_at filtering ---');

test('getActiveSessions excludes all sessions with ended_at', () => {
  const ids = ['S-test-heal-010', 'S-test-heal-011', 'S-test-heal-012'];
  // Create 2 zombie sessions and 1 healthy
  createTestSession(ids[0], { ended_at: new Date().toISOString(), end_reason: 'stale' });
  createTestSession(ids[1], { ended_at: new Date().toISOString(), end_reason: 'process_dead' });
  createTestSession(ids[2]); // healthy

  const active = session.getActiveSessions('S-never-match');
  const testActive = active.filter(s => ids.includes(s.session_id));

  assert(testActive.length === 1, `Expected 1 active, got ${testActive.length}`);
  assert(testActive[0].session_id === ids[2], 'Only the healthy session should be active');

  ids.forEach(cleanupTestSession);
});

test('getActiveSessions excludes ended sessions even with fresh heartbeat', () => {
  const testId = 'S-test-heal-013';
  // Fresh heartbeat but ended_at is set — should still be excluded
  createTestSession(testId, {
    last_heartbeat: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    end_reason: 'stale'
  });

  const active = session.getActiveSessions('S-never-match');
  const found = active.find(s => s.session_id === testId);
  assert(!found, 'Ended session with fresh heartbeat should still be excluded');

  cleanupTestSession(testId);
});

// ═══════════════════════════════════════════════════
// heartbeat — skip ended sessions
// ═══════════════════════════════════════════════════
console.log('\n--- heartbeat: ended_at skip ---');

test('heartbeat does not update sessions with ended_at', () => {
  const testId = 'S-test-heal-020';
  const oldHeartbeat = '2026-01-01T00:00:00.000Z';
  createTestSession(testId, {
    last_heartbeat: oldHeartbeat,
    ended_at: '2026-02-11T03:43:06.335Z',
    end_reason: 'stale',
    parent_pid: process.ppid
  });

  // Call heartbeat — it should NOT update this ended session
  const result = session.heartbeat();

  // Read back the session
  const fp = path.join(stateDir, `${testId}.json`);
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));

  // If there's another active session for this ppid, heartbeat may have updated that one.
  // The key test is that THIS ended session's heartbeat was NOT updated.
  assert(data.last_heartbeat === oldHeartbeat,
    `Ended session heartbeat should not be updated. Was: ${data.last_heartbeat}, expected: ${oldHeartbeat}`);

  cleanupTestSession(testId);
});

// ═══════════════════════════════════════════════════
// cleanupStaleSessions — zombie fix
// ═══════════════════════════════════════════════════
console.log('\n--- cleanupStaleSessions: zombie handling ---');

test('cleanupStaleSessions fixes zombie sessions', () => {
  const testId = 'S-test-heal-030';
  createTestSession(testId, {
    status: 'active',
    ended_at: '2026-02-11T03:43:06.335Z',
    end_reason: 'stale',
    // Use a PID that doesn't exist so isSessionAlive returns false
    pid: 99999999,
    parent_pid: 99999998
  });

  session.cleanupStaleSessions();

  const fp = path.join(stateDir, `${testId}.json`);
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert(data.status === 'ended', `Zombie session should be ended, got: ${data.status}`);

  cleanupTestSession(testId);
});

test('cleanupStaleSessions does not touch healthy sessions', () => {
  const testId = 'S-test-heal-031';
  createTestSession(testId, {
    pid: process.pid,
    parent_pid: process.ppid
  });

  session.cleanupStaleSessions();

  const fp = path.join(stateDir, `${testId}.json`);
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert(data.status === 'active', `Healthy session should remain active, got: ${data.status}`);

  cleanupTestSession(testId);
});

// ═══════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════
console.log('\n--- Edge cases ---');

test('session with status=ended is excluded (existing behavior preserved)', () => {
  const testId = 'S-test-heal-040';
  createTestSession(testId, { status: 'ended' });

  const active = session.getActiveSessions('S-never-match');
  const found = active.find(s => s.session_id === testId);
  assert(!found, 'Session with status=ended should not appear in active sessions');

  cleanupTestSession(testId);
});

test('session with ended_at=null is treated as active', () => {
  const testId = 'S-test-heal-041';
  createTestSession(testId, { ended_at: null });

  const active = session.getActiveSessions('S-never-match');
  const found = active.find(s => s.session_id === testId);
  assert(found, 'Session with ended_at=null should be treated as active');

  cleanupTestSession(testId);
});

test('session with ended_at=undefined (missing field) is treated as active', () => {
  const testId = 'S-test-heal-042';
  const { fp, data } = createTestSession(testId);
  // Remove ended_at entirely
  delete data.ended_at;
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));

  const active = session.getActiveSessions('S-never-match');
  const found = active.find(s => s.session_id === testId);
  assert(found, 'Session without ended_at field should be treated as active');

  cleanupTestSession(testId);
});

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
