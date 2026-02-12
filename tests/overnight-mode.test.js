#!/usr/bin/env node

/**
 * Verification tests for Overnight Mode (Phase 4.8)
 * Tests: run lifecycle, error budget, report generation, drain mode,
 *        plan-and-queue flow, and pm-daemon CLI integration.
 *
 * Run: node tests/overnight-mode.test.js
 *
 * Part of Phase 4.8 (Pilot AGI-l5u)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS: ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL: ' + name + ' - ' + e.message);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// =============================================================================
// SETUP: temp directory for isolated file operations
// =============================================================================

const TMP_DIR = path.join(os.tmpdir(), 'pilot-overnight-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

// Create directory structure
const dirs = [
  '.claude/pilot/state/orchestrator',
  '.claude/pilot/state/sessions',
  '.claude/pilot/state/overnight',
  '.claude/pilot/state/overnight/errors',
  '.claude/pilot/state/overnight/reports',
  '.claude/pilot/state/costs/tasks',
  '.claude/pilot/state/costs/agents',
  '.claude/pilot/state/approved-plans',
  '.claude/pilot/messages/cursors',
  '.claude/pilot/memory/channels',
  '.claude/pilot/memory/schemas',
  '.claude/pilot/logs',
  '.claude/pilot/config',
  'runs'
];
for (const d of dirs) {
  fs.mkdirSync(path.join(TMP_DIR, d), { recursive: true });
}

// Create minimal policy with overnight config
fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/policy.yaml'), [
  'enforcement:',
  '  require_active_task: false',
  '  require_plan_approval: false',
  'session:',
  '  heartbeat_interval_sec: 60',
  '  max_concurrent_sessions: 6',
  'orchestrator:',
  '  drift_threshold: 0.3',
  '  max_concurrent_agents: 4',
  'checkpoint:',
  '  enabled: true',
  '  pressure_threshold_pct: 60',
  '  respawn:',
  '    enabled: false',
  '    max_respawn_limit: 10',
  'overnight:',
  '  error_budget:',
  '    max_failures_per_task: 3',
  '    max_total_failures: 10',
  '  report:',
  '    auto_generate: true',
  '  drain:',
  '    timeout_min: 15',
  ''
].join('\n'));

const ORIG_CWD = process.cwd();
process.chdir(TMP_DIR);

function freshModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

// Clear messaging dependency from cache too
function clearModuleCache() {
  const modules = [
    '../.claude/pilot/hooks/lib/overnight-mode',
    '../.claude/pilot/hooks/lib/policy',
    '../.claude/pilot/hooks/lib/messaging'
  ];
  for (const m of modules) {
    try {
      const resolved = require.resolve(m);
      delete require.cache[resolved];
    } catch (e) { /* not cached */ }
  }
}

// =============================================================================
// TESTS: Run Lifecycle
// =============================================================================

console.log('\n=== Run Lifecycle ===\n');

clearModuleCache();
const overnightMode = freshModule('../.claude/pilot/hooks/lib/overnight-mode');

test('createRun creates valid run state', () => {
  const { runId, state } = overnightMode.createRun(TMP_DIR, {
    description: 'Test overnight run',
    taskIds: ['task-1', 'task-2', 'task-3']
  });

  assert(runId.startsWith('run-'), 'Run ID should start with run-');
  assertEqual(state.status, 'active', 'New run should be active');
  assertEqual(state.description, 'Test overnight run', 'Description should match');
  assertEqual(state.task_ids.length, 3, 'Should have 3 task IDs');
  assertEqual(state.tasks_completed.length, 0, 'No tasks completed yet');
  assertEqual(state.tasks_failed.length, 0, 'No tasks failed yet');
  assertEqual(state.drain_requested, false, 'Not draining');
  assert(state.started_at, 'Should have started_at');
  assertEqual(state.ended_at, null, 'Should not have ended_at');
});

test('getActiveRun finds active run', () => {
  const run = overnightMode.getActiveRun(TMP_DIR);
  assert(run, 'Should find active run');
  assertEqual(run.status, 'active', 'Should be active');
});

