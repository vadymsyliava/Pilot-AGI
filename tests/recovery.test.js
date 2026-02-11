/**
 * Tests for Self-Healing & Recovery (Phase 3.8)
 * Covers: assessRecovery, recoverFromCheckpoint, releaseAndReassign,
 * cleanupOrphanResources, handleMergeConflict, handleTestFailure,
 * getRecoveryHistory, session.recoverSession
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Create isolated test directory
const TEST_DIR = path.join(os.tmpdir(), `recovery-test-${Date.now()}`);
const ORIGINAL_CWD = process.cwd();

function setup() {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/messages/cursors'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/messages/archive'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/messages/nudge'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/memory/channels'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/memory/agents'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/state/locks'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/state/agent-loops'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/state/orchestrator'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/state/recovery'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, 'runs/sessions.jsonl'), '');

  // Create minimal policy.yaml
  fs.writeFileSync(path.join(TEST_DIR, '.claude/pilot/policy.yaml'), `
version: "1.0"
session:
  max_concurrent_sessions: 6
  heartbeat_interval_sec: 60
orchestrator:
  auto_reassign_stale: true
`);

  // Create memory index
  fs.writeFileSync(path.join(TEST_DIR, '.claude/pilot/memory/index.json'), JSON.stringify({
    version: 1,
    channels: {}
  }));

  // Create agent registry
  fs.writeFileSync(path.join(TEST_DIR, '.claude/pilot/agent-registry.json'), JSON.stringify({
    version: '1.1',
    agents: {
      frontend: { name: 'Frontend Agent', capabilities: ['react', 'css'] },
      backend: { name: 'Backend Agent', capabilities: ['api-design', 'nodejs'] },
      pm: { name: 'PM Agent', capabilities: ['task-assignment'] }
    }
  }));

  process.chdir(TEST_DIR);
}

function teardown() {
  process.chdir(ORIGINAL_CWD);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch (e) { /* best effort */ }
}

// Clear require cache for fresh module loading
function freshModule(modPath) {
  const resolved = require.resolve(modPath);
  delete require.cache[resolved];
  return require(modPath);
}

function freshModules() {
  // Clear all project modules from cache
  const projectModules = [
    '../.claude/pilot/hooks/lib/recovery',
    '../.claude/pilot/hooks/lib/checkpoint',
    '../.claude/pilot/hooks/lib/session',
    '../.claude/pilot/hooks/lib/memory',
    '../.claude/pilot/hooks/lib/messaging',
    '../.claude/pilot/hooks/lib/agent-loop',
    '../.claude/pilot/hooks/lib/policy',
    '../.claude/pilot/hooks/lib/worktree',
    '../.claude/pilot/hooks/lib/orchestrator',
    '../.claude/pilot/hooks/lib/pm-research'
  ];
  for (const mod of projectModules) {
    try {
      const resolved = require.resolve(mod);
      delete require.cache[resolved];
    } catch (e) { /* not loaded */ }
  }
}

// ============================================================================
// TEST RUNNER
// ============================================================================

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

// ============================================================================
// HELPERS
// ============================================================================

function createSession(sessionId, data = {}) {
  const sessionFile = path.join(TEST_DIR, '.claude/pilot/state/sessions', `${sessionId}.json`);
  const state = {
    session_id: sessionId,
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    status: 'active',
    role: data.role || 'backend',
    agent_name: data.agent_name || 'backend-1',
    claimed_task: data.claimed_task || null,
    claimed_at: data.claimed_task ? new Date().toISOString() : null,
    lease_expires_at: data.claimed_task ? new Date(Date.now() + 30 * 60000).toISOString() : null,
    locked_areas: data.locked_areas || [],
    locked_files: [],
    pid: data.pid || process.pid,
    parent_pid: data.parent_pid || process.ppid,
    worktree_path: data.worktree_path || null,
    worktree_branch: data.worktree_branch || null,
    ...data
  };
  fs.writeFileSync(sessionFile, JSON.stringify(state, null, 2));
  return state;
}

function createCheckpoint(sessionId, data = {}) {
  const cpDir = path.join(TEST_DIR, '.claude/pilot/memory/agents', sessionId);
  fs.mkdirSync(cpDir, { recursive: true });
  const checkpoint = {
    version: 1,
    session_id: sessionId,
    saved_at: new Date().toISOString(),
    task_id: data.task_id || 'TEST-001',
    task_title: data.task_title || 'Test task',
    plan_step: data.plan_step || 3,
    total_steps: data.total_steps || 7,
    completed_steps: data.completed_steps || [
      { step: 1, description: 'Step 1', result: 'done' },
      { step: 2, description: 'Step 2', result: 'done' }
    ],
    key_decisions: data.key_decisions || ['Used pattern X'],
    files_modified: data.files_modified || ['src/foo.js'],
    current_context: data.current_context || 'Working on step 3',
    important_findings: data.important_findings || [],
    tool_call_count: 42,
    output_bytes: 125000
  };
  fs.writeFileSync(path.join(cpDir, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2));
  return checkpoint;
}

