/**
 * Tests for PM Daemon — Phase 3.14 (Pilot AGI-sms)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/pm-daemon.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// Test isolation
let testDir;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-daemon-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/orchestrator'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/locks'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/approved-plans'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/messages'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/logs'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/config'), { recursive: true });

  fs.writeFileSync(path.join(testDir, '.claude/pilot/policy.yaml'), `
session:
  max_concurrent_sessions: 6
orchestrator:
  cost_tracking:
    enabled: false
`);
  fs.writeFileSync(path.join(testDir, '.claude/pilot/messages/bus.jsonl'), '');
}

function cleanup() {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (e) { /* ok */ }
}

function freshRequire(modPath) {
  const keysToDelete = Object.keys(require.cache).filter(k =>
    k.includes('pm-daemon') || k.includes('pm-loop') || k.includes('pm-watcher')
  );
  keysToDelete.forEach(k => delete require.cache[k]);
  return require(modPath);
}

// ============================================================================
// TESTS
// ============================================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  setup();
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  } finally {
    cleanup();
  }
}

console.log('\nPmDaemon Tests');
console.log('═'.repeat(60));

// --- Module exports ---

console.log('\n  Module exports');

test('exports PmDaemon class and helpers', () => {
  const mod = freshRequire('../pm-daemon');
  assert.strictEqual(typeof mod.PmDaemon, 'function');
  assert.strictEqual(typeof mod.isDaemonRunning, 'function');
  assert.strictEqual(typeof mod.readDaemonPid, 'function');
  assert.strictEqual(typeof mod.loadDaemonState, 'function');
  assert.strictEqual(mod.DEFAULT_MAX_AGENTS, 6);
  assert.ok(mod.DAEMON_PID_PATH);
});

// --- Single-instance enforcement ---

console.log('\n  Single-instance enforcement');

test('isDaemonRunning returns false when no PID file', () => {
  const { isDaemonRunning } = freshRequire('../pm-daemon');
  assert.strictEqual(isDaemonRunning(testDir), false);
});

test('isDaemonRunning returns false for stale PID (dead process)', () => {
  const { isDaemonRunning, DAEMON_PID_PATH } = freshRequire('../pm-daemon');
  const pidPath = path.join(testDir, DAEMON_PID_PATH);
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, JSON.stringify({ pid: 999999, started_at: new Date().toISOString() }));
  assert.strictEqual(isDaemonRunning(testDir), false);
  // Stale PID file should be cleaned up
  assert.strictEqual(fs.existsSync(pidPath), false);
});

test('isDaemonRunning returns true for live process PID', () => {
  const { isDaemonRunning, DAEMON_PID_PATH } = freshRequire('../pm-daemon');
  const pidPath = path.join(testDir, DAEMON_PID_PATH);
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  assert.strictEqual(isDaemonRunning(testDir), true);
  fs.unlinkSync(pidPath);
});

test('second daemon start is blocked', () => {
  const { PmDaemon, DAEMON_PID_PATH } = freshRequire('../pm-daemon');
  const pidPath = path.join(testDir, DAEMON_PID_PATH);
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));

  const daemon = new PmDaemon(testDir, { once: true, dryRun: true, skipSignalHandlers: true });
  const result = daemon.start();
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('already running'));
  fs.unlinkSync(pidPath);
});

// --- Daemon state ---

console.log('\n  Daemon state');

test('loadDaemonState returns null when no state file', () => {
  const { loadDaemonState } = freshRequire('../pm-daemon');
  assert.strictEqual(loadDaemonState(testDir), null);
});

test('readDaemonPid returns null when no PID file', () => {
  const { readDaemonPid } = freshRequire('../pm-daemon');
  assert.strictEqual(readDaemonPid(testDir), null);
});

// --- Daemon lifecycle ---

console.log('\n  Daemon lifecycle');

test('creates daemon with default options', () => {
  const { PmDaemon } = freshRequire('../pm-daemon');
  const daemon = new PmDaemon(testDir);
  assert.strictEqual(daemon.running, false);
  assert.strictEqual(daemon.opts.maxAgents, 6);
  assert.strictEqual(daemon.opts.tickIntervalMs, 30000);
  assert.strictEqual(daemon.spawnedAgents.size, 0);
});

test('creates daemon with custom options', () => {
  const { PmDaemon } = freshRequire('../pm-daemon');
  const daemon = new PmDaemon(testDir, {
    maxAgents: 3,
    tickIntervalMs: 5000,
    budgetPerAgentUsd: 10,
    dryRun: true
  });
  assert.strictEqual(daemon.opts.maxAgents, 3);
  assert.strictEqual(daemon.opts.tickIntervalMs, 5000);
  assert.strictEqual(daemon.opts.budgetPerAgentUsd, 10);
  assert.strictEqual(daemon.opts.dryRun, true);
});

test('start in once+dryRun mode succeeds and auto-stops', () => {
  const { PmDaemon } = freshRequire('../pm-daemon');
  const daemon = new PmDaemon(testDir, { once: true, dryRun: true, skipSignalHandlers: true });
  const result = daemon.start();
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.mode, 'once');
  assert.ok(result.pm_session);
  assert.strictEqual(daemon.running, false);
});

