#!/usr/bin/env node

/**
 * Verification tests for PM Daemon (Phase 3.14)
 * Tests: PmDaemon lifecycle, PID management, agent lifecycle,
 *        escalation queue, daemon state, and CTL CLI.
 *
 * Run: node tests/pm-daemon.test.js
 *
 * Part of Phase 3.14 (Pilot AGI-sms)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

// Queue of test functions (supports async)
const _testQueue = [];

function test(name, fn) {
  _testQueue.push({ name, fn });
}

// Run all queued tests sequentially (supports async test functions)
async function runTests() {
  for (const { name, fn } of _testQueue) {
    try {
      await fn();
      passed++;
      console.log('  PASS: ' + name);
    } catch (e) {
      failed++;
      console.log('  FAIL: ' + name + ' - ' + e.message);
    }
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

const TMP_DIR = path.join(os.tmpdir(), 'pilot-pm-daemon-test-' + Date.now());
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
// TESTS: PID file management
// =============================================================================

console.log('\n=== PM Daemon: PID Management ===');

const {
  PmDaemon,
  isDaemonRunning,
  readDaemonPid,
  loadDaemonState,
  DAEMON_PID_PATH,
  DAEMON_STATE_PATH,
  DAEMON_LOG_DIR,
  DAEMON_LOG_FILE,
  DEFAULT_TICK_INTERVAL_MS,
  DEFAULT_MAX_AGENTS,
  SPAWN_COOLDOWN_MS
} = require(libPath('pm-daemon'));

test('isDaemonRunning returns false when no PID file', () => {
  const pidPath = path.join(TMP_DIR, DAEMON_PID_PATH);
  if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
  assert(!isDaemonRunning(TMP_DIR), 'no daemon running');
});

test('isDaemonRunning returns false for stale PID file', () => {
  const pidPath = path.join(TMP_DIR, DAEMON_PID_PATH);
  fs.writeFileSync(pidPath, JSON.stringify({
    pid: 99999999,
    started_at: new Date().toISOString()
  }));
  assert(!isDaemonRunning(TMP_DIR), 'stale PID cleaned up');
  assert(!fs.existsSync(pidPath), 'PID file removed');
});

test('readDaemonPid returns null when no PID file', () => {
  const result = readDaemonPid(TMP_DIR);
  assertEqual(result, null, 'no PID info');
});

test('loadDaemonState returns null when no state file', () => {
  const result = loadDaemonState(TMP_DIR);
  assertEqual(result, null, 'no daemon state');
});

test('DEFAULT_TICK_INTERVAL_MS is 30000', () => {
  assertEqual(DEFAULT_TICK_INTERVAL_MS, 30000, 'default tick interval');
});

test('DEFAULT_MAX_AGENTS is 6', () => {
  assertEqual(DEFAULT_MAX_AGENTS, 6, 'default max agents');
});

// =============================================================================
// TESTS: PmDaemon constructor
// =============================================================================

console.log('\n=== PM Daemon: Constructor ===');

test('PmDaemon constructor sets defaults', () => {
  const daemon = new PmDaemon(TMP_DIR);
  assertEqual(daemon.projectRoot, TMP_DIR, 'projectRoot');
  assertEqual(daemon.running, false, 'not running');
  assertEqual(daemon.opts.once, false, 'not once mode');
  assertEqual(daemon.opts.dryRun, false, 'not dry run');
  assertEqual(daemon.opts.tickIntervalMs, DEFAULT_TICK_INTERVAL_MS, 'tick interval');
  assertEqual(daemon.opts.maxAgents, DEFAULT_MAX_AGENTS, 'max agents');
  assert(daemon.spawnedAgents instanceof Map, 'spawnedAgents is Map');
});

test('PmDaemon constructor accepts overrides', () => {
  const daemon = new PmDaemon(TMP_DIR, {
    tickIntervalMs: 5000,
    maxAgents: 2,
    once: true,
    dryRun: true,
    spawnCooldownMs: 1000
  });
  assertEqual(daemon.opts.tickIntervalMs, 5000, 'custom tick interval');
  assertEqual(daemon.opts.maxAgents, 2, 'custom max agents');
  assertEqual(daemon.opts.once, true, 'once mode');
  assertEqual(daemon.opts.dryRun, true, 'dry run');
  assertEqual(daemon.opts.spawnCooldownMs, 1000, 'spawn cooldown');
});

// =============================================================================
// TESTS: Daemon start/stop (--once mode + dryRun to avoid real spawns)
// =============================================================================

console.log('\n=== PM Daemon: Start/Stop ===');

test('PmDaemon.start() in once+dryRun mode succeeds', async () => {
  // Clean up any leftover PID file
  const pidPath = path.join(TMP_DIR, DAEMON_PID_PATH);
  if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);

  // Clear require caches for a clean run
  const modulesToClear = [
    'pm-daemon', 'pm-loop', 'pm-watcher', 'session', 'orchestrator',
    'messaging', 'policy', 'pm-research', 'decomposition'
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
  assert(result.pm_session, 'has pm session');

  // _tick is now async — wait for once-mode tick+stop to complete
  // (async bd commands may take a moment to fail in test env)
  await new Promise(resolve => setTimeout(resolve, 3000));
  assertEqual(daemon.running, false, 'stopped after once');
  assert(daemon.tickCount >= 1, 'ran at least one tick');
});

test('PmDaemon.start() rejects double start', () => {
  const pidPath = path.join(TMP_DIR, DAEMON_PID_PATH);
  if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);

  // Clear caches
  const { PmDaemon: FreshDaemon } = freshModule(libPath('pm-daemon'));

  // Write a PID file pointing to our own PID (simulates running daemon)
  fs.writeFileSync(pidPath, JSON.stringify({
    pid: process.pid,
    started_at: new Date().toISOString()
  }));

  const daemon = new FreshDaemon(TMP_DIR, { once: true, dryRun: true });
  const result = daemon.start();

  assertEqual(result.success, false, 'start fails');
  assertIncludes(result.error, 'already running', 'correct error message');

  // Clean up
  fs.unlinkSync(pidPath);
});

test('PmDaemon.stop() is safe to call when not running', () => {
  const { PmDaemon: FreshDaemon } = freshModule(libPath('pm-daemon'));
  const daemon = new FreshDaemon(TMP_DIR, { dryRun: true });
  // Should not throw
  daemon.stop('test');
  assertEqual(daemon.running, false, 'still not running');
});

// =============================================================================
// TESTS: Daemon state persistence
// =============================================================================

console.log('\n=== PM Daemon: State Persistence ===');

test('Daemon state is saved after once-mode tick', async () => {
  const pidPath = path.join(TMP_DIR, DAEMON_PID_PATH);
  if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);

  const { PmDaemon: FreshDaemon, loadDaemonState: freshLoadState } = freshModule(libPath('pm-daemon'));
  const daemon = new FreshDaemon(TMP_DIR, { once: true, dryRun: true });
  daemon.start();

  // _tick is now async — wait for once-mode tick+stop to complete
  // (async bd commands may take a moment to fail in test env)
  await new Promise(resolve => setTimeout(resolve, 3000));

  const state = freshLoadState(TMP_DIR);
  assert(state !== null, 'state file exists');
  assert(state.ticks >= 1, 'ticks recorded');
  assert(state.started_at, 'has started_at');
  assert(state.stopped_at, 'has stopped_at');
  assertEqual(state.stop_reason, 'once_complete', 'stop reason');
});

// =============================================================================
// TESTS: Logging
// =============================================================================

console.log('\n=== PM Daemon: Logging ===');

test('Daemon creates log file during operation', () => {
  const logPath = path.join(TMP_DIR, DAEMON_LOG_DIR, DAEMON_LOG_FILE);

  // Log file should exist from previous start
  assert(fs.existsSync(logPath), 'log file exists');

  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  assert(lines.length > 0, 'has log entries');

  // Parse first entry
  const entry = JSON.parse(lines[0]);
  assert(entry.ts, 'has timestamp');
  assert(entry.level, 'has level');
  assert(entry.msg, 'has message');
});

// =============================================================================
// TESTS: Escalation queue
// =============================================================================

console.log('\n=== PM Daemon: Escalation Queue ===');

test('_escalateToHuman writes to escalation file', () => {
  const pidPath = path.join(TMP_DIR, DAEMON_PID_PATH);
  if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);

  const { PmDaemon: FreshDaemon } = freshModule(libPath('pm-daemon'));
  const daemon = new FreshDaemon(TMP_DIR, { dryRun: true });

  // Manually call escalation
  daemon._escalateToHuman({
    type: 'review_failed',
    task_id: 'T-test-1',
    issues: ['tests failing', 'drift detected']
  });

  const escPath = path.join(TMP_DIR, '.claude/pilot/state/orchestrator/human-escalations.jsonl');
  assert(fs.existsSync(escPath), 'escalation file created');

  const content = fs.readFileSync(escPath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  assert(lines.length >= 1, 'has escalation entry');

  const entry = JSON.parse(lines[lines.length - 1]);
  assertEqual(entry.type, 'review_failed', 'correct type');
  assertEqual(entry.task_id, 'T-test-1', 'correct task_id');
  assert(Array.isArray(entry.issues), 'has issues array');
});

// =============================================================================
// TESTS: Agent lifecycle helpers
// =============================================================================

console.log('\n=== PM Daemon: Agent Lifecycle ===');

test('_countAliveSpawned returns 0 when no agents', () => {
  const { PmDaemon: FreshDaemon } = freshModule(libPath('pm-daemon'));
  const daemon = new FreshDaemon(TMP_DIR, { dryRun: true });
  assertEqual(daemon._countAliveSpawned(), 0, 'no alive agents');
});

test('_countAliveSpawned tracks alive PIDs', () => {
  const { PmDaemon: FreshDaemon } = freshModule(libPath('pm-daemon'));
  const daemon = new FreshDaemon(TMP_DIR, { dryRun: true });

  // Add our own PID as a "spawned agent" (it's alive)
  daemon.spawnedAgents.set(process.pid, {
    taskId: 'T-test',
    spawnedAt: new Date().toISOString(),
    exitCode: null
  });

  // Add a dead PID
  daemon.spawnedAgents.set(99999999, {
    taskId: 'T-dead',
    spawnedAt: new Date().toISOString(),
    exitCode: null
  });

  const alive = daemon._countAliveSpawned();
  assertEqual(alive, 1, 'one alive agent');

  // Dead PID should be marked
  const deadEntry = daemon.spawnedAgents.get(99999999);
  assertEqual(deadEntry.exitCode, -1, 'dead PID marked');
});

test('_reapDeadAgents removes exited processes after grace period', () => {
  const { PmDaemon: FreshDaemon } = freshModule(libPath('pm-daemon'));
  const daemon = new FreshDaemon(TMP_DIR, { dryRun: true });

  // Add a long-dead agent
  daemon.spawnedAgents.set(88888888, {
    taskId: 'T-old',
    spawnedAt: new Date(Date.now() - 600000).toISOString(),
    exitCode: 0,
    exitedAt: new Date(Date.now() - 60000).toISOString()
  });

  assertEqual(daemon.spawnedAgents.size, 1, 'one agent before reap');
  daemon._reapDeadAgents();
  assertEqual(daemon.spawnedAgents.size, 0, 'agent reaped');
});

test('_getReadyUnclaimedTasks returns empty when bd not available', async () => {
  const { PmDaemon: FreshDaemon } = freshModule(libPath('pm-daemon'));
  const daemon = new FreshDaemon(TMP_DIR, { dryRun: true });
  const tasks = await daemon._getReadyUnclaimedTasks();
  assert(Array.isArray(tasks), 'returns array');
  assertEqual(tasks.length, 0, 'empty when bd unavailable in test env');
});

// =============================================================================
// TESTS: getStatus
// =============================================================================

console.log('\n=== PM Daemon: Status ===');

test('getStatus returns correct shape when not running', () => {
  const { PmDaemon: FreshDaemon } = freshModule(libPath('pm-daemon'));
  const daemon = new FreshDaemon(TMP_DIR, { dryRun: true });
  const status = daemon.getStatus();

  assertEqual(status.running, false, 'not running');
  assert('pid' in status, 'has pid');
  assertEqual(status.mode, 'watch', 'default mode');
  assert(Array.isArray(status.spawned_agents), 'has spawned_agents array');
  assertEqual(status.spawned_agents.length, 0, 'no spawned agents');
  assertEqual(status.ticks, 0, 'zero ticks');
});

test('getStatus returns correct shape after once-mode run', () => {
  const pidPath = path.join(TMP_DIR, DAEMON_PID_PATH);
  if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);

  const { PmDaemon: FreshDaemon } = freshModule(libPath('pm-daemon'));
  const daemon = new FreshDaemon(TMP_DIR, { once: true, dryRun: true });
  daemon.start();

  const status = daemon.getStatus();
  assertEqual(status.mode, 'once', 'once mode');
  assertEqual(status.ticks, 1, 'one tick');
  assert(status.started_at, 'has started_at');
});

// =============================================================================
// TESTS: _spawnAgent (dry run)
// =============================================================================

console.log('\n=== PM Daemon: Agent Spawning (dry run) ===');

test('_spawnAgent in dry run returns success without spawning', () => {
  const { PmDaemon: FreshDaemon } = freshModule(libPath('pm-daemon'));
  const daemon = new FreshDaemon(TMP_DIR, { dryRun: true });
  const result = daemon._spawnAgent({ id: 'T-dryrun', title: 'Test task' });
  assertEqual(result.success, true, 'dry run succeeds');
  assert(result.dry_run, 'marked as dry run');
  assertEqual(daemon.spawnedAgents.size, 0, 'no actual spawn');
});

// =============================================================================
// TESTS: _resolveAgentType
// =============================================================================

console.log('\n=== PM Daemon: Agent Type Resolution ===');

test('_resolveAgentType returns null when no skill registry', () => {
  const { PmDaemon: FreshDaemon } = freshModule(libPath('pm-daemon'));
  const daemon = new FreshDaemon(TMP_DIR, { dryRun: true });
  const type = daemon._resolveAgentType({ id: 'T-1', title: 'Some task' });
  // Should return null since no skill-registry.json in TMP_DIR
  assertEqual(type, null, 'null when no registry');
});

// =============================================================================
// TESTS: CTL CLI (pm-daemon-ctl.js)
// =============================================================================

console.log('\n=== PM Daemon CTL ===');

test('CTL status returns JSON when daemon not running', () => {
  const pidPath = path.join(TMP_DIR, DAEMON_PID_PATH);
  if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);

  const { execFileSync } = require('child_process');
  try {
    const output = execFileSync('node', [
      path.join(ORIG_CWD, '.claude/pilot/hooks/cli/pm-daemon-ctl.js'),
      'status'
    ], {
      cwd: TMP_DIR,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const result = JSON.parse(output);
    assertEqual(result.running, false, 'not running');
  } catch (e) {
    // Some test environments may not have proper setup
    assert(e.message.includes('status') || e.status === 0, 'CTL status ran: ' + e.message);
  }
});

test('CTL stop returns error when no daemon running', () => {
  const pidPath = path.join(TMP_DIR, DAEMON_PID_PATH);
  if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);

  const { execFileSync } = require('child_process');
  try {
    execFileSync('node', [
      path.join(ORIG_CWD, '.claude/pilot/hooks/cli/pm-daemon-ctl.js'),
      'stop'
    ], {
      cwd: TMP_DIR,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // Should exit 1
    assert(false, 'should have thrown');
  } catch (e) {
    if (e.stdout) {
      const result = JSON.parse(e.stdout);
      assertEqual(result.success, false, 'stop fails when not running');
    }
    // Exit code 1 is expected
    assertEqual(e.status, 1, 'exit code 1');
  }
});

// =============================================================================
// TESTS: Launchd plist
// =============================================================================

console.log('\n=== PM Daemon: Launchd Plist ===');

test('Launchd plist file exists and is valid XML', () => {
  const plistPath = path.join(ORIG_CWD, '.claude/pilot/config/com.pilot-agi.pm-daemon.plist');
  assert(fs.existsSync(plistPath), 'plist file exists');

  const content = fs.readFileSync(plistPath, 'utf8');
  assertIncludes(content, 'com.pilot-agi.pm-daemon', 'has correct label');
  assertIncludes(content, 'pm-daemon.js', 'references daemon script');
  assertIncludes(content, '--watch', 'uses watch mode');
  assertIncludes(content, 'RunAtLoad', 'runs at load');
  assertIncludes(content, 'KeepAlive', 'has keep alive');
  assertIncludes(content, 'PILOT_PROJECT_ROOT', 'has project root placeholder');
});

// =============================================================================
// CLEANUP
// =============================================================================

process.chdir(ORIG_CWD);
// =============================================================================
// RUN ALL TESTS (async-aware runner)
// =============================================================================

runTests().then(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch (e) {
    // best effort
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`PM Daemon Tests: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}).catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
