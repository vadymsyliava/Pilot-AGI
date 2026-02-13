/**
 * Pool Autoscaler (Phase 5.4)
 *
 * Core autoscaling engine for dynamic agent pool management.
 * Monitors queue depth, active agents, budget remaining, and system resources
 * to make scale-up/scale-down/hold decisions.
 *
 * State: .claude/pilot/state/pool/autoscaler-state.json
 *
 * API:
 *   evaluateScaling(currentState) -> { action, reason, targetCount }
 *   getPoolState() -> { active, idle, pending, budget_remaining_pct, cpu_pct, mem_pct }
 *   recordScalingDecision(decision) -- audit trail
 *   getScalingHistory(limit) -- recent decisions
 */

const fs = require('fs');
const path = require('path');

const POOL_STATE_DIR = '.claude/pilot/state/pool';
const AUTOSCALER_STATE_FILE = 'autoscaler-state.json';
const SCALING_HISTORY_FILE = 'scaling-history.jsonl';

// ============================================================================
// PATH HELPERS
// ============================================================================

function getStatePath(projectRoot) {
  return path.join(projectRoot || process.cwd(), POOL_STATE_DIR, AUTOSCALER_STATE_FILE);
}

function getHistoryPath(projectRoot) {
  return path.join(projectRoot || process.cwd(), POOL_STATE_DIR, SCALING_HISTORY_FILE);
}

