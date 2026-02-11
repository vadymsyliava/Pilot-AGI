/**
 * Respawn Tracker (Phase 4.3)
 *
 * Tracks respawn count per task for the Checkpoint-Respawn Loop.
 * Enforces max respawn limit to prevent infinite loops.
 *
 * State files: .claude/pilot/state/respawns/<taskId>.json
 *
 * Each state file tracks:
 * - respawn_count: number of times task has been respawned
 * - history: array of { at, session_id, exit_reason, pressure_pct }
 * - created_at: first spawn timestamp
 * - last_respawn_at: most recent respawn timestamp
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const RESPAWN_STATE_DIR = '.claude/pilot/state/respawns';
const DEFAULT_MAX_RESPAWNS = 10;
const DEFAULT_COOLDOWN_MS = 5000;

// ============================================================================
// PATH HELPERS
// ============================================================================

function getStateDir(projectRoot) {
  return path.join(projectRoot || process.cwd(), RESPAWN_STATE_DIR);
}

function getStatePath(taskId, projectRoot) {
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  return path.join(getStateDir(projectRoot), `${safeId}.json`);
}

function ensureStateDir(projectRoot) {
  const dir = getStateDir(projectRoot);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// STATE READ/WRITE
// ============================================================================

/**
 * Load respawn state for a task.
 *
 * @param {string} taskId
 * @param {string} [projectRoot]
 * @returns {object|null} Respawn state or null if none exists
 */
function loadRespawnState(taskId, projectRoot) {
  const statePath = getStatePath(taskId, projectRoot);
  if (!fs.existsSync(statePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Save respawn state for a task (atomic write).
 *
 * @param {string} taskId
 * @param {object} state
 * @param {string} [projectRoot]
 */
function saveRespawnState(taskId, state, projectRoot) {
  ensureStateDir(projectRoot);
  const statePath = getStatePath(taskId, projectRoot);
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}

// ============================================================================
// CORE API
// ============================================================================

/**
 * Record a respawn for a task. Increments counter and appends to history.
 *
 * @param {string} taskId
 * @param {object} info
 * @param {string} info.sessionId - Session that just exited
 * @param {string} [info.exitReason] - Why the agent exited
 * @param {number} [info.pressurePct] - Context pressure at exit time
 * @param {string} [projectRoot]
 * @returns {object} Updated respawn state
 */
function recordRespawn(taskId, info, projectRoot) {
  const existing = loadRespawnState(taskId, projectRoot);
  const now = new Date().toISOString();

  const state = existing || {
    task_id: taskId,
    respawn_count: 0,
    history: [],
    created_at: now,
    last_respawn_at: null
  };

  state.respawn_count++;
  state.last_respawn_at = now;
  state.history.push({
    at: now,
    session_id: info.sessionId || null,
    exit_reason: info.exitReason || 'checkpoint_respawn',
    pressure_pct: info.pressurePct || null
  });

  // Keep history bounded (last 20 entries)
  if (state.history.length > 20) {
    state.history = state.history.slice(-20);
  }

  saveRespawnState(taskId, state, projectRoot);
  return state;
}

/**
 * Check whether a task can be respawned (under limit and past cooldown).
 *
 * @param {string} taskId
 * @param {object} [options]
 * @param {number} [options.maxRespawns] - Override max limit
 * @param {number} [options.cooldownMs] - Override cooldown
 * @param {string} [options.projectRoot]
 * @returns {{ allowed: boolean, reason?: string, respawn_count: number, max: number }}
 */
function canRespawn(taskId, options = {}) {
  const maxRespawns = options.maxRespawns || _loadMaxRespawns(options.projectRoot);
  const cooldownMs = options.cooldownMs || _loadCooldownMs(options.projectRoot);
  const projectRoot = options.projectRoot;

  const state = loadRespawnState(taskId, projectRoot);
  const count = state ? state.respawn_count : 0;

  // Check limit
  if (count >= maxRespawns) {
    return {
      allowed: false,
      reason: `Respawn limit reached (${count}/${maxRespawns})`,
      respawn_count: count,
      max: maxRespawns
    };
  }

  // Check cooldown
  if (state && state.last_respawn_at && cooldownMs > 0) {
    const elapsed = Date.now() - new Date(state.last_respawn_at).getTime();
    if (elapsed < cooldownMs) {
      return {
        allowed: false,
        reason: `Cooldown active (${Math.ceil((cooldownMs - elapsed) / 1000)}s remaining)`,
        respawn_count: count,
        max: maxRespawns
      };
    }
  }

  return {
    allowed: true,
    respawn_count: count,
    max: maxRespawns
  };
}

/**
 * Get the respawn count for a task.
 *
 * @param {string} taskId
 * @param {string} [projectRoot]
 * @returns {number}
 */
function getRespawnCount(taskId, projectRoot) {
  const state = loadRespawnState(taskId, projectRoot);
  return state ? state.respawn_count : 0;
}

/**
 * Reset respawn state for a task (e.g., when task completes).
 *
 * @param {string} taskId
 * @param {string} [projectRoot]
 */
function resetRespawnState(taskId, projectRoot) {
  const statePath = getStatePath(taskId, projectRoot);
  try {
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  } catch (e) {
    // Best effort
  }
}

// ============================================================================
// POLICY HELPERS
// ============================================================================

/**
 * Load max respawn limit from policy.yaml.
 */
function _loadMaxRespawns(projectRoot) {
  try {
    const { loadPolicy } = require('./policy');
    const policy = loadPolicy(projectRoot);
    return policy.checkpoint?.respawn?.max_respawn_limit || DEFAULT_MAX_RESPAWNS;
  } catch (e) {
    return DEFAULT_MAX_RESPAWNS;
  }
}

/**
 * Load cooldown from policy.yaml (convert seconds to ms).
 */
function _loadCooldownMs(projectRoot) {
  try {
    const { loadPolicy } = require('./policy');
    const policy = loadPolicy(projectRoot);
    const sec = policy.checkpoint?.respawn?.cooldown_sec;
    return sec != null ? sec * 1000 : DEFAULT_COOLDOWN_MS;
  } catch (e) {
    return DEFAULT_COOLDOWN_MS;
  }
}

/**
 * Check if checkpoint-respawn is enabled in policy.
 *
 * @param {string} [projectRoot]
 * @returns {boolean}
 */
function isRespawnEnabled(projectRoot) {
  try {
    const { loadPolicy } = require('./policy');
    const policy = loadPolicy(projectRoot);
    return policy.checkpoint?.respawn?.enabled === true;
  } catch (e) {
    return false;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  recordRespawn,
  canRespawn,
  getRespawnCount,
  resetRespawnState,
  loadRespawnState,
  isRespawnEnabled,
  // Constants
  RESPAWN_STATE_DIR,
  DEFAULT_MAX_RESPAWNS,
  DEFAULT_COOLDOWN_MS,
  // Exposed for testing
  getStatePath,
  saveRespawnState
};
