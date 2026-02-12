/**
 * Auto-Escalation Engine (Phase 3.12)
 *
 * Configurable progressive escalation for drift, test failures, budget
 * overruns, merge conflicts, and agent unresponsiveness.
 *
 * Escalation levels (progressive):
 *   1. warning    — notify agent, log event
 *   2. block      — pause agent edits, notify PM
 *   3. reassign   — release task, reassign to another agent
 *   4. human      — queue for human review
 *
 * Policy-driven: all thresholds and paths read from policy.yaml
 * under `orchestrator.escalation`.
 *
 * State files:
 *   .claude/pilot/state/escalations/<eventKey>.json  — per-event escalation state
 *   .claude/pilot/state/escalations/log.jsonl        — append-only audit log
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const ESCALATION_STATE_DIR = '.claude/pilot/state/escalations';
const ESCALATION_LOG_FILE = 'log.jsonl';

const LEVELS = {
  WARNING: 'warning',
  BLOCK: 'block',
  REASSIGN: 'reassign',
  HUMAN: 'human'
};

const LEVEL_ORDER = [LEVELS.WARNING, LEVELS.BLOCK, LEVELS.REASSIGN, LEVELS.HUMAN];

const EVENT_TYPES = {
  DRIFT: 'drift',
  TEST_FAILURE: 'test_failure',
  BUDGET_EXCEEDED: 'budget_exceeded',
  MERGE_CONFLICT: 'merge_conflict',
  AGENT_UNRESPONSIVE: 'agent_unresponsive'
};

// Default escalation paths (overridden by policy.yaml)
const DEFAULT_PATHS = {
  [EVENT_TYPES.DRIFT]: {
    levels: ['warning', 'block', 'reassign', 'human'],
    cooldown_sec: 120,
    auto_deescalate: true
  },
  [EVENT_TYPES.TEST_FAILURE]: {
    levels: ['warning', 'reassign', 'human'],
    cooldown_sec: 60,
    auto_deescalate: true
  },
  [EVENT_TYPES.BUDGET_EXCEEDED]: {
    levels: ['warning', 'block', 'human'],
    cooldown_sec: 300,
    auto_deescalate: false
  },
  [EVENT_TYPES.MERGE_CONFLICT]: {
    levels: ['warning', 'block', 'reassign', 'human'],
    cooldown_sec: 60,
    auto_deescalate: true
  },
  [EVENT_TYPES.AGENT_UNRESPONSIVE]: {
    levels: ['warning', 'reassign', 'human'],
    cooldown_sec: 30,
    auto_deescalate: false
  }
};

// ============================================================================
// PATH HELPERS
// ============================================================================

function getEscalationDir() {
  return path.join(process.cwd(), ESCALATION_STATE_DIR);
}

function getEscalationStatePath(eventKey) {
  const safe = eventKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getEscalationDir(), `${safe}.json`);
}

function getEscalationLogPath() {
  return path.join(getEscalationDir(), ESCALATION_LOG_FILE);
}

function ensureEscalationDir() {
  const dir = getEscalationDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// JSON FILE OPS
// ============================================================================

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) { /* corrupted — start fresh */ }
  return null;
}