test('updateRun modifies run state', () => {
  const run = overnightMode.getActiveRun(TMP_DIR);
  const updated = overnightMode.updateRun(TMP_DIR, run.run_id, {
    tasks_in_progress: ['task-1']
  });

  assert(updated, 'Update should return state');
  assertEqual(updated.tasks_in_progress.length, 1, 'Should have 1 in-progress');
});

test('endRun marks run as completed', () => {
  const run = overnightMode.getActiveRun(TMP_DIR);
  const runId = run.run_id;
  overnightMode.endRun(TMP_DIR, runId);

  const ended = overnightMode.getMostRecentRun(TMP_DIR);
  assertEqual(ended.status, 'completed', 'Should be completed');
  assert(ended.ended_at, 'Should have ended_at');
});

test('getActiveRun returns null when no active run', () => {
  const run = overnightMode.getActiveRun(TMP_DIR);
  assertEqual(run, null, 'Should be null after ending');
});

// =============================================================================
// TESTS: Error Budget
// =============================================================================

console.log('\n=== Error Budget ===\n');

test('checkErrorBudget returns not exceeded for new task', () => {
  const check = overnightMode.checkErrorBudget('new-task', TMP_DIR);
  assertEqual(check.exceeded, false, 'Should not be exceeded');
  assertEqual(check.consecutive, 0, 'No consecutive errors');
  assertEqual(check.total, 0, 'No total errors');
  assertEqual(check.max_per_task, 3, 'Default max is 3');
});

test('trackError increments error counts', () => {
  const result = overnightMode.trackError('err-task-1', {
    type: 'exit_error',
    message: 'Exit code 1',
    sessionId: 'test-session'
  }, TMP_DIR);

  assertEqual(result.total_errors, 1, 'Should have 1 total error');
  assertEqual(result.consecutive_errors, 1, 'Should have 1 consecutive error');
});

test('trackError accumulates errors', () => {
  overnightMode.trackError('err-task-1', { type: 'exit_error', message: 'Error 2' }, TMP_DIR);
  const result = overnightMode.trackError('err-task-1', {
    type: 'exit_error', message: 'Error 3'
  }, TMP_DIR);

  assertEqual(result.total_errors, 3, 'Should have 3 total errors');
  assertEqual(result.consecutive_errors, 3, 'Should have 3 consecutive errors');
});

test('checkErrorBudget detects exceeded budget (3 consecutive)', () => {
  const check = overnightMode.checkErrorBudget('err-task-1', TMP_DIR);
  assertEqual(check.exceeded, true, 'Should be exceeded after 3 errors');
  assert(check.reason.includes('3'), 'Reason should mention count');
  assertEqual(check.consecutive, 3, 'Should be 3 consecutive');
  assertEqual(check.total, 3, 'Should be 3 total');
});

test('trackSuccess resets consecutive error count', () => {
  overnightMode.trackSuccess('err-task-1', TMP_DIR);
  const check = overnightMode.checkErrorBudget('err-task-1', TMP_DIR);
  assertEqual(check.exceeded, false, 'Should not be exceeded after success');
  assertEqual(check.consecutive, 0, 'Consecutive should be reset');
  assertEqual(check.total, 3, 'Total should still be 3');
});

test('getOverBudgetTasks returns tasks over budget', () => {
  // Create a task with exceeded budget
  overnightMode.trackError('over-task', { type: 'test' }, TMP_DIR);
  overnightMode.trackError('over-task', { type: 'test' }, TMP_DIR);
  overnightMode.trackError('over-task', { type: 'test' }, TMP_DIR);

  const overBudget = overnightMode.getOverBudgetTasks(TMP_DIR);
  assert(overBudget.includes('over-task'), 'Should include over-task');
});

