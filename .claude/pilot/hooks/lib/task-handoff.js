/**
 * Reliable Task Handoff (Phase 4.6)
 *
 * Ensures no work is lost when agents exit (planned or crash).
 *
 * Pre-exit protocol:
 *   - Save checkpoint with current state
 *   - Stash uncommitted work (via git stash in worktree)
 *   - Update bd status appropriately
 *
 * Post-exit validation:
 *   - Verify last commit matches expected plan step
 *   - Detect dirty worktrees
 *   - Validate task state consistency
 *
 * Dirty worktree recovery:
 *   - Detect uncommitted changes
 *   - Attempt stash pop if stash exists
 *   - Fall back to commit WIP or escalate
 *
 * Test gate on resume:
 *   - Run task-relevant tests before continuing work
 *   - Block if tests fail (agent must fix before proceeding)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ============================================================================
// CONSTANTS
// ============================================================================

const HANDOFF_STATE_DIR = '.claude/pilot/state/handoffs';
const STASH_MESSAGE_PREFIX = 'pilot-handoff:';
const WIP_COMMIT_PREFIX = 'wip(handoff):';

const HANDOFF_STRATEGIES = {
  STASH_POP: 'stash_pop',
  WIP_COMMIT: 'wip_commit',
  CLEAN: 'clean',
  ESCALATE: 'escalate'
};

// Lazy dependencies
let _checkpoint = null;
let _worktree = null;

function getCheckpoint() {
  if (!_checkpoint) _checkpoint = require('./checkpoint');
  return _checkpoint;
}

function getWorktree() {
  if (!_worktree) _worktree = require('./worktree');
  return _worktree;
}

// ============================================================================
// PATH HELPERS
// ============================================================================

function getHandoffDir(projectRoot) {
  return path.join(projectRoot || process.cwd(), HANDOFF_STATE_DIR);
}

function getHandoffPath(taskId, projectRoot) {
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  return path.join(getHandoffDir(projectRoot), `${safeId}.json`);
}

function ensureHandoffDir(projectRoot) {
  const dir = getHandoffDir(projectRoot);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// PRE-EXIT PROTOCOL
// ============================================================================

/**
 * Execute pre-exit protocol to save all state before agent exits.
 *
 * @param {object} params
 * @param {string} params.sessionId - Current session ID
 * @param {string} params.taskId - Task being worked on
 * @param {string} params.projectRoot - Project root path
 * @param {object} [params.checkpointData] - Additional checkpoint data
 * @param {string} [params.exitReason] - Why the agent is exiting
 * @returns {{ success: boolean, checkpoint?: object, stashed?: boolean, handoff?: object }}
 */
function preExitProtocol(params) {
  const { sessionId, taskId, projectRoot, checkpointData, exitReason } = params;
  const root = projectRoot || process.cwd();
  const result = { success: true, actions: [] };

  // 1. Save checkpoint
  try {
    const cp = getCheckpoint();
    const cpResult = cp.saveCheckpoint(sessionId, {
      ...checkpointData,
      task_id: taskId,
      current_context: `Pre-exit handoff. Reason: ${exitReason || 'unknown'}`
    });
    if (cpResult.success) {
      result.checkpoint = cpResult;
      result.actions.push('checkpoint_saved');
    }
  } catch (e) {
    result.actions.push(`checkpoint_failed:${e.message}`);
  }

  // 2. Check for dirty worktree and stash if needed
  const stashResult = _stashWorktreeChanges(taskId, root);
  result.stashed = stashResult.stashed;
  if (stashResult.stashed) {
    result.actions.push('changes_stashed');
  }

  // 3. Get last commit info for validation
  const lastCommit = _getLastCommitInfo(taskId, root);

  // 4. Write handoff state file
  const handoff = {
    task_id: taskId,
    session_id: sessionId,
    exit_reason: exitReason || 'unknown',
    exited_at: new Date().toISOString(),
    last_commit: lastCommit,
    stashed: stashResult.stashed,
    stash_ref: stashResult.stash_ref || null,
    checkpoint_version: result.checkpoint?.version || null,
    worktree_dirty: stashResult.was_dirty
  };

  try {
    ensureHandoffDir(root);
    const handoffPath = getHandoffPath(taskId, root);
    const tmp = handoffPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(handoff, null, 2));
    fs.renameSync(tmp, handoffPath);
    result.handoff = handoff;
    result.actions.push('handoff_state_written');
  } catch (e) {
    result.actions.push(`handoff_write_failed:${e.message}`);
  }

  return result;
}

