/**
 * Self-Healing & Recovery Protocol (Phase 3.8)
 *
 * Centralizes all recovery logic for agent crashes, stale sessions,
 * merge conflicts, and test failures. Builds on:
 *   - Phase 3.5: checkpoint.js (state save/load)
 *   - Phase 3.7: memory.js (error/decision logging)
 *   - Phase 3.10: messaging.js (bus notifications, escalation)
 *
 * Recovery strategies:
 *   - resume:   Checkpoint exists → agent can pick up where it left off
 *   - reassign: No checkpoint but task was claimed → release for another agent
 *   - cleanup:  No task claimed → just clean up orphan resources
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const RECOVERY_LOG_DIR = '.claude/pilot/state/recovery';
const STRATEGIES = {
  RESUME: 'resume',
  REASSIGN: 'reassign',
  CLEANUP: 'cleanup'
};

// ============================================================================
// PATH HELPERS
// ============================================================================

function getRecoveryLogDir() {
  return path.join(process.cwd(), RECOVERY_LOG_DIR);
}

function getRecoveryLogPath(sessionId) {
  return path.join(getRecoveryLogDir(), `${sessionId}.jsonl`);
}

function ensureRecoveryDir() {
  const dir = getRecoveryLogDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// RECOVERY ASSESSMENT
// ============================================================================

/**
 * Assess what recovery strategy to use for a failed/stale session.
 *
 * @param {string} sessionId - The dead/stale session
 * @returns {{ strategy: string, checkpoint: object|null, loopState: object|null, session: object|null }}
 */
function assessRecovery(sessionId) {
  const checkpoint = require('./checkpoint');
  const { loadLoopState } = require('./agent-loop');

  // Load checkpoint (if any)
  let savedCheckpoint = null;
  try {
    savedCheckpoint = checkpoint.loadCheckpoint(sessionId);
  } catch (e) { /* no checkpoint */ }

  // Load agent loop state (if any)
  let loopState = null;
  try {
    loopState = loadLoopState(sessionId);
  } catch (e) { /* no loop state */ }

  // Load session state
  let sessionState = null;
  try {
    const sessionFile = path.join(
      process.cwd(),
      '.claude/pilot/state/sessions',
      `${sessionId}.json`
    );
    if (fs.existsSync(sessionFile)) {
      sessionState = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    }
  } catch (e) { /* no session */ }

  // Determine strategy
  let strategy;
  if (savedCheckpoint && savedCheckpoint.task_id) {
    strategy = STRATEGIES.RESUME;
  } else if (sessionState && sessionState.claimed_task) {
    strategy = STRATEGIES.REASSIGN;
  } else {
    strategy = STRATEGIES.CLEANUP;
  }

  return {
    strategy,
    checkpoint: savedCheckpoint,
    loopState,
    session: sessionState
  };
}

// ============================================================================
// RECOVERY ACTIONS
// ============================================================================

/**
 * Build recovery context from a checkpoint for a new agent to resume work.
 *
 * @param {string} sessionId - The dead session with the checkpoint
 * @returns {{ task_id: string, restoration: string, loopState: object|null }|null}
 */
function recoverFromCheckpoint(sessionId) {
  const checkpoint = require('./checkpoint');

  const saved = checkpoint.loadCheckpoint(sessionId);
  if (!saved || !saved.task_id) return null;

  const restoration = checkpoint.buildRestorationPrompt(saved);
  const { loadLoopState } = require('./agent-loop');
  const loopState = loadLoopState(sessionId);

  logRecoveryEvent(sessionId, 'checkpoint_recovered', {
    task_id: saved.task_id,
    plan_step: saved.plan_step,
    total_steps: saved.total_steps
  });

  return {
    task_id: saved.task_id,
    task_title: saved.task_title,
    plan_step: saved.plan_step,
    total_steps: saved.total_steps,
    restoration,
    loopState
  };
}