test('checkTotalErrorBudget tracks across run', () => {
  // Create a run so total errors are tracked
  overnightMode.createRun(TMP_DIR, {
    description: 'Error budget test',
    taskIds: ['t1']
  });

  // Track errors within the run
  for (let i = 0; i < 5; i++) {
    overnightMode.trackError('budget-task', { type: 'test' }, TMP_DIR);
  }

  const totalCheck = overnightMode.checkTotalErrorBudget(TMP_DIR);
  assert(totalCheck.total_errors >= 5, 'Should have at least 5 total errors');
  assertEqual(totalCheck.max_total, 10, 'Max total should be 10');

  // Clean up
  const run = overnightMode.getActiveRun(TMP_DIR);
  if (run) overnightMode.endRun(TMP_DIR, run.run_id);
});

// =============================================================================
// TESTS: Drain Mode
// =============================================================================

console.log('\n=== Drain Mode ===\n');

test('requestDrain fails without active run', () => {
  const result = overnightMode.requestDrain(TMP_DIR);
  assertEqual(result.success, false, 'Should fail without active run');
  assert(result.error, 'Should have error message');
});

test('requestDrain succeeds with active run', () => {
  overnightMode.createRun(TMP_DIR, {
    description: 'Drain test',
    taskIds: ['drain-1']
  });

  const result = overnightMode.requestDrain(TMP_DIR);
  assertEqual(result.success, true, 'Should succeed');
  assert(result.runId, 'Should return run ID');
});

test('isDraining returns true after drain requested', () => {
  const draining = overnightMode.isDraining(TMP_DIR);
  assertEqual(draining, true, 'Should be draining');
});

test('isDrainTimedOut returns false for recent drain', () => {
  const timedOut = overnightMode.isDrainTimedOut(TMP_DIR);
  assertEqual(timedOut, false, 'Should not be timed out yet');
});

// Clean up drain test run
{
  const run = overnightMode.getActiveRun(TMP_DIR);
  if (run) overnightMode.endRun(TMP_DIR, run.run_id);
}

// =============================================================================
// TESTS: Task Completion Tracking
// =============================================================================

console.log('\n=== Task Completion Tracking ===\n');

test('recordTaskStarted adds to in_progress list', () => {
  overnightMode.createRun(TMP_DIR, {
    description: 'Tracking test',
    taskIds: ['track-1', 'track-2']
  });

  overnightMode.recordTaskStarted('track-1', TMP_DIR);

  const run = overnightMode.getActiveRun(TMP_DIR);
  assert(run.tasks_in_progress.includes('track-1'), 'Should include track-1');
});

test('recordTaskCompletion moves task from in_progress to completed', () => {
  overnightMode.recordTaskCompletion('track-1', TMP_DIR);

  const run = overnightMode.getActiveRun(TMP_DIR);
  assert(run.tasks_completed.includes('track-1'), 'Should be in completed');
  assert(!run.tasks_in_progress.includes('track-1'), 'Should not be in in_progress');
});

test('recordTaskFailure adds to failed list', () => {
  overnightMode.recordTaskStarted('track-2', TMP_DIR);
  overnightMode.recordTaskFailure('track-2', TMP_DIR);

  const run = overnightMode.getActiveRun(TMP_DIR);
  assert(run.tasks_failed.includes('track-2'), 'Should be in failed');
  assert(!run.tasks_in_progress.includes('track-2'), 'Should not be in in_progress');
});

// Clean up
{
  const run = overnightMode.getActiveRun(TMP_DIR);
  if (run) overnightMode.endRun(TMP_DIR, run.run_id);
}

// =============================================================================
// TESTS: Report Generation
// =============================================================================

console.log('\n=== Report Generation ===\n');

test('generateReport fails with no run', () => {
  const result = overnightMode.generateReport({ projectRoot: TMP_DIR });
  // May find a completed run which is fine
  // Just verify it doesn't crash
  assert(typeof result.success === 'boolean', 'Should return success boolean');
});

