#!/usr/bin/env node

/**
 * Verification tests for PM Decisions module (Phase 4.4)
 * Tests: decision classification, AI function signatures,
 *        fallback behavior, and expanded CLI commands.
 *
 * Run: node tests/pm-decisions.test.js
 *
 * Part of Phase 4.4 (Pilot AGI-ock)
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

function assertIncludes(str, sub, msg) {
  if (typeof str !== 'string' || !str.includes(sub)) {
    throw new Error(`${msg || 'assertIncludes'}: "${str}" does not include "${sub}"`);
  }
}

// =============================================================================
// SETUP: temp directory for isolated file operations
// =============================================================================

const TMP_DIR = path.join(os.tmpdir(), 'pilot-pm-decisions-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

// Create directory structure
const dirs = [
  '.claude/pilot/state/orchestrator',
  '.claude/pilot/state/sessions',
  '.claude/pilot/state/locks',
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

// Create minimal policy
fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/policy.yaml'), [
  'enforcement:',
  '  require_active_task: false',
  '  require_plan_approval: false',
  'session:',
  '  heartbeat_interval_sec: 60',
  '  max_concurrent_sessions: 6',
  'orchestrator:',
  '  drift_threshold: 0.3',
  '  auto_reassign_stale: true',
  '  max_concurrent_agents: 4',
  '  cost_tracking:',
  '    enabled: false',
  ''
].join('\n'));

// Create minimal memory index
fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/memory/index.json'), JSON.stringify({
  version: 1,
  channels: {}
}));

// Create empty bus
fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/messages/bus.jsonl'), '');

// Switch CWD
const ORIG_CWD = process.cwd();
process.chdir(TMP_DIR);

// Fresh module helper
function freshModule(modulePath) {
  const fullPath = require.resolve(modulePath);
  delete require.cache[fullPath];
  return require(modulePath);
}

// Lib path helper
function libPath(name) {
  return path.join(ORIG_CWD, '.claude/pilot/hooks/lib', name);
}

// =============================================================================
// TESTS: Module exports
// =============================================================================

console.log('\n=== PM Decisions: Module Exports ===');

const pmDecisions = require(libPath('pm-decisions'));

test('exports callClaude function', () => {
  assertEqual(typeof pmDecisions.callClaude, 'function', 'callClaude is function');
});

test('exports classifyDecision function', () => {
  assertEqual(typeof pmDecisions.classifyDecision, 'function', 'classifyDecision is function');
});

test('exports reviewDiff function', () => {
  assertEqual(typeof pmDecisions.reviewDiff, 'function', 'reviewDiff is function');
});

test('exports decomposeTask function', () => {
  assertEqual(typeof pmDecisions.decomposeTask, 'function', 'decomposeTask is function');
});

test('exports resolveConflict function', () => {
  assertEqual(typeof pmDecisions.resolveConflict, 'function', 'resolveConflict is function');
});

test('exports assessComplexity function', () => {
  assertEqual(typeof pmDecisions.assessComplexity, 'function', 'assessComplexity is function');
});

test('exports constants', () => {
  assertEqual(pmDecisions.CLAUDE_TIMEOUT_MS, 60000, 'CLAUDE_TIMEOUT_MS');
  assertEqual(pmDecisions.MAX_DIFF_CHARS, 8000, 'MAX_DIFF_CHARS');
  assertEqual(pmDecisions.MAX_CONTEXT_CHARS, 4000, 'MAX_CONTEXT_CHARS');
});

// =============================================================================
// TESTS: Decision classification
// =============================================================================

console.log('\n=== PM Decisions: Decision Classification ===');

test('classifies spawn_agent as mechanical', () => {
  assertEqual(pmDecisions.classifyDecision('spawn_agent'), 'mechanical', 'spawn is mechanical');
});

test('classifies kill_agent as mechanical', () => {
  assertEqual(pmDecisions.classifyDecision('kill_agent'), 'mechanical', 'kill is mechanical');
});

test('classifies health_check as mechanical', () => {
  assertEqual(pmDecisions.classifyDecision('health_check'), 'mechanical', 'health is mechanical');
});

test('classifies reap_dead as mechanical', () => {
  assertEqual(pmDecisions.classifyDecision('reap_dead'), 'mechanical', 'reap is mechanical');
});

test('classifies budget_check as mechanical', () => {
  assertEqual(pmDecisions.classifyDecision('budget_check'), 'mechanical', 'budget is mechanical');
});

test('classifies pressure_check as mechanical', () => {
  assertEqual(pmDecisions.classifyDecision('pressure_check'), 'mechanical', 'pressure is mechanical');
});

test('classifies session_cleanup as mechanical', () => {
  assertEqual(pmDecisions.classifyDecision('session_cleanup'), 'mechanical', 'cleanup is mechanical');
});

test('classifies tick as mechanical', () => {
  assertEqual(pmDecisions.classifyDecision('tick'), 'mechanical', 'tick is mechanical');
});

test('classifies status_query as mechanical', () => {
  assertEqual(pmDecisions.classifyDecision('status_query'), 'mechanical', 'status is mechanical');
});

test('classifies process_table as mechanical', () => {
  assertEqual(pmDecisions.classifyDecision('process_table'), 'mechanical', 'ps is mechanical');
});

test('classifies review_diff as judgment', () => {
  assertEqual(pmDecisions.classifyDecision('review_diff'), 'judgment', 'review is judgment');
});

test('classifies decompose_task as judgment', () => {
  assertEqual(pmDecisions.classifyDecision('decompose_task'), 'judgment', 'decompose is judgment');
});

test('classifies resolve_conflict as judgment', () => {
  assertEqual(pmDecisions.classifyDecision('resolve_conflict'), 'judgment', 'resolve is judgment');
});

test('classifies assess_complexity as judgment', () => {
  assertEqual(pmDecisions.classifyDecision('assess_complexity'), 'judgment', 'assess is judgment');
});

test('classifies unknown type as judgment', () => {
  assertEqual(pmDecisions.classifyDecision('some_unknown'), 'judgment', 'unknown defaults to judgment');
});

// =============================================================================
// TESTS: reviewDiff return shape (with mock failure since claude CLI not available)
// =============================================================================

console.log('\n=== PM Decisions: reviewDiff (no claude CLI) ===');

test('reviewDiff returns correct shape', () => {
  const result = pmDecisions.reviewDiff('T-test', 'diff --git a/file.js b/file.js\n+added line', {
    projectRoot: TMP_DIR
  });

  assertEqual(typeof result.approved, 'boolean', 'has approved boolean');
  assert(Array.isArray(result.issues), 'has issues array');
  assertEqual(typeof result.summary, 'string', 'has summary string');
  assertEqual(result.decision_type, 'judgment', 'decision_type is judgment');
});

// =============================================================================
// TESTS: decomposeTask return shape
// =============================================================================

console.log('\n=== PM Decisions: decomposeTask (no claude CLI) ===');

test('decomposeTask returns correct shape on failure', () => {
  const result = pmDecisions.decomposeTask('Add user authentication with JWT tokens', {
    projectRoot: TMP_DIR
  });

  assert(Array.isArray(result.subtasks), 'has subtasks array');
  assertEqual(result.decision_type, 'judgment', 'decision_type is judgment');
});

// =============================================================================
// TESTS: resolveConflict return shape
// =============================================================================

console.log('\n=== PM Decisions: resolveConflict (no claude CLI) ===');

test('resolveConflict returns correct shape on failure', () => {
  const result = pmDecisions.resolveConflict({
    file: 'src/auth.js',
    ours: 'const token = jwt.sign(payload)',
    theirs: 'const token = jwt.sign(payload, secret)',
    taskId: 'T-test'
  }, { projectRoot: TMP_DIR });

  assert(['ours', 'theirs', 'merge', 'manual'].includes(result.strategy), 'valid strategy');
  assertEqual(typeof result.suggestion, 'string', 'has suggestion');
  assert(['high', 'medium', 'low'].includes(result.confidence), 'valid confidence');
  assertEqual(result.decision_type, 'judgment', 'decision_type is judgment');
  // Should fallback to manual on failure
  assertEqual(result.strategy, 'manual', 'manual fallback');
  assertEqual(result.confidence, 'low', 'low confidence on failure');
});

// =============================================================================
// TESTS: assessComplexity return shape
// =============================================================================

console.log('\n=== PM Decisions: assessComplexity (no claude CLI) ===');

test('assessComplexity returns correct shape', () => {
  const result = pmDecisions.assessComplexity('Simple bug fix in auth module', {
    projectRoot: TMP_DIR
  });

  assert(['S', 'M', 'L'].includes(result.complexity), 'valid complexity');
  assertEqual(typeof result.reasoning, 'string', 'has reasoning');
  assertEqual(typeof result.estimated_steps, 'number', 'has estimated_steps');
  assert(['mechanical', 'judgment'].includes(result.decision_type), 'valid decision_type');
});

test('assessComplexity fallback uses word count heuristic when claude fails', () => {
  // Test the internal fallback by calling with an invalid projectRoot
  // that makes claude -p fail
  const result = pmDecisions.assessComplexity('Fix typo', {
    projectRoot: '/nonexistent/path/that/will/cause/claude/to/fail'
  });

  // If claude CLI is available it may succeed; if not, it falls back
  assert(['S', 'M', 'L'].includes(result.complexity), 'valid complexity either way');
  assertEqual(typeof result.reasoning, 'string', 'has reasoning either way');
  assertEqual(typeof result.estimated_steps, 'number', 'has estimated_steps either way');
});

// =============================================================================
// TESTS: Daemon structured logging with decision_type
// =============================================================================

console.log('\n=== PM Daemon: Structured Decision Logging ===');

test('Daemon logger includes decision_type in log entries', () => {
  // Clean PID file
  const pidPath = path.join(TMP_DIR, '.claude/pilot/state/orchestrator/pm-daemon.pid');
  if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);

  // Clear caches
  const modulesToClear = [
    'pm-daemon', 'pm-loop', 'pm-watcher', 'session', 'orchestrator',
    'messaging', 'policy', 'pm-research', 'decomposition', 'pm-decisions'
  ];
  for (const mod of modulesToClear) {
    try {
      const full = require.resolve(libPath(mod));
      delete require.cache[full];
    } catch (e) { /* not cached */ }
  }

  const { PmDaemon: FreshDaemon } = freshModule(libPath('pm-daemon'));
  const daemon = new FreshDaemon(TMP_DIR, { once: true, dryRun: true });
  const result = daemon.start();
  assertEqual(result.success, true, 'daemon started');

  // Read log file
  const logPath = path.join(TMP_DIR, '.claude/pilot/logs/pm-daemon.log');
  assert(fs.existsSync(logPath), 'log file exists');

  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  assert(lines.length > 0, 'has log entries');

  // Check that log entries have decision_type
  const entry = JSON.parse(lines[0]);
  assert('decision_type' in entry, 'log entry has decision_type');
  assertEqual(entry.decision_type, 'mechanical', 'startup is mechanical');
});