function ensurePoolDir(projectRoot) {
  const dir = path.join(projectRoot || process.cwd(), POOL_STATE_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ============================================================================
// POLICY LOADING
// ============================================================================

/**
 * Load pool scaling policy from policy.yaml.
 *
 * @param {string} [projectRoot]
 * @returns {object} Pool policy with defaults
 */
function loadPoolPolicy(projectRoot) {
  try {
    const { loadPolicy } = require('./policy');
    const policy = loadPolicy(projectRoot);
    const pool = policy.pool || {};

    return {
      min: pool.min || 1,
      max: pool.max || 12,
      scale_up: {
        queue_ratio: pool.scale_up?.queue_ratio || 2.0,
        priority_idle_threshold: pool.scale_up?.priority_idle_threshold ?? 0,
        deadline_hours: pool.scale_up?.deadline_hours || 2
      },
      scale_down: {
        idle_cooldown_minutes: pool.scale_down?.idle_cooldown_minutes || 5,
        budget_threshold_pct: pool.scale_down?.budget_threshold_pct || 90,
        cpu_threshold_pct: pool.scale_down?.cpu_threshold_pct || 80,
        memory_threshold_pct: pool.scale_down?.memory_threshold_pct || 85
      },
      evaluation_interval_seconds: pool.evaluation_interval_seconds || 60
    };
  } catch (e) {
    return {
      min: 1,
      max: 12,
      scale_up: {
        queue_ratio: 2.0,
        priority_idle_threshold: 0,
        deadline_hours: 2
      },
      scale_down: {
        idle_cooldown_minutes: 5,
        budget_threshold_pct: 90,
        cpu_threshold_pct: 80,
        memory_threshold_pct: 85
      },
      evaluation_interval_seconds: 60
    };
  }
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

/**
 * Load autoscaler state.
 *
 * @param {string} [projectRoot]
 * @returns {object|null}
 */
function loadState(projectRoot) {
  const statePath = getStatePath(projectRoot);
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
  } catch (e) { /* corrupt */ }
  return null;
}

/**
 * Save autoscaler state.
 *
 * @param {object} state
 * @param {string} [projectRoot]
 */
function saveState(state, projectRoot) {
  ensurePoolDir(projectRoot);
  const statePath = getStatePath(projectRoot);
  const tmpPath = statePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, statePath);
}

// ============================================================================
// POOL STATE
// ============================================================================

/**
 * Get current pool state by aggregating active sessions, budget, and resources.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string} [opts.pmSessionId] - PM session to exclude from active count
 * @returns {{ active: number, idle: number, pending: number, budget_remaining_pct: number, cpu_pct: number, mem_pct: number }}
 */
function getPoolState(opts = {}) {
  const { projectRoot, pmSessionId } = opts;

  let active = 0;
  let idle = 0;
  let pending = 0;

  // Count active/idle agents from session module
  try {
    const session = require('./session');
    const sessions = session.getActiveSessions();
    for (const s of sessions) {
      if (s.session_id === pmSessionId) continue;
      if (s.claimed_task) {
        active++;
      } else {
        idle++;
      }
    }
  } catch (e) { /* session module not available */ }

  // Count pending tasks from bd
  try {
    const { execFileSync } = require('child_process');
    const output = execFileSync('bd', ['ready', '--json'], {
      cwd: projectRoot || process.cwd(),
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const tasks = JSON.parse(output);
    pending = tasks.length;
  } catch (e) {
    // bd not available
  }

  // Budget remaining (percentage of daily budget used)
  let budgetRemainingPct = 100;
  try {
    const costTracker = require('./cost-tracker');
    const daily = costTracker.getDailyCost();
    const budgetPolicy = costTracker.loadBudgetPolicy();
    const blockTokens = budgetPolicy.per_day?.block_tokens;
    if (blockTokens && blockTokens > 0) {
      const usedPct = (daily.total_tokens / blockTokens) * 100;
      budgetRemainingPct = Math.max(0, Math.round(100 - usedPct));
    }
  } catch (e) { /* cost tracker not available */ }

  // System resources
  let cpuPct = 0;
  let memPct = 0;
  try {
    const resourceMonitor = require('./resource-monitor');
    const resources = resourceMonitor.getSystemResources();
    cpuPct = resources.cpuPct;
    memPct = resources.memPct;
  } catch (e) { /* resource monitor not available */ }

  return {
    active,
    idle,
    pending,
    budget_remaining_pct: budgetRemainingPct,
    cpu_pct: cpuPct,
    mem_pct: memPct
  };
}

// ============================================================================
// SCALING EVALUATION
// ============================================================================

/**
 * Evaluate whether to scale up, scale down, or hold.
 *
 * @param {object} currentState - Pool state from getPoolState()
 * @param {object} [opts]
 * @param {string} [opts.projectRoot]
 * @param {object} [opts.policy] - Override policy for testing
 * @returns {{ action: 'scale_up'|'scale_down'|'hold', reason: string, targetCount: number }}
 */
function evaluateScaling(currentState, opts = {}) {
  const projectRoot = opts.projectRoot;
  const policy = opts.policy || loadPoolPolicy(projectRoot);
  const state = opts.state || loadState(projectRoot) || {};
  const now = Date.now();

  const { active, idle, pending, budget_remaining_pct, cpu_pct, mem_pct } = currentState;
  const totalAgents = active + idle;

  // --- Scale-down checks (evaluated first for safety) ---

  // Budget threshold: scale down if budget nearly exhausted
  const budgetUsedPct = 100 - budget_remaining_pct;
  if (budgetUsedPct >= policy.scale_down.budget_threshold_pct && totalAgents > policy.min) {
    return {
      action: 'scale_down',
      reason: `Budget ${budgetUsedPct}% used (threshold: ${policy.scale_down.budget_threshold_pct}%)`,
      targetCount: policy.min
    };
  }

  // Resource pressure: scale down if CPU or memory too high
  if (cpu_pct >= policy.scale_down.cpu_threshold_pct && totalAgents > policy.min) {
    return {
      action: 'scale_down',
      reason: `CPU pressure at ${cpu_pct}% (threshold: ${policy.scale_down.cpu_threshold_pct}%)`,
      targetCount: Math.max(policy.min, totalAgents - 1)
    };
  }
  if (mem_pct >= policy.scale_down.memory_threshold_pct && totalAgents > policy.min) {
    return {
      action: 'scale_down',
      reason: `Memory pressure at ${mem_pct}% (threshold: ${policy.scale_down.memory_threshold_pct}%)`,
      targetCount: Math.max(policy.min, totalAgents - 1)
    };
  }

  // Idle cooldown: scale down if no pending tasks for cooldown period
  if (pending === 0 && idle > 0 && totalAgents > policy.min) {
    const lastPendingAt = state.last_pending_at || 0;
    const cooldownMs = policy.scale_down.idle_cooldown_minutes * 60 * 1000;

    if (lastPendingAt > 0 && (now - lastPendingAt) >= cooldownMs) {
      return {
        action: 'scale_down',
        reason: `No pending tasks for ${policy.scale_down.idle_cooldown_minutes}min (cooldown elapsed)`,
        targetCount: Math.max(policy.min, totalAgents - 1)
      };
    }
  }

  // --- Scale-up checks ---

  // Respect max bound
  if (totalAgents >= policy.max) {
    return {
      action: 'hold',
      reason: `At pool maximum (${policy.max})`,
      targetCount: totalAgents
    };
  }

  // Queue ratio: scale up if queue depth > ratio * active agents
  if (active > 0 && pending > 0) {
    const ratio = pending / active;
    if (ratio >= policy.scale_up.queue_ratio) {
      return {
        action: 'scale_up',
        reason: `Queue ratio ${ratio.toFixed(1)} >= ${policy.scale_up.queue_ratio} (${pending} pending / ${active} active)`,
        targetCount: Math.min(policy.max, totalAgents + 1)
      };
    }
  }

  // No active agents but pending tasks: must scale up
  if (active === 0 && idle === 0 && pending > 0 && totalAgents < policy.max) {
    return {
      action: 'scale_up',
      reason: `No agents running but ${pending} tasks pending`,
      targetCount: Math.min(policy.max, policy.min)
    };
  }

  // High-priority with no idle: scale up if all agents busy and tasks waiting
  if (idle <= policy.scale_up.priority_idle_threshold && pending > 0 && totalAgents < policy.max) {
    return {
      action: 'scale_up',
      reason: `${idle} idle agents <= threshold ${policy.scale_up.priority_idle_threshold} with ${pending} tasks pending`,
      targetCount: Math.min(policy.max, totalAgents + 1)
    };
  }

  // Default: hold
  return {
    action: 'hold',
    reason: `Pool balanced (${active} active, ${idle} idle, ${pending} pending)`,
    targetCount: totalAgents
  };
}

// ============================================================================
// SCALING DECISIONS AUDIT
// ============================================================================

/**
 * Record a scaling decision for audit trail.
 *
 * @param {object} decision - { action, reason, targetCount, poolState }
 * @param {string} [projectRoot]
 */
function recordScalingDecision(decision, projectRoot) {
  ensurePoolDir(projectRoot);

  const entry = {
    ts: new Date().toISOString(),
    action: decision.action,
    reason: decision.reason,
    target_count: decision.targetCount,
    pool_state: decision.poolState || null
  };

  const historyPath = getHistoryPath(projectRoot);
  try {
    fs.appendFileSync(historyPath, JSON.stringify(entry) + '\n');
  } catch (e) { /* best effort */ }

  // Update autoscaler state with last decision
  const state = loadState(projectRoot) || {};
  state.last_decision = entry;
  state.last_decision_at = entry.ts;

  // Track when we last had pending tasks (for cooldown)
  if (decision.poolState && decision.poolState.pending > 0) {
    state.last_pending_at = Date.now();
  }

  state.updated_at = entry.ts;
  saveState(state, projectRoot);
}

/**
 * Get recent scaling decisions.
 *
 * @param {number} [limit=20]
 * @param {string} [projectRoot]
 * @returns {Array<object>}
 */
function getScalingHistory(limit = 20, projectRoot) {
  const historyPath = getHistoryPath(projectRoot);
  try {
    if (!fs.existsSync(historyPath)) return [];
    const lines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(line => {
      try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

/**
 * Update the last_pending_at timestamp in state.
 * Called by PM loop when pending tasks are detected.
 *
 * @param {string} [projectRoot]
 */
function markPendingTasksSeen(projectRoot) {
  const state = loadState(projectRoot) || {};
  state.last_pending_at = Date.now();
  state.updated_at = new Date().toISOString();
  saveState(state, projectRoot);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  evaluateScaling,
  getPoolState,
  recordScalingDecision,
  getScalingHistory,
  loadPoolPolicy,
  loadState,
  saveState,
  markPendingTasksSeen,
  // Constants for testing
  POOL_STATE_DIR,
  AUTOSCALER_STATE_FILE,
  SCALING_HISTORY_FILE
};
