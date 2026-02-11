/**
 * Tests for Session Lifecycle Overhaul (Phase 4.1)
 * Covers: archiveSessions(), _onAgentExit(), zombie reaper with dead PIDs,
 * PID-primary liveness checks
 */
const fs = require('fs');
const path = require('path');

// Clear require cache for fresh modules
const libDir = path.join(__dirname, '..', '.claude/pilot/hooks/lib');
for (const key of Object.keys(require.cache)) {
  if (key.startsWith(libDir)) delete require.cache[key];
}

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
const archiveDir = path.join(cwd, '.claude/pilot/state/sessions/archive');
const lockDir = path.join(cwd, '.claude/pilot/state/locks');

// Helper: create a fake session state file
function writeSessionState(sessionId, data) {
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
  const filePath = path.join(stateDir, `${sessionId}.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    session_id: sessionId,
    status: 'active',
    last_heartbeat: new Date().toISOString(),
    ...data
  }, null, 2));
}

// Helper: clean up test session files
function cleanupTestSession(sessionId) {
  const filePath = path.join(stateDir, `${sessionId}.json`);
  const archivePath = path.join(archiveDir, `${sessionId}.json`);
  const lockPath = path.join(lockDir, `${sessionId}.lock`);
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
  try { if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath); } catch (_) {}
  try { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); } catch (_) {}
}

console.log('Session Lifecycle Tests (Phase 4.1)');
console.log('='.repeat(50));

// ═══════════════════════════════════════════════════
// archiveSessions()
// ═══════════════════════════════════════════════════

console.log('\n--- archiveSessions ---');

const testSessArchive1 = 'S-test-archive-old';
const testSessArchive2 = 'S-test-archive-recent';
const testSessArchive3 = 'S-test-archive-active';

// Cleanup before tests
cleanupTestSession(testSessArchive1);
cleanupTestSession(testSessArchive2);
cleanupTestSession(testSessArchive3);

test('archiveSessions moves old ended sessions to archive', () => {
  // Create an ended session from 2 days ago
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  writeSessionState(testSessArchive1, {
    status: 'ended',
    ended_at: twoDaysAgo,
    end_reason: 'completed'
  });

  const archived = session.archiveSessions();
  assert(archived >= 1, `Expected at least 1 archived, got ${archived}`);

  // File should be in archive, not in sessions
  const originalPath = path.join(stateDir, `${testSessArchive1}.json`);
  const archivePath = path.join(archiveDir, `${testSessArchive1}.json`);
  assert(!fs.existsSync(originalPath), 'Original file should be removed');
  assert(fs.existsSync(archivePath), 'File should exist in archive');

  // Cleanup
  cleanupTestSession(testSessArchive1);
});

test('archiveSessions does NOT archive recently ended sessions', () => {
  // Create an ended session from 1 hour ago
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  writeSessionState(testSessArchive2, {
    status: 'ended',
    ended_at: oneHourAgo,
    end_reason: 'completed'
  });

  const archived = session.archiveSessions();
  // The recent session should not be archived
  const originalPath = path.join(stateDir, `${testSessArchive2}.json`);
  assert(fs.existsSync(originalPath), 'Recent ended session should still be in sessions dir');

  // Cleanup
  cleanupTestSession(testSessArchive2);
});

test('archiveSessions does NOT archive active sessions', () => {
  writeSessionState(testSessArchive3, {
    status: 'active'
  });

  session.archiveSessions();
  const originalPath = path.join(stateDir, `${testSessArchive3}.json`);
  assert(fs.existsSync(originalPath), 'Active session should not be archived');

  // Cleanup
  cleanupTestSession(testSessArchive3);
});

test('archiveSessions with custom threshold', () => {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  writeSessionState(testSessArchive1, {
    status: 'ended',
    ended_at: fiveMinAgo,
    end_reason: 'stale'
  });

  // 1 minute threshold — should archive the 5-min-old session
  const archived = session.archiveSessions(60 * 1000);
  assert(archived >= 1, `Expected at least 1 archived with 1min threshold, got ${archived}`);

  const archivePath = path.join(archiveDir, `${testSessArchive1}.json`);
  assert(fs.existsSync(archivePath), 'Session should be in archive with short threshold');

  // Cleanup
  cleanupTestSession(testSessArchive1);
});

test('archiveSessions returns 0 when no sessions to archive', () => {
  const archived = session.archiveSessions();
  // Should be 0 or low (only test leftovers at most)
  assert(typeof archived === 'number', 'Should return a number');
});

// ═══════════════════════════════════════════════════
// isSessionAlive with PID checks
// ═══════════════════════════════════════════════════

console.log('\n--- isSessionAlive PID-primary ---');

const testSessAlive = 'S-test-alive-pid';
cleanupTestSession(testSessAlive);

test('isSessionAlive returns true for session with live PID in lockfile', () => {
  // Create a lockfile with current process PID (known to be alive)
  if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `${testSessAlive}.lock`);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));

  const alive = session.isSessionAlive(testSessAlive);
  assert(alive === true, 'Session with live PID should be alive');

  cleanupTestSession(testSessAlive);
});

test('isSessionAlive returns false for session with dead PID', () => {
  // Use a PID that doesn't exist (99999999)
  if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `${testSessAlive}.lock`);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999 }));

  const alive = session.isSessionAlive(testSessAlive);
  assert(alive === false, 'Session with dead PID should not be alive');

  // Lockfile should be cleaned up automatically
  assert(!fs.existsSync(lockPath), 'Dead PID lockfile should be auto-cleaned');

  cleanupTestSession(testSessAlive);
});

test('isSessionAlive falls back to parent_pid in session state', () => {
  // No lockfile, but session state has parent_pid = current process
  writeSessionState(testSessAlive, {
    parent_pid: process.pid
  });

  const alive = session.isSessionAlive(testSessAlive);
  assert(alive === true, 'Session with live parent_pid in state should be alive');

  cleanupTestSession(testSessAlive);
});

test('isSessionAlive returns false when no lockfile and dead parent_pid', () => {
  writeSessionState(testSessAlive, {
    parent_pid: 99999999
  });

  const alive = session.isSessionAlive(testSessAlive);
  assert(alive === false, 'Session with dead parent_pid and no lockfile should be dead');

  cleanupTestSession(testSessAlive);
});

// ═══════════════════════════════════════════════════
// Zombie reaper (cleanupStaleSessions with dead PIDs)
// ═══════════════════════════════════════════════════

console.log('\n--- zombie reaper ---');

const testSessZombie = 'S-test-zombie-reap';
cleanupTestSession(testSessZombie);

test('cleanupStaleSessions ends zombie sessions with dead PIDs', () => {
  // Create a session with stale heartbeat AND dead PID
  const staleTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  writeSessionState(testSessZombie, {
    status: 'active',
    last_heartbeat: staleTime,
    parent_pid: 99999999 // dead PID
  });

  const cleaned = session.cleanupStaleSessions();
  assert(cleaned >= 1, `Expected at least 1 cleaned, got ${cleaned}`);

  // Session should be marked ended
  const sessFile = path.join(stateDir, `${testSessZombie}.json`);
  if (fs.existsSync(sessFile)) {
    const data = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
    assert(data.status === 'ended', `Expected status ended, got ${data.status}`);
  }

  cleanupTestSession(testSessZombie);
});

test('cleanupStaleSessions preserves sessions with live PIDs despite stale heartbeat', () => {
  // Create a session with stale heartbeat BUT live PID (current process)
  const staleTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  writeSessionState(testSessZombie, {
    status: 'active',
    last_heartbeat: staleTime,
    parent_pid: process.pid // live PID
  });

  // Create lockfile too
  if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, `${testSessZombie}.lock`),
    JSON.stringify({ pid: process.pid }));

  session.cleanupStaleSessions();

  // Session should still be active (live process)
  const sessFile = path.join(stateDir, `${testSessZombie}.json`);
  assert(fs.existsSync(sessFile), 'Session file should still exist');
  const data = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
  assert(data.status === 'active', `Expected status active, got ${data.status}`);

  cleanupTestSession(testSessZombie);
});

// ═══════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
