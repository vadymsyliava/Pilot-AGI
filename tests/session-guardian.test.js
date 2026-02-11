/**
 * Tests for Session Guardian — auto-claim workflow + auto-announce
 * Covers: claim-task.js CLI, release-task.js CLI, session awareness,
 * enriched session-start announcements, lockfile liveness
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const session = require('../.claude/pilot/hooks/lib/session');
const messaging = require('../.claude/pilot/hooks/lib/messaging');

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
const claimScript = path.join(cwd, '.claude/pilot/hooks/cli/claim-task.js');
const releaseScript = path.join(cwd, '.claude/pilot/hooks/cli/release-task.js');

console.log('Session Guardian Tests');
console.log('='.repeat(50));

// ═══════════════════════════════════════════════════
// claim-task.js CLI
// ═══════════════════════════════════════════════════

console.log('\n--- claim-task.js CLI ---');

test('claim-task.js syntax check passes', () => {
  execFileSync('node', ['-c', claimScript], { encoding: 'utf8' });
});

test('claim-task.js exits with error when no task ID given', () => {
  try {
    execFileSync('node', [claimScript], {
      encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe']
    });
    throw new Error('Should have exited non-zero');
  } catch (e) {
    if (e.stdout) {
      const result = JSON.parse(e.stdout.trim());
      assert(!result.success, 'Should not succeed without task ID');
      assert(result.error.includes('Usage'), 'Should show usage message');
    } else if (e.status === 1) {
      // Expected exit code
    } else {
      throw e;
    }
  }
});

test('claim-task.js claims a task and broadcasts', () => {
  const result = JSON.parse(execFileSync('node', [claimScript, 'test-guardian-1'], {
    encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe']
  }).trim());

  assert(result.success === true, 'Should succeed');
  assert(result.claim.task_id === 'test-guardian-1', 'Task ID should match');
  assert(result.session_id, 'Should include session ID');
  assert(result.claim.lease_expires_at, 'Should have lease expiry');
  assert(result.broadcast === 'sent', 'Should have broadcast');
});

test('claim-task.js re-claim by same session is idempotent', () => {
  const result = JSON.parse(execFileSync('node', [claimScript, 'test-guardian-1'], {
    encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe']
  }).trim());
  assert(result.success === true, 'Same session re-claim should succeed');
});

// ═══════════════════════════════════════════════════
// release-task.js CLI
// ═══════════════════════════════════════════════════

console.log('\n--- release-task.js CLI ---');

test('release-task.js syntax check passes', () => {
  execFileSync('node', ['-c', releaseScript], { encoding: 'utf8' });
});

test('release-task.js releases a claimed task and broadcasts', () => {
  const result = JSON.parse(execFileSync('node', [releaseScript], {
    encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe']
  }).trim());

  assert(result.success === true, 'Should succeed');
  assert(result.released_task === 'test-guardian-1', 'Should release correct task');
  assert(result.broadcast === 'sent', 'Should have broadcast');
});

test('release-task.js fails when no task claimed', () => {
  try {
    execFileSync('node', [releaseScript], {
      encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe']
    });
    throw new Error('Should have exited non-zero');
  } catch (e) {
    if (e.stdout) {
      const result = JSON.parse(e.stdout.trim());
      assert(!result.success, 'Should fail when nothing claimed');
    } else if (e.status === 1) {
      // Expected
    } else {
      throw e;
    }
  }
});

// ═══════════════════════════════════════════════════
// session.isTaskClaimed round-trip
// ═══════════════════════════════════════════════════

console.log('\n--- session claim/release round-trip ---');

test('isTaskClaimed returns null for unclaimed task', () => {
  const claimed = session.isTaskClaimed('nonexistent-task-xyz');
  assert(claimed === null, 'Should be null for unclaimed task');
});

test('claim + isTaskClaimed + release full round-trip', () => {
  const stateDir = path.join(cwd, '.claude/pilot/state/sessions');
  const files = fs.readdirSync(stateDir)
    .filter(f => f.startsWith('S-') && f.endsWith('.json') && !f.includes('.pressure'))
    .map(f => ({
      name: f,
      mtime: fs.statSync(path.join(stateDir, f)).mtime.getTime()
    }))
    .sort((a, b) => b.mtime - a.mtime);

  const content = fs.readFileSync(path.join(stateDir, files[0].name), 'utf8');
  const sess = JSON.parse(content);
  const sessionId = sess.session_id;

  // Claim
  const claimResult = session.claimTask(sessionId, 'round-trip-test');
  assert(claimResult.success, 'Claim should succeed');

  // Verify claimed
  const claimed = session.isTaskClaimed('round-trip-test');
  assert(claimed !== null, 'Should be claimed');
  assert(claimed.session_id === sessionId, 'Should be claimed by this session');

  // Release
  const releaseResult = session.releaseTask(sessionId);
  assert(releaseResult.success, 'Release should succeed');
  assert(releaseResult.released_task === 'round-trip-test', 'Released correct task');

  // Verify unclaimed
  const afterRelease = session.isTaskClaimed('round-trip-test');
  assert(afterRelease === null, 'Should be null after release');
});

// ═══════════════════════════════════════════════════
// Lockfile-based liveness
// ═══════════════════════════════════════════════════

console.log('\n--- lockfile liveness ---');

test('isSessionAlive returns false for nonexistent session', () => {
  const alive = session.isSessionAlive('S-nonexistent-0000');
  assert(alive === false, 'Nonexistent session should not be alive');
});

test('isSessionAlive detects current session as alive', () => {
  const stateDir = path.join(cwd, '.claude/pilot/state/sessions');
  const files = fs.readdirSync(stateDir)
    .filter(f => f.startsWith('S-') && f.endsWith('.json') && !f.includes('.pressure'))
    .map(f => ({
      name: f,
      mtime: fs.statSync(path.join(stateDir, f)).mtime.getTime()
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length > 0) {
    const content = fs.readFileSync(path.join(stateDir, files[0].name), 'utf8');
    const sess = JSON.parse(content);
    if (sess.status === 'active') {
      const alive = session.isSessionAlive(sess.session_id);
      assert(alive === true, `Current session ${sess.session_id} should be alive`);
    }
  }
});

// ═══════════════════════════════════════════════════
// pilot-next SKILL.md — auto-claim integration
// ═══════════════════════════════════════════════════

console.log('\n--- pilot-next auto-claim wiring ---');

test('pilot-next uses claim-task.js CLI for atomic claim', () => {
  const skillPath = path.join(cwd, '.claude/skills/pilot-next/SKILL.md');
  const content = fs.readFileSync(skillPath, 'utf8');
  assert(content.includes('claim-task.js'),
    'SKILL.md should reference claim-task.js CLI helper');
});

test('pilot-next step 5.1 does bd update + claim in one step', () => {
  const skillPath = path.join(cwd, '.claude/skills/pilot-next/SKILL.md');
  const content = fs.readFileSync(skillPath, 'utf8');
  assert(content.includes('bd update {id} --status in_progress && node .claude/pilot/hooks/cli/claim-task.js'),
    'Step 5.1 should chain bd update with claim-task.js');
});

test('pilot-next documents claim conflict handling', () => {
  const skillPath = path.join(cwd, '.claude/skills/pilot-next/SKILL.md');
  const content = fs.readFileSync(skillPath, 'utf8');
  assert(content.includes('already claimed'),
    'Should document what happens when task is already claimed');
});

test('pilot-next documents Multi-Session Coordination', () => {
  const skillPath = path.join(cwd, '.claude/skills/pilot-next/SKILL.md');
  const content = fs.readFileSync(skillPath, 'utf8');
  assert(content.includes('Multi-Session Coordination'),
    'Should have Multi-Session Coordination section');
});

// ═══════════════════════════════════════════════════
// session-start.js — enriched auto-announce
// ═══════════════════════════════════════════════════

console.log('\n--- session-start.js auto-announce ---');

test('session-start broadcasts session_announced with task context', () => {
  const hookPath = path.join(cwd, '.claude/pilot/hooks/session-start.js');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert(content.includes('session_announced'), 'Should emit session_announced');
  assert(content.includes('ready_tasks'), 'Should include ready_tasks');
  assert(content.includes('top_task'), 'Should include top_task');
  assert(content.includes('peers'), 'Should include peer count');
});

test('session-start shows "N tasks available, top: X" to new agents', () => {
  const hookPath = path.join(cwd, '.claude/pilot/hooks/session-start.js');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert(content.includes('tasks available'), 'Should show task availability');
});

test('session-start uses execFileSync for bd commands (no shell injection)', () => {
  const hookPath = path.join(cwd, '.claude/pilot/hooks/session-start.js');
  const content = fs.readFileSync(hookPath, 'utf8');
  // The announce section should use execFileSync, not execSync
  const announceStart = content.indexOf('Announce new session');
  const announceEnd = content.indexOf("don't block startup", announceStart);
  const announceSection = content.substring(announceStart, announceEnd);
  assert(announceSection.includes('execFileSync'),
    'Announce section should use execFileSync for safety');
});

test('session-start announce is best-effort (does not block startup)', () => {
  const hookPath = path.join(cwd, '.claude/pilot/hooks/session-start.js');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert(content.includes("don't block startup"),
    'Announce should not block startup on failure');
});

// ═══════════════════════════════════════════════════
// user-prompt-submit.js — session awareness
// ═══════════════════════════════════════════════════

console.log('\n--- user-prompt-submit.js awareness ---');

test('prompt-submit has buildSessionAwareness using lockfile liveness', () => {
  const hookPath = path.join(cwd, '.claude/pilot/hooks/user-prompt-submit.js');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert(content.includes('buildSessionAwareness'), 'Should have buildSessionAwareness');
  assert(content.includes('isSessionAlive'), 'Should use lockfile-based liveness');
});

test('prompt-submit injects session awareness with active task context', () => {
  const hookPath = path.join(cwd, '.claude/pilot/hooks/user-prompt-submit.js');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert(content.includes('sessionAwareness') && content.includes('activeTask'),
    'Should inject session awareness alongside active task');
});

// ═══════════════════════════════════════════════════
// session module exports
// ═══════════════════════════════════════════════════

console.log('\n--- session module exports ---');

test('session exports all Guardian functions', () => {
  assert(typeof session.createSessionLock === 'function', 'createSessionLock');
  assert(typeof session.removeSessionLock === 'function', 'removeSessionLock');
  assert(typeof session.isSessionAlive === 'function', 'isSessionAlive');
  assert(typeof session.getParentClaudePID === 'function', 'getParentClaudePID');
  assert(typeof session.claimTask === 'function', 'claimTask');
  assert(typeof session.releaseTask === 'function', 'releaseTask');
  assert(typeof session.isTaskClaimed === 'function', 'isTaskClaimed');
});

test('messaging exports broadcast functions', () => {
  assert(typeof messaging.sendBroadcast === 'function', 'sendBroadcast');
  assert(typeof messaging.sendNotification === 'function', 'sendNotification');
});

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