function createLoopState(sessionId, data = {}) {
  const dir = path.join(TEST_DIR, '.claude/pilot/state/agent-loops');
  fs.mkdirSync(dir, { recursive: true });
  const state = {
    session_id: sessionId,
    state: data.state || 'executing',
    currentTaskId: data.currentTaskId || 'TEST-001',
    currentTaskTitle: data.currentTaskTitle || 'Test task',
    planRequestId: null,
    execStep: data.execStep || 3,
    totalSteps: data.totalSteps || 7,
    consecutiveErrors: 0,
    role: 'backend',
    agentName: 'backend-1',
    updated_at: new Date().toISOString()
  };
  fs.writeFileSync(path.join(dir, `${sessionId}.loop.json`), JSON.stringify(state, null, 2));
  return state;
}

function createLockFile(sessionId) {
  const lockPath = path.join(TEST_DIR, '.claude/pilot/state/locks', `${sessionId}.lock`);
  fs.writeFileSync(lockPath, JSON.stringify({
    session_id: sessionId,
    pid: process.pid,
    parent_pid: process.ppid,
    created_at: new Date().toISOString()
  }));
}

function createNudgeFile(sessionId) {
  const nudgePath = path.join(TEST_DIR, '.claude/pilot/messages/nudge', `${sessionId}.nudge`);
  fs.writeFileSync(nudgePath, Date.now().toString());
}

// ============================================================================
// TESTS
// ============================================================================

console.log('Recovery Tests (Phase 3.8)');
console.log('='.repeat(50));

setup();

// ─── assessRecovery ─────────────────────────────────────────

console.log('\n--- assessRecovery ---');

test('assessRecovery returns cleanup for dead session without checkpoint', () => {
  freshModules();
  const recovery = freshModule('../.claude/pilot/hooks/lib/recovery');

  createSession('S-dead-nochk', { claimed_task: null });

  const result = recovery.assessRecovery('S-dead-nochk');
  assert(result.strategy === 'cleanup', `Expected cleanup, got ${result.strategy}`);
  assert(result.checkpoint === null, 'Should have no checkpoint');
});

test('assessRecovery returns resume for dead session with checkpoint', () => {
  freshModules();
  const recovery = freshModule('../.claude/pilot/hooks/lib/recovery');

  createSession('S-dead-chk', { claimed_task: 'TASK-1' });
  createCheckpoint('S-dead-chk', { task_id: 'TASK-1' });

  const result = recovery.assessRecovery('S-dead-chk');
  assert(result.strategy === 'resume', `Expected resume, got ${result.strategy}`);
  assert(result.checkpoint !== null, 'Should have checkpoint');
  assert(result.checkpoint.task_id === 'TASK-1', 'Checkpoint task_id mismatch');
});

test('assessRecovery returns reassign for stale session without checkpoint', () => {
  freshModules();
  const recovery = freshModule('../.claude/pilot/hooks/lib/recovery');

  createSession('S-stale-nochk', { claimed_task: 'TASK-2' });
  // No checkpoint

  const result = recovery.assessRecovery('S-stale-nochk');
  assert(result.strategy === 'reassign', `Expected reassign, got ${result.strategy}`);
  assert(result.session !== null, 'Should have session state');
  assert(result.session.claimed_task === 'TASK-2', 'Session task mismatch');
});

// ─── recoverFromCheckpoint ──────────────────────────────────

console.log('\n--- recoverFromCheckpoint ---');

test('recoverFromCheckpoint returns restoration context', () => {
  freshModules();
  const recovery = freshModule('../.claude/pilot/hooks/lib/recovery');

  createSession('S-recover-1', { claimed_task: 'TASK-3' });
  createCheckpoint('S-recover-1', {
    task_id: 'TASK-3',
    task_title: 'Recovery test',
    plan_step: 4,
    total_steps: 8
  });

  const result = recovery.recoverFromCheckpoint('S-recover-1');
  assert(result !== null, 'Should return recovery context');
  assert(result.task_id === 'TASK-3', 'Task ID mismatch');
  assert(result.plan_step === 4, 'Plan step mismatch');
  assert(result.total_steps === 8, 'Total steps mismatch');
  assert(typeof result.restoration === 'string', 'Should have restoration prompt');
  assert(result.restoration.includes('TASK-3'), 'Restoration should reference task');
});