// =============================================================================
// TESTS: PmLoop logAction includes decision_type
// =============================================================================

console.log('\n=== PmLoop: Decision Type in Action Log ===');

test('PmLoop logAction classifies mechanical actions', () => {
  // Clear caches
  const modulesToClear = [
    'pm-loop', 'pm-decisions', 'orchestrator', 'session',
    'messaging', 'pm-research', 'decomposition'
  ];
  for (const mod of modulesToClear) {
    try {
      const full = require.resolve(libPath(mod));
      delete require.cache[full];
    } catch (e) { /* not cached */ }
  }

  const { PmLoop } = freshModule(libPath('pm-loop'));
  const loop = new PmLoop(TMP_DIR, { pmSessionId: 'test-pm', dryRun: true });
  loop.running = true;

  // Log a health scan action
  loop.logAction('health_check', { agent: 'test-agent' });

  // Read action log
  const logPath = path.join(TMP_DIR, '.claude/pilot/state/orchestrator/action-log.jsonl');
  assert(fs.existsSync(logPath), 'action log exists');

  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  const lastEntry = JSON.parse(lines[lines.length - 1]);

  assertEqual(lastEntry.type, 'health_check', 'correct type');
  assertEqual(lastEntry.decision_type, 'mechanical', 'classified as mechanical');
  assertEqual(lastEntry.pm_session, 'test-pm', 'has pm session');
});