/**
 * Stash uncommitted changes in a worktree.
 *
 * @param {string} taskId
 * @param {string} projectRoot
 * @returns {{ stashed: boolean, was_dirty: boolean, stash_ref?: string }}
 */
function _stashWorktreeChanges(taskId, projectRoot) {
  const wt = getWorktree();
  const config = wt.getConfig();

  if (!config.enabled) {
    // No worktree — check main repo
    return _stashInDir(projectRoot, taskId);
  }

  const status = wt.getWorktreeStatus(taskId);
  if (!status.exists) {
    return { stashed: false, was_dirty: false };
  }

  if (!status.dirty) {
    return { stashed: false, was_dirty: false };
  }

  return _stashInDir(status.path, taskId);
}

/**
 * Stash changes in a directory.
 *
 * @param {string} dir
 * @param {string} taskId
 * @returns {{ stashed: boolean, was_dirty: boolean, stash_ref?: string }}
 */
function _stashInDir(dir, taskId) {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 5000
    }).trim();

    if (!status) {
      return { stashed: false, was_dirty: false };
    }

    // Stage all changes and stash
    execFileSync('git', ['add', '-A'], {
      cwd: dir,
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    execFileSync('git', ['stash', 'push', '-m', `${STASH_MESSAGE_PREFIX}${taskId}`], {
      cwd: dir,
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Get stash ref
    let stashRef = null;
    try {
      stashRef = execFileSync('git', ['stash', 'list', '--format=%H', '-1'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 5000
      }).trim();
    } catch (e) { /* best effort */ }

    return { stashed: true, was_dirty: true, stash_ref: stashRef };
  } catch (e) {
    return { stashed: false, was_dirty: true, error: e.message };
  }
}

// ============================================================================
// POST-EXIT VALIDATION
// ============================================================================

/**
 * Validate the state of a task after an agent exited.
 * Called by PM daemon when it detects an agent has exited.
 *
 * @param {string} taskId
 * @param {string} projectRoot
 * @returns {{ valid: boolean, issues: string[], handoff?: object, lastCommit?: object }}
 */
function postExitValidation(taskId, projectRoot) {
  const root = projectRoot || process.cwd();
  const issues = [];

  // 1. Load handoff state
  const handoffPath = getHandoffPath(taskId, root);
  let handoff = null;
  if (fs.existsSync(handoffPath)) {
    try {
      handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
    } catch (e) {
      issues.push('handoff_state_corrupt');
    }
  } else {
    issues.push('no_handoff_state');
  }

  // 2. Check last commit matches expected state
  const lastCommit = _getLastCommitInfo(taskId, root);

  if (handoff && handoff.last_commit && lastCommit) {
    if (handoff.last_commit.hash !== lastCommit.hash) {
      // Commit changed after handoff — unexpected
      issues.push('commit_mismatch');
    }
  }

  // 3. Check worktree status
  const wt = getWorktree();
  const config = wt.getConfig();
  if (config.enabled) {
    const wtStatus = wt.getWorktreeStatus(taskId);
    if (wtStatus.exists && wtStatus.dirty) {
      if (!handoff || !handoff.stashed) {
        issues.push('dirty_worktree_not_stashed');
      }
    }
  }

  // 4. Check checkpoint exists
  if (handoff && handoff.session_id) {
    const cp = getCheckpoint();
    const checkpoint = cp.loadCheckpoint(handoff.session_id);
    if (!checkpoint) {
      issues.push('no_checkpoint');
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    handoff,
    lastCommit
  };
}

/**
 * Get the last commit info for a task's worktree (or main repo).
 *
 * @param {string} taskId
 * @param {string} projectRoot
 * @returns {{ hash: string, message: string, timestamp: string }|null}
 */
function _getLastCommitInfo(taskId, projectRoot) {
  const wt = getWorktree();
  const config = wt.getConfig();

  let dir = projectRoot;
  if (config.enabled) {
    const status = wt.getWorktreeStatus(taskId);
    if (status.exists && status.path) {
      dir = status.path;
    }
  }

  try {
    const log = execFileSync('git', ['log', '-1', '--format=%H|%s|%aI'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 5000
    }).trim();

    if (!log) return null;
    const [hash, message, timestamp] = log.split('|');
    return { hash, message, timestamp };
  } catch (e) {
    return null;
  }
}

// ============================================================================
// DIRTY WORKTREE RECOVERY
// ============================================================================

/**
 * Recover a dirty worktree for task resumption.
 *
 * Strategies (tried in order):
 * 1. stash_pop — if handoff stashed changes, pop them
 * 2. wip_commit — commit uncommitted changes as WIP
 * 3. clean — no dirty files, proceed normally
 * 4. escalate — cannot recover, needs human intervention
 *
 * @param {string} taskId
 * @param {string} projectRoot
 * @returns {{ strategy: string, success: boolean, error?: string }}
 */
function recoverDirtyWorktree(taskId, projectRoot) {
  const root = projectRoot || process.cwd();

  // Load handoff state
  const handoffPath = getHandoffPath(taskId, root);
  let handoff = null;
  if (fs.existsSync(handoffPath)) {
    try {
      handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
    } catch (e) { /* corrupt */ }
  }

  // Get worktree dir
  const wt = getWorktree();
  const config = wt.getConfig();
  let dir = root;
  if (config.enabled) {
    const status = wt.getWorktreeStatus(taskId);
    if (status.exists && status.path) {
      dir = status.path;
    }
  }

  // Check if worktree is clean
  let isDirty = false;
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 5000
    }).trim();
    isDirty = status.length > 0;
  } catch (e) {
    return { strategy: HANDOFF_STRATEGIES.ESCALATE, success: false, error: e.message };
  }

  if (!isDirty) {
    // Check if we need to pop a stash
    if (handoff && handoff.stashed) {
      return _tryStashPop(dir, taskId);
    }
    return { strategy: HANDOFF_STRATEGIES.CLEAN, success: true };
  }

  // Worktree is dirty — try strategies
  // Strategy 1: Pop stash if handoff had one
  if (handoff && handoff.stashed) {
    const popResult = _tryStashPop(dir, taskId);
    if (popResult.success) return popResult;
  }

  // Strategy 2: Create WIP commit
  const wipResult = _createWipCommit(dir, taskId);
  if (wipResult.success) return wipResult;

  // Strategy 3: Escalate
  return {
    strategy: HANDOFF_STRATEGIES.ESCALATE,
    success: false,
    error: 'Could not recover dirty worktree'
  };
}