function writeJSON(filePath, data) {
  ensureEscalationDir();
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// ============================================================================
// POLICY LOADING
// ============================================================================

/**
 * Load escalation policy from policy.yaml.
 * Falls back to DEFAULT_PATHS if not configured.
 *
 * @returns {{ paths: object, enabled: boolean }}
 */
function loadEscalationPolicy() {
  try {
    const { loadPolicy } = require('./policy');
    const policy = loadPolicy();
    const escalation = policy?.orchestrator?.escalation;

    if (escalation) {
      return {
        enabled: escalation.enabled !== false,
        paths: { ...DEFAULT_PATHS, ...(escalation.paths || {}) },
        scan_interval_sec: escalation.scan_interval_sec || 60
      };
    }
  } catch (e) { /* no policy or parse error */ }

  return {
    enabled: true,
    paths: DEFAULT_PATHS,
    scan_interval_sec: 60
  };
}

// ============================================================================
// EVENT KEY
// ============================================================================

/**
 * Build a unique key for an escalation event.
 * Combines event type + session + task for per-incident tracking.
 *
 * @param {string} eventType - One of EVENT_TYPES
 * @param {string} sessionId - Agent session
 * @param {string} [taskId]  - Task ID (optional)
 * @returns {string}
 */
function buildEventKey(eventType, sessionId, taskId) {
  const parts = [eventType, sessionId];
  if (taskId) parts.push(taskId);
  return parts.join(':');
}

// ============================================================================
// ESCALATION STATE
// ============================================================================

/**
 * Get current escalation state for an event.
 *
 * @param {string} eventKey
 * @returns {object|null} { level, level_index, first_triggered, last_escalated, retries, resolved }
 */
function getEscalationState(eventKey) {
  return readJSON(getEscalationStatePath(eventKey));
}

/**
 * Get all active (unresolved) escalations.
 *
 * @returns {object[]} Array of escalation states with their eventKey
 */
function getActiveEscalations() {
  ensureEscalationDir();
  const dir = getEscalationDir();
  const results = [];

  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const data = readJSON(path.join(dir, f));
      if (data && !data.resolved) {
        results.push({ eventKey: f.replace('.json', ''), ...data });
      }
    }
  } catch (e) { /* directory read error */ }

  return results;
}

// ============================================================================
// CORE ESCALATION ENGINE
// ============================================================================

/**
 * Trigger or escalate an event. Returns the action to take.
 *
 * If this is the first occurrence, starts at level 0 of the escalation path.
 * If already escalated and cooldown has passed, advances to next level.
 * If at max level, stays there (human review).
 *
 * @param {string} eventType - One of EVENT_TYPES
 * @param {string} sessionId - Agent session
 * @param {string} [taskId]  - Task ID
 * @param {object} [context] - Additional context for the escalation
 * @returns {{ action: string, level: string, level_index: number, eventKey: string, first_time: boolean, escalated: boolean }}
 */
function triggerEscalation(eventType, sessionId, taskId, context = {}) {
  const policy = loadEscalationPolicy();
  if (!policy.enabled) {
    return { action: 'noop', level: 'disabled', level_index: -1, eventKey: '', first_time: false, escalated: false };
  }

  const escalationPath = policy.paths[eventType] || DEFAULT_PATHS[eventType];
  if (!escalationPath) {
    return { action: 'noop', level: 'unknown_event', level_index: -1, eventKey: '', first_time: false, escalated: false };
  }

  const eventKey = buildEventKey(eventType, sessionId, taskId);
  const state = getEscalationState(eventKey);
  const now = Date.now();

  if (!state) {
    // First trigger — start at level 0
    const level = escalationPath.levels[0];
    const newState = {
      event_type: eventType,
      session_id: sessionId,
      task_id: taskId || null,
      level,
      level_index: 0,
      first_triggered: new Date(now).toISOString(),
      last_escalated: new Date(now).toISOString(),
      retries: 0,
      resolved: false,
      context
    };

    writeJSON(getEscalationStatePath(eventKey), newState);
    logEscalationEvent(eventKey, 'triggered', { level, context });

    return { action: level, level, level_index: 0, eventKey, first_time: true, escalated: false };
  }

  // Already resolved — re-trigger starts fresh
  if (state.resolved) {
    const level = escalationPath.levels[0];
    const newState = {
      event_type: eventType,
      session_id: sessionId,
      task_id: taskId || null,
      level,
      level_index: 0,
      first_triggered: new Date(now).toISOString(),
      last_escalated: new Date(now).toISOString(),
      retries: 0,
      resolved: false,
      context
    };

    writeJSON(getEscalationStatePath(eventKey), newState);
    logEscalationEvent(eventKey, 're_triggered', { level, context });

    return { action: level, level, level_index: 0, eventKey, first_time: true, escalated: false };
  }

  // Check cooldown
  const lastEscalated = new Date(state.last_escalated).getTime();
  const cooldownMs = (escalationPath.cooldown_sec || 120) * 1000;

  if (now - lastEscalated < cooldownMs) {
    // Still in cooldown — return current level without escalating
    return {
      action: state.level,
      level: state.level,
      level_index: state.level_index,
      eventKey,
      first_time: false,
      escalated: false
    };
  }

  // Cooldown passed — escalate to next level
  const nextIndex = state.level_index + 1;
  const maxIndex = escalationPath.levels.length - 1;
  const newIndex = Math.min(nextIndex, maxIndex);
  const newLevel = escalationPath.levels[newIndex];
  const didEscalate = newIndex > state.level_index;

  const updatedState = {
    ...state,
    level: newLevel,
    level_index: newIndex,
    last_escalated: new Date(now).toISOString(),
    retries: state.retries + 1,
    context: { ...state.context, ...context }
  };

  writeJSON(getEscalationStatePath(eventKey), updatedState);

  if (didEscalate) {
    logEscalationEvent(eventKey, 'escalated', {
      from_level: state.level,
      to_level: newLevel,
      retries: updatedState.retries
    });
  } else {
    logEscalationEvent(eventKey, 'repeated_at_max', {
      level: newLevel,
      retries: updatedState.retries
    });
  }

  return {
    action: newLevel,
    level: newLevel,
    level_index: newIndex,
    eventKey,
    first_time: false,
    escalated: didEscalate
  };
}

