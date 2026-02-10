/**
 * Context Pressure Tracker (Phase 2.2.1)
 *
 * Tracks tool call count and estimated output bytes per session.
 * Used by PostToolUse hook to detect when context window is filling up
 * and nudge the agent to save a checkpoint.
 *
 * State is stored per-session at:
 *   .claude/pilot/state/sessions/<session-id>.pressure.json
 *
 * This is intentionally lightweight — runs on every tool call.
 */

const fs = require('fs');
const path = require('path');

const STATE_DIR = '.claude/pilot/state/sessions';
const DEFAULT_THRESHOLD_PCT = 60;

// Rough estimate: Claude Code context is ~200k tokens.
// Average token ~4 chars. We track bytes as a proxy.
// 200k tokens * 4 bytes = 800KB estimated context capacity.
const ESTIMATED_CONTEXT_BYTES = 800 * 1024;

// =============================================================================
// PATH HELPERS
// =============================================================================

function getPressurePath(sessionId) {
  return path.join(process.cwd(), STATE_DIR, `${sessionId}.pressure.json`);
}

// =============================================================================
// PRESSURE STATE
// =============================================================================

/**
 * Load pressure state for a session.
 * Returns { calls: number, bytes: number, last_nudge_at: string|null }
 */
function loadPressure(sessionId) {
  if (!sessionId) return { calls: 0, bytes: 0, last_nudge_at: null };

  const pressurePath = getPressurePath(sessionId);

  if (!fs.existsSync(pressurePath)) {
    return { calls: 0, bytes: 0, last_nudge_at: null };
  }

  try {
    return JSON.parse(fs.readFileSync(pressurePath, 'utf8'));
  } catch (e) {
    return { calls: 0, bytes: 0, last_nudge_at: null };
  }
}

/**
 * Save pressure state atomically.
 */
function savePressure(sessionId, state) {
  if (!sessionId) return;

  const pressurePath = getPressurePath(sessionId);
  const dir = path.dirname(pressurePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = pressurePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, pressurePath);
}

// =============================================================================
// TRACKING
// =============================================================================

/**
 * Record a tool call. Increments counter and adds estimated bytes.
 *
 * @param {string} sessionId
 * @param {number} outputBytes - Estimated output bytes from this tool call
 * @returns {object} Updated pressure state
 */
function recordToolCall(sessionId, outputBytes = 0) {
  const state = loadPressure(sessionId);

  state.calls = (state.calls || 0) + 1;
  state.bytes = (state.bytes || 0) + outputBytes;

  savePressure(sessionId, state);
  return state;
}

/**
 * Get current pressure as a percentage estimate.
 *
 * @param {string} sessionId
 * @returns {{ calls: number, bytes: number, pct_estimate: number }}
 */
function getPressure(sessionId) {
  const state = loadPressure(sessionId);
  const pct = Math.min(100, Math.round((state.bytes / ESTIMATED_CONTEXT_BYTES) * 100));

  return {
    calls: state.calls || 0,
    bytes: state.bytes || 0,
    pct_estimate: pct
  };
}

/**
 * Check if session is approaching context limit.
 *
 * @param {string} sessionId
 * @param {number} thresholdPct - Percentage threshold (default 60)
 * @returns {boolean}
 */
function isNearLimit(sessionId, thresholdPct) {
  const threshold = thresholdPct || DEFAULT_THRESHOLD_PCT;
  const pressure = getPressure(sessionId);
  return pressure.pct_estimate >= threshold;
}

/**
 * Check if we should nudge (haven't nudged recently).
 * Prevents spamming nudges on every tool call once threshold is hit.
 * Only nudges once per threshold crossing.
 *
 * @param {string} sessionId
 * @param {number} thresholdPct
 * @returns {{ shouldNudge: boolean, pressure: object }}
 */
function checkAndNudge(sessionId, thresholdPct) {
  const threshold = thresholdPct || DEFAULT_THRESHOLD_PCT;
  const state = loadPressure(sessionId);
  const pct = Math.min(100, Math.round((state.bytes / ESTIMATED_CONTEXT_BYTES) * 100));

  const pressure = {
    calls: state.calls || 0,
    bytes: state.bytes || 0,
    pct_estimate: pct
  };

  if (pct < threshold) {
    return { shouldNudge: false, pressure };
  }

  // Already nudged at this level? Only re-nudge every 10% increase
  if (state.last_nudge_at) {
    const lastNudgePct = state.last_nudge_pct || 0;
    if (pct - lastNudgePct < 10) {
      return { shouldNudge: false, pressure };
    }
  }

  // Record that we nudged
  state.last_nudge_at = new Date().toISOString();
  state.last_nudge_pct = pct;
  savePressure(sessionId, state);

  return { shouldNudge: true, pressure };
}

/**
 * Reset pressure counters (after checkpoint save or session start).
 */
function resetPressure(sessionId) {
  if (!sessionId) return;
  savePressure(sessionId, { calls: 0, bytes: 0, last_nudge_at: null });
}

/**
 * Delete pressure state file (cleanup).
 */
function deletePressure(sessionId) {
  if (!sessionId) return;

  const pressurePath = getPressurePath(sessionId);
  try {
    if (fs.existsSync(pressurePath)) {
      fs.unlinkSync(pressurePath);
    }
  } catch (e) {
    // Best effort
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  recordToolCall,
  getPressure,
  isNearLimit,
  checkAndNudge,
  resetPressure,
  deletePressure,
  loadPressure,
  // Constants (for testing)
  ESTIMATED_CONTEXT_BYTES,
  DEFAULT_THRESHOLD_PCT,
  getPressurePath
};
