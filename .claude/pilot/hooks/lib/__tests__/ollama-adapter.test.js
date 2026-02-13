/**
 * Tests for Ollama Adapter — Phase 6.6 (Pilot AGI-5w6)
 *
 * Tests:
 * - OllamaAdapter interface compliance (extends AgentAdapter)
 * - detect() — runs `ollama list`, parses pulled models
 * - listModels() — returns 3 static local models
 * - spawn() — uses node wrapper script, strips ollama: prefix
 * - inject() — writes to stdin
 * - isAlive() / stop() — process lifecycle
 * - getEnforcementStrategy() — returns wrapper strategy with fullControl
 * - buildCommand() — builds wrapper command string
 * - _parseOllamaList() — parses ollama list output
 * - _inferCapabilities() — infers caps from model name
 * - Integration with AgentAdapterRegistry
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/ollama-adapter.test.js
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
let mockExecFileResult = { err: null, stdout: 'NAME\tID\tSIZE\tMODIFIED\nllama3.3:70b\tabc123\t40GB\t2 days ago\n', stderr: '' };

function createMockProcess(pid = 66000) {
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
let _mockPid = 66000;

function installMocks() {
  mockSpawnCalls = [];
  mockExecFileCalls = [];
  _mockPid = 66000;

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

delete require.cache[require.resolve('../ollama-adapter')];
delete require.cache[require.resolve('../agent-adapter')];
delete require.cache[require.resolve('../agent-adapter-registry')];

const { AgentAdapter } = require('../agent-adapter');

// ============================================================================
// TESTS: Interface Compliance
// ============================================================================

console.log('\n=== OllamaAdapter: Interface Compliance ===\n');

test('OllamaAdapter extends AgentAdapter', () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();
  assert.ok(adapter instanceof AgentAdapter, 'Should be instance of AgentAdapter');
  restoreMocks();
});

test('name returns "ollama"', () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();
  assert.strictEqual(adapter.name, 'ollama');
  restoreMocks();
});

test('displayName returns "Ollama (Local)"', () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();
  assert.strictEqual(adapter.displayName, 'Ollama (Local)');
  restoreMocks();
});

// ============================================================================
// TESTS: detect()
// ============================================================================

console.log('\n=== OllamaAdapter: detect() ===\n');

testAsync('detect returns available=true when ollama is installed', async () => {
  installMocks();
  mockExecFileResult = {
    err: null,
    stdout: 'NAME\tID\tSIZE\tMODIFIED\nllama3.3:70b\tabc123\t40GB\t2 days ago\n',
    stderr: ''
  };
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const result = await adapter.detect();
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.version, 'local');
  assert.strictEqual(result.path, 'ollama');
  restoreMocks();
});

testAsync('detect calls ollama list', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'NAME\tID\tSIZE\tMODIFIED\n', stderr: '' };
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  await adapter.detect();
  assert.strictEqual(mockExecFileCalls.length, 1);
  assert.strictEqual(mockExecFileCalls[0].cmd, 'ollama');
  assert.deepStrictEqual(mockExecFileCalls[0].args, ['list']);
  restoreMocks();
});

testAsync('detect returns available=false when ollama not installed', async () => {
  installMocks();
  mockExecFileResult = { err: new Error('ENOENT'), stdout: '', stderr: '' };
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const result = await adapter.detect();
  assert.strictEqual(result.available, false);
  restoreMocks();
});

testAsync('detect parses pulled models from ollama list', async () => {
  installMocks();
  mockExecFileResult = {
    err: null,
    stdout: 'NAME\tID\tSIZE\tMODIFIED\nllama3.3:70b\tabc\t40GB\t1d\ndeepseek-coder:v3\tdef\t20GB\t2d\n',
    stderr: ''
  };
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const result = await adapter.detect();
  assert.ok(Array.isArray(result.pulledModels));
  assert.strictEqual(result.pulledModels.length, 2);
  assert.strictEqual(result.pulledModels[0].name, 'llama3.3:70b');
  assert.strictEqual(result.pulledModels[1].name, 'deepseek-coder:v3');
  restoreMocks();
});

// ============================================================================
// TESTS: listModels()
// ============================================================================

console.log('\n=== OllamaAdapter: listModels() ===\n');

testAsync('listModels returns exactly 3 models', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const models = await adapter.listModels();
  assert.strictEqual(models.length, 3);
  restoreMocks();
});

testAsync('listModels includes Llama, DeepSeek Coder, Qwen', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const models = await adapter.listModels();
  const ids = models.map(m => m.id);
  assert.ok(ids.includes('ollama:llama-3.3-70b'));
  assert.ok(ids.includes('ollama:deepseek-coder-v3'));
  assert.ok(ids.includes('ollama:qwen-2.5-coder'));
  restoreMocks();
});

testAsync('all models have provider "local"', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const models = await adapter.listModels();
  assert.ok(models.every(m => m.provider === 'local'));
  restoreMocks();
});

testAsync('all models have "free" capability', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const models = await adapter.listModels();
  assert.ok(models.every(m => m.capabilities.includes('free')));
  restoreMocks();
});

testAsync('all models have "private" capability', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const models = await adapter.listModels();
  assert.ok(models.every(m => m.capabilities.includes('private')));
  restoreMocks();
});

// ============================================================================
// TESTS: spawn()
// ============================================================================

console.log('\n=== OllamaAdapter: spawn() ===\n');

testAsync('spawn calls child_process.spawn with node command', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  await adapter.spawn({ prompt: 'Write docs', cwd: '/tmp' });
  assert.strictEqual(mockSpawnCalls.length, 1);
  assert.strictEqual(mockSpawnCalls[0].cmd, 'node');
  restoreMocks();
});

testAsync('spawn first arg is wrapper script path', async () => {
  installMocks();
  const { OllamaAdapter, WRAPPER_SCRIPT } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  assert.strictEqual(args[0], WRAPPER_SCRIPT);
  restoreMocks();
});

testAsync('spawn includes --model with stripped ollama: prefix', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  await adapter.spawn({ prompt: 'test', model: 'ollama:llama-3.3-70b', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  const modelIdx = args.indexOf('--model');
  assert.ok(modelIdx >= 0);
  assert.strictEqual(args[modelIdx + 1], 'llama-3.3-70b');
  restoreMocks();
});

testAsync('spawn handles model without ollama: prefix', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  await adapter.spawn({ prompt: 'test', model: 'deepseek-coder-v3', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  const modelIdx = args.indexOf('--model');
  assert.strictEqual(args[modelIdx + 1], 'deepseek-coder-v3');
  restoreMocks();
});

testAsync('spawn includes --prompt with task prompt', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  await adapter.spawn({ prompt: 'Update README', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  const promptIdx = args.indexOf('--prompt');
  assert.ok(promptIdx >= 0);
  assert.strictEqual(args[promptIdx + 1], 'Update README');
  restoreMocks();
});

testAsync('spawn includes --task when contextFile provided', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  await adapter.spawn({
    prompt: 'test',
    cwd: '/tmp',
    contextFile: '/path/to/ctx.json'
  });
  const args = mockSpawnCalls[0].args;
  const taskIdx = args.indexOf('--task');
  assert.ok(taskIdx >= 0);
  assert.strictEqual(args[taskIdx + 1], '/path/to/ctx.json');
  restoreMocks();
});

testAsync('spawn does not include --task when no contextFile', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  assert.ok(!args.includes('--task'));
  restoreMocks();
});

testAsync('spawn passes cwd to child process', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/project/root' });
  assert.strictEqual(mockSpawnCalls[0].opts.cwd, '/project/root');
  restoreMocks();
});

testAsync('spawn sets PILOT_CONTEXT_FILE env when contextFile provided', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  await adapter.spawn({
    prompt: 'test',
    cwd: '/tmp',
    contextFile: '/ctx.json'
  });
  assert.strictEqual(mockSpawnCalls[0].opts.env.PILOT_CONTEXT_FILE, '/ctx.json');
  restoreMocks();
});

testAsync('spawn sets PILOT_TOKEN_BUDGET env when maxTokens provided', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/tmp', maxTokens: 8000 });
  assert.strictEqual(mockSpawnCalls[0].opts.env.PILOT_TOKEN_BUDGET, '8000');
  restoreMocks();
});

testAsync('spawn returns pid and sessionId', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const result = await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  assert.ok(typeof result.pid === 'number');
  assert.ok(typeof result.sessionId === 'string');
  assert.ok(result.sessionId.startsWith('ollama-'));
  assert.ok(result.process);
  restoreMocks();
});

testAsync('spawn uses PILOT_SESSION_ID from env if provided', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const result = await adapter.spawn({
    prompt: 'test',
    cwd: '/tmp',
    env: { PILOT_SESSION_ID: 'ollama-session-42' }
  });
  assert.strictEqual(result.sessionId, 'ollama-session-42');
  restoreMocks();
});

testAsync('spawn sets detached=true and stdio pipes', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  assert.strictEqual(mockSpawnCalls[0].opts.detached, true);
  assert.deepStrictEqual(mockSpawnCalls[0].opts.stdio, ['pipe', 'pipe', 'pipe']);
  restoreMocks();
});

// ============================================================================
// TESTS: inject()
// ============================================================================

console.log('\n=== OllamaAdapter: inject() ===\n');

testAsync('inject writes to process stdin', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

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
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const ok = await adapter.inject('nonexistent', 'data');
  assert.strictEqual(ok, false);
  restoreMocks();
});

// ============================================================================
// TESTS: readOutput()
// ============================================================================

console.log('\n=== OllamaAdapter: readOutput() ===\n');

testAsync('readOutput returns empty string', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const result = await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  const output = await adapter.readOutput(result.sessionId);
  assert.strictEqual(output, '');
  restoreMocks();
});

// ============================================================================
// TESTS: isAlive() / stop()
// ============================================================================

console.log('\n=== OllamaAdapter: isAlive() / stop() ===\n');

testAsync('isAlive returns alive=false for unknown session', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const result = await adapter.isAlive('nonexistent');
  assert.strictEqual(result.alive, false);
  restoreMocks();
});

testAsync('stop removes session from process map', async () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

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
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  await adapter.stop('nonexistent');
  restoreMocks();
});

// ============================================================================
// TESTS: getEnforcementStrategy()
// ============================================================================

console.log('\n=== OllamaAdapter: getEnforcementStrategy() ===\n');

test('enforcement type is "wrapper"', () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const strategy = adapter.getEnforcementStrategy();
  assert.strictEqual(strategy.type, 'wrapper');
  restoreMocks();
});

test('enforcement has fullControl=true', () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const { details } = adapter.getEnforcementStrategy();
  assert.strictEqual(details.fullControl, true);
  restoreMocks();
});

test('enforcement includes wrapperScript path', () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const { details } = adapter.getEnforcementStrategy();
  assert.ok(details.wrapperScript);
  assert.ok(details.wrapperScript.includes('ollama-agent-wrapper'));
  restoreMocks();
});

test('enforcement includes preCommit path', () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const { details } = adapter.getEnforcementStrategy();
  assert.ok(details.preCommit);
  assert.ok(details.preCommit.includes('pre-commit'));
  restoreMocks();
});

// ============================================================================
// TESTS: buildCommand()
// ============================================================================

console.log('\n=== OllamaAdapter: buildCommand() ===\n');

test('buildCommand starts with "node"', () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const cmd = adapter.buildCommand({ model: 'ollama:llama-3.3-70b' });
  assert.ok(cmd.startsWith('node'));
  restoreMocks();
});

test('buildCommand includes wrapper script', () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const cmd = adapter.buildCommand({ model: 'ollama:llama-3.3-70b' });
  assert.ok(cmd.includes('ollama-agent-wrapper'));
  restoreMocks();
});

test('buildCommand strips ollama: prefix from model', () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const cmd = adapter.buildCommand({ model: 'ollama:deepseek-coder-v3' });
  assert.ok(cmd.includes('deepseek-coder-v3'));
  assert.ok(!cmd.includes('ollama:deepseek'));
  restoreMocks();
});

test('buildCommand includes --task when contextFile provided', () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const cmd = adapter.buildCommand({ model: 'ollama:llama-3.3-70b', contextFile: '/ctx.json' });
  assert.ok(cmd.includes('--task'));
  assert.ok(cmd.includes('/ctx.json'));
  restoreMocks();
});

// ============================================================================
// TESTS: _parseOllamaList()
// ============================================================================

console.log('\n=== OllamaAdapter: _parseOllamaList() ===\n');

test('parses single model from ollama list output', () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const result = adapter._parseOllamaList('NAME\tID\tSIZE\tMODIFIED\nllama3.3:70b\tabc123\t40GB\t2d\n');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].name, 'llama3.3:70b');
  restoreMocks();
});

test('parses multiple models', () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const output = 'NAME\tID\tSIZE\tMODIFIED\nllama3.3:70b\tabc\t40GB\t1d\ndeepseek:v3\tdef\t20GB\t2d\nqwen:2.5\tghi\t10GB\t3d\n';
  const result = adapter._parseOllamaList(output);
  assert.strictEqual(result.length, 3);
  restoreMocks();
});

test('handles empty list (header only)', () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const result = adapter._parseOllamaList('NAME\tID\tSIZE\tMODIFIED\n');
  assert.strictEqual(result.length, 0);
  restoreMocks();
});

// ============================================================================
// TESTS: _inferCapabilities()
// ============================================================================

console.log('\n=== OllamaAdapter: _inferCapabilities() ===\n');

test('infers code-gen for coder models', () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const caps = adapter._inferCapabilities('deepseek-coder-v3');
  assert.ok(caps.includes('code-gen'));
  assert.ok(caps.includes('free'));
  assert.ok(caps.includes('private'));
  restoreMocks();
});

test('infers general for llama models', () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const caps = adapter._inferCapabilities('llama-3.3-70b');
  assert.ok(caps.includes('general'));
  restoreMocks();
});

test('infers balanced for mistral models', () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const caps = adapter._inferCapabilities('mistral-7b');
  assert.ok(caps.includes('balanced'));
  restoreMocks();
});

test('always includes free and private', () => {
  installMocks();
  const { OllamaAdapter } = freshModule('../ollama-adapter');
  const adapter = new OllamaAdapter();

  const caps = adapter._inferCapabilities('unknown-model');
  assert.ok(caps.includes('free'));
  assert.ok(caps.includes('private'));
  restoreMocks();
});

// ============================================================================
// TESTS: Registry Integration
// ============================================================================

console.log('\n=== OllamaAdapter: Registry Integration ===\n');

testAsync('can register with AgentAdapterRegistry', async () => {
  installMocks();
  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { OllamaAdapter } = freshModule('../ollama-adapter');

  const registry = new AgentAdapterRegistry();
  const adapter = new OllamaAdapter();
  registry.register(adapter);

  assert.strictEqual(registry.get('ollama'), adapter);
  restoreMocks();
});

testAsync('detectAll works with OllamaAdapter', async () => {
  installMocks();
  mockExecFileResult = {
    err: null,
    stdout: 'NAME\tID\tSIZE\tMODIFIED\nllama3.3:70b\tabc\t40GB\t1d\n',
    stderr: ''
  };

  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { OllamaAdapter } = freshModule('../ollama-adapter');

  const registry = new AgentAdapterRegistry();
  registry.register(new OllamaAdapter());

  const results = await registry.detectAll();
  const detection = results.get('ollama');
  assert.strictEqual(detection.available, true);
  assert.strictEqual(detection.version, 'local');
  assert.strictEqual(detection.models.length, 3);
  restoreMocks();
});

testAsync('getAdapterForModel resolves ollama: models', async () => {
  installMocks();
  mockExecFileResult = {
    err: null,
    stdout: 'NAME\tID\tSIZE\tMODIFIED\nllama3.3:70b\tabc\t40GB\t1d\n',
    stderr: ''
  };

  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { OllamaAdapter } = freshModule('../ollama-adapter');

  const registry = new AgentAdapterRegistry();
  registry.register(new OllamaAdapter());
  await registry.detectAll();

  assert.strictEqual(registry.getAdapterForModel('ollama:llama-3.3-70b').name, 'ollama');
  assert.strictEqual(registry.getAdapterForModel('ollama:deepseek-coder-v3').name, 'ollama');
  assert.strictEqual(registry.getAdapterForModel('ollama:qwen-2.5-coder').name, 'ollama');
  assert.strictEqual(registry.getAdapterForModel('gpt-4.5'), null);
  restoreMocks();
});

testAsync('getSummary includes Ollama adapter', async () => {
  installMocks();
  mockExecFileResult = {
    err: null,
    stdout: 'NAME\tID\tSIZE\tMODIFIED\nllama3.3:70b\tabc\t40GB\t1d\n',
    stderr: ''
  };

  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { OllamaAdapter } = freshModule('../ollama-adapter');

  const registry = new AgentAdapterRegistry();
  registry.register(new OllamaAdapter());
  await registry.detectAll();

  const summary = registry.getSummary();
  assert.strictEqual(summary.adapters, 1);
  assert.strictEqual(summary.available, 1);
  assert.strictEqual(summary.models, 3);
  const detail = summary.details.find(d => d.name === 'ollama');
  assert.ok(detail);
  assert.strictEqual(detail.displayName, 'Ollama (Local)');
  restoreMocks();
});

// ============================================================================
// TESTS: Exports
// ============================================================================

console.log('\n=== OllamaAdapter: Exports ===\n');

test('module exports OllamaAdapter class', () => {
  installMocks();
  const mod = freshModule('../ollama-adapter');
  assert.ok(typeof mod.OllamaAdapter === 'function');
  restoreMocks();
});

test('module exports OLLAMA_MODELS array', () => {
  installMocks();
  const mod = freshModule('../ollama-adapter');
  assert.ok(Array.isArray(mod.OLLAMA_MODELS));
  assert.strictEqual(mod.OLLAMA_MODELS.length, 3);
  restoreMocks();
});

test('module exports DEFAULT_MODEL string', () => {
  installMocks();
  const mod = freshModule('../ollama-adapter');
  assert.strictEqual(mod.DEFAULT_MODEL, 'ollama:llama-3.3-70b');
  restoreMocks();
});

test('module exports WRAPPER_SCRIPT path', () => {
  installMocks();
  const mod = freshModule('../ollama-adapter');
  assert.ok(typeof mod.WRAPPER_SCRIPT === 'string');
  assert.ok(mod.WRAPPER_SCRIPT.includes('ollama-agent-wrapper'));
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
