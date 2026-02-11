/**
 * Overnight Mode — autonomous batch execution with error budgets and morning reports
 *
 * Enables PM daemon to run large task sets unattended for hours.
 * Flow: plan → decompose → queue → execute → checkpoint → respawn → complete → report
 *
 * Part of Phase 4.8 (Pilot AGI-l5u)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ============================================================================
// CONSTANTS
// ============================================================================

const OVERNIGHT_STATE_DIR = '.claude/pilot/state/overnight';
const ERROR_BUDGET_DIR = '.claude/pilot/state/overnight/errors';
const REPORT_DIR = '.claude/pilot/state/overnight/reports';

const DEFAULT_MAX_FAILURES_PER_TASK = 3;
const DEFAULT_MAX_TOTAL_FAILURES = 10;
const DEFAULT_DRAIN_TIMEOUT_MIN = 15;

// ============================================================================
// PATH HELPERS
// ============================================================================

function resolvePath(projectRoot, relPath) {
  return path.join(projectRoot, relPath);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) { /* corrupted — start fresh */ }
  return null;
}

function writeJSON(filePath, data) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// ============================================================================
// OVERNIGHT RUN STATE
// ============================================================================

/**
 * Get the state file path for an overnight run.
 */
function getRunStatePath(projectRoot, runId) {
  return resolvePath(projectRoot, path.join(OVERNIGHT_STATE_DIR, `${runId}.json`));
}

/**
 * Create a new overnight run.
 *
 * @param {string} projectRoot
 * @param {object} opts - { description, taskIds }
 * @returns {{ runId: string, state: object }}
 */
function createRun(projectRoot, opts = {}) {
  const runId = 'run-' + Date.now();
  const state = {
    run_id: runId,
    status: 'active',
    description: opts.description || '',
    started_at: new Date().toISOString(),
    ended_at: null,
    task_ids: opts.taskIds || [],
    tasks_completed: [],
    tasks_failed: [],
    tasks_in_progress: [],
    total_errors: 0,
    drain_requested: false,
    drain_requested_at: null
  };

  writeJSON(getRunStatePath(projectRoot, runId), state);
  return { runId, state };
}

/**
 * Load the active overnight run, if any.
 */
function getActiveRun(projectRoot) {
  const dir = resolvePath(projectRoot, OVERNIGHT_STATE_DIR);
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir).filter(f => f.startsWith('run-') && f.endsWith('.json'));
  // Find most recent active run
  for (const f of files.sort().reverse()) {
    const state = readJSON(path.join(dir, f));
    if (state && state.status === 'active') {
      return state;
    }
  }
  return null;
}

/**
 * Update an overnight run's state.
 */
function updateRun(projectRoot, runId, updates) {
  const statePath = getRunStatePath(projectRoot, runId);
  const state = readJSON(statePath);
  if (!state) return null;

  Object.assign(state, updates);
  writeJSON(statePath, state);
  return state;
}

/**
 * Mark an overnight run as complete.
 */
function endRun(projectRoot, runId) {
  return updateRun(projectRoot, runId, {
    status: 'completed',
    ended_at: new Date().toISOString()
  });
}

// ============================================================================
// PLAN AND QUEUE
// ============================================================================

/**
 * Take a high-level description, decompose it into tasks, and queue them in bd.
 *
 * @param {string} description - High-level task description (e.g. "build authentication system")
 * @param {object} opts - { projectRoot, dryRun, logger }
 * @returns {{ success: boolean, runId?: string, taskIds?: string[], error?: string }}
 */
