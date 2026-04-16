/**
 * Tests for Claude Code Adapter — Phase 6.2 (Pilot AGI-0ub)
 *
 * Tests:
 * - ClaudeAdapter interface compliance (extends AgentAdapter)
 * - detect() — finds claude CLI, handles missing CLI
 * - listModels() — returns all 3 Claude models
 * - spawn() — builds correct args for all models
 * - inject() — writes to stdin
 * - isAlive() / stop() — process lifecycle
 * - getEnforcementStrategy() — returns hooks strategy
 * - buildCommand() — builds correct CLI string
 * - Integration with AgentAdapterRegistry
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/claude-adapter.test.js
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
let mockExecFileResult = { err: null, stdout: 'claude v1.2.3\n', stderr: '' };

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

// Monkey-patch child_process for testing
const cp = require('child_process');
let _mockPid = 99999;

function installMocks() {
  mockSpawnCalls = [];
  mockExecFileCalls = [];
  _mockPid = 99999;

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
delete require.cache[require.resolve('../claude-adapter')];
delete require.cache[require.resolve('../agent-adapter')];
delete require.cache[require.resolve('../agent-adapter-registry')];

const { AgentAdapter } = require('../agent-adapter');

// ============================================================================
// TESTS: Interface Compliance
// ============================================================================

console.log('\n=== ClaudeAdapter: Interface Compliance ===\n');

test('ClaudeAdapter extends AgentAdapter', () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();
  assert.ok(adapter instanceof AgentAdapter, 'Should be instance of AgentAdapter');
  restoreMocks();
});

test('name returns "claude"', () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();
  assert.strictEqual(adapter.name, 'claude');
  restoreMocks();
});

test('displayName returns "Claude Code"', () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();
  assert.strictEqual(adapter.displayName, 'Claude Code');
  restoreMocks();
});

// ============================================================================
// TESTS: detect()
// ============================================================================

console.log('\n=== ClaudeAdapter: detect() ===\n');

testAsync('detect returns available=true when claude CLI exists', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'claude v1.2.3\n', stderr: '' };
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const result = await adapter.detect();
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.version, 'claude v1.2.3');
  assert.strictEqual(result.path, 'claude');
  restoreMocks();
});

testAsync('detect calls claude --version', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'v2.0.0', stderr: '' };
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  await adapter.detect();
  assert.strictEqual(mockExecFileCalls.length, 1);
  assert.strictEqual(mockExecFileCalls[0].cmd, 'claude');
  assert.deepStrictEqual(mockExecFileCalls[0].args, ['--version']);
  restoreMocks();
});

testAsync('detect returns available=false when claude CLI missing', async () => {
  installMocks();
  mockExecFileResult = { err: new Error('ENOENT'), stdout: '', stderr: '' };
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const result = await adapter.detect();
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.version, undefined);
  restoreMocks();
});

testAsync('detect trims version whitespace', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: '  claude v3.0.0  \n', stderr: '' };
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const result = await adapter.detect();
  assert.strictEqual(result.version, 'claude v3.0.0');
  restoreMocks();
});

// ============================================================================
// TESTS: listModels()
// ============================================================================

console.log('\n=== ClaudeAdapter: listModels() ===\n');

testAsync('listModels returns exactly 3 Claude models', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const models = await adapter.listModels();
  assert.strictEqual(models.length, 3);
  restoreMocks();
});

testAsync('listModels includes Opus, Sonnet, Haiku', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const models = await adapter.listModels();
  const ids = models.map(m => m.id);
  assert.ok(ids.includes('claude-opus-4-6'), 'Should include Opus');
  assert.ok(ids.includes('claude-sonnet-4-5'), 'Should include Sonnet');
  assert.ok(ids.includes('claude-haiku-4-5'), 'Should include Haiku');
  restoreMocks();
});

testAsync('all models have provider "anthropic"', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const models = await adapter.listModels();
  assert.ok(models.every(m => m.provider === 'anthropic'));
  restoreMocks();
});

testAsync('all models have non-empty capabilities', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const models = await adapter.listModels();
  assert.ok(models.every(m => Array.isArray(m.capabilities) && m.capabilities.length > 0));
  restoreMocks();
});

testAsync('Opus has reasoning capability', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const models = await adapter.listModels();
  const opus = models.find(m => m.id === 'claude-opus-4-6');
  assert.ok(opus.capabilities.includes('reasoning'));
  restoreMocks();
});

testAsync('Haiku has cheap capability', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const models = await adapter.listModels();
  const haiku = models.find(m => m.id === 'claude-haiku-4-5');
  assert.ok(haiku.capabilities.includes('cheap'));
  restoreMocks();
});

// ============================================================================
// TESTS: spawn()
// ============================================================================

console.log('\n=== ClaudeAdapter: spawn() ===\n');

testAsync('spawn calls child_process.spawn with claude command', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  await adapter.spawn({ prompt: 'Fix bug', cwd: '/tmp' });
  assert.strictEqual(mockSpawnCalls.length, 1);
  assert.strictEqual(mockSpawnCalls[0].cmd, 'claude');
  restoreMocks();
});

testAsync('spawn includes -p flag with prompt', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  await adapter.spawn({ prompt: 'Implement feature X', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  const pIdx = args.indexOf('-p');
  assert.ok(pIdx >= 0, 'Should have -p flag');
  assert.strictEqual(args[pIdx + 1], 'Implement feature X');
  restoreMocks();
});

testAsync('spawn uses default model when none specified', async () => {
  installMocks();
  const { ClaudeAdapter, DEFAULT_MODEL } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  const modelIdx = args.indexOf('--model');
  assert.ok(modelIdx >= 0, 'Should have --model flag');
  assert.strictEqual(args[modelIdx + 1], DEFAULT_MODEL);
  restoreMocks();
});

testAsync('spawn uses specified model', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  await adapter.spawn({ prompt: 'test', model: 'claude-opus-4-6', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  const modelIdx = args.indexOf('--model');
  assert.strictEqual(args[modelIdx + 1], 'claude-opus-4-6');
  restoreMocks();
});

testAsync('spawn with Haiku model', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  await adapter.spawn({ prompt: 'write docs', model: 'claude-haiku-4-5', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  const modelIdx = args.indexOf('--model');
  assert.strictEqual(args[modelIdx + 1], 'claude-haiku-4-5');
  restoreMocks();
});

testAsync('spawn passes cwd to child process', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/project/root' });
  assert.strictEqual(mockSpawnCalls[0].opts.cwd, '/project/root');
  restoreMocks();
});

testAsync('spawn sets PILOT_CONTEXT_FILE when contextFile provided', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

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
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  await adapter.spawn({
    prompt: 'test',
    cwd: '/tmp',
    maxTokens: 50000
  });
  const env = mockSpawnCalls[0].opts.env;
  assert.strictEqual(env.PILOT_TOKEN_BUDGET, '50000');
  restoreMocks();
});

testAsync('spawn merges extra env vars', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  await adapter.spawn({
    prompt: 'test',
    cwd: '/tmp',
    env: { PILOT_TASK_HINT: 'task-123', CUSTOM_VAR: 'value' }
  });
  const env = mockSpawnCalls[0].opts.env;
  assert.strictEqual(env.PILOT_TASK_HINT, 'task-123');
  assert.strictEqual(env.CUSTOM_VAR, 'value');
  restoreMocks();
});

testAsync('spawn returns pid and sessionId', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const result = await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  assert.ok(typeof result.pid === 'number');
  assert.ok(typeof result.sessionId === 'string');
  assert.ok(result.sessionId.length > 0);
  assert.ok(result.process);
  restoreMocks();
});

testAsync('spawn uses PILOT_SESSION_ID from env if provided', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const result = await adapter.spawn({
    prompt: 'test',
    cwd: '/tmp',
    env: { PILOT_SESSION_ID: 'my-session-42' }
  });
  assert.strictEqual(result.sessionId, 'my-session-42');
  restoreMocks();
});

testAsync('spawn includes --permission-mode acceptEdits', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  const args = mockSpawnCalls[0].args;
  const permIdx = args.indexOf('--permission-mode');
  assert.ok(permIdx >= 0, 'Should have --permission-mode');
  assert.strictEqual(args[permIdx + 1], 'acceptEdits');
  restoreMocks();
});

testAsync('spawn sets detached=true and stdio pipes', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  assert.strictEqual(mockSpawnCalls[0].opts.detached, true);
  assert.deepStrictEqual(mockSpawnCalls[0].opts.stdio, ['pipe', 'pipe', 'pipe']);
  restoreMocks();
});

// ============================================================================
// TESTS: inject()
// ============================================================================

console.log('\n=== ClaudeAdapter: inject() ===\n');

testAsync('inject writes to process stdin', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

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
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const ok = await adapter.inject('nonexistent-session', 'data');
  assert.strictEqual(ok, false);
  restoreMocks();
});

testAsync('inject returns false when stdin not writable', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

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

console.log('\n=== ClaudeAdapter: readOutput() ===\n');

testAsync('readOutput returns empty string (output via agent-logger)', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const result = await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  const output = await adapter.readOutput(result.sessionId);
  assert.strictEqual(output, '');
  restoreMocks();
});

testAsync('readOutput returns empty for unknown session', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const output = await adapter.readOutput('unknown');
  assert.strictEqual(output, '');
  restoreMocks();
});

// ============================================================================
// TESTS: isAlive() / stop()
// ============================================================================

console.log('\n=== ClaudeAdapter: isAlive() / stop() ===\n');

testAsync('isAlive returns alive=false for unknown session', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const result = await adapter.isAlive('nonexistent');
  assert.strictEqual(result.alive, false);
  restoreMocks();
});

testAsync('stop removes session from process map', async () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  // Mock process.kill to not actually kill anything
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
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  // Should not throw
  await adapter.stop('nonexistent');
  restoreMocks();
});

// ============================================================================
// TESTS: getEnforcementStrategy()
// ============================================================================

console.log('\n=== ClaudeAdapter: getEnforcementStrategy() ===\n');

test('enforcement type is "hooks"', () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const strategy = adapter.getEnforcementStrategy();
  assert.strictEqual(strategy.type, 'hooks');
  restoreMocks();
});

test('enforcement includes all 4 hook paths', () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const { details } = adapter.getEnforcementStrategy();
  assert.ok(details.sessionStart, 'Should have sessionStart');
  assert.ok(details.preToolUse, 'Should have preToolUse');
  assert.ok(details.postToolUse, 'Should have postToolUse');
  assert.ok(details.userPromptSubmit, 'Should have userPromptSubmit');
  restoreMocks();
});

test('enforcement hook paths point to .claude/pilot/hooks/', () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const { details } = adapter.getEnforcementStrategy();
  const paths = Object.values(details);
  assert.ok(paths.every(p => p.startsWith('.claude/pilot/hooks/')));
  restoreMocks();
});

// ============================================================================
// TESTS: buildCommand()
// ============================================================================

console.log('\n=== ClaudeAdapter: buildCommand() ===\n');

test('buildCommand includes claude command', () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const cmd = adapter.buildCommand({ prompt: 'fix bug', model: 'claude-opus-4-6' });
  assert.ok(cmd.includes('claude'), 'Should include claude command');
  restoreMocks();
});

test('buildCommand includes model flag', () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const cmd = adapter.buildCommand({ prompt: 'test', model: 'claude-haiku-4-5' });
  assert.ok(cmd.includes('claude-haiku-4-5'));
  restoreMocks();
});

test('buildCommand uses default model when none specified', () => {
  installMocks();
  const { ClaudeAdapter, DEFAULT_MODEL } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const cmd = adapter.buildCommand({ prompt: 'test' });
  assert.ok(cmd.includes(DEFAULT_MODEL));
  restoreMocks();
});

test('buildCommand includes prompt', () => {
  installMocks();
  const { ClaudeAdapter } = freshModule('../claude-adapter');
  const adapter = new ClaudeAdapter();

  const cmd = adapter.buildCommand({ prompt: 'implement auth flow' });
  assert.ok(cmd.includes('implement auth flow'));
  restoreMocks();
});

// ============================================================================
// TESTS: Registry Integration
// ============================================================================

console.log('\n=== ClaudeAdapter: Registry Integration ===\n');

testAsync('can register with AgentAdapterRegistry', async () => {
  installMocks();
  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { ClaudeAdapter } = freshModule('../claude-adapter');

  const registry = new AgentAdapterRegistry();
  const adapter = new ClaudeAdapter();
  registry.register(adapter);

  assert.strictEqual(registry.get('claude'), adapter);
  restoreMocks();
});

testAsync('detectAll works with ClaudeAdapter', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'claude v1.5.0', stderr: '' };

  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { ClaudeAdapter } = freshModule('../claude-adapter');

  const registry = new AgentAdapterRegistry();
  registry.register(new ClaudeAdapter());

  const results = await registry.detectAll();
  const detection = results.get('claude');
  assert.strictEqual(detection.available, true);
  assert.strictEqual(detection.version, 'claude v1.5.0');
  assert.strictEqual(detection.models.length, 3);
  restoreMocks();
});

testAsync('getAdapterForModel resolves Claude models', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'claude v1.5.0', stderr: '' };

  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { ClaudeAdapter } = freshModule('../claude-adapter');

  const registry = new AgentAdapterRegistry();
  registry.register(new ClaudeAdapter());
  await registry.detectAll();

  assert.strictEqual(registry.getAdapterForModel('claude-opus-4-6').name, 'claude');
  assert.strictEqual(registry.getAdapterForModel('claude-sonnet-4-5').name, 'claude');
  assert.strictEqual(registry.getAdapterForModel('claude-haiku-4-5').name, 'claude');
  assert.strictEqual(registry.getAdapterForModel('gpt-4.5'), null);
  restoreMocks();
});

testAsync('getAllModels includes adapter name', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'v1.0', stderr: '' };

  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { ClaudeAdapter } = freshModule('../claude-adapter');

  const registry = new AgentAdapterRegistry();
  registry.register(new ClaudeAdapter());
  await registry.detectAll();

  const models = registry.getAllModels();
  assert.strictEqual(models.length, 3);
  assert.ok(models.every(m => m.adapter === 'claude'));
  restoreMocks();
});

testAsync('getSummary includes Claude adapter', async () => {
  installMocks();
  mockExecFileResult = { err: null, stdout: 'v1.0', stderr: '' };

  delete require.cache[require.resolve('../agent-adapter-registry')];
  const { AgentAdapterRegistry } = require('../agent-adapter-registry');
  const { ClaudeAdapter } = freshModule('../claude-adapter');

  const registry = new AgentAdapterRegistry();
  registry.register(new ClaudeAdapter());
  await registry.detectAll();

  const summary = registry.getSummary();
  assert.strictEqual(summary.adapters, 1);
  assert.strictEqual(summary.available, 1);
  assert.strictEqual(summary.models, 3);
  const detail = summary.details.find(d => d.name === 'claude');
  assert.ok(detail);
  assert.strictEqual(detail.displayName, 'Claude Code');
  assert.strictEqual(detail.modelCount, 3);
  restoreMocks();
});

// ============================================================================
// TESTS: Exports
// ============================================================================

console.log('\n=== ClaudeAdapter: Exports ===\n');

test('module exports ClaudeAdapter class', () => {
  installMocks();
  const mod = freshModule('../claude-adapter');
  assert.ok(typeof mod.ClaudeAdapter === 'function');
  restoreMocks();
});

test('module exports CLAUDE_MODELS array', () => {
  installMocks();
  const mod = freshModule('../claude-adapter');
  assert.ok(Array.isArray(mod.CLAUDE_MODELS));
  assert.strictEqual(mod.CLAUDE_MODELS.length, 3);
  restoreMocks();
});

test('module exports DEFAULT_MODEL string', () => {
  installMocks();
  const mod = freshModule('../claude-adapter');
  assert.strictEqual(typeof mod.DEFAULT_MODEL, 'string');
  assert.ok(mod.DEFAULT_MODEL.startsWith('claude-'));
  restoreMocks();
});

// ============================================================================
// RESULTS
// ============================================================================

async function run() {
  // Run all queued async tests sequentially
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

  // Ensure mocks are restored
  restoreMocks();

  process.exit(failed > 0 ? 1 : 0);
}

run();
