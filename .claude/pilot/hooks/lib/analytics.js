/**
 * Performance Analytics (Phase 3.13)
 *
 * Tracks agent effectiveness, scores task complexity, detects bottlenecks,
 * and generates sprint retrospectives. Consumes data from cost-tracker,
 * scheduler, session affinity, and PM action log.
 *
 * State files:
 *   .claude/pilot/state/analytics/lifecycle.jsonl  — task lifecycle events
 *   .claude/pilot/state/analytics/snapshots/<date>.json — daily aggregated snapshots
 *
 * This module is called by pm-loop._analyticsScan() every 5 minutes
 * and by dashboard.collect() for real-time data.
 */

const fs = require('fs');
const path = require('path');

const ANALYTICS_DIR = '.claude/pilot/state/analytics';
const LIFECYCLE_FILE = path.join(ANALYTICS_DIR, 'lifecycle.jsonl');
const SNAPSHOTS_DIR = path.join(ANALYTICS_DIR, 'snapshots');

// =============================================================================
// PATH HELPERS
// =============================================================================

function getLifecyclePath() {
  return path.join(process.cwd(), LIFECYCLE_FILE);
}

function getSnapshotPath(date) {
  return path.join(process.cwd(), SNAPSHOTS_DIR, `${date}.json`);
}

function ensureDir(dirPath) {
  const full = path.join(process.cwd(), dirPath);
  if (!fs.existsSync(full)) {
    fs.mkdirSync(full, { recursive: true });
  }
}

// =============================================================================
// ATOMIC FILE OPS (same pattern as cost-tracker.js)
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

function appendJSONL(filePath, entry) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

