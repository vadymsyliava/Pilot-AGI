/**
 * PM Queue — Persistent action queue with retry and backoff
 *
 * Part of Pilot AGI-v1k — Autonomous PM-Executor Loop
 *
 * When the PM terminal is unavailable, actions accumulate here.
 * On recovery, the queue drains automatically.
 *
 * Integrates with:
 *   - stdin-injector.js (action queue storage)
 *   - pm-loop.js (produces queued actions)
 *   - pm-watcher.js (triggers drain attempts)
 */

const fs = require('fs');
const path = require('path');
const session = require('./session');
const injector = require('./stdin-injector');

// ============================================================================
// CONSTANTS
// ============================================================================

const PM_QUEUE_STATE_PATH = '.claude/pilot/state/orchestrator/pm-queue-state.json';
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 5000;       // 5 seconds
const MAX_BACKOFF_MS = 300000;          // 5 minutes
const BACKOFF_MULTIPLIER = 2;
const DRAIN_BATCH_SIZE = 5;

// ============================================================================
// QUEUE STATE
// ============================================================================

function loadQueueState(projectRoot) {
  const statePath = path.join(projectRoot, PM_QUEUE_STATE_PATH);
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
  } catch (e) {
    // Corrupt — start fresh
  }
  return createInitialQueueState();
}

function saveQueueState(projectRoot, state) {
  const statePath = path.join(projectRoot, PM_QUEUE_STATE_PATH);
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = statePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, statePath);
}

function createInitialQueueState() {
  return {
    pm_available: false,
    last_pm_check: null,
    last_drain_attempt: null,
    last_successful_drain: null,
    consecutive_failures: 0,
    next_retry_at: null,
    total_drained: 0,
    total_failed: 0
  };
}

// ============================================================================
// PM AVAILABILITY CHECK
// ============================================================================

/**
 * Check if the PM terminal is currently available.
 * Looks for an active session with PM role.
 */
function isPmAvailable(projectRoot) {
  try {
    const activeSessions = session.getActiveSessions();

    // Look for a session that has PM state
    const pmStatePath = path.join(projectRoot, '.claude/pilot/state/orchestrator/pm-state.json');
    if (!fs.existsSync(pmStatePath)) return false;

    const pmState = JSON.parse(fs.readFileSync(pmStatePath, 'utf8'));
    if (!pmState.pm_session_id) return false;

    // Check if PM session is still alive
    const pmSession = activeSessions.find(s => s.session_id === pmState.pm_session_id);
    return !!pmSession && pmSession.status === 'active';
  } catch (e) {
    return false;
  }
}

// ============================================================================
// DRAIN LOGIC
// ============================================================================

/**
 * Attempt to drain the queue by processing pending actions.
 * Returns results of processed actions.
 *
 * @param {string} projectRoot
 * @param {object} opts - { batchSize, dryRun }
 */
function drainQueue(projectRoot, opts = {}) {
  const batchSize = opts.batchSize || DRAIN_BATCH_SIZE;
  const state = loadQueueState(projectRoot);
  const results = [];

  // Check backoff
  if (state.next_retry_at && Date.now() < new Date(state.next_retry_at).getTime()) {
    return {
      drained: 0,
      skipped: true,
      reason: 'backoff',
      next_retry_at: state.next_retry_at
    };
  }

  state.last_drain_attempt = new Date().toISOString();

  // Check PM availability
  const pmAvailable = isPmAvailable(projectRoot);
  state.pm_available = pmAvailable;
  state.last_pm_check = new Date().toISOString();

  if (!pmAvailable) {
    // PM is offline — apply backoff
    state.consecutive_failures++;
    const backoff = Math.min(
      INITIAL_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, state.consecutive_failures - 1),
      MAX_BACKOFF_MS
    );
    state.next_retry_at = new Date(Date.now() + backoff).toISOString();
    saveQueueState(projectRoot, state);

    return {
      drained: 0,
      skipped: false,
      reason: 'pm_unavailable',
      next_retry_at: state.next_retry_at,
      consecutive_failures: state.consecutive_failures
    };
  }

  // PM is available — drain actions
  state.consecutive_failures = 0;
  state.next_retry_at = null;

  let processed = 0;
  for (let i = 0; i < batchSize; i++) {
    const action = injector.dequeueAction(projectRoot);
    if (!action) break;

    try {
      // Convert action to a prompt and enqueue it for PM processing
      const prompt = injector.actionToPrompt(action);

      if (opts.dryRun) {
        results.push({ action_id: action.id, prompt, dry_run: true });
        injector.completeAction(projectRoot, action.id, { dry_run: true });
      } else {
        // The action is already dequeued and marked as processing.
        // The PM terminal will see it via the action queue mechanism.
        // For now, just mark it complete since it's been picked up.
        injector.completeAction(projectRoot, action.id, { prompt_generated: prompt });
        results.push({ action_id: action.id, prompt, processed: true });
      }

      processed++;
    } catch (e) {
      injector.failAction(projectRoot, action.id, e.message);
      state.total_failed++;
      results.push({ action_id: action.id, error: e.message });
    }
  }

  state.total_drained += processed;
  if (processed > 0) {
    state.last_successful_drain = new Date().toISOString();
  }

  saveQueueState(projectRoot, state);

  return {
    drained: processed,
    results,
    queue_remaining: injector.getQueueStats(projectRoot)
  };
}

/**
 * Force retry — reset backoff and attempt drain immediately
 */
function forceRetry(projectRoot) {
  const state = loadQueueState(projectRoot);
  state.consecutive_failures = 0;
  state.next_retry_at = null;
  saveQueueState(projectRoot, state);

  return drainQueue(projectRoot);
}

/**
 * Get queue health summary
 */
function getQueueHealth(projectRoot) {
  const state = loadQueueState(projectRoot);
  const queueStats = injector.getQueueStats(projectRoot);

  return {
    ...state,
    queue: queueStats,
    healthy: state.pm_available && queueStats.pending === 0,
    needs_attention: queueStats.pending > 10 || state.consecutive_failures > MAX_RETRIES
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  isPmAvailable,
  drainQueue,
  forceRetry,
  getQueueHealth,
  loadQueueState,
  saveQueueState,
  MAX_RETRIES,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS
};