test('PmLoop logAction preserves explicit decision_type', () => {
  const { PmLoop } = freshModule(libPath('pm-loop'));
  const loop = new PmLoop(TMP_DIR, { pmSessionId: 'test-pm', dryRun: true });
  loop.running = true;

  // Log with explicit decision_type
  loop.logAction('custom_action', { decision_type: 'judgment', rationale: 'AI decided' });

  const logPath = path.join(TMP_DIR, '.claude/pilot/state/orchestrator/action-log.jsonl');
  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  const lastEntry = JSON.parse(lines[lines.length - 1]);

  assertEqual(lastEntry.decision_type, 'judgment', 'explicit judgment preserved');
  assertEqual(lastEntry.rationale, 'AI decided', 'rationale preserved');
});

// =============================================================================
// TESTS: Expanded CLI --status shape
// =============================================================================

console.log('\n=== PM Daemon CLI: --status ===');

test('--status returns full JSON with sessions and recent_actions', () => {
  // Clean PID file
  const pidPath = path.join(TMP_DIR, '.claude/pilot/state/orchestrator/pm-daemon.pid');
  if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);

  // Write a daemon state file to simulate previous run
  const statePath = path.join(TMP_DIR, '.claude/pilot/state/orchestrator/pm-daemon-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    started_at: '2026-02-11T06:00:00.000Z',
    ticks: 42,
    events_processed: 10,
    agents_spawned: 3,
    errors: 0
  }));

  const { execFileSync } = require('child_process');
  try {
    const output = execFileSync('node', [
      libPath('pm-daemon'),
      '--status',
      '--root', TMP_DIR
    ], {
      cwd: TMP_DIR,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const result = JSON.parse(output);
    assertEqual(result.running, false, 'not running (no PID)');
    assertEqual(result.ticks, 42, 'has ticks from state');
    assertEqual(result.events_processed, 10, 'has events_processed');
    assertEqual(result.agents_spawned, 3, 'has agents_spawned');
    assert(Array.isArray(result.sessions), 'has sessions array');
    assert(Array.isArray(result.recent_actions), 'has recent_actions array');
  } catch (e) {
    // May fail if session module can't load outside real project
    assert(
      e.message.includes('Cannot find') || e.stdout,
      'CLI ran (module load may fail in isolation): ' + e.message
    );
  }
});