// ============================================================================
// ESCALATION ACTIONS
// ============================================================================

/**
 * Execute an escalation action. Called by the PM loop after triggerEscalation.
 *
 * @param {string} action - The escalation level/action
 * @param {object} params - { eventType, sessionId, taskId, pmSessionId, context, dryRun }
 * @returns {object} Result of the action
 */
function executeAction(action, params) {
  const { eventType, sessionId, taskId, pmSessionId, context, dryRun } = params;

  switch (action) {
    case LEVELS.WARNING:
      return _actionWarning(sessionId, taskId, eventType, context, pmSessionId, dryRun);
    case LEVELS.BLOCK:
      return _actionBlock(sessionId, taskId, eventType, context, pmSessionId, dryRun);
    case LEVELS.REASSIGN:
      return _actionReassign(sessionId, taskId, eventType, context, pmSessionId, dryRun);
    case LEVELS.HUMAN:
      return _actionHuman(sessionId, taskId, eventType, context, pmSessionId, dryRun);
    default:
      return { executed: false, reason: 'unknown_action' };
  }
}

/**
 * Warning: Notify the agent about the issue.
 */
function _actionWarning(sessionId, taskId, eventType, context, pmSessionId, dryRun) {
  if (dryRun) {
    return { executed: false, dry_run: true, action: 'warning', sessionId, taskId };
  }

  const messaging = require('./messaging');
  messaging.sendNotification(pmSessionId, sessionId, `escalation.${eventType}.warning`, {
    event_type: eventType,
    task_id: taskId,
    message: `Warning: ${_humanReadableEvent(eventType)} detected on task ${taskId || 'unknown'}.`,
    context
  });

  return { executed: true, action: 'warning', sessionId, taskId };
}

/**
 * Block: Pause agent edits and notify PM.
 */