function readJSONL(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

// =============================================================================
// TASK LIFECYCLE EVENT RECORDING
// =============================================================================

/**
 * Record a task lifecycle event.
 * Call when tasks transition: ready → assigned → completed/failed/reassigned
 *
 * @param {string} taskId - bd task ID
 * @param {string} event - 'ready' | 'assigned' | 'started' | 'completed' | 'failed' | 'reassigned'
 * @param {object} [meta] - Extra metadata (agent, predicted_complexity, etc.)
 */
function recordLifecycleEvent(taskId, event, meta = {}) {
  if (!taskId || !event) return;

  ensureDir(ANALYTICS_DIR);

  const entry = {
    ts: new Date().toISOString(),
    task_id: taskId,
    event,
    ...meta
  };

  appendJSONL(getLifecyclePath(), entry);
}

/**
 * Get all lifecycle events for a specific task.
 *
 * @param {string} taskId
 * @returns {Array<{ts: string, task_id: string, event: string, ...}>}
 */
function getTaskLifecycle(taskId) {
  const events = readJSONL(getLifecyclePath());
  return events.filter(e => e.task_id === taskId);
}

/**
 * Get task cycle time (ready → completed) in milliseconds.
 * Returns null if task isn't completed or missing events.
 *
 * @param {string} taskId
 * @returns {number|null}
 */
function getTaskCycleTime(taskId) {
  const events = getTaskLifecycle(taskId);
  const assigned = events.find(e => e.event === 'assigned');
  const completed = events.find(e => e.event === 'completed');

  if (!assigned || !completed) return null;

  return new Date(completed.ts).getTime() - new Date(assigned.ts).getTime();
}

// =============================================================================
// AGENT PERFORMANCE METRICS
// =============================================================================

/**
 * Compute performance metrics for an agent across all recorded lifecycle events.
 *
 * @param {string} sessionId - Agent session ID
 * @returns {{
 *   session_id: string,
 *   tasks_completed: number,
 *   tasks_failed: number,
 *   tasks_reassigned: number,
 *   success_rate: number,
 *   avg_cycle_time_ms: number|null,
 *   total_tokens: number,
 *   cost_efficiency: number|null,
 *   rework_count: number
 * }}
 */
function getAgentPerformance(sessionId) {
  if (!sessionId) return null;

  const allEvents = readJSONL(getLifecyclePath());
  const agentEvents = allEvents.filter(e => e.agent === sessionId);

  // Count outcomes
  const completed = agentEvents.filter(e => e.event === 'completed');
  const failed = agentEvents.filter(e => e.event === 'failed');
  const reassigned = agentEvents.filter(e => e.event === 'reassigned');

  const total = completed.length + failed.length + reassigned.length;

  // Calculate average cycle time for completed tasks
  const cycleTimes = [];
  for (const c of completed) {
    const assigned = agentEvents.find(
      e => e.event === 'assigned' && e.task_id === c.task_id
    );
    if (assigned) {
      const ms = new Date(c.ts).getTime() - new Date(assigned.ts).getTime();
      if (ms > 0) cycleTimes.push(ms);
    }
  }

  const avgCycleTime = cycleTimes.length > 0
    ? Math.round(cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length)
    : null;

  // Get token data from cost-tracker
  let totalTokens = 0;
  let costEfficiency = null;
  try {
    const costTracker = require('./cost-tracker');
    const agentCost = costTracker.getAgentCost(sessionId);
    totalTokens = agentCost.total_tokens;
    if (completed.length > 0) {
      costEfficiency = Math.round(totalTokens / completed.length);
    }
  } catch (e) {
    // cost-tracker not available
  }

  return {
    session_id: sessionId,
    tasks_completed: completed.length,
    tasks_failed: failed.length,
    tasks_reassigned: reassigned.length,
    success_rate: total > 0 ? Math.round((completed.length / total) * 100) / 100 : 0,
    avg_cycle_time_ms: avgCycleTime,
    total_tokens: totalTokens,
    cost_efficiency: costEfficiency,
    rework_count: reassigned.length
  };
}

/**
 * Get performance summary for all agents that have lifecycle events.
 *
 * @returns {Array<object>} - Array of agent performance objects
 */
function getAllAgentPerformance() {
  const allEvents = readJSONL(getLifecyclePath());
  const agentIds = [...new Set(allEvents.filter(e => e.agent).map(e => e.agent))];
  return agentIds.map(id => getAgentPerformance(id));
}

// =============================================================================
// TASK COMPLEXITY SCORING
// =============================================================================

/**
 * Record predicted complexity for a task (before work starts).
 *
 * @param {string} taskId
 * @param {string} predicted - 'S' | 'M' | 'L' | 'XL'
 * @param {object} [factors] - Complexity factors (files, dependencies, etc.)
 */
function recordPredictedComplexity(taskId, predicted, factors = {}) {
  recordLifecycleEvent(taskId, 'complexity_predicted', {
    predicted_complexity: predicted,
    factors
  });
}

/**
 * Record actual complexity after task completion.
 *
 * @param {string} taskId
 * @param {string} actual - 'S' | 'M' | 'L' | 'XL'
 * @param {object} [actuals] - Actual measurements (files_touched, commits, tokens_used)
 */
function recordActualComplexity(taskId, actual, actuals = {}) {
  recordLifecycleEvent(taskId, 'complexity_actual', {
    actual_complexity: actual,
    actuals
  });
}

/**
 * Get complexity calibration data — how accurate predictions are.
 *
 * @returns {{
 *   total_predictions: number,
 *   accuracy_rate: number,
 *   underestimates: number,
 *   overestimates: number,
 *   calibration: object
 * }}
 */
function getComplexityCalibration() {
  const allEvents = readJSONL(getLifecyclePath());

  const predicted = allEvents.filter(e => e.event === 'complexity_predicted');
  const actual = allEvents.filter(e => e.event === 'complexity_actual');

  const sizes = { S: 1, M: 2, L: 3, XL: 4 };
  let matches = 0;
  let underestimates = 0;
  let overestimates = 0;
  let compared = 0;

  const calibration = { S: { predicted: 0, actual_S: 0, actual_M: 0, actual_L: 0, actual_XL: 0 },
                         M: { predicted: 0, actual_S: 0, actual_M: 0, actual_L: 0, actual_XL: 0 },
                         L: { predicted: 0, actual_S: 0, actual_M: 0, actual_L: 0, actual_XL: 0 },
                         XL: { predicted: 0, actual_S: 0, actual_M: 0, actual_L: 0, actual_XL: 0 } };

  for (const p of predicted) {
    const a = actual.find(e => e.task_id === p.task_id);
    if (!a) continue;

    const pSize = p.predicted_complexity;
    const aSize = a.actual_complexity;

    if (!sizes[pSize] || !sizes[aSize]) continue;

    compared++;
    if (calibration[pSize]) {
      calibration[pSize].predicted++;
      calibration[pSize][`actual_${aSize}`]++;
    }

    if (pSize === aSize) {
      matches++;
    } else if (sizes[pSize] < sizes[aSize]) {
      underestimates++;
    } else {
      overestimates++;
    }
  }

  return {
    total_predictions: predicted.length,
    total_compared: compared,
    accuracy_rate: compared > 0 ? Math.round((matches / compared) * 100) / 100 : 0,
    underestimates,
    overestimates,
    calibration
  };
}

// =============================================================================
// BOTTLENECK DETECTION
// =============================================================================

/**
 * Detect bottlenecks in the current project state.
 * Identifies: blocking tasks, slow agents, and queue depth issues.
 *
 * @param {object} [opts] - Options
 * @param {number} [opts.slowThresholdMs] - Task cycle time threshold for "slow" (default: 30min)
 * @returns {{
 *   blocking_tasks: Array,
 *   slow_tasks: Array,
 *   queue_depth: number,
 *   bottleneck_agents: Array,
 *   assessment: string
 * }}
 */
function detectBottlenecks(opts = {}) {
  const slowThresholdMs = opts.slowThresholdMs || 30 * 60 * 1000; // 30 min default

  const result = {
    blocking_tasks: [],
    slow_tasks: [],
    queue_depth: 0,
    bottleneck_agents: [],
    assessment: 'healthy'
  };

  // 1. Find blocking tasks (in_progress tasks that other tasks depend on)
  try {
    const { execFileSync } = require('child_process');
    const bdOutput = execFileSync('bd', ['list', '--json', '--limit', '50'], {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd()
    });
    const tasks = JSON.parse(bdOutput);

    // Count unassigned ready tasks (queue depth)
    const readyTasks = tasks.filter(t => t.status === 'open');
    const inProgressTasks = tasks.filter(t => t.status === 'in_progress');
    result.queue_depth = readyTasks.length;

    // Check in-progress tasks for being slow
    const allEvents = readJSONL(getLifecyclePath());
    for (const task of inProgressTasks) {
      const assigned = allEvents.find(
        e => e.task_id === task.id && e.event === 'assigned'
      );
      if (assigned) {
        const elapsed = Date.now() - new Date(assigned.ts).getTime();
        if (elapsed > slowThresholdMs) {
          result.slow_tasks.push({
            task_id: task.id,
            title: task.title,
            elapsed_ms: elapsed,
            agent: assigned.agent || 'unknown'
          });
        }
      }
    }

    // Check dependencies — tasks that block the most downstream work
    for (const task of inProgressTasks) {
      try {
        const depsOutput = execFileSync('bd', ['deps', task.id, '--json'], {
          encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
          cwd: process.cwd()
        });
        const deps = JSON.parse(depsOutput);
        const blockedCount = (deps.blocks || []).length;
        if (blockedCount > 0) {
          result.blocking_tasks.push({
            task_id: task.id,
            title: task.title,
            blocks_count: blockedCount,
            blocked_tasks: (deps.blocks || []).map(d => d.id || d)
          });
        }
      } catch (e) {
        // bd deps not available
      }
    }
  } catch (e) {
    // bd not available — use lifecycle events only
  }

  // 2. Identify bottleneck agents (consistently slow or high rework)
  const allPerf = getAllAgentPerformance();
  for (const perf of allPerf) {
    const isSlowAgent = perf.avg_cycle_time_ms && perf.avg_cycle_time_ms > slowThresholdMs;
    const isHighRework = perf.rework_count > 0 && perf.tasks_completed > 0 &&
      (perf.rework_count / (perf.tasks_completed + perf.rework_count)) > 0.3;

    if (isSlowAgent || isHighRework) {
      result.bottleneck_agents.push({
        session_id: perf.session_id,
        avg_cycle_time_ms: perf.avg_cycle_time_ms,
        rework_rate: perf.tasks_completed + perf.rework_count > 0
          ? Math.round((perf.rework_count / (perf.tasks_completed + perf.rework_count)) * 100) / 100
          : 0,
        reason: isSlowAgent && isHighRework ? 'slow_and_rework' :
                isSlowAgent ? 'slow' : 'high_rework'
      });
    }
  }

  // Assessment
  if (result.blocking_tasks.length > 2 || result.bottleneck_agents.length > 1) {
    result.assessment = 'critical';
  } else if (result.slow_tasks.length > 0 || result.blocking_tasks.length > 0 || result.queue_depth > 5) {
    result.assessment = 'degraded';
  }

  return result;
}

// =============================================================================
// DAILY AGGREGATION (SNAPSHOTS)
// =============================================================================

/**
 * Aggregate metrics for today and write a snapshot.
 * Called by pm-loop._analyticsScan().
 *
 * @returns {object} - Today's snapshot
 */
function aggregateDaily() {
  ensureDir(SNAPSHOTS_DIR);

  const today = new Date().toISOString().split('T')[0];
  const allEvents = readJSONL(getLifecyclePath());

  // Filter to today's events
  const todayEvents = allEvents.filter(e => e.ts && e.ts.startsWith(today));

  // Task counts by event type
  const assigned = todayEvents.filter(e => e.event === 'assigned');
  const completed = todayEvents.filter(e => e.event === 'completed');
  const failed = todayEvents.filter(e => e.event === 'failed');
  const reassigned = todayEvents.filter(e => e.event === 'reassigned');

  // Cycle times for completed tasks today
  const cycleTimes = [];
  for (const c of completed) {
    const a = allEvents.find(e => e.event === 'assigned' && e.task_id === c.task_id);
    if (a) {
      const ms = new Date(c.ts).getTime() - new Date(a.ts).getTime();
      if (ms > 0) cycleTimes.push(ms);
    }
  }

  // Cost data
  let dailyCost = { total_tokens: 0, cost_usd: 0 };
  try {
    const costTracker = require('./cost-tracker');
    dailyCost = costTracker.getDailyCost();
  } catch (e) {
    // cost-tracker not available
  }

  // Complexity calibration
  const calibration = getComplexityCalibration();

  // Bottleneck snapshot
  const bottlenecks = detectBottlenecks();

  const snapshot = {
    date: today,
    generated_at: new Date().toISOString(),

    // Velocity
    tasks_assigned: assigned.length,
    tasks_completed: completed.length,
    tasks_failed: failed.length,
    tasks_reassigned: reassigned.length,

    // Cycle time
    avg_cycle_time_ms: cycleTimes.length > 0
      ? Math.round(cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length)
      : null,
    min_cycle_time_ms: cycleTimes.length > 0 ? Math.min(...cycleTimes) : null,
    max_cycle_time_ms: cycleTimes.length > 0 ? Math.max(...cycleTimes) : null,

    // Cost
    total_tokens: dailyCost.total_tokens,
    cost_usd: dailyCost.cost_usd || 0,
    tokens_per_completed_task: completed.length > 0
      ? Math.round(dailyCost.total_tokens / completed.length)
      : null,

    // Quality
    success_rate: (completed.length + failed.length + reassigned.length) > 0
      ? Math.round((completed.length / (completed.length + failed.length + reassigned.length)) * 100) / 100
      : null,
    rework_rate: (completed.length + reassigned.length) > 0
      ? Math.round((reassigned.length / (completed.length + reassigned.length)) * 100) / 100
      : 0,

    // Complexity calibration
    complexity_accuracy: calibration.accuracy_rate,

    // Bottlenecks
    queue_depth: bottlenecks.queue_depth,
    blocking_task_count: bottlenecks.blocking_tasks.length,
    bottleneck_assessment: bottlenecks.assessment,

    // Agent performance
    agents: getAllAgentPerformance()
  };

  writeJSON(getSnapshotPath(today), snapshot);
  return snapshot;
}

/**
 * Get the snapshot for a specific date.
 *
 * @param {string} date - YYYY-MM-DD
 * @returns {object|null}
 */
function getSnapshot(date) {
  return readJSON(getSnapshotPath(date));
}

/**
 * Get snapshots for a date range.
 *
 * @param {number} days - Number of days to look back (default: 7)
 * @returns {Array<object>}
 */
function getRecentSnapshots(days = 7) {
  const snapshots = [];
  const now = new Date();

  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const date = d.toISOString().split('T')[0];
    const snap = getSnapshot(date);
    if (snap) snapshots.push(snap);
  }

  return snapshots;
}

