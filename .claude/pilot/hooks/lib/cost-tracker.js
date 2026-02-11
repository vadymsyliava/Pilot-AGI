/**
 * Cost & Budget Tracker (Phase 3.11)
 *
 * Tracks token usage per agent, per task, and per day.
 * Provides budget enforcement and efficiency metrics.
 *
 * State files:
 *   .claude/pilot/state/costs/tasks/<taskId>.json   — per-task cost accumulation
 *   .claude/pilot/state/costs/agents/<sessionId>.json — per-agent daily costs
 *
 * This module is intentionally lightweight — called on every tool use
 * via post-tool-use.js.
 */

const fs = require('fs');
const path = require('path');

const COSTS_DIR = '.claude/pilot/state/costs';
const TASKS_DIR = path.join(COSTS_DIR, 'tasks');
const AGENTS_DIR = path.join(COSTS_DIR, 'agents');

// Cost constants (shared with pressure.js)
const COST_PER_MILLION_TOKENS = 10.0;
const BYTES_PER_TOKEN = 4;

// =============================================================================
// PATH HELPERS
// =============================================================================

function getTaskCostPath(taskId) {
  // Sanitize taskId for filesystem (replace spaces with underscores)
  const safe = taskId.replace(/\s+/g, '_');
  return path.join(process.cwd(), TASKS_DIR, `${safe}.json`);
}

function getAgentCostPath(sessionId) {
  return path.join(process.cwd(), AGENTS_DIR, `${sessionId}.json`);
}

function ensureDir(dirPath) {
  const full = path.join(process.cwd(), dirPath);
  if (!fs.existsSync(full)) {
    fs.mkdirSync(full, { recursive: true });
  }
}

// =============================================================================
// ATOMIC FILE OPS
// =============================================================================

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    // Corrupted file — start fresh
  }
  return null;
}

function writeJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

// =============================================================================
// COST RECORDING
// =============================================================================

/**
 * Record cost for a specific task from a specific session.
 *
 * @param {string} sessionId - Agent session ID
 * @param {string} taskId - bd task ID
 * @param {number} outputBytes - Output bytes from this tool call
 */
function recordTaskCost(sessionId, taskId, outputBytes = 0) {
  if (!taskId || !sessionId) return;

  ensureDir(TASKS_DIR);
  ensureDir(AGENTS_DIR);

  const tokens = Math.round(outputBytes / BYTES_PER_TOKEN);

  // Update per-task cost
  const taskPath = getTaskCostPath(taskId);
  const taskState = readJSON(taskPath) || {
    task_id: taskId,
    total_bytes: 0,
    total_tokens: 0,
    total_calls: 0,
    sessions: {},
    created_at: new Date().toISOString()
  };

  taskState.total_bytes += outputBytes;
  taskState.total_tokens += tokens;
  taskState.total_calls += 1;
  taskState.updated_at = new Date().toISOString();

  // Track per-session contribution
  if (!taskState.sessions[sessionId]) {
    taskState.sessions[sessionId] = { bytes: 0, tokens: 0, calls: 0 };
  }
  taskState.sessions[sessionId].bytes += outputBytes;
  taskState.sessions[sessionId].tokens += tokens;
  taskState.sessions[sessionId].calls += 1;

  writeJSON(taskPath, taskState);

  // Update per-agent daily cost
  const agentPath = getAgentCostPath(sessionId);
  const today = new Date().toISOString().split('T')[0];
  const agentState = readJSON(agentPath) || {
    session_id: sessionId,
    days: {},
    total_bytes: 0,
    total_tokens: 0,
    total_calls: 0,
    tasks_worked: [],
    created_at: new Date().toISOString()
  };

  if (!agentState.days[today]) {
    agentState.days[today] = { bytes: 0, tokens: 0, calls: 0 };
  }
  agentState.days[today].bytes += outputBytes;
  agentState.days[today].tokens += tokens;
  agentState.days[today].calls += 1;

  agentState.total_bytes += outputBytes;
  agentState.total_tokens += tokens;
  agentState.total_calls += 1;

  if (!agentState.tasks_worked.includes(taskId)) {
    agentState.tasks_worked.push(taskId);
  }

  agentState.updated_at = new Date().toISOString();
  writeJSON(agentPath, agentState);
}

// =============================================================================
// COST RETRIEVAL
// =============================================================================

/**
 * Get accumulated cost for a task.
 *
 * @param {string} taskId
 * @returns {{ task_id: string, total_bytes: number, total_tokens: number, total_calls: number, cost_usd: number, sessions: object }}
 */
function getTaskCost(taskId) {
  if (!taskId) return null;

  const taskPath = getTaskCostPath(taskId);
  const state = readJSON(taskPath);
  if (!state) {
    return { task_id: taskId, total_bytes: 0, total_tokens: 0, total_calls: 0, cost_usd: 0, sessions: {} };
  }

  return {
    ...state,
    cost_usd: roundCost((state.total_tokens / 1_000_000) * COST_PER_MILLION_TOKENS)
  };
}

