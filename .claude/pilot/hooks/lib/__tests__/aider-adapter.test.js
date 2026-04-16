/**
 * Tests for Aider Adapter — Phase 6.3 (Pilot AGI-7u3)
 *
 * Tests:
 * - AiderAdapter interface compliance (extends AgentAdapter)
 * - detect() — finds aider CLI, handles missing CLI
 * - listModels() — returns all 4 Aider models
 * - spawn() — builds correct args for all models
 * - inject() — writes to stdin
 * - isAlive() / stop() — process lifecycle
 * - getEnforcementStrategy() — returns git-hooks strategy
 * - buildCommand() — builds correct CLI string
 * - Integration with AgentAdapterRegistry
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/aider-adapter.test.js
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
let mockExecFileResult = { err: null, stdout: 'aider v0.50.0\n', stderr: '' };

function createMockProcess(pid = 99999) {
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
let _mockPid = 88000;

function installMocks() {
  mockSpawnCalls = [];
  mockExecFileCalls = [];
  _mockPid = 88000;

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

// Clear caches
delete require.cache[require.resolve('../aider-adapter')];
delete require.cache[require.resolve('../agent-adapter')];
delete require.cache[require.resolve('../agent-adapter-registry')];

const { AgentAdapter } = require('../agent-adapter');

// ============================================================================
// TESTS: Interface Compliance
// ============================================================================

console.log('\n=== AiderAdapter: Interface Compliance ===\n');

test('AiderAdapter extends AgentAdapter', () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();
  assert.ok(adapter instanceof AgentAdapter, 'Should be instance of AgentAdapter');
  restoreMocks();
});

test('name returns "aider"', () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();
  assert.strictEqual(adapter.name, 'aider');
  restoreMocks();
});

test('displayName returns "Aider"', () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();
  assert.strictEqual(adapter.displayName, 'Aider');
  restoreMocks();
});

// ============================================================================
// TESTS: detect()
// ============================================================================

console.log('\n=== AiderAdapter: detect() ===\n');

testAsync('detect returns available=true when aider CLI exists', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'aider v0.50.0\n', stderr: '' };
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const result = await adapter.detect();
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.version, 'aider v0.50.0');
  assert.strictEqual(result.path, 'aider');
  restoreMocks();
});

testAsync('detect calls aider --version', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'v0.50.0', stderr: '' };
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  await adapter.detect();
  assert.strictEqual(mockExecFileCalls.length, 1);
  assert.strictEqual(mockExecFileCalls[0].cmd, 'aider');
  assert.deepStrictEqual(mockExecFileCalls[0].args, ['--version']);
  restoreMocks();
});

testAsync('detect returns available=false when aider CLI missing', async () => {
  installMocks();
  mockExecFileResult = { err: new Error('ENOENT'), stdout: '', stderr: '' };
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const result = await adapter.detect();
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.version, undefined);
  restoreMocks();
});

testAsync('detect trims version whitespace', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: '  aider v0.51.0  \n', stderr: '' };
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const result = await adapter.detect();
  assert.strictEqual(result.version, 'aider v0.51.0');
  restoreMocks();
});

// ============================================================================
// TESTS: listModels()
// ============================================================================

console.log('\n=== AiderAdapter: listModels() ===\n');

testAsync('listModels returns exactly 4 models', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const models = await adapter.listModels();
  assert.strictEqual(models.length, 4);
  restoreMocks();
});

testAsync('listModels includes GPT-4.5, GPT-4o, o3-mini, DeepSeek', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const models = await adapter.listModels();
  const ids = models.map(m => m.id);
  assert.ok(ids.includes('gpt-4.5'), 'Should include gpt-4.5');
  assert.ok(ids.includes('gpt-4o'), 'Should include gpt-4o');
  assert.ok(ids.includes('o3-mini'), 'Should include o3-mini');
  assert.ok(ids.includes('deepseek-chat'), 'Should include deepseek-chat');
  restoreMocks();
});

testAsync('OpenAI models have provider "openai"', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const models = await adapter.listModels();
  const openaiModels = models.filter(m => m.provider === 'openai');
  assert.strictEqual(openaiModels.length, 3);
  restoreMocks();
});

testAsync('DeepSeek model has provider "deepseek"', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const models = await adapter.listModels();
  const ds = models.find(m => m.id === 'deepseek-chat');
  assert.strictEqual(ds.provider, 'deepseek');
  restoreMocks();
});

testAsync('all models have non-empty capabilities', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const models = await adapter.listModels();
  assert.ok(models.every(m => Array.isArray(m.capabilities) && m.capabilities.length > 0));
  restoreMocks();
});

testAsync('o3-mini has reasoning capability', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const models = await adapter.listModels();
  const o3 = models.find(m => m.id === 'o3-mini');
  assert.ok(o3.capabilities.includes('reasoning'));
  restoreMocks();
});

testAsync('DeepSeek has bulk capability', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const models = await adapter.listModels();
  const ds = models.find(m => m.id === 'deepseek-chat');
  assert.ok(ds.capabilities.includes('bulk'));
  restoreMocks();
});

// ============================================================================
// TESTS: spawn()
// ============================================================================

console.log('\n=== AiderAdapter: spawn() ===\n');

testAsync('spawn calls child_process.spawn with aider command', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  await adapter.spawn({ prompt: 'Fix bug', cwd: '/tmp' });
  assert.strictEqual(mockSpawnCalls.length, 1);
  assert.strictEqual(mockSpawnCalls[0].cmd, 'aider');
  restoreMocks();
});

testAsync('spawn includes --message flag with prompt', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  await adapter.spawn({ prompt: 'Implement feature X', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  const msgIdx = args.indexOf('--message');
  assert.ok(msgIdx >= 0, 'Should have --message flag');
  assert.strictEqual(args[msgIdx + 1], 'Implement feature X');
  restoreMocks();
});

testAsync('spawn uses default model when none specified', async () => {
  installMocks();
  const { AiderAdapter, DEFAULT_MODEL } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  const modelIdx = args.indexOf('--model');
  assert.ok(modelIdx >= 0, 'Should have --model flag');
  assert.strictEqual(args[modelIdx + 1], DEFAULT_MODEL);
  restoreMocks();
});

testAsync('spawn uses specified model', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  await adapter.spawn({ prompt: 'test', model: 'o3-mini', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  const modelIdx = args.indexOf('--model');
  assert.strictEqual(args[modelIdx + 1], 'o3-mini');
  restoreMocks();
});

testAsync('spawn with DeepSeek model', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  await adapter.spawn({ prompt: 'generate code', model: 'deepseek-chat', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  const modelIdx = args.indexOf('--model');
  assert.strictEqual(args[modelIdx + 1], 'deepseek-chat');
  restoreMocks();
});

testAsync('spawn includes --yes-always flag', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  assert.ok(args.includes('--yes-always'), 'Should have --yes-always');
  restoreMocks();
});

testAsync('spawn includes --no-auto-commits flag', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  assert.ok(args.includes('--no-auto-commits'), 'Should have --no-auto-commits');
  restoreMocks();
});

testAsync('spawn includes --no-suggest-shell-commands flag', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  assert.ok(args.includes('--no-suggest-shell-commands'), 'Should have --no-suggest-shell-commands');
  restoreMocks();
});

testAsync('spawn passes cwd to child process', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/project/root' });
  assert.strictEqual(mockSpawnCalls[0].opts.cwd, '/project/root');
  restoreMocks();
});

testAsync('spawn includes --read flag when contextFile provided', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  await adapter.spawn({
    prompt: 'test',
    cwd: '/tmp',
    contextFile: '/path/to/context.json'
  });
  const args = mockSpawnCalls[0].args;
  const readIdx = args.indexOf('--read');
  assert.ok(readIdx >= 0, 'Should have --read flag');
  assert.strictEqual(args[readIdx + 1], '/path/to/context.json');
  restoreMocks();
});

testAsync('spawn does not include --read when no contextFile', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  assert.ok(!args.includes('--read'), 'Should not have --read without contextFile');
  restoreMocks();
});

testAsync('spawn sets PILOT_CONTEXT_FILE when contextFile provided', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

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
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  await adapter.spawn({
    prompt: 'test',
    cwd: '/tmp',
    maxTokens: 50000
  });
  const env = mockSpawnCalls[0].opts.env;
  assert.strictEqual(env.PILOT_TOKEN_BUDGET, '50000');
  restoreMocks();
});

testAsync('spawn sets AIDER_MODEL env var when model specified', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  await adapter.spawn({ prompt: 'test', model: 'gpt-4o', cwd: '/tmp' });
  const env = mockSpawnCalls[0].opts.env;
  assert.strictEqual(env.AIDER_MODEL, 'gpt-4o');
  restoreMocks();
});

testAsync('spawn merges extra env vars', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  await adapter.spawn({
    prompt: 'test',
    cwd: '/tmp',
    env: { PILOT_TASK_HINT: 'task-456', OPENAI_API_KEY: 'sk-test' }
  });
  const env = mockSpawnCalls[0].opts.env;
  assert.strictEqual(env.PILOT_TASK_HINT, 'task-456');
  assert.strictEqual(env.OPENAI_API_KEY, 'sk-test');
  restoreMocks();
});

testAsync('spawn returns pid and sessionId', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const result = await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  assert.ok(typeof result.pid === 'number');
  assert.ok(typeof result.sessionId === 'string');
  assert.ok(result.sessionId.length > 0);
  assert.ok(result.process);
  restoreMocks();
});

testAsync('spawn uses PILOT_SESSION_ID from env if provided', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const result = await adapter.spawn({
    prompt: 'test',
    cwd: '/tmp',
    env: { PILOT_SESSION_ID: 'aider-session-42' }
  });
  assert.strictEqual(result.sessionId, 'aider-session-42');
  restoreMocks();
});

testAsync('spawn sets detached=true and stdio pipes', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  assert.strictEqual(mockSpawnCalls[0].opts.detached, true);
  assert.deepStrictEqual(mockSpawnCalls[0].opts.stdio, ['pipe', 'pipe', 'pipe']);
  restoreMocks();
});

// ============================================================================
// TESTS: inject()
// ============================================================================

console.log('\n=== AiderAdapter: inject() ===\n');

testAsync('inject writes to process stdin', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

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
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const ok = await adapter.inject('nonexistent-session', 'data');
  assert.strictEqual(ok, false);
  restoreMocks();
});

testAsync('inject returns false when stdin not writable', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

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

console.log('\n=== AiderAdapter: readOutput() ===\n');

testAsync('readOutput returns empty string', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const result = await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  const output = await adapter.readOutput(result.sessionId);
  assert.strictEqual(output, '');
  restoreMocks();
});

testAsync('readOutput returns empty for unknown session', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const output = await adapter.readOutput('unknown');
  assert.strictEqual(output, '');
  restoreMocks();
});

// ============================================================================
// TESTS: isAlive() / stop()
// ============================================================================

console.log('\n=== AiderAdapter: isAlive() / stop() ===\n');

testAsync('isAlive returns alive=false for unknown session', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const result = await adapter.isAlive('nonexistent');
  assert.strictEqual(result.alive, false);
  restoreMocks();
});

testAsync('stop removes session from process map', async () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

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
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  await adapter.stop('nonexistent');
  restoreMocks();
});

// ============================================================================
// TESTS: getEnforcementStrategy()
// ============================================================================

console.log('\n=== AiderAdapter: getEnforcementStrategy() ===\n');

test('enforcement type is "git-hooks"', () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const strategy = adapter.getEnforcementStrategy();
  assert.strictEqual(strategy.type, 'git-hooks');
  restoreMocks();
});

test('enforcement includes preCommit path', () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const { details } = adapter.getEnforcementStrategy();
  assert.ok(details.preCommit, 'Should have preCommit');
  assert.ok(details.preCommit.includes('pre-commit'), 'preCommit should reference pre-commit hook');
  restoreMocks();
});

test('enforcement includes fileWatcher=true', () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const { details } = adapter.getEnforcementStrategy();
  assert.strictEqual(details.fileWatcher, true);
  restoreMocks();
});

test('enforcement includes postRun=true', () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const { details } = adapter.getEnforcementStrategy();
  assert.strictEqual(details.postRun, true);
  restoreMocks();
});

// ============================================================================
// TESTS: buildCommand()
// ============================================================================

console.log('\n=== AiderAdapter: buildCommand() ===\n');

test('buildCommand includes aider command', () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const cmd = adapter.buildCommand({ prompt: 'fix bug', model: 'gpt-4.5' });
  assert.ok(cmd.startsWith('aider'), 'Should start with aider command');
  restoreMocks();
});

test('buildCommand includes --message with prompt', () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const cmd = adapter.buildCommand({ prompt: 'implement auth', model: 'gpt-4o' });
  assert.ok(cmd.includes('--message'));
  assert.ok(cmd.includes('implement auth'));
  restoreMocks();
});

test('buildCommand includes model flag', () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const cmd = adapter.buildCommand({ prompt: 'test', model: 'deepseek-chat' });
  assert.ok(cmd.includes('deepseek-chat'));
  restoreMocks();
});

test('buildCommand uses default model when none specified', () => {
  installMocks();
  const { AiderAdapter, DEFAULT_MODEL } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const cmd = adapter.buildCommand({ prompt: 'test' });
  assert.ok(cmd.includes(DEFAULT_MODEL));
  restoreMocks();
});

test('buildCommand includes --yes-always', () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const cmd = adapter.buildCommand({ prompt: 'test' });
  assert.ok(cmd.includes('--yes-always'));
  restoreMocks();
});

test('buildCommand includes --read when contextFile provided', () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const cmd = adapter.buildCommand({ prompt: 'test', contextFile: '/ctx.json' });
  assert.ok(cmd.includes('--read'));
  assert.ok(cmd.includes('/ctx.json'));
  restoreMocks();
});

test('buildCommand excludes --read when no contextFile', () => {
  installMocks();
  const { AiderAdapter } = freshModule('../aider-adapter');
  const adapter = new AiderAdapter();

  const cmd = adapter.buildCommand({ prompt: 'test' });
  assert.ok(!cmd.includes('--read'));
  restoreMocks();
});

// ============================================================================
// TESTS: Registry Integration
// ============================================================================

console.log('\n=== AiderAdapter: Registry Integration ===\n');

testAsync('can register with AgentAdapterRegistry', async () => {
  installMocks();
  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { AiderAdapter } = freshModule('../aider-adapter');

  const registry = new AgentAdapterRegistry();
  const adapter = new AiderAdapter();
  registry.register(adapter);

  assert.strictEqual(registry.get('aider'), adapter);
  restoreMocks();
});

testAsync('detectAll works with AiderAdapter', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'aider v0.50.0', stderr: '' };

  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { AiderAdapter } = freshModule('../aider-adapter');

  const registry = new AgentAdapterRegistry();
  registry.register(new AiderAdapter());

  const results = await registry.detectAll();
  const detection = results.get('aider');
  assert.strictEqual(detection.available, true);
  assert.strictEqual(detection.version, 'aider v0.50.0');
  assert.strictEqual(detection.models.length, 4);
  restoreMocks();
});

testAsync('getAdapterForModel resolves Aider models', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'aider v0.50.0', stderr: '' };

  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { AiderAdapter } = freshModule('../aider-adapter');

  const registry = new AgentAdapterRegistry();
  registry.register(new AiderAdapter());
  await registry.detectAll();

  assert.strictEqual(registry.getAdapterForModel('gpt-4.5').name, 'aider');
  assert.strictEqual(registry.getAdapterForModel('gpt-4o').name, 'aider');
  assert.strictEqual(registry.getAdapterForModel('o3-mini').name, 'aider');
  assert.strictEqual(registry.getAdapterForModel('deepseek-chat').name, 'aider');
  assert.strictEqual(registry.getAdapterForModel('claude-opus-4-6'), null);
  restoreMocks();
});

testAsync('getAllModels includes adapter name', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'v0.50.0', stderr: '' };

  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { AiderAdapter } = freshModule('../aider-adapter');

  const registry = new AgentAdapterRegistry();
  registry.register(new AiderAdapter());
  await registry.detectAll();

  const models = registry.getAllModels();
  assert.strictEqual(models.length, 4);
  assert.ok(models.every(m => m.adapter === 'aider'));
  restoreMocks();
});

testAsync('getSummary includes Aider adapter', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'v0.50.0', stderr: '' };

  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { AiderAdapter } = freshModule('../aider-adapter');

  const registry = new AgentAdapterRegistry();
  registry.register(new AiderAdapter());
  await registry.detectAll();

  const summary = registry.getSummary();
  assert.strictEqual(summary.adapters, 1);
  assert.strictEqual(summary.available, 1);
  assert.strictEqual(summary.models, 4);
  const detail = summary.details.find(d => d.name === 'aider');
  assert.ok(detail);
  assert.strictEqual(detail.displayName, 'Aider');
  assert.strictEqual(detail.modelCount, 4);
  restoreMocks();
});

// ============================================================================
// TESTS: Exports
// ============================================================================

console.log('\n=== AiderAdapter: Exports ===\n');

test('module exports AiderAdapter class', () => {
  installMocks();
  const mod = freshModule('../aider-adapter');
  assert.ok(typeof mod.AiderAdapter === 'function');
  restoreMocks();
});

test('module exports AIDER_MODELS array', () => {
  installMocks();
  const mod = freshModule('../aider-adapter');
  assert.ok(Array.isArray(mod.AIDER_MODELS));
  assert.strictEqual(mod.AIDER_MODELS.length, 4);
  restoreMocks();
});

test('module exports DEFAULT_MODEL string', () => {
  installMocks();
  const mod = freshModule('../aider-adapter');
  assert.strictEqual(typeof mod.DEFAULT_MODEL, 'string');
  assert.strictEqual(mod.DEFAULT_MODEL, 'gpt-4.5');
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