// =============================================================================
// SPRINT RETROSPECTIVE GENERATOR
// =============================================================================

/**
 * Generate a sprint retrospective from recent snapshots.
 *
 * @param {number} [days] - Sprint length in days (default: 7)
 * @returns {{
 *   period: { start: string, end: string },
 *   velocity: object,
 *   cost: object,
 *   quality: object,
 *   highlights: string[],
 *   concerns: string[],
 *   recommendations: string[]
 * }}
 */
function generateRetrospective(days = 7) {
  const snapshots = getRecentSnapshots(days);

  if (snapshots.length === 0) {
    return {
      period: { start: null, end: null },
      velocity: { tasks_completed: 0, tasks_assigned: 0, avg_cycle_time_ms: null },
      cost: { total_tokens: 0, cost_usd: 0, tokens_per_task: null },
      quality: { success_rate: null, rework_rate: 0 },
      highlights: ['No data collected yet'],
      concerns: [],
      recommendations: ['Start recording lifecycle events to enable analytics']
    };
  }

  const dates = snapshots.map(s => s.date).sort();
  const period = { start: dates[0], end: dates[dates.length - 1] };

  // Aggregate across snapshots
  let totalAssigned = 0, totalCompleted = 0, totalFailed = 0, totalReassigned = 0;
  let totalTokens = 0, totalCost = 0;
  const cycleTimes = [];

  for (const s of snapshots) {
    totalAssigned += s.tasks_assigned || 0;
    totalCompleted += s.tasks_completed || 0;
    totalFailed += s.tasks_failed || 0;
    totalReassigned += s.tasks_reassigned || 0;
    totalTokens += s.total_tokens || 0;
    totalCost += s.cost_usd || 0;
    if (s.avg_cycle_time_ms) cycleTimes.push(s.avg_cycle_time_ms);
  }

  const totalOutcomes = totalCompleted + totalFailed + totalReassigned;
  const successRate = totalOutcomes > 0 ? Math.round((totalCompleted / totalOutcomes) * 100) / 100 : null;
  const reworkRate = (totalCompleted + totalReassigned) > 0
    ? Math.round((totalReassigned / (totalCompleted + totalReassigned)) * 100) / 100 : 0;

  const avgCycleTime = cycleTimes.length > 0
    ? Math.round(cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length)
    : null;

  // Generate highlights, concerns, recommendations
  const highlights = [];
  const concerns = [];
  const recommendations = [];

  if (totalCompleted > 0) {
    highlights.push(`Completed ${totalCompleted} tasks across ${snapshots.length} day(s)`);
  }
  if (successRate !== null && successRate >= 0.9) {
    highlights.push(`High success rate: ${Math.round(successRate * 100)}%`);
  }

  if (totalFailed > 0) {
    concerns.push(`${totalFailed} task(s) failed during the sprint`);
    recommendations.push('Review failed tasks for common patterns');
  }
  if (reworkRate > 0.2) {
    concerns.push(`High rework rate: ${Math.round(reworkRate * 100)}%`);
    recommendations.push('Improve task specifications to reduce reassignments');
  }
  if (successRate !== null && successRate < 0.7) {
    concerns.push(`Low success rate: ${Math.round(successRate * 100)}%`);
    recommendations.push('Consider simpler task decomposition');
  }

  // Cost efficiency
  const tokensPerTask = totalCompleted > 0 ? Math.round(totalTokens / totalCompleted) : null;
  if (tokensPerTask && tokensPerTask > 500000) {
    concerns.push(`High token usage per task: ${tokensPerTask.toLocaleString()}`);
    recommendations.push('Optimize context loading to reduce token consumption');
  }

  if (recommendations.length === 0) {
    recommendations.push('Continue current pace — metrics look healthy');
  }

  return {
    period,
    velocity: {
      tasks_assigned: totalAssigned,
      tasks_completed: totalCompleted,
      tasks_failed: totalFailed,
      tasks_reassigned: totalReassigned,
      avg_cycle_time_ms: avgCycleTime
    },
    cost: {
      total_tokens: totalTokens,
      cost_usd: Math.round(totalCost * 10000) / 10000,
      tokens_per_task: tokensPerTask
    },
    quality: {
      success_rate: successRate,
      rework_rate: reworkRate
    },
    highlights,
    concerns,
    recommendations
  };
}