test('recoverFromCheckpoint returns null when no checkpoint', () => {
  freshModules();
  const recovery = freshModule('../.claude/pilot/hooks/lib/recovery');

  const result = recovery.recoverFromCheckpoint('S-no-checkpoint');
  assert(result === null, 'Should return null');
});

// ─── releaseAndReassign ─────────────────────────────────────

console.log('\n--- releaseAndReassign ---');

test('releaseAndReassign releases task and sends bus notification', () => {
  freshModules();
  const recovery = freshModule('../.claude/pilot/hooks/lib/recovery');

  createSession('S-release-1', { claimed_task: 'TASK-4', role: 'frontend' });
  createLockFile('S-release-1');

  const result = recovery.releaseAndReassign('S-release-1', 'S-pm-1');
  assert(result.success, 'Should succeed');
  assert(result.released_task === 'TASK-4', 'Should return released task');

  // Verify session was cleaned up
  const sessionFile = path.join(TEST_DIR, '.claude/pilot/state/sessions', 'S-release-1.json');
  const state = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert(state.claimed_task === null, 'Task should be released');
});

// ─── cleanupOrphanResources ─────────────────────────────────

console.log('\n--- cleanupOrphanResources ---');

test('cleanupOrphanResources removes lockfile and nudge files', () => {
  freshModules();
  const recovery = freshModule('../.claude/pilot/hooks/lib/recovery');

  const sid = 'S-orphan-1';
  createLockFile(sid);
  createNudgeFile(sid);
  createLoopState(sid);

  // Create cursor file
  const cursorPath = path.join(TEST_DIR, '.claude/pilot/messages/cursors', `${sid}.cursor.json`);
  fs.writeFileSync(cursorPath, JSON.stringify({ session_id: sid, last_seq: 0 }));

  const result = recovery.cleanupOrphanResources(sid);
  assert(result.cleaned.includes('lockfile'), 'Should clean lockfile');
  assert(result.cleaned.includes('nudge_file'), 'Should clean nudge file');
  assert(result.cleaned.includes('cursor'), 'Should clean cursor');
  assert(result.cleaned.includes('loop_state'), 'Should clean loop state');

  // Verify files are gone
  assert(!fs.existsSync(path.join(TEST_DIR, '.claude/pilot/state/locks', `${sid}.lock`)), 'Lockfile should be removed');
  assert(!fs.existsSync(path.join(TEST_DIR, '.claude/pilot/messages/nudge', `${sid}.nudge`)), 'Nudge file should be removed');
});

// ─── handleTestFailure ──────────────────────────────────────

console.log('\n--- handleTestFailure ---');

test('handleTestFailure records error in agent memory', () => {
  freshModules();
  const recovery = freshModule('../.claude/pilot/hooks/lib/recovery');

  createSession('S-testfail-1', { claimed_task: 'TASK-5', role: 'backend' });

  const result = recovery.handleTestFailure('S-testfail-1', 'Error: Cannot find module foo');
  assert(result.known_pattern === false, 'Should not be known pattern');
  assert(result.escalated === true, 'Should escalate');

  // Verify error was recorded in agent memory
  const errorsPath = path.join(TEST_DIR, '.claude/pilot/memory/agents/backend/errors.jsonl');
  assert(fs.existsSync(errorsPath), 'Errors file should exist');
  const content = fs.readFileSync(errorsPath, 'utf8').trim();
  assert(content.includes('test_failure'), 'Should contain test_failure error type');
});

test('handleTestFailure returns known pattern match', () => {
  freshModules();
  const recovery = freshModule('../.claude/pilot/hooks/lib/recovery');

  createSession('S-testfail-2', { claimed_task: 'TASK-6', role: 'testing' });

  // Create a known error pattern in agent memory
  const errorsDir = path.join(TEST_DIR, '.claude/pilot/memory/agents/testing');
  fs.mkdirSync(errorsDir, { recursive: true });
  fs.writeFileSync(path.join(errorsDir, 'errors.jsonl'),
    JSON.stringify({
      ts: new Date().toISOString(),
      error_type: 'test_failure',
      pattern: 'ECONNREFUSED',
      resolution: 'Restart the dev server before running tests',
      task_id: 'TASK-0'
    }) + '\n'
  );

  const result = recovery.handleTestFailure('S-testfail-2', 'connect ECONNREFUSED 127.0.0.1:3000');
  assert(result.known_pattern === true, 'Should match known pattern');
  assert(result.suggestion === 'Restart the dev server before running tests', 'Should return fix suggestion');
  assert(result.escalated === false, 'Should not escalate for known pattern');
});

// ─── getRecoveryHistory ─────────────────────────────────────

console.log('\n--- getRecoveryHistory ---');

