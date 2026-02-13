/**
 * Tests for Codex CLI Adapter — Phase 6.5 (Pilot AGI-eud)
 *
 * Tests:
 * - CodexAdapter interface compliance (extends AgentAdapter)
 * - detect() — finds codex CLI, handles missing CLI
 * - listModels() — returns 2 Codex models
 * - spawn() — positional prompt, --approval-mode, --quiet
 * - inject() — writes to stdin
 * - isAlive() / stop() — process lifecycle
 * - getEnforcementStrategy() — returns wrapper strategy with sandbox
 * - buildCommand() — builds correct CLI string
 * - Integration with AgentAdapterRegistry
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/codex-adapter.test.js
 */

'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');

// ============================================================================
// TEST INFRASTRUCTURE
// ============================================================================

let passed = 0;
let failed = 0;
const failures = [];
const asyncTests = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  \u2717 ${name}`);
    console.log(`    ${e.message}`);
  }
}

function testAsync(name, fn) {
  asyncTests.push({ name, fn });
}

// ============================================================================
// MOCK child_process
// ============================================================================

const originalSpawn = require('child_process').spawn;
const originalExecFile = require('child_process').execFile;

let mockSpawnCalls = [];
let mockExecFileCalls = [];
let mockExecFileResult = { err: null, stdout: 'codex v0.3.0\n', stderr: '' };

function createMockProcess(pid = 55000) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.exitCode = null;
  proc.stdin = new EventEmitter();
  proc.stdin.writable = true;
  proc.stdin.write = function(data) {
    proc.stdin.emit('data', data);
    return true;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.unref = function() {};
  proc.kill = function() {};
  return proc;
}

const cp = require('child_process');
let _mockPid = 55000;

function installMocks() {
  mockSpawnCalls = [];
  mockExecFileCalls = [];
  _mockPid = 55000;

  cp.spawn = function(cmd, args, opts) {
    mockSpawnCalls.push({ cmd, args, opts });
    return createMockProcess(_mockPid++);
  };

  cp.execFile = function(cmd, args, opts, callback) {
    mockExecFileCalls.push({ cmd, args });
    if (typeof opts === 'function') {
      callback = opts;
    }
    if (mockExecFileResult.err) {
      callback(mockExecFileResult.err, '', mockExecFileResult.stderr || '');
    } else {
      callback(null, mockExecFileResult.stdout, '');
    }
  };
}

function restoreMocks() {
  cp.spawn = originalSpawn;
  cp.execFile = originalExecFile;
}

// ============================================================================
// FRESH MODULE LOADING
// ============================================================================

function freshModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

delete require.cache[require.resolve('../codex-adapter')];
delete require.cache[require.resolve('../agent-adapter')];
delete require.cache[require.resolve('../agent-adapter-registry')];

const { AgentAdapter } = require('../agent-adapter');

// ============================================================================
// TESTS: Interface Compliance
// ============================================================================

console.log('\n=== CodexAdapter: Interface Compliance ===\n');

test('CodexAdapter extends AgentAdapter', () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();
  assert.ok(adapter instanceof AgentAdapter, 'Should be instance of AgentAdapter');
  restoreMocks();
});

test('name returns "codex"', () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();
  assert.strictEqual(adapter.name, 'codex');
  restoreMocks();
});

test('displayName returns "Codex CLI"', () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();
  assert.strictEqual(adapter.displayName, 'Codex CLI');
  restoreMocks();
});

// ============================================================================
// TESTS: detect()
// ============================================================================

console.log('\n=== CodexAdapter: detect() ===\n');

testAsync('detect returns available=true when codex CLI exists', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'codex v0.3.0\n', stderr: '' };
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const result = await adapter.detect();
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.version, 'codex v0.3.0');
  assert.strictEqual(result.path, 'codex');
  restoreMocks();
});

testAsync('detect calls codex --version', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'v0.3.0', stderr: '' };
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  await adapter.detect();
  assert.strictEqual(mockExecFileCalls.length, 1);
  assert.strictEqual(mockExecFileCalls[0].cmd, 'codex');
  assert.deepStrictEqual(mockExecFileCalls[0].args, ['--version']);
  restoreMocks();
});

testAsync('detect returns available=false when codex CLI missing', async () => {
  installMocks();
  mockExecFileResult = { err: new Error('ENOENT'), stdout: '', stderr: '' };
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const result = await adapter.detect();
  assert.strictEqual(result.available, false);
  restoreMocks();
});

testAsync('detect trims version whitespace', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: '  codex v0.4.0  \n', stderr: '' };
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const result = await adapter.detect();
  assert.strictEqual(result.version, 'codex v0.4.0');
  restoreMocks();
});

// ============================================================================
// TESTS: listModels()
// ============================================================================

console.log('\n=== CodexAdapter: listModels() ===\n');

testAsync('listModels returns exactly 2 models', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const models = await adapter.listModels();
  assert.strictEqual(models.length, 2);
  restoreMocks();
});

testAsync('listModels includes codex-mini and o4-mini', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const models = await adapter.listModels();
  const ids = models.map(m => m.id);
  assert.ok(ids.includes('codex-mini'));
  assert.ok(ids.includes('o4-mini'));
  restoreMocks();
});

testAsync('all models have provider "openai"', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const models = await adapter.listModels();
  assert.ok(models.every(m => m.provider === 'openai'));
  restoreMocks();
});

testAsync('codex-mini has code-gen capability', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const models = await adapter.listModels();
  const mini = models.find(m => m.id === 'codex-mini');
  assert.ok(mini.capabilities.includes('code-gen'));
  restoreMocks();
});

testAsync('o4-mini has reasoning capability', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const models = await adapter.listModels();
  const o4 = models.find(m => m.id === 'o4-mini');
  assert.ok(o4.capabilities.includes('reasoning'));
  restoreMocks();
});

// ============================================================================
// TESTS: spawn()
// ============================================================================

console.log('\n=== CodexAdapter: spawn() ===\n');

testAsync('spawn calls child_process.spawn with codex command', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  await adapter.spawn({ prompt: 'Fix bug', cwd: '/tmp' });
  assert.strictEqual(mockSpawnCalls.length, 1);
  assert.strictEqual(mockSpawnCalls[0].cmd, 'codex');
  restoreMocks();
});

testAsync('spawn uses prompt as first positional arg', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  await adapter.spawn({ prompt: 'Refactor auth module', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  assert.strictEqual(args[0], 'Refactor auth module');
  restoreMocks();
});

testAsync('spawn includes --approval-mode full-auto', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  const approvalIdx = args.indexOf('--approval-mode');
  assert.ok(approvalIdx >= 0);
  assert.strictEqual(args[approvalIdx + 1], 'full-auto');
  restoreMocks();
});

testAsync('spawn includes --quiet flag', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  assert.ok(args.includes('--quiet'));
  restoreMocks();
});

testAsync('spawn uses default model when none specified', async () => {
  installMocks();
  const { CodexAdapter, DEFAULT_MODEL } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  const modelIdx = args.indexOf('--model');
  assert.ok(modelIdx >= 0);
  assert.strictEqual(args[modelIdx + 1], DEFAULT_MODEL);
  restoreMocks();
});

testAsync('spawn uses specified model', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  await adapter.spawn({ prompt: 'test', model: 'o4-mini', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  const modelIdx = args.indexOf('--model');
  assert.strictEqual(args[modelIdx + 1], 'o4-mini');
  restoreMocks();
});

testAsync('spawn passes cwd to child process', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/project/root' });
  assert.strictEqual(mockSpawnCalls[0].opts.cwd, '/project/root');
  restoreMocks();
});

testAsync('spawn sets PILOT_CONTEXT_FILE when contextFile provided', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  await adapter.spawn({
    prompt: 'test',
    cwd: '/tmp',
    contextFile: '/path/to/context.json'
  });
  assert.strictEqual(mockSpawnCalls[0].opts.env.PILOT_CONTEXT_FILE, '/path/to/context.json');
  restoreMocks();
});

testAsync('spawn merges extra env vars', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  await adapter.spawn({
    prompt: 'test',
    cwd: '/tmp',
    env: { OPENAI_API_KEY: 'sk-test', PILOT_TASK_HINT: 'task-999' }
  });
  const env = mockSpawnCalls[0].opts.env;
  assert.strictEqual(env.OPENAI_API_KEY, 'sk-test');
  assert.strictEqual(env.PILOT_TASK_HINT, 'task-999');
  restoreMocks();
});

testAsync('spawn returns pid and sessionId', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const result = await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  assert.ok(typeof result.pid === 'number');
  assert.ok(typeof result.sessionId === 'string');
  assert.ok(result.process);
  restoreMocks();
});

testAsync('spawn uses PILOT_SESSION_ID from env if provided', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const result = await adapter.spawn({
    prompt: 'test',
    cwd: '/tmp',
    env: { PILOT_SESSION_ID: 'codex-session-42' }
  });
  assert.strictEqual(result.sessionId, 'codex-session-42');
  restoreMocks();
});

testAsync('spawn sets detached=true and stdio pipes', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  assert.strictEqual(mockSpawnCalls[0].opts.detached, true);
  assert.deepStrictEqual(mockSpawnCalls[0].opts.stdio, ['pipe', 'pipe', 'pipe']);
  restoreMocks();
});

// ============================================================================
// TESTS: inject()
// ============================================================================

console.log('\n=== CodexAdapter: inject() ===\n');

testAsync('inject writes to process stdin', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const result = await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  let written = '';
  const entry = adapter._processes.get(result.sessionId);
  entry.process.stdin.write = function(data) { written = data; return true; };

  const ok = await adapter.inject(result.sessionId, 'new context');
  assert.strictEqual(ok, true);
  assert.strictEqual(written, 'new context\n');
  restoreMocks();
});

testAsync('inject returns false for unknown session', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const ok = await adapter.inject('nonexistent', 'data');
  assert.strictEqual(ok, false);
  restoreMocks();
});

// ============================================================================
// TESTS: readOutput()
// ============================================================================

console.log('\n=== CodexAdapter: readOutput() ===\n');

testAsync('readOutput returns empty string', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const result = await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  const output = await adapter.readOutput(result.sessionId);
  assert.strictEqual(output, '');
  restoreMocks();
});

// ============================================================================
// TESTS: isAlive() / stop()
// ============================================================================

console.log('\n=== CodexAdapter: isAlive() / stop() ===\n');

testAsync('isAlive returns alive=false for unknown session', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const result = await adapter.isAlive('nonexistent');
  assert.strictEqual(result.alive, false);
  restoreMocks();
});

testAsync('stop removes session from process map', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const origKill = process.kill;
  process.kill = function() {};

  const result = await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  assert.ok(adapter._processes.has(result.sessionId));

  await adapter.stop(result.sessionId);
  assert.ok(!adapter._processes.has(result.sessionId));

  process.kill = origKill;
  restoreMocks();
});

testAsync('stop is safe for unknown session', async () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  await adapter.stop('nonexistent');
  restoreMocks();
});

// ============================================================================
// TESTS: getEnforcementStrategy()
// ============================================================================

console.log('\n=== CodexAdapter: getEnforcementStrategy() ===\n');

test('enforcement type is "wrapper"', () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const strategy = adapter.getEnforcementStrategy();
  assert.strictEqual(strategy.type, 'wrapper');
  restoreMocks();
});

test('enforcement has sandbox=true', () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const { details } = adapter.getEnforcementStrategy();
  assert.strictEqual(details.sandbox, true);
  restoreMocks();
});

test('enforcement includes preCommit path', () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const { details } = adapter.getEnforcementStrategy();
  assert.ok(details.preCommit);
  assert.ok(details.preCommit.includes('pre-commit'));
  restoreMocks();
});

test('enforcement includes fileWatcher=true and postRun=true', () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const { details } = adapter.getEnforcementStrategy();
  assert.strictEqual(details.fileWatcher, true);
  assert.strictEqual(details.postRun, true);
  restoreMocks();
});

// ============================================================================
// TESTS: buildCommand()
// ============================================================================

console.log('\n=== CodexAdapter: buildCommand() ===\n');

test('buildCommand starts with "codex"', () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const cmd = adapter.buildCommand({ prompt: 'fix bug', model: 'codex-mini' });
  assert.ok(cmd.startsWith('codex'));
  restoreMocks();
});

test('buildCommand includes prompt', () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const cmd = adapter.buildCommand({ prompt: 'refactor code' });
  assert.ok(cmd.includes('refactor code'));
  restoreMocks();
});

test('buildCommand includes --approval-mode full-auto', () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const cmd = adapter.buildCommand({ prompt: 'test' });
  assert.ok(cmd.includes('--approval-mode'));
  assert.ok(cmd.includes('full-auto'));
  restoreMocks();
});

test('buildCommand includes --quiet', () => {
  installMocks();
  const { CodexAdapter } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const cmd = adapter.buildCommand({ prompt: 'test' });
  assert.ok(cmd.includes('--quiet'));
  restoreMocks();
});

test('buildCommand uses default model when none specified', () => {
  installMocks();
  const { CodexAdapter, DEFAULT_MODEL } = freshModule('../codex-adapter');
  const adapter = new CodexAdapter();

  const cmd = adapter.buildCommand({ prompt: 'test' });
  assert.ok(cmd.includes(DEFAULT_MODEL));
  restoreMocks();
});

// ============================================================================
// TESTS: Registry Integration
// ============================================================================

console.log('\n=== CodexAdapter: Registry Integration ===\n');

testAsync('can register with AgentAdapterRegistry', async () => {
  installMocks();
  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { CodexAdapter } = freshModule('../codex-adapter');

  const registry = new AgentAdapterRegistry();
  const adapter = new CodexAdapter();
  registry.register(adapter);

  assert.strictEqual(registry.get('codex'), adapter);
  restoreMocks();
});

testAsync('detectAll works with CodexAdapter', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'codex v0.3.0', stderr: '' };

  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { CodexAdapter } = freshModule('../codex-adapter');

  const registry = new AgentAdapterRegistry();
  registry.register(new CodexAdapter());

  const results = await registry.detectAll();
  const detection = results.get('codex');
  assert.strictEqual(detection.available, true);
  assert.strictEqual(detection.models.length, 2);
  restoreMocks();
});

testAsync('getAdapterForModel resolves Codex models', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'codex v0.3.0', stderr: '' };

  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { CodexAdapter } = freshModule('../codex-adapter');

  const registry = new AgentAdapterRegistry();
  registry.register(new CodexAdapter());
  await registry.detectAll();

  assert.strictEqual(registry.getAdapterForModel('codex-mini').name, 'codex');
  assert.strictEqual(registry.getAdapterForModel('o4-mini').name, 'codex');
  assert.strictEqual(registry.getAdapterForModel('gpt-4.5'), null);
  restoreMocks();
});

testAsync('getSummary includes Codex adapter', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'v0.3.0', stderr: '' };

  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { CodexAdapter } = freshModule('../codex-adapter');

  const registry = new AgentAdapterRegistry();
  registry.register(new CodexAdapter());
  await registry.detectAll();

  const summary = registry.getSummary();
  assert.strictEqual(summary.adapters, 1);
  assert.strictEqual(summary.available, 1);
  assert.strictEqual(summary.models, 2);
  const detail = summary.details.find(d => d.name === 'codex');
  assert.ok(detail);
  assert.strictEqual(detail.displayName, 'Codex CLI');
  restoreMocks();
});

// ============================================================================
// TESTS: Exports
// ============================================================================

console.log('\n=== CodexAdapter: Exports ===\n');

test('module exports CodexAdapter class', () => {
  installMocks();
  const mod = freshModule('../codex-adapter');
  assert.ok(typeof mod.CodexAdapter === 'function');
  restoreMocks();
});

test('module exports CODEX_MODELS array', () => {
  installMocks();
  const mod = freshModule('../codex-adapter');
  assert.ok(Array.isArray(mod.CODEX_MODELS));
  assert.strictEqual(mod.CODEX_MODELS.length, 2);
  restoreMocks();
});

test('module exports DEFAULT_MODEL string', () => {
  installMocks();
  const mod = freshModule('../codex-adapter');
  assert.strictEqual(mod.DEFAULT_MODEL, 'codex-mini');
  restoreMocks();
});

// ============================================================================
// RESULTS
// ============================================================================

async function run() {
  for (const { name, fn } of asyncTests) {
    try {
      await fn();
      passed++;
      console.log(`  \u2713 ${name}`);
    } catch (e) {
      failed++;
      failures.push({ name, error: e.message });
      console.log(`  \u2717 ${name}`);
      console.log(`    ${e.message}`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
  }
  console.log('='.repeat(60));

  restoreMocks();

  process.exit(failed > 0 ? 1 : 0);
}

run();
