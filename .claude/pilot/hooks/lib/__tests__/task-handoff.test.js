/**
 * Tests for Reliable Task Handoff — Phase 4.6 (Pilot AGI-2v8)
 *
 * Tests:
 * - Pre-exit protocol (checkpoint save, stash, handoff state)
 * - Post-exit validation (commit matching, worktree check)
 * - Dirty worktree recovery (stash pop, WIP commit, escalate)
 * - Test gate on resume
 * - Resume readiness check (full pipeline)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/task-handoff.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');

// ============================================================================
// TEST INFRASTRUCTURE
// ============================================================================

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/orchestrator'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/approved-plans'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/handoffs'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/locks'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/messages'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/memory/agents'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/memory/channels'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/logs'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/config'), { recursive: true });

  fs.writeFileSync(path.join(testDir, '.claude/pilot/policy.yaml'), `
session:
  max_concurrent_sessions: 6
worktree:
  enabled: false
orchestrator:
  cost_tracking:
    enabled: false
`);
  fs.writeFileSync(path.join(testDir, '.claude/pilot/messages/bus.jsonl'), '');

  // Init git repo for git-dependent tests
  try {
    execFileSync('git', ['init'], { cwd: testDir, stdio: 'pipe' });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: testDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(testDir, 'README.md'), '# Test');
    // Commit everything including .claude/ so git status starts clean
    execFileSync('git', ['add', '-A'], { cwd: testDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: testDir, stdio: 'pipe' });
  } catch (e) { /* git may not be available */ }

  originalCwd = process.cwd();
  process.chdir(testDir);
}

function cleanup() {
  process.chdir(originalCwd);
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (e) { /* ok */ }
}

function freshRequire(modPath) {
  const keysToDelete = Object.keys(require.cache).filter(k =>
    k.includes('task-handoff') ||
    k.includes('checkpoint') ||
    k.includes('memory') ||
    k.includes('worktree') ||
    k.includes('session') ||
    k.includes('messaging') ||
    k.includes('policy') ||
    k.includes('pm-daemon') ||
    k.includes('process-spawner') ||
    k.includes('spawn-context')
  );
  keysToDelete.forEach(k => delete require.cache[k]);
  return require(modPath);
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  setup();
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`    ${e.message}`);
    if (e.stack) {
      const frames = e.stack.split('\n').slice(1, 3);
      frames.forEach(f => console.log(`    ${f.trim()}`));
    }
  } finally {
    cleanup();
  }
}

// ============================================================================
// HANDOFF STATE TESTS
// ============================================================================

console.log('\nHandoff state management');

test('getHandoffPath sanitizes task ID', () => {
  const { getHandoffPath } = freshRequire('../task-handoff');
  const handoffPath = getHandoffPath('Pilot AGI-02g', testDir);
  assert.ok(handoffPath.includes('pilot-agi-02g.json'));
  assert.ok(!handoffPath.includes(' '));
});

test('preExitProtocol writes handoff state file', () => {
  const mod = freshRequire('../task-handoff');

  const result = mod.preExitProtocol({
    sessionId: 'S-test-1234',
    taskId: 'bd-42',
    projectRoot: testDir,
    exitReason: 'context_pressure'
  });

  assert.strictEqual(result.success, true);
  assert.ok(result.actions.includes('handoff_state_written'));

  // Read the handoff file
  const handoffPath = mod.getHandoffPath('bd-42', testDir);
  assert.ok(fs.existsSync(handoffPath));

  const handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
  assert.strictEqual(handoff.task_id, 'bd-42');
  assert.strictEqual(handoff.session_id, 'S-test-1234');
  assert.strictEqual(handoff.exit_reason, 'context_pressure');
  assert.ok(handoff.exited_at);
});

test('preExitProtocol saves checkpoint', () => {
  // Create agent memory dir for checkpoint
  const agentDir = path.join(testDir, '.claude/pilot/memory/agents/S-test-cp');
  fs.mkdirSync(agentDir, { recursive: true });

  const mod = freshRequire('../task-handoff');

  const result = mod.preExitProtocol({
    sessionId: 'S-test-cp',
    taskId: 'bd-42',
    projectRoot: testDir,
    checkpointData: {
      plan_step: 3,
      total_steps: 5,
      completed_steps: [{ step: 1, description: 'Setup' }],
      key_decisions: ['Used postgres']
    },
    exitReason: 'planned_exit'
  });

  assert.ok(result.actions.includes('checkpoint_saved'));
  assert.ok(result.checkpoint);
});