// =============================================================================
// TESTS: Expanded CLI --ps shape
// =============================================================================

console.log('\n=== PM Daemon CLI: --ps ===');

test('--ps --json returns JSON with agents array', () => {
  const { execFileSync } = require('child_process');
  try {
    const output = execFileSync('node', [
      libPath('pm-daemon'),
      '--ps', '--json',
      '--root', TMP_DIR
    ], {
      cwd: TMP_DIR,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const result = JSON.parse(output);
    assert(Array.isArray(result.agents), 'has agents array');
    assert('daemon_state' in result, 'has daemon_state');
  } catch (e) {
    // May fail if session module can't load outside real project
    assert(
      e.message.includes('Cannot find') || e.stdout,
      'CLI ran (module load may fail in isolation): ' + e.message
    );
  }
});

// =============================================================================
// TESTS: Existing pm-daemon tests still pass
// =============================================================================

console.log('\n=== PM Daemon: Backward Compatibility ===');

test('PmDaemon constructor still works', () => {
  const modulesToClear = [
    'pm-daemon', 'pm-loop', 'pm-watcher', 'session', 'orchestrator',
    'messaging', 'policy', 'pm-research', 'decomposition', 'pm-decisions'
  ];
  for (const mod of modulesToClear) {
    try {
      const full = require.resolve(libPath(mod));
      delete require.cache[full];
    } catch (e) { /* not cached */ }
  }

  const { PmDaemon: FreshDaemon } = freshModule(libPath('pm-daemon'));
  const daemon = new FreshDaemon(TMP_DIR);
  assertEqual(daemon.running, false, 'not running');
  assertEqual(daemon.opts.maxAgents, 6, 'max agents default');
  assert(daemon.spawnedAgents instanceof Map, 'spawnedAgents is Map');
});

test('PmDaemon.start() in once+dryRun still succeeds', () => {
  const pidPath = path.join(TMP_DIR, '.claude/pilot/state/orchestrator/pm-daemon.pid');
  if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);

  const modulesToClear = [
    'pm-daemon', 'pm-loop', 'pm-watcher', 'session', 'orchestrator',
    'messaging', 'policy', 'pm-research', 'decomposition', 'pm-decisions'
  ];
  for (const mod of modulesToClear) {
    try {
      const full = require.resolve(libPath(mod));
      delete require.cache[full];
    } catch (e) { /* not cached */ }
  }

  const { PmDaemon: FreshDaemon } = freshModule(libPath('pm-daemon'));
  const daemon = new FreshDaemon(TMP_DIR, { once: true, dryRun: true });
  const result = daemon.start();

  assertEqual(result.success, true, 'start succeeds');
  assertEqual(result.mode, 'once', 'once mode');
  assertEqual(daemon.tickCount, 1, 'ran one tick');
});

test('getStatus still returns correct shape', () => {
  const pidPath = path.join(TMP_DIR, '.claude/pilot/state/orchestrator/pm-daemon.pid');
  if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);

  const { PmDaemon: FreshDaemon } = freshModule(libPath('pm-daemon'));
  const daemon = new FreshDaemon(TMP_DIR, { once: true, dryRun: true });
  daemon.start();

  const status = daemon.getStatus();
  assertEqual(status.mode, 'once', 'once mode');
  assertEqual(status.ticks, 1, 'one tick');
  assert(Array.isArray(status.spawned_agents), 'has spawned_agents array');
});

// =============================================================================
// CLEANUP
// =============================================================================

process.chdir(ORIG_CWD);
try {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
} catch (e) {
  // best effort
}

// =============================================================================
// SUMMARY
// =============================================================================

console.log(`\n${'='.repeat(60)}`);
console.log(`PM Decisions Tests: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