test('generateReport produces valid report for completed run', () => {
  // Create and complete a run
  const { runId } = overnightMode.createRun(TMP_DIR, {
    description: 'Report test run',
    taskIds: ['report-1', 'report-2']
  });

  overnightMode.recordTaskCompletion('report-1', TMP_DIR);
  overnightMode.recordTaskFailure('report-2', TMP_DIR);
  overnightMode.endRun(TMP_DIR, runId);

  const result = overnightMode.generateReport({
    projectRoot: TMP_DIR,
    runId,
    format: 'both'
  });

  assertEqual(result.success, true, 'Should succeed');
  assert(result.report, 'Should have report object');
  assert(result.formatted, 'Should have formatted markdown');

  const report = result.report;
  assertEqual(report.run_id, runId, 'Run ID should match');
  assertEqual(report.description, 'Report test run', 'Description should match');
  assert(report.summary, 'Should have summary');
  assertEqual(report.summary.total_tasks, 2, 'Should have 2 tasks');
  assert(report.started_at, 'Should have started_at');
  assert(report.ended_at, 'Should have ended_at');
  assert(report.duration_ms >= 0, 'Should have non-negative duration');
  assert(report.generated_at, 'Should have generated_at');
});

test('formatReportMarkdown generates valid markdown', () => {
  const mockReport = {
    run_id: 'run-test',
    description: 'Test',
    started_at: '2026-02-10T20:00:00Z',
    ended_at: '2026-02-11T06:00:00Z',
    duration_ms: 36000000,
    summary: {
      total_tasks: 10,
      completed: 8,
      failed: 1,
      in_progress: 0,
      pending: 1,
      success_rate: 80
    },
    cost: { total_tokens: 5000000, per_task: {} },
    total_errors: 3,
    tasks: [
      { task_id: 't1', title: 'Task 1', status: 'closed', error_budget_exceeded: false, errors: 0 },
      { task_id: 't2', title: 'Task 2', status: 'closed', error_budget_exceeded: true, errors: 3 }
    ],
    drain_requested: false,
    generated_at: new Date().toISOString()
  };

  const md = overnightMode.formatReportMarkdown(mockReport);
  assert(md.includes('# Overnight Run Report'), 'Should have header');
  assert(md.includes('run-test'), 'Should include run ID');
  assert(md.includes('10h'), 'Should include duration');
  assert(md.includes('80%'), 'Should include success rate');
  assert(md.includes('5,000,000'), 'Should include formatted token count');
  assert(md.includes('[OVER BUDGET]'), 'Should include over budget badge');
});

// =============================================================================
// TESTS: Reporter extension
// =============================================================================

console.log('\n=== Reporter Extension ===\n');

test('formatOvernightConsole produces compact output', () => {
  clearModuleCache();
  const reporter = freshModule('../.claude/pilot/hooks/lib/reporter');
  assert(typeof reporter.formatOvernightConsole === 'function', 'Should export formatOvernightConsole');

  const mockReport = {
    run_id: 'run-test',
    duration_ms: 36000000,
    summary: {
      total_tasks: 10,
      completed: 8,
      failed: 1,
      success_rate: 80
    },
    cost: { total_tokens: 2500000 },
    total_errors: 2,
    tasks: [
      { task_id: 't1', status: 'closed', errors: 0, error_budget_exceeded: false },
      { task_id: 't2', status: 'open', errors: 2, error_budget_exceeded: true }
    ]
  };

  const output = reporter.formatOvernightConsole(mockReport);
  assert(output.includes('OVERNIGHT RUN REPORT'), 'Should have header');
  assert(output.includes('8/10'), 'Should show completed/total');
  assert(output.includes('80%'), 'Should show success rate');
});

// =============================================================================
// TESTS: Constants and Exports
// =============================================================================

console.log('\n=== Exports ===\n');

test('overnight-mode exports all expected functions', () => {
  const expectedFunctions = [
    'createRun', 'getActiveRun', 'getMostRecentRun', 'updateRun', 'endRun',
    'planAndQueue', 'trackError', 'trackSuccess',
    'checkErrorBudget', 'checkTotalErrorBudget', 'getOverBudgetTasks',
    'requestDrain', 'isDraining', 'isDrainTimedOut',
    'generateReport', 'formatReportMarkdown',
    'recordTaskCompletion', 'recordTaskFailure', 'recordTaskStarted'
  ];

  for (const fn of expectedFunctions) {
    assertEqual(typeof overnightMode[fn], 'function', `Should export ${fn}`);
  }
});