/**
 * Release a stale/dead agent's task and notify the bus for reassignment.
 *
 * @param {string} sessionId - The dead/stale session
 * @param {string} pmSessionId - PM session for logging
 * @returns {{ success: boolean, released_task?: string }}
 */
function releaseAndReassign(sessionId, pmSessionId) {
  const session = require('./session');
  const messaging = require('./messaging');
  const memory = require('./memory');

  // Read session state to get task info before releasing
  let taskId = null;
  let role = null;
  try {
    const sessionFile = path.join(
      process.cwd(),
      '.claude/pilot/state/sessions',
      `${sessionId}.json`
    );
    if (fs.existsSync(sessionFile)) {
      const state = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      taskId = state.claimed_task;
      role = state.role;
    }
  } catch (e) { /* best effort */ }

  if (!taskId) {
    return { success: false, error: 'No task to release' };
  }

  // Release the task
  session.releaseTask(sessionId);
  session.endSession(sessionId, 'recovered_by_pm');
  session.removeSessionLock(sessionId);

  // Notify bus so PM can reassign
  try {
    messaging.sendNotification(
      pmSessionId,
      'task.needs_reassign',
      {
        task_id: taskId,
        released_from: sessionId,
        reason: 'agent_recovery',
        original_role: role
      }
    );
  } catch (e) { /* best effort */ }

  // Record in agent memory
  if (role) {
    try {
      memory.recordError(role, {
        error_type: 'session_recovered',
        context: `Task ${taskId} released from dead session ${sessionId}`,
        resolution: 'released_for_reassignment',
        task_id: taskId
      });
    } catch (e) { /* best effort */ }
  }

  logRecoveryEvent(sessionId, 'released_and_reassigned', {
    task_id: taskId,
    pm_session: pmSessionId
  });

  return { success: true, released_task: taskId };
}

/**
 * Clean up orphan resources from a dead session.
 *
 * @param {string} sessionId - The dead session
 * @returns {{ cleaned: string[] }}
 */
function cleanupOrphanResources(sessionId) {
  const cleaned = [];

  // Remove lockfile
  const lockPath = path.join(
    process.cwd(),
    '.claude/pilot/state/locks',
    `${sessionId}.lock`
  );
  if (fs.existsSync(lockPath)) {
    try {
      fs.unlinkSync(lockPath);
      cleaned.push('lockfile');
    } catch (e) { /* best effort */ }
  }

  // Remove nudge files
  const nudgeDir = path.join(process.cwd(), '.claude/pilot/messages/nudge');
  if (fs.existsSync(nudgeDir)) {
    try {
      const nudgeFile = path.join(nudgeDir, `${sessionId}.nudge`);
      if (fs.existsSync(nudgeFile)) {
        fs.unlinkSync(nudgeFile);
        cleaned.push('nudge_file');
      }
    } catch (e) { /* best effort */ }
  }

  // Remove cursor file (archived messages already consumed)
  const cursorPath = path.join(
    process.cwd(),
    '.claude/pilot/messages/cursors',
    `${sessionId}.cursor.json`
  );
  if (fs.existsSync(cursorPath)) {
    try {
      fs.unlinkSync(cursorPath);
      cleaned.push('cursor');
    } catch (e) { /* best effort */ }
  }

  // Remove loop state
  const loopStatePath = path.join(
    process.cwd(),
    '.claude/pilot/state/agent-loops',
    `${sessionId}.loop.json`
  );
  if (fs.existsSync(loopStatePath)) {
    try {
      fs.unlinkSync(loopStatePath);
      cleaned.push('loop_state');
    } catch (e) { /* best effort */ }
  }

  // Remove pressure state
  const pressurePath = path.join(
    process.cwd(),
    '.claude/pilot/state/sessions',
    `${sessionId}.pressure.json`
  );
  if (fs.existsSync(pressurePath)) {
    try {
      fs.unlinkSync(pressurePath);
      cleaned.push('pressure_state');
    } catch (e) { /* best effort */ }
  }

  logRecoveryEvent(sessionId, 'orphan_cleanup', { cleaned });

  return { cleaned };
}