/**
 * Try to pop a stash for a task.
 */
function _tryStashPop(dir, taskId) {
  try {
    // Find the matching stash
    const stashList = execFileSync('git', ['stash', 'list'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 5000
    }).trim();

    const stashLines = stashList.split('\n').filter(Boolean);
    let stashIndex = -1;
    for (let i = 0; i < stashLines.length; i++) {
      if (stashLines[i].includes(`${STASH_MESSAGE_PREFIX}${taskId}`)) {
        stashIndex = i;
        break;
      }
    }

    if (stashIndex < 0) {
      return {
        strategy: HANDOFF_STRATEGIES.STASH_POP,
        success: false,
        error: 'No matching stash found'
      };
    }

    execFileSync('git', ['stash', 'pop', `stash@{${stashIndex}}`], {
      cwd: dir,
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return { strategy: HANDOFF_STRATEGIES.STASH_POP, success: true };
  } catch (e) {
    // Stash pop failed (likely conflicts) — abort and try next strategy
    try {
      execFileSync('git', ['checkout', '--', '.'], {
        cwd: dir,
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (e2) { /* best effort cleanup */ }

    return {
      strategy: HANDOFF_STRATEGIES.STASH_POP,
      success: false,
      error: `Stash pop failed: ${e.message}`
    };
  }
}

/**
 * Create a WIP commit to save dirty state.
 */
function _createWipCommit(dir, taskId) {
  try {
    execFileSync('git', ['add', '-A'], {
      cwd: dir,
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    execFileSync('git', ['commit', '-m', `${WIP_COMMIT_PREFIX} ${taskId} — uncommitted changes from previous session`], {
      cwd: dir,
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return { strategy: HANDOFF_STRATEGIES.WIP_COMMIT, success: true };
  } catch (e) {
    return {
      strategy: HANDOFF_STRATEGIES.WIP_COMMIT,
      success: false,
      error: `WIP commit failed: ${e.message}`
    };
  }
}

// ============================================================================
// TEST GATE ON RESUME
// ============================================================================

/**
 * Run tests before allowing an agent to resume work.
 *
 * @param {string} taskId
 * @param {string} projectRoot
 * @param {object} [options]
 * @param {string} [options.testCommand] - Custom test command (default: npm test)
 * @param {number} [options.timeout] - Test timeout in ms (default: 120000)
 * @returns {{ passed: boolean, output?: string, error?: string, skipped?: boolean }}
 */
function runTestGate(taskId, projectRoot, options = {}) {
  const root = projectRoot || process.cwd();
  const testCommand = options.testCommand || null;
  const timeout = options.timeout || 120000;

  // Determine test directory (worktree or project root)
  const wt = getWorktree();
  const config = wt.getConfig();
  let testDir = root;
  if (config.enabled) {
    const status = wt.getWorktreeStatus(taskId);
    if (status.exists && status.path) {
      testDir = status.path;
    }
  }

  // Find test command
  let cmd = testCommand;
  if (!cmd) {
    // Check package.json for test script
    const pkgPath = path.join(testDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.scripts && pkg.scripts.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
          cmd = 'npm test';
        }
      } catch (e) { /* no package.json */ }
    }
  }

  if (!cmd) {
    // No test command available — skip gate
    return { passed: true, skipped: true };
  }

  try {
    const [binary, ...args] = cmd.split(' ');
    const output = execFileSync(binary, args, {
      cwd: testDir,
      encoding: 'utf8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1' }
    });

    return { passed: true, output: output.slice(-2000) };
  } catch (e) {
    return {
      passed: false,
      error: e.message,
      output: (e.stdout || '').slice(-2000) + '\n' + (e.stderr || '').slice(-1000)
    };
  }
}

// ============================================================================
// RESUME READINESS CHECK
// ============================================================================

/**
 * Full resume readiness check — validates handoff state, recovers worktree,
 * runs test gate. Used by PM daemon before respawning an agent.
 *
 * @param {string} taskId
 * @param {string} projectRoot
 * @param {object} [options]
 * @param {boolean} [options.skipTests] - Skip test gate
 * @returns {{ ready: boolean, issues: string[], recovery?: object, testResult?: object }}
 */
function checkResumeReadiness(taskId, projectRoot, options = {}) {
  const root = projectRoot || process.cwd();
  const issues = [];

  // 1. Post-exit validation
  const validation = postExitValidation(taskId, root);
  if (!validation.valid) {
    // Non-blocking issues — log but continue
    for (const issue of validation.issues) {
      if (issue === 'no_handoff_state' || issue === 'no_checkpoint') {
        // These mean fresh start, not handoff failure
        continue;
      }
      issues.push(issue);
    }
  }

  // 2. Recover dirty worktree
  const recovery = recoverDirtyWorktree(taskId, root);
  if (!recovery.success && recovery.strategy === HANDOFF_STRATEGIES.ESCALATE) {
    issues.push(`worktree_recovery_failed:${recovery.error}`);
  }

  // 3. Test gate (optional)
  let testResult = null;
  if (!options.skipTests) {
    testResult = runTestGate(taskId, root);
    if (!testResult.passed && !testResult.skipped) {
      issues.push('test_gate_failed');
    }
  }

  // 4. Clean up handoff state file (consumed)
  const handoffPath = getHandoffPath(taskId, root);
  if (fs.existsSync(handoffPath)) {
    try {
      fs.unlinkSync(handoffPath);
    } catch (e) { /* best effort */ }
  }

  return {
    ready: issues.length === 0,
    issues,
    recovery,
    testResult
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  preExitProtocol,
  postExitValidation,
  recoverDirtyWorktree,
  runTestGate,
  checkResumeReadiness,
  cleanupHandoff: function(taskId, projectRoot) {
    const handoffPath = getHandoffPath(taskId, projectRoot);
    try {
      if (fs.existsSync(handoffPath)) fs.unlinkSync(handoffPath);
    } catch (e) { /* best effort */ }
  },
  // Constants
  HANDOFF_STATE_DIR,
  HANDOFF_STRATEGIES,
  STASH_MESSAGE_PREFIX,
  WIP_COMMIT_PREFIX,
  // Exposed for testing
  _stashWorktreeChanges,
  _stashInDir,
  _getLastCommitInfo,
  _tryStashPop,
  _createWipCommit,
  getHandoffPath
};