// =============================================================================
// MEMORY CHANNEL PUBLISHING
// =============================================================================

/**
 * Publish analytics data to the performance-analytics memory channel.
 * Called by pm-loop._analyticsScan().
 */
function publishAnalyticsChannel() {
  try {
    const memory = require('./memory');

    const today = new Date().toISOString().split('T')[0];
    const snapshot = getSnapshot(today) || aggregateDaily();
    const retro = generateRetrospective(7);

    const payload = {
      daily_snapshot: snapshot,
      retrospective_summary: {
        velocity: retro.velocity,
        quality: retro.quality,
        cost: retro.cost
      },
      bottlenecks: detectBottlenecks(),
      published_at: new Date().toISOString()
    };

    memory.publish('performance-analytics', payload);
    return { published: true, date: today };
  } catch (e) {
    return { published: false, error: e.message };
  }
}

// =============================================================================
// QUICK SUMMARY (for dashboard)
// =============================================================================

/**
 * Get a quick analytics summary suitable for dashboard display.
 *
 * @returns {object}
 */
function getSummary() {
  const today = new Date().toISOString().split('T')[0];
  const snapshot = getSnapshot(today);

  if (snapshot) {
    return {
      date: today,
      tasks_completed: snapshot.tasks_completed,
      success_rate: snapshot.success_rate,
      avg_cycle_time_ms: snapshot.avg_cycle_time_ms,
      queue_depth: snapshot.queue_depth,
      bottleneck_assessment: snapshot.bottleneck_assessment,
      total_tokens: snapshot.total_tokens,
      cost_usd: snapshot.cost_usd
    };
  }

  // No snapshot yet — compute minimal live data
  const allEvents = readJSONL(getLifecyclePath());
  const todayEvents = allEvents.filter(e => e.ts && e.ts.startsWith(today));
  const completed = todayEvents.filter(e => e.event === 'completed').length;
  const assigned = todayEvents.filter(e => e.event === 'assigned').length;

  return {
    date: today,
    tasks_completed: completed,
    tasks_assigned: assigned,
    success_rate: null,
    avg_cycle_time_ms: null,
    queue_depth: null,
    bottleneck_assessment: null,
    total_tokens: 0,
    cost_usd: 0
  };
}