test('getRecoveryHistory returns events for session', () => {
  freshModules();
  const recovery = freshModule('../.claude/pilot/hooks/lib/recovery');

  // Create some recovery events
  recovery.logRecoveryEvent('S-history-1', 'test_event', { foo: 'bar' });
  recovery.logRecoveryEvent('S-history-1', 'another_event', { baz: 42 });

  const history = recovery.getRecoveryHistory('S-history-1');
  assert(Array.isArray(history), 'Should return array');
  assert(history.length === 2, `Expected 2 events, got ${history.length}`);
  assert(history[0].event === 'test_event', 'First event type mismatch');
  assert(history[1].event === 'another_event', 'Second event type mismatch');
});

test('getRecoveryHistory returns empty for unknown session', () => {
  freshModules();
  const recovery = freshModule('../.claude/pilot/hooks/lib/recovery');

  const history = recovery.getRecoveryHistory('S-nonexistent');
  assert(Array.isArray(history), 'Should return array');
  assert(history.length === 0, 'Should be empty');
});

// ─── session.recoverSession ─────────────────────────────────

console.log('\n--- session.recoverSession ---');

test('session.recoverSession transfers task claim between sessions', () => {
  freshModules();
  const session = freshModule('../.claude/pilot/hooks/lib/session');

  createSession('S-dead-xfer', {
    claimed_task: 'TASK-7',
    locked_areas: ['backend'],
    worktree_path: '/tmp/wt-1',
    worktree_branch: 'task/TASK-7'
  });
  createSession('S-new-xfer', { claimed_task: null });

  const result = session.recoverSession('S-dead-xfer', 'S-new-xfer');
  assert(result.success, `Recovery should succeed: ${result.error || ''}`);
  assert(result.transferred.task_id === 'TASK-7', 'Task ID should transfer');
  assert(result.transferred.locked_areas.includes('backend'), 'Area locks should transfer');
  assert(result.transferred.worktree_path === '/tmp/wt-1', 'Worktree should transfer');

  // Verify dead session is cleared
  const deadFile = path.join(TEST_DIR, '.claude/pilot/state/sessions', 'S-dead-xfer.json');
  const deadState = JSON.parse(fs.readFileSync(deadFile, 'utf8'));
  assert(deadState.claimed_task === null, 'Dead session task should be cleared');
  assert(deadState.status === 'ended', 'Dead session should be ended');

  // Verify new session has the task
  const newFile = path.join(TEST_DIR, '.claude/pilot/state/sessions', 'S-new-xfer.json');
  const newState = JSON.parse(fs.readFileSync(newFile, 'utf8'));
  assert(newState.claimed_task === 'TASK-7', 'New session should have task');
  assert(newState.locked_areas.includes('backend'), 'New session should have area lock');
});

test('session.recoverSession fails when dead session has no task', () => {
  freshModules();
  const session = freshModule('../.claude/pilot/hooks/lib/session');

  createSession('S-dead-notask', { claimed_task: null });
  createSession('S-new-notask', { claimed_task: null });

  const result = session.recoverSession('S-dead-notask', 'S-new-notask');
  assert(!result.success, 'Should fail');
  assert(result.error.includes('no claimed task'), 'Should indicate no task');
});

// ─── extractErrorPattern ────────────────────────────────────

console.log('\n--- extractErrorPattern ---');

test('extractErrorPattern extracts Error: lines', () => {
  freshModules();
  const recovery = freshModule('../.claude/pilot/hooks/lib/recovery');

  const pattern = recovery.extractErrorPattern('Some output\nError: Module not found\nMore output');
  assert(pattern === 'Error: Module not found', `Expected error line, got: ${pattern}`);
});

test('extractErrorPattern extracts TypeError lines', () => {
  freshModules();
  const recovery = freshModule('../.claude/pilot/hooks/lib/recovery');

  const pattern = recovery.extractErrorPattern('  TypeError: x is not a function');
  assert(pattern === 'TypeError: x is not a function', `Expected TypeError line, got: ${pattern}`);
});

test('extractErrorPattern returns null for empty input', () => {
  freshModules();
  const recovery = freshModule('../.claude/pilot/hooks/lib/recovery');

  const pattern = recovery.extractErrorPattern('');
  assert(pattern === null, 'Should return null for empty input');
});

// ─── handleMergeConflict ────────────────────────────────────

console.log('\n--- handleMergeConflict ---');

test('handleMergeConflict returns error for missing worktree_path', () => {
  freshModules();
  const recovery = freshModule('../.claude/pilot/hooks/lib/recovery');

  const result = recovery.handleMergeConflict('S-merge-1', {});
  assert(!result.resolved, 'Should not resolve');
  assert(result.error.includes('Missing'), 'Should indicate missing params');
});

// ============================================================================
// CLEANUP
// ============================================================================

teardown();

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