/**
 * Get accumulated cost for an agent (all-time and today).
 *
 * @param {string} sessionId
 * @returns {{ session_id: string, total_tokens: number, today_tokens: number, cost_usd: number, today_cost_usd: number, tasks_worked: Array }}
 */
function getAgentCost(sessionId) {
  if (!sessionId) return null;

  const agentPath = getAgentCostPath(sessionId);
  const state = readJSON(agentPath);
  if (!state) {
    return {
      session_id: sessionId, total_tokens: 0, today_tokens: 0,
      cost_usd: 0, today_cost_usd: 0, tasks_worked: []
    };
  }

  const today = new Date().toISOString().split('T')[0];
  const todayData = state.days[today] || { tokens: 0 };

  return {
    session_id: sessionId,
    total_tokens: state.total_tokens || 0,
    today_tokens: todayData.tokens || 0,
    cost_usd: roundCost(((state.total_tokens || 0) / 1_000_000) * COST_PER_MILLION_TOKENS),
    today_cost_usd: roundCost(((todayData.tokens || 0) / 1_000_000) * COST_PER_MILLION_TOKENS),
    tasks_worked: state.tasks_worked || []
  };
}

/**
 * Get total cost for today across all agents.
 *
 * @returns {{ date: string, total_tokens: number, cost_usd: number, agents: Array }}
 */
function getDailyCost() {
  const today = new Date().toISOString().split('T')[0];
  const agentsDir = path.join(process.cwd(), AGENTS_DIR);
  let totalTokens = 0;
  const agents = [];

  try {
    if (!fs.existsSync(agentsDir)) return { date: today, total_tokens: 0, cost_usd: 0, agents: [] };

    const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const state = JSON.parse(fs.readFileSync(path.join(agentsDir, f), 'utf8'));
        const dayData = state.days?.[today];
        if (dayData) {
          totalTokens += dayData.tokens || 0;
          agents.push({
            session_id: state.session_id,
            tokens: dayData.tokens || 0,
            calls: dayData.calls || 0
          });
        }
      } catch (e) {
        // Skip corrupted files
      }
    }
  } catch (e) {
    // Directory read error
  }

  return {
    date: today,
    total_tokens: totalTokens,
    cost_usd: roundCost((totalTokens / 1_000_000) * COST_PER_MILLION_TOKENS),
    agents
  };
}

// =============================================================================
// BUDGET CHECKING
// =============================================================================

/**
 * Check budget status for an agent's current task.
 *
 * @param {string} sessionId
 * @param {string} taskId
 * @returns {{ status: 'ok'|'warning'|'exceeded', task_tokens: number, agent_today_tokens: number, daily_tokens: number, details: object }}
 */
function checkBudget(sessionId, taskId) {
  const policy = loadBudgetPolicy();
  const taskCost = getTaskCost(taskId);
  const agentCost = getAgentCost(sessionId);
  const dailyCost = getDailyCost();

  const result = {
    status: 'ok',
    task_tokens: taskCost.total_tokens,
    agent_today_tokens: agentCost.today_tokens,
    daily_tokens: dailyCost.total_tokens,
    details: {}
  };

  // Check per-task budget
  if (policy.per_task) {
    if (policy.per_task.block_tokens && taskCost.total_tokens >= policy.per_task.block_tokens) {
      result.status = 'exceeded';
      result.details.task = {
        tokens: taskCost.total_tokens,
        limit: policy.per_task.block_tokens,
        type: 'block'
      };
    } else if (policy.per_task.warn_tokens && taskCost.total_tokens >= policy.per_task.warn_tokens) {
      if (result.status !== 'exceeded') result.status = 'warning';
      result.details.task = {
        tokens: taskCost.total_tokens,
        limit: policy.per_task.warn_tokens,
        type: 'warn'
      };
    }
  }

  // Check per-agent-per-day budget
  if (policy.per_agent_per_day) {
    if (policy.per_agent_per_day.block_tokens && agentCost.today_tokens >= policy.per_agent_per_day.block_tokens) {
      result.status = 'exceeded';
      result.details.agent = {
        tokens: agentCost.today_tokens,
        limit: policy.per_agent_per_day.block_tokens,
        type: 'block'
      };
    } else if (policy.per_agent_per_day.warn_tokens && agentCost.today_tokens >= policy.per_agent_per_day.warn_tokens) {
      if (result.status !== 'exceeded') result.status = 'warning';
      result.details.agent = {
        tokens: agentCost.today_tokens,
        limit: policy.per_agent_per_day.warn_tokens,
        type: 'warn'
      };
    }
  }

  // Check per-day budget
  if (policy.per_day) {
    if (policy.per_day.block_tokens && dailyCost.total_tokens >= policy.per_day.block_tokens) {
      result.status = 'exceeded';
      result.details.daily = {
        tokens: dailyCost.total_tokens,
        limit: policy.per_day.block_tokens,
        type: 'block'
      };
    } else if (policy.per_day.warn_tokens && dailyCost.total_tokens >= policy.per_day.warn_tokens) {
      if (result.status !== 'exceeded') result.status = 'warning';
      result.details.daily = {
        tokens: dailyCost.total_tokens,
        limit: policy.per_day.warn_tokens,
        type: 'warn'
      };
    }
  }

  return result;
}

