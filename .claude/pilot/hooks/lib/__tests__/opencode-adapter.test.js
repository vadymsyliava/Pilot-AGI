/**
 * Tests for OpenCode Adapter — Phase 6.4 (Pilot AGI-pg3)
 *
 * Tests:
 * - OpenCodeAdapter interface compliance (extends AgentAdapter)
 * - detect() — finds opencode CLI, handles missing CLI
 * - listModels() — returns all 2 Gemini models
 * - spawn() — builds correct args with -m flag
 * - inject() — writes to stdin
 * - isAlive() / stop() — process lifecycle
 * - getEnforcementStrategy() — returns wrapper strategy
 * - buildCommand() — builds correct CLI string
 * - Integration with AgentAdapterRegistry
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/opencode-adapter.test.js
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
// MOCK child_process — intercept spawn and execFile
// ============================================================================

const originalSpawn = require('child_process').spawn;
const originalExecFile = require('child_process').execFile;

let mockSpawnCalls = [];
let mockExecFileCalls = [];
let mockExecFileResult = { err: null, stdout: 'opencode v1.4.0\n', stderr: '' };

function createMockProcess(pid = 77000) {
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
let _mockPid = 77000;

function installMocks() {
  mockSpawnCalls = [];
  mockExecFileCalls = [];
  _mockPid = 77000;

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

delete require.cache[require.resolve('../opencode-adapter')];
delete require.cache[require.resolve('../agent-adapter')];
delete require.cache[require.resolve('../agent-adapter-registry')];

const { AgentAdapter } = require('../agent-adapter');

// ============================================================================
// TESTS: Interface Compliance
// ============================================================================

console.log('\n=== OpenCodeAdapter: Interface Compliance ===\n');

test('OpenCodeAdapter extends AgentAdapter', () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();
  assert.ok(adapter instanceof AgentAdapter, 'Should be instance of AgentAdapter');
  restoreMocks();
});

test('name returns "opencode"', () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();
  assert.strictEqual(adapter.name, 'opencode');
  restoreMocks();
});

test('displayName returns "OpenCode"', () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();
  assert.strictEqual(adapter.displayName, 'OpenCode');
  restoreMocks();
});

// ============================================================================
// TESTS: detect()
// ============================================================================

console.log('\n=== OpenCodeAdapter: detect() ===\n');

testAsync('detect returns available=true when opencode CLI exists', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'opencode v1.4.0\n', stderr: '' };
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const result = await adapter.detect();
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.version, 'opencode v1.4.0');
  assert.strictEqual(result.path, 'opencode');
  restoreMocks();
});

testAsync('detect calls opencode --version', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'v1.4.0', stderr: '' };
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  await adapter.detect();
  assert.strictEqual(mockExecFileCalls.length, 1);
  assert.strictEqual(mockExecFileCalls[0].cmd, 'opencode');
  assert.deepStrictEqual(mockExecFileCalls[0].args, ['--version']);
  restoreMocks();
});

testAsync('detect returns available=false when opencode CLI missing', async () => {
  installMocks();
  mockExecFileResult = { err: new Error('ENOENT'), stdout: '', stderr: '' };
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const result = await adapter.detect();
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.version, undefined);
  restoreMocks();
});

testAsync('detect trims version whitespace', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: '  opencode v1.5.0  \n', stderr: '' };
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const result = await adapter.detect();
  assert.strictEqual(result.version, 'opencode v1.5.0');
  restoreMocks();
});

// ============================================================================
// TESTS: listModels()
// ============================================================================

console.log('\n=== OpenCodeAdapter: listModels() ===\n');

testAsync('listModels returns exactly 2 models', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const models = await adapter.listModels();
  assert.strictEqual(models.length, 2);
  restoreMocks();
});

testAsync('listModels includes Gemini 2.5 Pro and Flash', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const models = await adapter.listModels();
  const ids = models.map(m => m.id);
  assert.ok(ids.includes('gemini-2.5-pro'), 'Should include gemini-2.5-pro');
  assert.ok(ids.includes('gemini-2.5-flash'), 'Should include gemini-2.5-flash');
  restoreMocks();
});

testAsync('all models have provider "google"', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const models = await adapter.listModels();
  assert.ok(models.every(m => m.provider === 'google'));
  restoreMocks();
});

testAsync('all models have non-empty capabilities', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const models = await adapter.listModels();
  assert.ok(models.every(m => Array.isArray(m.capabilities) && m.capabilities.length > 0));
  restoreMocks();
});

testAsync('Gemini Pro has fast capability', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const models = await adapter.listModels();
  const pro = models.find(m => m.id === 'gemini-2.5-pro');
  assert.ok(pro.capabilities.includes('fast'));
  restoreMocks();
});

testAsync('Gemini Flash has cheap capability', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const models = await adapter.listModels();
  const flash = models.find(m => m.id === 'gemini-2.5-flash');
  assert.ok(flash.capabilities.includes('cheap'));
  restoreMocks();
});

// ============================================================================
// TESTS: spawn()
// ============================================================================

console.log('\n=== OpenCodeAdapter: spawn() ===\n');

testAsync('spawn calls child_process.spawn with opencode command', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  await adapter.spawn({ prompt: 'Fix bug', cwd: '/tmp' });
  assert.strictEqual(mockSpawnCalls.length, 1);
  assert.strictEqual(mockSpawnCalls[0].cmd, 'opencode');
  restoreMocks();
});

testAsync('spawn includes -m flag with prompt', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  await adapter.spawn({ prompt: 'Build login page', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  const mIdx = args.indexOf('-m');
  assert.ok(mIdx >= 0, 'Should have -m flag');
  assert.strictEqual(args[mIdx + 1], 'Build login page');
  restoreMocks();
});

testAsync('spawn uses default model when none specified', async () => {
  installMocks();
  const { OpenCodeAdapter, DEFAULT_MODEL } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  const modelIdx = args.indexOf('--model');
  assert.ok(modelIdx >= 0, 'Should have --model flag');
  assert.strictEqual(args[modelIdx + 1], DEFAULT_MODEL);
  restoreMocks();
});

testAsync('spawn uses specified model', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  await adapter.spawn({ prompt: 'test', model: 'gemini-2.5-flash', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  const modelIdx = args.indexOf('--model');
  assert.strictEqual(args[modelIdx + 1], 'gemini-2.5-flash');
  restoreMocks();
});

testAsync('spawn passes cwd to child process', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/project/root' });
  assert.strictEqual(mockSpawnCalls[0].opts.cwd, '/project/root');
  restoreMocks();
});

testAsync('spawn sets PILOT_CONTEXT_FILE when contextFile provided', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  await adapter.spawn({
    prompt: 'test',
    cwd: '/tmp',
    contextFile: '/path/to/context.json'
  });
  const env = mockSpawnCalls[0].opts.env;
  assert.strictEqual(env.PILOT_CONTEXT_FILE, '/path/to/context.json');
  restoreMocks();
});

testAsync('spawn sets PILOT_TOKEN_BUDGET when maxTokens provided', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  await adapter.spawn({
    prompt: 'test',
    cwd: '/tmp',
    maxTokens: 100000
  });
  const env = mockSpawnCalls[0].opts.env;
  assert.strictEqual(env.PILOT_TOKEN_BUDGET, '100000');
  restoreMocks();
});

testAsync('spawn merges extra env vars', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  await adapter.spawn({
    prompt: 'test',
    cwd: '/tmp',
    env: { PILOT_TASK_HINT: 'task-789', GOOGLE_API_KEY: 'key-test' }
  });
  const env = mockSpawnCalls[0].opts.env;
  assert.strictEqual(env.PILOT_TASK_HINT, 'task-789');
  assert.strictEqual(env.GOOGLE_API_KEY, 'key-test');
  restoreMocks();
});

testAsync('spawn returns pid and sessionId', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const result = await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  assert.ok(typeof result.pid === 'number');
  assert.ok(typeof result.sessionId === 'string');
  assert.ok(result.sessionId.length > 0);
  assert.ok(result.process);
  restoreMocks();
});

testAsync('spawn uses PILOT_SESSION_ID from env if provided', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const result = await adapter.spawn({
    prompt: 'test',
    cwd: '/tmp',
    env: { PILOT_SESSION_ID: 'opencode-session-42' }
  });
  assert.strictEqual(result.sessionId, 'opencode-session-42');
  restoreMocks();
});

testAsync('spawn sets detached=true and stdio pipes', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  assert.strictEqual(mockSpawnCalls[0].opts.detached, true);
  assert.deepStrictEqual(mockSpawnCalls[0].opts.stdio, ['pipe', 'pipe', 'pipe']);
  restoreMocks();
});

// ============================================================================
// TESTS: inject()
// ============================================================================

console.log('\n=== OpenCodeAdapter: inject() ===\n');

testAsync('inject writes to process stdin', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

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
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const ok = await adapter.inject('nonexistent-session', 'data');
  assert.strictEqual(ok, false);
  restoreMocks();
});

testAsync('inject returns false when stdin not writable', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const result = await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  const entry = adapter._processes.get(result.sessionId);
  entry.process.stdin.writable = false;

  const ok = await adapter.inject(result.sessionId, 'data');
  assert.strictEqual(ok, false);
  restoreMocks();
});

// ============================================================================
// TESTS: readOutput()
// ============================================================================

console.log('\n=== OpenCodeAdapter: readOutput() ===\n');

testAsync('readOutput returns empty string', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const result = await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  const output = await adapter.readOutput(result.sessionId);
  assert.strictEqual(output, '');
  restoreMocks();
});

testAsync('readOutput returns empty for unknown session', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const output = await adapter.readOutput('unknown');
  assert.strictEqual(output, '');
  restoreMocks();
});

// ============================================================================
// TESTS: isAlive() / stop()
// ============================================================================

console.log('\n=== OpenCodeAdapter: isAlive() / stop() ===\n');

testAsync('isAlive returns alive=false for unknown session', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const result = await adapter.isAlive('nonexistent');
  assert.strictEqual(result.alive, false);
  restoreMocks();
});

testAsync('stop removes session from process map', async () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

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
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  await adapter.stop('nonexistent');
  restoreMocks();
});

// ============================================================================
// TESTS: getEnforcementStrategy()
// ============================================================================

console.log('\n=== OpenCodeAdapter: getEnforcementStrategy() ===\n');

test('enforcement type is "wrapper"', () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const strategy = adapter.getEnforcementStrategy();
  assert.strictEqual(strategy.type, 'wrapper');
  restoreMocks();
});

test('enforcement includes mcpServer=true', () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const { details } = adapter.getEnforcementStrategy();
  assert.strictEqual(details.mcpServer, true);
  restoreMocks();
});

test('enforcement includes preCommit path', () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const { details } = adapter.getEnforcementStrategy();
  assert.ok(details.preCommit);
  assert.ok(details.preCommit.includes('pre-commit'));
  restoreMocks();
});

test('enforcement includes fileWatcher=true', () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const { details } = adapter.getEnforcementStrategy();
  assert.strictEqual(details.fileWatcher, true);
  restoreMocks();
});

test('enforcement includes postRun=true', () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const { details } = adapter.getEnforcementStrategy();
  assert.strictEqual(details.postRun, true);
  restoreMocks();
});

// ============================================================================
// TESTS: buildCommand()
// ============================================================================

console.log('\n=== OpenCodeAdapter: buildCommand() ===\n');

test('buildCommand includes opencode command', () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const cmd = adapter.buildCommand({ prompt: 'fix bug', model: 'gemini-2.5-pro' });
  assert.ok(cmd.startsWith('opencode'), 'Should start with opencode command');
  restoreMocks();
});

test('buildCommand includes -m with prompt', () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const cmd = adapter.buildCommand({ prompt: 'build UI', model: 'gemini-2.5-flash' });
  assert.ok(cmd.includes('-m'));
  assert.ok(cmd.includes('build UI'));
  restoreMocks();
});

test('buildCommand includes model flag', () => {
  installMocks();
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const cmd = adapter.buildCommand({ prompt: 'test', model: 'gemini-2.5-flash' });
  assert.ok(cmd.includes('gemini-2.5-flash'));
  restoreMocks();
});

test('buildCommand uses default model when none specified', () => {
  installMocks();
  const { OpenCodeAdapter, DEFAULT_MODEL } = freshModule('../opencode-adapter');
  const adapter = new OpenCodeAdapter();

  const cmd = adapter.buildCommand({ prompt: 'test' });
  assert.ok(cmd.includes(DEFAULT_MODEL));
  restoreMocks();
});

// ============================================================================
// TESTS: Registry Integration
// ============================================================================

console.log('\n=== OpenCodeAdapter: Registry Integration ===\n');

testAsync('can register with AgentAdapterRegistry', async () => {
  installMocks();
  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');

  const registry = new AgentAdapterRegistry();
  const adapter = new OpenCodeAdapter();
  registry.register(adapter);

  assert.strictEqual(registry.get('opencode'), adapter);
  restoreMocks();
});

testAsync('detectAll works with OpenCodeAdapter', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'opencode v1.4.0', stderr: '' };

  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');

  const registry = new AgentAdapterRegistry();
  registry.register(new OpenCodeAdapter());

  const results = await registry.detectAll();
  const detection = results.get('opencode');
  assert.strictEqual(detection.available, true);
  assert.strictEqual(detection.version, 'opencode v1.4.0');
  assert.strictEqual(detection.models.length, 2);
  restoreMocks();
});

testAsync('getAdapterForModel resolves Gemini models', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'opencode v1.4.0', stderr: '' };

  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');

  const registry = new AgentAdapterRegistry();
  registry.register(new OpenCodeAdapter());
  await registry.detectAll();

  assert.strictEqual(registry.getAdapterForModel('gemini-2.5-pro').name, 'opencode');
  assert.strictEqual(registry.getAdapterForModel('gemini-2.5-flash').name, 'opencode');
  assert.strictEqual(registry.getAdapterForModel('claude-opus-4-6'), null);
  restoreMocks();
});

testAsync('getAllModels includes adapter name', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'v1.4.0', stderr: '' };

  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');

  const registry = new AgentAdapterRegistry();
  registry.register(new OpenCodeAdapter());
  await registry.detectAll();

  const models = registry.getAllModels();
  assert.strictEqual(models.length, 2);
  assert.ok(models.every(m => m.adapter === 'opencode'));
  restoreMocks();
});

testAsync('getSummary includes OpenCode adapter', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'v1.4.0', stderr: '' };

  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { OpenCodeAdapter } = freshModule('../opencode-adapter');

  const registry = new AgentAdapterRegistry();
  registry.register(new OpenCodeAdapter());
  await registry.detectAll();

  const summary = registry.getSummary();
  assert.strictEqual(summary.adapters, 1);
  assert.strictEqual(summary.available, 1);
  assert.strictEqual(summary.models, 2);
  const detail = summary.details.find(d => d.name === 'opencode');
  assert.ok(detail);
  assert.strictEqual(detail.displayName, 'OpenCode');
  assert.strictEqual(detail.modelCount, 2);
  restoreMocks();
});

// ============================================================================
// TESTS: Exports
// ============================================================================

console.log('\n=== OpenCodeAdapter: Exports ===\n');

test('module exports OpenCodeAdapter class', () => {
  installMocks();
  const mod = freshModule('../opencode-adapter');
  assert.ok(typeof mod.OpenCodeAdapter === 'function');
  restoreMocks();
});

test('module exports OPENCODE_MODELS array', () => {
  installMocks();
  const mod = freshModule('../opencode-adapter');
  assert.ok(Array.isArray(mod.OPENCODE_MODELS));
  assert.strictEqual(mod.OPENCODE_MODELS.length, 2);
  restoreMocks();
});

test('module exports DEFAULT_MODEL string', () => {
  installMocks();
  const mod = freshModule('../opencode-adapter');
  assert.strictEqual(typeof mod.DEFAULT_MODEL, 'string');
  assert.strictEqual(mod.DEFAULT_MODEL, 'gemini-2.5-pro');
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