function planAndQueue(description, opts = {}) {
  const projectRoot = opts.projectRoot || process.cwd();
  const log = opts.logger || { info: () => {}, warn: () => {}, error: () => {} };

  if (!description || typeof description !== 'string' || description.trim().length === 0) {
    return { success: false, error: 'Description is required' };
  }

  log.info('Overnight plan: decomposing description', { description: description.substring(0, 200) });

  // Step 1: Create a parent task in bd
  let parentTaskId = null;
  if (!opts.dryRun) {
    try {
      const output = execFileSync('bd', [
        'create',
        '--title', `[Overnight] ${description.substring(0, 100)}`,
        '--priority', '2',
        '--label', 'overnight',
        '--label', 'auto-decomposed',
        '--json'
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const created = JSON.parse(output);
      parentTaskId = created.id || created.issue_id;
      log.info('Created parent task', { task_id: parentTaskId });
    } catch (e) {
      return { success: false, error: `Failed to create parent task: ${e.message}` };
    }
  } else {
    parentTaskId = 'dry-run-parent';
  }

  // Step 2: Decompose into subtasks using existing decomposition engine
  let subtaskIds = [];
  try {
    const decomposition = require('./decomposition');
    const parentTask = {
      id: parentTaskId,
      title: description,
      description: description,
      labels: ['overnight', 'auto-decomposed']
    };

    const result = decomposition.decomposeTask(parentTask, { projectRoot });

    if (result.subtasks && result.subtasks.length > 0) {
      // Create subtasks in bd
      if (!opts.dryRun) {
        const bdResult = decomposition.createSubtasksInBd(parentTaskId, result.subtasks, { projectRoot });
        subtaskIds = bdResult.created || [];
      } else {
        subtaskIds = result.subtasks.map((st, i) => `dry-run-st-${i + 1}`);
      }
      log.info('Decomposed into subtasks', { count: subtaskIds.length });
    } else {
      // Single task — use parent directly
      subtaskIds = [parentTaskId];
      log.info('No decomposition needed, using parent task');
    }
  } catch (e) {
    // Decomposition failed — use single parent task
    subtaskIds = [parentTaskId];
    log.warn('Decomposition failed, using parent task', { error: e.message });
  }

  // Step 3: Create overnight run
  const allTaskIds = [parentTaskId, ...subtaskIds.filter(id => id !== parentTaskId)];
  const { runId, state } = createRun(projectRoot, {
    description,
    taskIds: allTaskIds
  });

  log.info('Overnight run created', { run_id: runId, task_count: allTaskIds.length });

  return {
    success: true,
    runId,
    parentTaskId,
    taskIds: allTaskIds,
    subtaskCount: subtaskIds.length
  };
}

// ============================================================================
// ERROR BUDGET TRACKING
// ============================================================================

/**
 * Get the error state file path for a task.
 */
function getErrorStatePath(projectRoot, taskId) {
  const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  return resolvePath(projectRoot, path.join(ERROR_BUDGET_DIR, `${sanitized}.json`));
}

/**
 * Record an error for a task.
 *
 * @param {string} taskId
 * @param {object} error - { type, message, sessionId }
 * @param {string} projectRoot
 * @returns {{ total_errors: number, consecutive_errors: number }}
 */
function trackError(taskId, error, projectRoot) {
  const filePath = getErrorStatePath(projectRoot, taskId);
  const state = readJSON(filePath) || {
    task_id: taskId,
    total_errors: 0,
    consecutive_errors: 0,
    last_success_at: null,
    errors: []
  };

  state.total_errors++;
  state.consecutive_errors++;
  state.errors.push({
    type: error.type || 'unknown',
    message: (error.message || '').substring(0, 500),
    session_id: error.sessionId || null,
    recorded_at: new Date().toISOString()
  });

  // Keep last 20 errors
  if (state.errors.length > 20) {
    state.errors = state.errors.slice(-20);
  }

  writeJSON(filePath, state);

  // Update overnight run total errors
  const run = getActiveRun(projectRoot);
  if (run) {
    updateRun(projectRoot, run.run_id, {
      total_errors: (run.total_errors || 0) + 1
    });
  }

  return { total_errors: state.total_errors, consecutive_errors: state.consecutive_errors };
}

/**
 * Record a success for a task (resets consecutive error count).
 *
 * @param {string} taskId
 * @param {string} projectRoot
 */
function trackSuccess(taskId, projectRoot) {
  const filePath = getErrorStatePath(projectRoot, taskId);
  const state = readJSON(filePath);
  if (!state) return;

  state.consecutive_errors = 0;
  state.last_success_at = new Date().toISOString();
  writeJSON(filePath, state);
}

/**
 * Check if a task has exceeded its error budget.
 *
 * @param {string} taskId
 * @param {string} projectRoot
 * @returns {{ exceeded: boolean, reason?: string, consecutive: number, total: number, max_per_task: number }}
 */
function checkErrorBudget(taskId, projectRoot) {
  const policy = loadOvernightPolicy(projectRoot);
  const maxPerTask = policy.error_budget?.max_failures_per_task || DEFAULT_MAX_FAILURES_PER_TASK;

  const filePath = getErrorStatePath(projectRoot, taskId);
  const state = readJSON(filePath);

  if (!state) {
    return { exceeded: false, consecutive: 0, total: 0, max_per_task: maxPerTask };
  }

  if (state.consecutive_errors >= maxPerTask) {
    return {
      exceeded: true,
      reason: `Consecutive failures (${state.consecutive_errors}) >= limit (${maxPerTask})`,
      consecutive: state.consecutive_errors,
      total: state.total_errors,
      max_per_task: maxPerTask
    };
  }

  return {
    exceeded: false,
    consecutive: state.consecutive_errors,
    total: state.total_errors,
    max_per_task: maxPerTask
  };
}

/**
 * Check total error budget across all tasks in the active run.
 *
 * @param {string} projectRoot
 * @returns {{ exceeded: boolean, total_errors: number, max_total: number }}
 */
function checkTotalErrorBudget(projectRoot) {
  const policy = loadOvernightPolicy(projectRoot);
  const maxTotal = policy.error_budget?.max_total_failures || DEFAULT_MAX_TOTAL_FAILURES;

  const run = getActiveRun(projectRoot);
  const totalErrors = run ? (run.total_errors || 0) : 0;

  return {
    exceeded: totalErrors >= maxTotal,
    total_errors: totalErrors,
    max_total: maxTotal
  };
}

/**
 * Get all tasks that have exceeded their error budget.
 *
 * @param {string} projectRoot
 * @returns {string[]} - task IDs that exceeded budget
 */
function getOverBudgetTasks(projectRoot) {
  const dir = resolvePath(projectRoot, ERROR_BUDGET_DIR);
  if (!fs.existsSync(dir)) return [];

  const overBudget = [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

  for (const f of files) {
    const state = readJSON(path.join(dir, f));
    if (state && state.task_id) {
      const check = checkErrorBudget(state.task_id, projectRoot);
      if (check.exceeded) {
        overBudget.push(state.task_id);
      }
    }
  }

  return overBudget;
}

// ============================================================================
// DRAIN MODE
// ============================================================================

/**
 * Request drain mode — stop spawning new agents, let active ones finish.
 *
 * @param {string} projectRoot
 * @returns {{ success: boolean, runId?: string }}
 */
function requestDrain(projectRoot) {
  const run = getActiveRun(projectRoot);
  if (!run) {
    return { success: false, error: 'No active overnight run' };
  }

  updateRun(projectRoot, run.run_id, {
    drain_requested: true,
    drain_requested_at: new Date().toISOString()
  });

  return { success: true, runId: run.run_id };
}

/**
 * Check if drain mode is active.
 *
 * @param {string} projectRoot
 * @returns {boolean}
 */
function isDraining(projectRoot) {
  const run = getActiveRun(projectRoot);
  return run ? !!run.drain_requested : false;
}

/**
 * Check if drain has timed out (exceeded max wait time).
 *
 * @param {string} projectRoot
 * @returns {boolean}
 */
function isDrainTimedOut(projectRoot) {
  const run = getActiveRun(projectRoot);
  if (!run || !run.drain_requested || !run.drain_requested_at) return false;

  const policy = loadOvernightPolicy(projectRoot);
  const timeoutMin = policy.drain?.timeout_min || DEFAULT_DRAIN_TIMEOUT_MIN;
  const timeoutMs = timeoutMin * 60 * 1000;

  const elapsed = Date.now() - new Date(run.drain_requested_at).getTime();
  return elapsed >= timeoutMs;
}

// ============================================================================
// MORNING REPORT
// ============================================================================

/**
 * Generate a morning report for the most recent overnight run.
 *
 * @param {object} opts - { projectRoot, since, runId, format }
 * @returns {{ success: boolean, report?: object, formatted?: string, error?: string }}
 */
function generateReport(opts = {}) {
  const projectRoot = opts.projectRoot || process.cwd();
  const format = opts.format || 'both'; // 'json' | 'markdown' | 'both'

  // Find the run to report on
  let run = null;
  if (opts.runId) {
    run = readJSON(getRunStatePath(projectRoot, opts.runId));
  } else {
    // Find the most recent run
    run = getMostRecentRun(projectRoot);
  }

  if (!run) {
    return { success: false, error: 'No overnight run found' };
  }

  // Gather task data
  const taskSummaries = [];
  for (const taskId of (run.task_ids || [])) {
    const summary = gatherTaskSummary(taskId, projectRoot);
    taskSummaries.push(summary);
  }

  // Gather cost data
  let costData = { total_tokens: 0, tasks: {} };
  try {
    const costTracker = require('./cost-tracker');
    for (const taskId of (run.task_ids || [])) {
      const taskCost = costTracker.getTaskCost(taskId);
      if (taskCost) {
        costData.tasks[taskId] = taskCost;
        costData.total_tokens += taskCost.total_output_bytes || 0;
      }
    }
  } catch (e) { /* cost tracker may not have data */ }

  // Build report
  const completed = taskSummaries.filter(t => t.status === 'closed');
  const failed = taskSummaries.filter(t => t.error_budget_exceeded);
  const inProgress = taskSummaries.filter(t => t.status === 'in_progress');
  const pending = taskSummaries.filter(t => t.status === 'open' || t.status === 'ready');

  const report = {
    run_id: run.run_id,
    description: run.description,
    started_at: run.started_at,
    ended_at: run.ended_at || new Date().toISOString(),
    duration_ms: run.ended_at
      ? new Date(run.ended_at).getTime() - new Date(run.started_at).getTime()
      : Date.now() - new Date(run.started_at).getTime(),
    summary: {
      total_tasks: taskSummaries.length,
      completed: completed.length,
      failed: failed.length,
      in_progress: inProgress.length,
      pending: pending.length,
      success_rate: taskSummaries.length > 0
        ? Math.round((completed.length / taskSummaries.length) * 100)
        : 0
    },
    cost: {
      total_tokens: costData.total_tokens,
      per_task: costData.tasks
    },
    total_errors: run.total_errors || 0,
    tasks: taskSummaries,
    drain_requested: run.drain_requested || false,
    generated_at: new Date().toISOString()
  };

  // Save report
  const reportPath = resolvePath(projectRoot, path.join(REPORT_DIR, `${run.run_id}.json`));
  writeJSON(reportPath, report);

  const result = { success: true, report };

  if (format === 'markdown' || format === 'both') {
    result.formatted = formatReportMarkdown(report);
  }

  return result;
}

/**
 * Get the most recent overnight run (active or completed).
 */
function getMostRecentRun(projectRoot) {
  const dir = resolvePath(projectRoot, OVERNIGHT_STATE_DIR);
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('run-') && f.endsWith('.json'))
    .sort()
    .reverse();

  for (const f of files) {
    const state = readJSON(path.join(dir, f));
    if (state) return state;
  }
  return null;
}

/**
 * Gather summary info for a single task.
 */
function gatherTaskSummary(taskId, projectRoot) {
  const summary = {
    task_id: taskId,
    title: taskId,
    status: 'unknown',
    error_budget_exceeded: false,
    errors: 0
  };

  // Get task info from bd
  try {
    const output = execFileSync('bd', ['show', taskId, '--json'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const task = JSON.parse(output);
    summary.title = task.title || taskId;
    summary.status = task.status || 'unknown';
  } catch (e) { /* best effort */ }

  // Get error budget info
  const errorCheck = checkErrorBudget(taskId, projectRoot);
  summary.error_budget_exceeded = errorCheck.exceeded;
  summary.errors = errorCheck.total;
  summary.consecutive_errors = errorCheck.consecutive;

  return summary;
}

/**
 * Format a report as markdown.
 */
function formatReportMarkdown(report) {
  const duration = formatDuration(report.duration_ms);
  const lines = [];

  lines.push('# Overnight Run Report');
  lines.push('');
  lines.push(`**Run ID**: ${report.run_id}`);
  lines.push(`**Description**: ${report.description || 'N/A'}`);
  lines.push(`**Started**: ${report.started_at}`);
  lines.push(`**Ended**: ${report.ended_at}`);
  lines.push(`**Duration**: ${duration}`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Tasks | ${report.summary.total_tasks} |`);
  lines.push(`| Completed | ${report.summary.completed} |`);
  lines.push(`| Failed | ${report.summary.failed} |`);
  lines.push(`| In Progress | ${report.summary.in_progress} |`);
  lines.push(`| Pending | ${report.summary.pending} |`);
  lines.push(`| Success Rate | ${report.summary.success_rate}% |`);
  lines.push(`| Total Errors | ${report.total_errors} |`);
  lines.push(`| Total Tokens | ${report.cost.total_tokens.toLocaleString()} |`);
  lines.push('');

  if (report.tasks && report.tasks.length > 0) {
    lines.push('## Tasks');
    lines.push('');
    lines.push('| Task | Status | Errors |');
    lines.push('|------|--------|--------|');
    for (const t of report.tasks) {
      const badge = t.error_budget_exceeded ? ' [OVER BUDGET]' : '';
      lines.push(`| ${t.task_id} — ${t.title} | ${t.status}${badge} | ${t.errors} |`);
    }
    lines.push('');
  }

  if (report.drain_requested) {
    lines.push('> Drain mode was requested during this run.');
    lines.push('');
  }

  lines.push(`*Generated at ${report.generated_at}*`);

  return lines.join('\n');
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0m';
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ============================================================================
// POLICY HELPER
// ============================================================================

function loadOvernightPolicy(projectRoot) {
  try {
    const { loadPolicy } = require('./policy');
    const policy = loadPolicy();
    return policy.overnight || {};
  } catch (e) {
    return {};
  }
}

// ============================================================================
// TASK COMPLETION TRACKING
// ============================================================================

/**
 * Record a task completion in the active overnight run.
 *
 * @param {string} taskId
 * @param {string} projectRoot
 */
function recordTaskCompletion(taskId, projectRoot) {
  const run = getActiveRun(projectRoot);
  if (!run) return;

  const completed = run.tasks_completed || [];
  if (!completed.includes(taskId)) {
    completed.push(taskId);
  }

  // Remove from in_progress
  const inProgress = (run.tasks_in_progress || []).filter(id => id !== taskId);

  updateRun(projectRoot, run.run_id, {
    tasks_completed: completed,
    tasks_in_progress: inProgress
  });

  // Reset error counter on success
  trackSuccess(taskId, projectRoot);
}

/**
 * Record a task failure in the active overnight run.
 *
 * @param {string} taskId
 * @param {string} projectRoot
 */
function recordTaskFailure(taskId, projectRoot) {
  const run = getActiveRun(projectRoot);
  if (!run) return;

  const failed = run.tasks_failed || [];
  if (!failed.includes(taskId)) {
    failed.push(taskId);
  }

  // Remove from in_progress
  const inProgress = (run.tasks_in_progress || []).filter(id => id !== taskId);

  updateRun(projectRoot, run.run_id, {
    tasks_failed: failed,
    tasks_in_progress: inProgress
  });
}

/**
 * Record that a task is now being worked on.
 *
 * @param {string} taskId
 * @param {string} projectRoot
 */
function recordTaskStarted(taskId, projectRoot) {
  const run = getActiveRun(projectRoot);
  if (!run) return;

  const inProgress = run.tasks_in_progress || [];
  if (!inProgress.includes(taskId)) {
    inProgress.push(taskId);
  }

  updateRun(projectRoot, run.run_id, {
    tasks_in_progress: inProgress
  });
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Run lifecycle
  createRun,
  getActiveRun,
  getMostRecentRun,
  updateRun,
  endRun,

  // Plan and queue
  planAndQueue,

  // Error budget
  trackError,
  trackSuccess,
  checkErrorBudget,
  checkTotalErrorBudget,
  getOverBudgetTasks,

  // Drain mode
  requestDrain,
  isDraining,
  isDrainTimedOut,

  // Report
  generateReport,
  formatReportMarkdown,

  // Task tracking
  recordTaskCompletion,
  recordTaskFailure,
  recordTaskStarted,

  // Constants
  OVERNIGHT_STATE_DIR,
  ERROR_BUDGET_DIR,
  REPORT_DIR,
  DEFAULT_MAX_FAILURES_PER_TASK,
  DEFAULT_MAX_TOTAL_FAILURES,
  DEFAULT_DRAIN_TIMEOUT_MIN
};