// =============================================================================
// TESTING HELPERS
// =============================================================================

/**
 * Reset all analytics state (for testing).
 */
function resetAll() {
  const lifecyclePath = getLifecyclePath();
  try { if (fs.existsSync(lifecyclePath)) fs.unlinkSync(lifecyclePath); } catch (e) { /* best effort */ }

  const snapshotsDir = path.join(process.cwd(), SNAPSHOTS_DIR);
  try {
    if (fs.existsSync(snapshotsDir)) {
      const files = fs.readdirSync(snapshotsDir);
      for (const f of files) {
        fs.unlinkSync(path.join(snapshotsDir, f));
      }
    }
  } catch (e) { /* best effort */ }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Lifecycle events
  recordLifecycleEvent,
  getTaskLifecycle,
  getTaskCycleTime,

  // Agent performance
  getAgentPerformance,
  getAllAgentPerformance,

  // Complexity scoring
  recordPredictedComplexity,
  recordActualComplexity,
  getComplexityCalibration,

  // Bottleneck detection
  detectBottlenecks,

  // Aggregation
  aggregateDaily,
  getSnapshot,
  getRecentSnapshots,

  // Retrospective
  generateRetrospective,

  // Memory channel
  publishAnalyticsChannel,

  // Dashboard
  getSummary,

  // Testing
  resetAll,

  // Constants
  ANALYTICS_DIR,
  LIFECYCLE_FILE,
  SNAPSHOTS_DIR
};