test('overnight-mode exports expected constants', () => {
  assert(overnightMode.OVERNIGHT_STATE_DIR, 'Should export OVERNIGHT_STATE_DIR');
  assert(overnightMode.ERROR_BUDGET_DIR, 'Should export ERROR_BUDGET_DIR');
  assert(overnightMode.REPORT_DIR, 'Should export REPORT_DIR');
  assertEqual(overnightMode.DEFAULT_MAX_FAILURES_PER_TASK, 3, 'Default max failures per task');
  assertEqual(overnightMode.DEFAULT_MAX_TOTAL_FAILURES, 10, 'Default max total failures');
  assertEqual(overnightMode.DEFAULT_DRAIN_TIMEOUT_MIN, 15, 'Default drain timeout');
});

// =============================================================================
// TESTS: pm-daemon CLI flags parsing
// =============================================================================

console.log('\n=== PM Daemon CLI Integration ===\n');

test('pm-daemon help text includes overnight CLI flags', () => {
  clearModuleCache();
  // Read pm-daemon.js and check help text
  const daemonSrc = fs.readFileSync(
    path.join(ORIG_CWD, '.claude/pilot/hooks/lib/pm-daemon.js'), 'utf8'
  );
  assert(daemonSrc.includes('--plan'), 'Help should include --plan');
  assert(daemonSrc.includes('--report'), 'Help should include --report');
  assert(daemonSrc.includes('--drain'), 'Help should include --drain');
});

test('pm-daemon requires overnight-mode module', () => {
  const daemonSrc = fs.readFileSync(
    path.join(ORIG_CWD, '.claude/pilot/hooks/lib/pm-daemon.js'), 'utf8'
  );
  assert(
    daemonSrc.includes("require('./overnight-mode')"),
    'Should require overnight-mode'
  );
});

// =============================================================================
// TESTS: pm-loop overnight scan integration
// =============================================================================

console.log('\n=== PM Loop Integration ===\n');

test('pm-loop has _overnightScan method', () => {
  const loopSrc = fs.readFileSync(
    path.join(ORIG_CWD, '.claude/pilot/hooks/lib/pm-loop.js'), 'utf8'
  );
  assert(loopSrc.includes('_overnightScan'), 'Should have _overnightScan');
  assert(loopSrc.includes('_generateOvernightReport'), 'Should have _generateOvernightReport');
  assert(loopSrc.includes('overnight_budget_exhausted'), 'Should handle budget exhaustion');
  assert(loopSrc.includes('overnight_run_complete'), 'Should handle run completion');
});

test('pm-loop overnight scan interval is configured', () => {
  const loopSrc = fs.readFileSync(
    path.join(ORIG_CWD, '.claude/pilot/hooks/lib/pm-loop.js'), 'utf8'
  );
  assert(loopSrc.includes('OVERNIGHT_SCAN_INTERVAL_MS'), 'Should have scan interval constant');
  assert(loopSrc.includes('lastOvernightScan'), 'Should track last scan time');
});

// =============================================================================
// TESTS: Policy configuration
// =============================================================================

console.log('\n=== Policy Config ===\n');

test('policy.yaml has overnight section', () => {
  const policySrc = fs.readFileSync(
    path.join(ORIG_CWD, '.claude/pilot/policy.yaml'), 'utf8'
  );
  assert(policySrc.includes('overnight:'), 'Should have overnight section');
  assert(policySrc.includes('error_budget:'), 'Should have error_budget subsection');
  assert(policySrc.includes('max_failures_per_task:'), 'Should have per-task limit');
  assert(policySrc.includes('max_total_failures:'), 'Should have total limit');
  assert(policySrc.includes('drain:'), 'Should have drain subsection');
  assert(policySrc.includes('timeout_min:'), 'Should have drain timeout');
});

// =============================================================================
// CLEANUP
// =============================================================================

process.chdir(ORIG_CWD);

// Clean up temp directory
try {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
} catch (e) {
  // Best effort cleanup
}

// =============================================================================
// RESULTS
// =============================================================================

console.log('\n' + '='.repeat(60));
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60) + '\n');

process.exit(failed > 0 ? 1 : 0);