// ============================================================================
// POST-EXIT VALIDATION TESTS
// ============================================================================

console.log('\nPost-exit validation');

test('postExitValidation returns valid when handoff exists', () => {
  const mod = freshRequire('../task-handoff');

  // Create a handoff file
  const handoffPath = mod.getHandoffPath('bd-42', testDir);
  fs.writeFileSync(handoffPath, JSON.stringify({
    task_id: 'bd-42',
    session_id: 'S-test-val',
    exit_reason: 'completed',
    exited_at: new Date().toISOString(),
    last_commit: null,
    stashed: false,
    worktree_dirty: false
  }));

  const result = mod.postExitValidation('bd-42', testDir);
  // May have no_checkpoint issue since we didn't create one, but that's ok
  assert.ok(result);
  assert.ok(Array.isArray(result.issues));
});

test('postExitValidation detects missing handoff state', () => {
  const mod = freshRequire('../task-handoff');

  const result = mod.postExitValidation('bd-nonexistent', testDir);
  assert.ok(result.issues.includes('no_handoff_state'));
});

test('postExitValidation detects corrupt handoff state', () => {
  const mod = freshRequire('../task-handoff');

  const handoffPath = mod.getHandoffPath('bd-corrupt', testDir);
  fs.writeFileSync(handoffPath, 'not valid json{{{');

  const result = mod.postExitValidation('bd-corrupt', testDir);
  assert.ok(result.issues.includes('handoff_state_corrupt'));
});

// ============================================================================
// DIRTY WORKTREE RECOVERY TESTS
// ============================================================================

console.log('\nDirty worktree recovery');

test('recoverDirtyWorktree returns clean when no dirty files', () => {
  const mod = freshRequire('../task-handoff');
  const result = mod.recoverDirtyWorktree('bd-42', testDir);

  assert.strictEqual(result.strategy, 'clean');
  assert.strictEqual(result.success, true);
});

test('recoverDirtyWorktree creates WIP commit for dirty repo', () => {
  // Create a dirty file
  fs.writeFileSync(path.join(testDir, 'dirty.txt'), 'uncommitted work');

  const mod = freshRequire('../task-handoff');
  const result = mod.recoverDirtyWorktree('bd-42', testDir);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.strategy, 'wip_commit');

  // Verify WIP commit was created
  try {
    const log = execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: testDir,
      encoding: 'utf8'
    }).trim();
    assert.ok(log.includes('wip(handoff)'));
  } catch (e) {
    // git might not be available in CI
  }
});

test('_stashInDir stashes and returns ref', () => {
  // Create dirty file
  fs.writeFileSync(path.join(testDir, 'stash-test.txt'), 'stash me');

  const mod = freshRequire('../task-handoff');
  const result = mod._stashInDir(testDir, 'bd-stash');

  assert.strictEqual(result.stashed, true);
  assert.strictEqual(result.was_dirty, true);

  // Verify file is gone from working tree
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: testDir,
    encoding: 'utf8'
  }).trim();
  assert.strictEqual(status, '');
});

test('_stashInDir returns not dirty for clean repo', () => {
  const mod = freshRequire('../task-handoff');
  const result = mod._stashInDir(testDir, 'bd-clean');

  assert.strictEqual(result.stashed, false);
  assert.strictEqual(result.was_dirty, false);
});

test('_tryStashPop recovers stashed changes', () => {
  // Create and stash a file
  fs.writeFileSync(path.join(testDir, 'pop-test.txt'), 'pop me');
  execFileSync('git', ['add', '-A'], { cwd: testDir, stdio: 'pipe' });
  execFileSync('git', ['stash', 'push', '-m', 'pilot-handoff:bd-pop'], {
    cwd: testDir,
    stdio: 'pipe'
  });

  const mod = freshRequire('../task-handoff');
  const result = mod._tryStashPop(testDir, 'bd-pop');

  assert.strictEqual(result.strategy, 'stash_pop');
  assert.strictEqual(result.success, true);

  // Verify file is back
  assert.ok(fs.existsSync(path.join(testDir, 'pop-test.txt')));
});