// ============================================================================
// MERGE CONFLICT HANDLING
// ============================================================================

/**
 * Attempt to resolve a merge conflict via auto-rebase.
 *
 * @param {string} sessionId - The session with the conflict
 * @param {{ worktree_path: string, branch: string }} conflictDetails
 * @returns {{ resolved: boolean, method?: string, error?: string }}
 */
function handleMergeConflict(sessionId, conflictDetails) {
  const { execFileSync } = require('child_process');
  const memory = require('./memory');
  const messaging = require('./messaging');

  const { worktree_path, branch } = conflictDetails;
  if (!worktree_path || !branch) {
    return { resolved: false, error: 'Missing worktree_path or branch' };
  }

  // Attempt auto-rebase
  try {
    execFileSync('git', ['rebase', 'main'], {
      cwd: worktree_path,
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    logRecoveryEvent(sessionId, 'merge_conflict_resolved', {
      method: 'auto_rebase',
      branch
    });

    return { resolved: true, method: 'auto_rebase' };
  } catch (rebaseErr) {
    // Abort the failed rebase
    try {
      execFileSync('git', ['rebase', '--abort'], {
        cwd: worktree_path,
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (e) { /* may not need aborting */ }

    // Get conflict details for escalation
    let conflictFiles = [];
    try {
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: worktree_path,
        encoding: 'utf8',
        timeout: 5000
      });
      conflictFiles = status.split('\n')
        .filter(l => l.startsWith('UU') || l.startsWith('AA'))
        .map(l => l.slice(3).trim());
    } catch (e) { /* best effort */ }

    // Record in agent memory
    let role = null;
    try {
      const sessionFile = path.join(
        process.cwd(),
        '.claude/pilot/state/sessions',
        `${sessionId}.json`
      );
      if (fs.existsSync(sessionFile)) {
        role = JSON.parse(fs.readFileSync(sessionFile, 'utf8')).role;
      }
    } catch (e) { /* best effort */ }

    if (role) {
      try {
        memory.recordError(role, {
          error_type: 'merge_conflict',
          context: `Rebase of ${branch} on main failed`,
          resolution: 'escalated_to_pm',
          task_id: null,
          conflict_files: conflictFiles
        });
      } catch (e) { /* best effort */ }
    }

    // Escalate to PM
    try {
      messaging.sendBlockingRequest(
        sessionId,
        'pm',
        `Merge conflict on branch ${branch} — auto-rebase failed`,
        {
          context: {
            branch,
            conflict_files: conflictFiles,
            worktree_path
          }
        }
      );
    } catch (e) { /* best effort */ }

    logRecoveryEvent(sessionId, 'merge_conflict_escalated', {
      branch,
      conflict_files: conflictFiles
    });

    return {
      resolved: false,
      error: 'Rebase failed, escalated to PM',
      conflict_files: conflictFiles
    };
  }
}

// ============================================================================
// TEST FAILURE HANDLING
// ============================================================================

/**
 * Diagnose a test failure and check for known patterns.
 *
 * @param {string} sessionId - The session with test failure
 * @param {string} testOutput - Raw test output/error
 * @returns {{ known_pattern: boolean, suggestion?: string, escalated: boolean }}
 */
function handleTestFailure(sessionId, testOutput) {
  const memory = require('./memory');
  const messaging = require('./messaging');

  // Get agent role
  let role = null;
  let taskId = null;
  try {
    const sessionFile = path.join(
      process.cwd(),
      '.claude/pilot/state/sessions',
      `${sessionId}.json`
    );
    if (fs.existsSync(sessionFile)) {
      const state = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      role = state.role;
      taskId = state.claimed_task;
    }
  } catch (e) { /* best effort */ }

  // Check agent memory for known error patterns
  let knownPattern = null;
  if (role) {
    try {
      const pastErrors = memory.getErrors(role, { error_type: 'test_failure', limit: 50 });
      for (const err of pastErrors) {
        if (err.pattern && testOutput.includes(err.pattern)) {
          knownPattern = err;
          break;
        }
      }
    } catch (e) { /* best effort */ }
  }

  // Record this failure
  if (role) {
    // Extract a short pattern from the output (first error line)
    const errorLine = extractErrorPattern(testOutput);

    try {
      memory.recordError(role, {
        error_type: 'test_failure',
        context: testOutput.slice(0, 500),
        pattern: errorLine,
        resolution: knownPattern ? 'known_pattern_matched' : 'new_failure',
        task_id: taskId
      });
    } catch (e) { /* best effort */ }
  }

  if (knownPattern && knownPattern.resolution && knownPattern.resolution !== 'new_failure') {
    logRecoveryEvent(sessionId, 'test_failure_known_pattern', {
      pattern: knownPattern.pattern,
      resolution: knownPattern.resolution
    });

    return {
      known_pattern: true,
      suggestion: knownPattern.resolution,
      escalated: false
    };
  }

  // Unknown pattern — escalate to PM
  try {
    messaging.sendBlockingRequest(
      sessionId,
      'pm',
      `Test failure on task ${taskId || 'unknown'} — no known fix`,
      {
        context: {
          test_output: testOutput.slice(0, 1000),
          task_id: taskId
        }
      }
    );
  } catch (e) { /* best effort */ }

  logRecoveryEvent(sessionId, 'test_failure_escalated', {
    task_id: taskId,
    output_preview: testOutput.slice(0, 200)
  });

  return {
    known_pattern: false,
    escalated: true
  };
}

/**
 * Extract a short error pattern from test output.
 */
function extractErrorPattern(output) {
  if (!output) return null;

  const lines = output.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Look for common error indicators
    if (
      trimmed.startsWith('Error:') ||
      trimmed.startsWith('FAIL') ||
      trimmed.includes('AssertionError') ||
      trimmed.includes('TypeError') ||
      trimmed.includes('ReferenceError') ||
      trimmed.includes('SyntaxError')
    ) {
      return trimmed.slice(0, 200);
    }
  }

  // Fallback: first non-empty line
  for (const line of lines) {
    if (line.trim()) return line.trim().slice(0, 200);
  }

  return null;
}

// ============================================================================
// RECOVERY HISTORY
// ============================================================================

/**
 * Get recovery event history for a session.
 *
 * @param {string} sessionId
 * @returns {Array<object>}
 */
function getRecoveryHistory(sessionId) {
  const logPath = getRecoveryLogPath(sessionId);
  if (!fs.existsSync(logPath)) return [];

  try {
    const content = fs.readFileSync(logPath, 'utf8').trim();
    if (!content) return [];

    return content.split('\n').map(line => {
      try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

/**
 * Log a recovery event.
 */
function logRecoveryEvent(sessionId, eventType, details = {}) {
  ensureRecoveryDir();

  const entry = {
    ts: new Date().toISOString(),
    session_id: sessionId,
    event: eventType,
    ...details
  };

  try {
    const logPath = getRecoveryLogPath(sessionId);
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch (e) { /* best effort */ }

  // Also log to session event stream
  try {
    const { logEvent } = require('./session');
    logEvent({
      type: `recovery_${eventType}`,
      session_id: sessionId,
      ...details
    });
  } catch (e) { /* best effort */ }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Assessment
  assessRecovery,
  STRATEGIES,
  // Recovery actions
  recoverFromCheckpoint,
  releaseAndReassign,
  cleanupOrphanResources,
  // Failure handling
  handleMergeConflict,
  handleTestFailure,
  extractErrorPattern,
  // History
  getRecoveryHistory,
  logRecoveryEvent,
  // Path helpers (for testing)
  getRecoveryLogDir,
  getRecoveryLogPath,
  RECOVERY_LOG_DIR
};