function _actionBlock(sessionId, taskId, eventType, context, pmSessionId, dryRun) {
  if (dryRun) {
    return { executed: false, dry_run: true, action: 'block', sessionId, taskId };
  }

  const messaging = require('./messaging');

  // Write a block marker that pre-tool-use hook can check
  const blockPath = path.join(
    process.cwd(),
    '.claude/pilot/state/escalations',
    `block_${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  );
  ensureEscalationDir();
  fs.writeFileSync(blockPath, JSON.stringify({
    blocked_at: new Date().toISOString(),
    reason: eventType,
    task_id: taskId,
    message: `Agent blocked due to ${_humanReadableEvent(eventType)}`
  }));

  // Notify the agent
  messaging.sendNotification(pmSessionId, sessionId, `escalation.${eventType}.blocked`, {
    event_type: eventType,
    task_id: taskId,
    message: `Edits blocked: ${_humanReadableEvent(eventType)} on task ${taskId || 'unknown'}. Resolve the issue to continue.`,
    context
  });

  // Notify PM
  messaging.sendNotification(sessionId, pmSessionId, `escalation.${eventType}.pm_alert`, {
    event_type: eventType,
    agent: sessionId,
    task_id: taskId,
    severity: 'block',
    message: `Agent ${sessionId} blocked due to ${_humanReadableEvent(eventType)}.`,
    context
  });

  return { executed: true, action: 'block', sessionId, taskId, block_path: blockPath };
}

/**
 * Reassign: Release the task and reassign to another agent.
 */
function _actionReassign(sessionId, taskId, eventType, context, pmSessionId, dryRun) {
  if (dryRun) {
    return { executed: false, dry_run: true, action: 'reassign', sessionId, taskId };
  }

  if (!taskId) {
    return { executed: false, action: 'reassign', reason: 'no_task_id' };
  }

  const recovery = require('./recovery');
  const messaging = require('./messaging');

  // Use recovery module's release & reassign
  const releaseResult = recovery.releaseAndReassign(sessionId, pmSessionId);

  // Remove any block marker
  _clearBlockMarker(sessionId);

  // Broadcast reassignment
  messaging.sendBroadcast(pmSessionId, 'escalation.task_reassigned', {
    event_type: eventType,
    original_agent: sessionId,
    task_id: taskId,
    reason: `Reassigned due to ${_humanReadableEvent(eventType)}`,
    context
  });

  return {
    executed: true,
    action: 'reassign',
    sessionId,
    taskId,
    release_result: releaseResult
  };
}

/**
 * Human: Queue for human review as final escalation.
 */
function _actionHuman(sessionId, taskId, eventType, context, pmSessionId, dryRun) {
  if (dryRun) {
    return { executed: false, dry_run: true, action: 'human', sessionId, taskId };
  }

  const agentContext = require('./agent-context');
  const messaging = require('./messaging');

  // Record in human escalation queue
  agentContext.recordHumanEscalation({
    from: sessionId,
    reason: `${_humanReadableEvent(eventType)} — progressive escalation reached human level`,
    event_type: eventType,
    task_id: taskId,
    context
  });

  // Notify PM about human escalation
  messaging.sendNotification(sessionId, pmSessionId, 'escalation.human_required', {
    event_type: eventType,
    agent: sessionId,
    task_id: taskId,
    severity: 'human',
    message: `HUMAN REVIEW REQUIRED: ${_humanReadableEvent(eventType)} on task ${taskId || 'unknown'} by agent ${sessionId}. All automated escalation levels exhausted.`,
    context
  });

  return { executed: true, action: 'human', sessionId, taskId };
}

// ============================================================================
// DE-ESCALATION
// ============================================================================

/**
 * Resolve an escalation event (issue fixed).
 *
 * @param {string} eventKey - The event key to resolve
 * @param {string} [resolvedBy] - Who/what resolved it
 * @returns {boolean} Whether the event was found and resolved
 */
function resolveEscalation(eventKey, resolvedBy) {
  const state = getEscalationState(eventKey);
  if (!state || state.resolved) return false;

  const updatedState = {
    ...state,
    resolved: true,
    resolved_at: new Date().toISOString(),
    resolved_by: resolvedBy || 'auto'
  };

  writeJSON(getEscalationStatePath(eventKey), updatedState);

  // Clear any block marker
  if (state.session_id) {
    _clearBlockMarker(state.session_id);
  }

  logEscalationEvent(eventKey, 'resolved', {
    was_level: state.level,
    resolved_by: resolvedBy || 'auto'
  });

  return true;
}

/**
 * Check all active escalations for auto-de-escalation.
 * Called by PM loop — if the triggering condition no longer exists,
 * the escalation is resolved.
 *
 * @param {function} conditionChecker - (eventType, sessionId, taskId) => boolean
 *   Returns true if the issue STILL exists, false if resolved.
 * @returns {string[]} List of eventKeys that were de-escalated
 */
function checkAutoDeescalation(conditionChecker) {
  const policy = loadEscalationPolicy();
  const active = getActiveEscalations();
  const deescalated = [];

  for (const esc of active) {
    const pathConfig = policy.paths[esc.event_type] || DEFAULT_PATHS[esc.event_type];
    if (!pathConfig || !pathConfig.auto_deescalate) continue;

    const issueStillExists = conditionChecker(esc.event_type, esc.session_id, esc.task_id);
    if (!issueStillExists) {
      resolveEscalation(esc.eventKey, 'auto_deescalation');
      deescalated.push(esc.eventKey);
    }
  }

  return deescalated;
}

// ============================================================================
// BLOCK CHECK (for pre-tool-use hook)
// ============================================================================

/**
 * Check if an agent session is currently blocked by an escalation.
 *
 * @param {string} sessionId
 * @returns {{ blocked: boolean, reason?: string, message?: string }}
 */
function isAgentBlocked(sessionId) {
  const blockPath = path.join(
    process.cwd(),
    '.claude/pilot/state/escalations',
    `block_${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  );

  if (fs.existsSync(blockPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(blockPath, 'utf8'));
      return { blocked: true, reason: data.reason, message: data.message };
    } catch (e) {
      return { blocked: true, reason: 'unknown', message: 'Agent blocked by escalation' };
    }
  }

  return { blocked: false };
}