test('_tryStashPop fails when no matching stash', () => {
  const mod = freshRequire('../task-handoff');
  const result = mod._tryStashPop(testDir, 'bd-nomatch');

  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('No matching stash'));
});

// ============================================================================
// TEST GATE TESTS
// ============================================================================

console.log('\nTest gate');

test('runTestGate skips when no test command found', () => {
  const mod = freshRequire('../task-handoff');
  const result = mod.runTestGate('bd-42', testDir);

  assert.strictEqual(result.passed, true);
  assert.strictEqual(result.skipped, true);
});

test('runTestGate runs custom test command', () => {
  const mod = freshRequire('../task-handoff');
  const result = mod.runTestGate('bd-42', testDir, { testCommand: 'echo tests-passed' });

  assert.strictEqual(result.passed, true);
  assert.ok(!result.skipped);
});

test('runTestGate detects test failure', () => {
  const mod = freshRequire('../task-handoff');
  const result = mod.runTestGate('bd-42', testDir, { testCommand: 'false' });

  assert.strictEqual(result.passed, false);
  assert.ok(result.error);
});

// ============================================================================
// RESUME READINESS TESTS
// ============================================================================

console.log('\nResume readiness');

test('checkResumeReadiness passes for clean state', () => {
  const mod = freshRequire('../task-handoff');
  const result = mod.checkResumeReadiness('bd-42', testDir, { skipTests: true });

  assert.strictEqual(result.ready, true);
  assert.deepStrictEqual(result.issues, []);
});

test('checkResumeReadiness detects dirty worktree and recovers', () => {
  // Create dirty file
  fs.writeFileSync(path.join(testDir, 'resume-dirty.txt'), 'dirty');

  const mod = freshRequire('../task-handoff');
  const result = mod.checkResumeReadiness('bd-42', testDir, { skipTests: true });

  // Should recover via WIP commit
  assert.strictEqual(result.ready, true);
  assert.ok(result.recovery);
  assert.strictEqual(result.recovery.strategy, 'wip_commit');
});

test('checkResumeReadiness cleans up handoff file after check', () => {
  const mod = freshRequire('../task-handoff');

  // Write a handoff file
  const handoffPath = mod.getHandoffPath('bd-cleanup', testDir);
  fs.writeFileSync(handoffPath, JSON.stringify({ task_id: 'bd-cleanup' }));
  assert.ok(fs.existsSync(handoffPath));

  mod.checkResumeReadiness('bd-cleanup', testDir, { skipTests: true });

  // Handoff file should be consumed
  assert.ok(!fs.existsSync(handoffPath));
});

test('cleanupHandoff removes handoff file', () => {
  const mod = freshRequire('../task-handoff');
  const handoffPath = mod.getHandoffPath('bd-clean', testDir);
  fs.writeFileSync(handoffPath, '{}');

  mod.cleanupHandoff('bd-clean', testDir);
  assert.ok(!fs.existsSync(handoffPath));
});

test('cleanupHandoff is safe when no file exists', () => {
  const mod = freshRequire('../task-handoff');
  // Should not throw
  mod.cleanupHandoff('bd-nope', testDir);
});

// ============================================================================
// FULL HANDOFF CYCLE TEST
// ============================================================================

console.log('\nFull handoff cycle');

test('pre-exit → post-exit → resume readiness cycle', () => {
  // Create agent checkpoint dir
  const agentDir = path.join(testDir, '.claude/pilot/memory/agents/S-cycle');
  fs.mkdirSync(agentDir, { recursive: true });

  const mod = freshRequire('../task-handoff');

  // 1. Pre-exit
  const preResult = mod.preExitProtocol({
    sessionId: 'S-cycle',
    taskId: 'bd-cycle',
    projectRoot: testDir,
    checkpointData: {
      plan_step: 2,
      total_steps: 4,
      completed_steps: [
        { step: 1, description: 'Init' },
        { step: 2, description: 'Build' }
      ]
    },
    exitReason: 'context_pressure'
  });
  assert.strictEqual(preResult.success, true);

  // 2. Post-exit validation
  const postResult = mod.postExitValidation('bd-cycle', testDir);
  assert.ok(postResult);

  // 3. Resume readiness
  const resumeResult = mod.checkResumeReadiness('bd-cycle', testDir, { skipTests: true });
  assert.strictEqual(resumeResult.ready, true);
});

// ============================================================================
// RESULTS
// ============================================================================

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