test('getStatus returns correct state after once run', () => {
  const { PmDaemon } = freshRequire('../pm-daemon');
  const daemon = new PmDaemon(testDir, { once: true, dryRun: true, skipSignalHandlers: true });
  daemon.start();
  const status = daemon.getStatus();
  assert.strictEqual(status.mode, 'once');
  assert.strictEqual(status.ticks, 1);
  assert.strictEqual(status.events_processed, 0);
  assert.strictEqual(status.agents_spawned, 0);
  assert.ok(Array.isArray(status.spawned_agents));
});

// --- Agent spawn ---

console.log('\n  Agent spawn');

test('dry run spawn returns success without creating process', () => {
  const { PmDaemon } = freshRequire('../pm-daemon');
  const daemon = new PmDaemon(testDir, { dryRun: true, skipSignalHandlers: true });
  daemon.pmSessionId = 'test-pm';
  daemon.running = true;
  daemon.log = { info() {}, warn() {}, error() {}, debug() {} };

  const result = daemon._spawnAgent({ id: 'test-1', title: 'Test task' });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.dry_run, true);
});

test('budget option is stored on daemon', () => {
  const { PmDaemon } = freshRequire('../pm-daemon');
  const daemon = new PmDaemon(testDir, { budgetPerAgentUsd: 5 });
  assert.strictEqual(daemon.opts.budgetPerAgentUsd, 5);
});

// --- Dead agent reaping ---

console.log('\n  Dead agent reaping');

test('reaps agents that exited over 30s ago', () => {
  const { PmDaemon } = freshRequire('../pm-daemon');
  const daemon = new PmDaemon(testDir, { skipSignalHandlers: true });
  daemon.running = true;
  daemon.log = { info() {}, warn() {}, error() {}, debug() {} };

  daemon.spawnedAgents.set(99999, {
    taskId: 'test-1',
    agentType: 'general',
    spawnedAt: new Date(Date.now() - 120000).toISOString(),
    process: null,
    exitCode: 0,
    exitedAt: new Date(Date.now() - 60000).toISOString()
  });

  assert.strictEqual(daemon.spawnedAgents.size, 1);
  daemon._reapDeadAgents();
  assert.strictEqual(daemon.spawnedAgents.size, 0);
});

test('does not reap recently exited agents', () => {
  const { PmDaemon } = freshRequire('../pm-daemon');
  const daemon = new PmDaemon(testDir, { skipSignalHandlers: true });
  daemon.running = true;
  daemon.log = { info() {}, warn() {}, error() {}, debug() {} };

  daemon.spawnedAgents.set(99999, {
    taskId: 'test-1',
    agentType: 'general',
    spawnedAt: new Date(Date.now() - 30000).toISOString(),
    process: null,
    exitCode: 0,
    exitedAt: new Date().toISOString()
  });

  daemon._reapDeadAgents();
  assert.strictEqual(daemon.spawnedAgents.size, 1);
});

// --- Human escalation ---

console.log('\n  Human escalation');

test('writes escalation to jsonl file', () => {
  const { PmDaemon } = freshRequire('../pm-daemon');
  const daemon = new PmDaemon(testDir, { skipSignalHandlers: true });
  daemon.log = { info() {}, warn() {}, error() {}, debug() {} };

  daemon._escalateToHuman({
    type: 'review_failed',
    task_id: 'test-1',
    issues: ['drift detected']
  });

  const escalationPath = path.join(testDir, '.claude/pilot/state/orchestrator/human-escalations.jsonl');
  assert.ok(fs.existsSync(escalationPath));
  const entry = JSON.parse(fs.readFileSync(escalationPath, 'utf8').trim());
  assert.strictEqual(entry.type, 'review_failed');
  assert.strictEqual(entry.task_id, 'test-1');
});

// --- Logging ---

console.log('\n  Logging');

test('creates log file on daemon start', () => {
  const { PmDaemon } = freshRequire('../pm-daemon');
  const daemon = new PmDaemon(testDir, { once: true, dryRun: true, skipSignalHandlers: true });
  daemon.start();

  const logPath = path.join(testDir, '.claude/pilot/logs/pm-daemon.log');
  assert.ok(fs.existsSync(logPath));
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.ok(lines.length > 0);
  const first = JSON.parse(lines[0]);
  assert.strictEqual(first.msg, 'PM Daemon starting');
});

// --- PmLoop task scan fix ---

console.log('\n  PmLoop task scan fix');

test('_taskScan does not loop infinitely', () => {
  const { PmLoop } = freshRequire('../pm-loop');
  const loop = new PmLoop(testDir, { pmSessionId: 'test', dryRun: true });
  loop.running = true;
  loop.lastTaskScan = 0;

  // Mock to return tasks without calling bd
  loop._getAllReadyTasks = () => [
    { id: 'task-1', title: 'First task', labels: [] },
    { id: 'task-2', title: 'Second task', labels: [] }
  ];

  const start = Date.now();
  const results = loop._taskScan();
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 5000, `Task scan took ${elapsed}ms (should be < 5000ms)`);
  assert.ok(Array.isArray(results));
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log('\n' + '═'.repeat(60));
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═'.repeat(60) + '\n');

if (failed > 0) process.exit(1);