/**
 * Clear the block marker for a session.
 */
function _clearBlockMarker(sessionId) {
  const blockPath = path.join(
    process.cwd(),
    '.claude/pilot/state/escalations',
    `block_${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  );

  try {
    if (fs.existsSync(blockPath)) {
      fs.unlinkSync(blockPath);
    }
  } catch (e) { /* best effort */ }
}

// ============================================================================
// LOGGING
// ============================================================================

/**
 * Append an escalation event to the audit log.
 */
function logEscalationEvent(eventKey, action, details = {}) {
  ensureEscalationDir();
  const logPath = getEscalationLogPath();
  const entry = {
    ts: new Date().toISOString(),
    event_key: eventKey,
    action,
    ...details
  };

  try {
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch (e) { /* best effort */ }
}

/**
 * Get escalation history for a specific event or all events.
 *
 * @param {string} [eventKey] - Filter by event key (optional)
 * @returns {object[]}
 */
function getEscalationHistory(eventKey) {
  const logPath = getEscalationLogPath();
  if (!fs.existsSync(logPath)) return [];

  try {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim());
    const entries = lines
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);

    if (eventKey) {
      return entries.filter(e => e.event_key === eventKey);
    }
    return entries;
  } catch (e) {
    return [];
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function _humanReadableEvent(eventType) {
  const names = {
    [EVENT_TYPES.DRIFT]: 'plan drift',
    [EVENT_TYPES.TEST_FAILURE]: 'test failure',
    [EVENT_TYPES.BUDGET_EXCEEDED]: 'budget exceeded',
    [EVENT_TYPES.MERGE_CONFLICT]: 'merge conflict',
    [EVENT_TYPES.AGENT_UNRESPONSIVE]: 'agent unresponsive'
  };
  return names[eventType] || eventType;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Constants
  LEVELS,
  LEVEL_ORDER,
  EVENT_TYPES,
  DEFAULT_PATHS,

  // Policy
  loadEscalationPolicy,

  // Event key
  buildEventKey,

  // State
  getEscalationState,
  getActiveEscalations,

  // Core engine
  triggerEscalation,
  executeAction,

  // De-escalation
  resolveEscalation,
  checkAutoDeescalation,

  // Block check
  isAgentBlocked,

  // Logging
  logEscalationEvent,
  getEscalationHistory,

  // Path helpers (for testing)
  getEscalationDir,
  getEscalationStatePath,
  getEscalationLogPath,
  ESCALATION_STATE_DIR
};