// =============================================================================
// EFFICIENCY METRICS
// =============================================================================

/**
 * Get efficiency metrics for a task.
 *
 * @param {string} taskId
 * @returns {{ tokens_per_commit: number|null, tokens_total: number, commit_count: number }}
 */
function getEfficiencyMetrics(taskId) {
  const taskCost = getTaskCost(taskId);
  const totalTokens = taskCost.total_tokens;

  // Count commits for this task from git log
  let commitCount = 0;
  try {
    const { execFileSync } = require('child_process');
    const output = execFileSync('git', ['log', '--oneline', '--all', `--grep=${taskId}`], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd()
    }).trim();
    if (output) {
      commitCount = output.split('\n').filter(Boolean).length;
    }
  } catch (e) {
    // Git not available or no commits yet
  }

  return {
    tokens_per_commit: commitCount > 0 ? Math.round(totalTokens / commitCount) : null,
    tokens_total: totalTokens,
    commit_count: commitCount,
    cost_usd: roundCost((totalTokens / 1_000_000) * COST_PER_MILLION_TOKENS)
  };
}

/**
 * Get efficiency metrics for an agent across all tasks.
 *
 * @param {string} sessionId
 * @returns {{ avg_tokens_per_task: number|null, tasks_completed: number, total_tokens: number }}
 */
function getAgentEfficiency(sessionId) {
  const agentCost = getAgentCost(sessionId);
  const taskCount = agentCost.tasks_worked.length;

  return {
    avg_tokens_per_task: taskCount > 0 ? Math.round(agentCost.total_tokens / taskCount) : null,
    tasks_completed: taskCount,
    total_tokens: agentCost.total_tokens,
    cost_usd: agentCost.cost_usd
  };
}

// =============================================================================
// SHARED MEMORY CHANNEL
// =============================================================================

/**
 * Publish aggregated cost data to the cost-tracking memory channel.
 * Called by PM loop's _costScan().
 */
function publishCostChannel() {
  try {
    const memory = require('./memory');
    const daily = getDailyCost();

    // Collect per-task costs for active tasks
    const tasksDir = path.join(process.cwd(), TASKS_DIR);
    const taskCosts = [];

    if (fs.existsSync(tasksDir)) {
      const files = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const state = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'));
          taskCosts.push({
            task_id: state.task_id,
            total_tokens: state.total_tokens,
            cost_usd: roundCost((state.total_tokens / 1_000_000) * COST_PER_MILLION_TOKENS),
            total_calls: state.total_calls
          });
        } catch (e) {
          // Skip
        }
      }
    }

    const payload = {
      daily_summary: daily,
      task_costs: taskCosts,
      published_at: new Date().toISOString()
    };

    memory.publish('cost-tracking', payload);
    return { published: true, tasks: taskCosts.length, daily_tokens: daily.total_tokens };
  } catch (e) {
    return { published: false, error: e.message };
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function roundCost(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * Load budget thresholds from policy.yaml.
 */
function loadBudgetPolicy() {
  try {
    const { loadPolicy } = require('./policy');
    const policy = loadPolicy();
    const ct = policy.orchestrator?.cost_tracking || {};

    return {
      per_task: {
        warn_tokens: ct.warn_threshold_tokens || null,
        block_tokens: ct.block_threshold_tokens || null
      },
      per_agent_per_day: {
        warn_tokens: ct.per_agent_per_day?.warn_tokens || null,
        block_tokens: ct.per_agent_per_day?.block_tokens || null
      },
      per_day: {
        warn_tokens: ct.per_day?.warn_tokens || null,
        block_tokens: ct.per_day?.block_tokens || null
      },
      enforcement: ct.enforcement || 'soft'
    };
  } catch (e) {
    return {
      per_task: { warn_tokens: null, block_tokens: null },
      per_agent_per_day: { warn_tokens: null, block_tokens: null },
      per_day: { warn_tokens: null, block_tokens: null },
      enforcement: 'soft'
    };
  }
}

/**
 * Reset cost state for a task (for testing).
 */
function resetTaskCost(taskId) {
  const p = getTaskCostPath(taskId);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* best effort */ }
}

/**
 * Reset cost state for an agent (for testing).
 */
function resetAgentCost(sessionId) {
  const p = getAgentCostPath(sessionId);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* best effort */ }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Recording
  recordTaskCost,

  // Retrieval
  getTaskCost,
  getAgentCost,
  getDailyCost,

  // Budget
  checkBudget,
  loadBudgetPolicy,

  // Efficiency
  getEfficiencyMetrics,
  getAgentEfficiency,

  // Memory channel
  publishCostChannel,

  // Testing helpers
  resetTaskCost,
  resetAgentCost,
  getTaskCostPath,
  getAgentCostPath,

  // Constants
  COST_PER_MILLION_TOKENS,
  BYTES_PER_TOKEN,
  COSTS_DIR,
  TASKS_DIR,
  AGENTS_DIR
};
