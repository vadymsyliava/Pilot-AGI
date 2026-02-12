/**
 * Tests for Agent Adapter Interface & Registry — Phase 6.1 (Pilot AGI-cni)
 *
 * Tests:
 * - AgentAdapter interface compliance (abstract methods throw)
 * - Concrete adapter implementations work
 * - AgentAdapterRegistry: register, detect, lookup, filtering
 * - Singleton: getRegistry/resetRegistry
 * - Edge cases: empty registry, detection failures, duplicate names
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/agent-adapter.test.js
 */

'use strict';

const assert = require('assert');

// ============================================================================
// TEST INFRASTRUCTURE
// ============================================================================

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

// Clear ALL caches related to agent adapter modules
for (const key of Object.keys(require.cache)) {
  if (key.includes('agent-adapter')) delete require.cache[key];
}

// Shared references — all tests use the same class instances
const { AgentAdapter } = require('../agent-adapter');
const { AgentAdapterRegistry, getRegistry, resetRegistry } = require('../agent-adapter-registry');

// ============================================================================
// MOCK ADAPTER — Concrete implementation for testing
// ============================================================================

function createMockAdapter(overrides = {}) {
  class MockAdapter extends AgentAdapter {
    get name() { return overrides.name || 'mock'; }
    get displayName() { return overrides.displayName || 'Mock Agent'; }

    async detect() {
      if (overrides.detectThrows) throw new Error(overrides.detectThrows);
      return overrides.detectResult || {
        available: true,
        version: '1.0.0',
        path: '/usr/local/bin/mock'
      };
    }

    async listModels() {
      return overrides.models || [
        { id: 'mock-fast', name: 'Mock Fast', provider: 'mock-co', capabilities: ['fast'] },
        { id: 'mock-smart', name: 'Mock Smart', provider: 'mock-co', capabilities: ['reasoning'] }
      ];
    }

    async spawn(opts) {
      return { pid: 12345, sessionId: 'mock-session-1', opts };
    }

    async inject(sessionId, content) {
      return true;
    }

    async readOutput(sessionId, lines) {
      return 'mock output line 1\nmock output line 2';
    }

    async isAlive(sessionId) {
      return { alive: true };
    }

    async stop(sessionId) {}

    getEnforcementStrategy() {
      return { type: 'wrapper', details: { wrapperScript: 'mock-enforce.sh' } };
    }

    buildCommand(opts) {
      return `mock-agent --prompt "${opts.prompt}" --model ${opts.model || 'default'}`;
    }
  }

  return new MockAdapter();
}

// ============================================================================
// TESTS: AgentAdapter Interface
// ============================================================================

console.log('\n=== AgentAdapter Interface ===\n');

test('base class throws on get name()', () => {
  const adapter = new AgentAdapter();
  assert.throws(() => adapter.name, /must implement get name/);
});

test('base class throws on get displayName()', () => {
  const adapter = new AgentAdapter();
  assert.throws(() => adapter.displayName, /must implement get displayName/);
});

test('base class throws on detect()', async () => {
  const adapter = new AgentAdapter();
  await assert.rejects(() => adapter.detect(), /must implement detect/);
});

test('base class throws on listModels()', async () => {
  const adapter = new AgentAdapter();
  await assert.rejects(() => adapter.listModels(), /must implement listModels/);
});

test('base class throws on spawn()', async () => {
  const adapter = new AgentAdapter();
  await assert.rejects(() => adapter.spawn({}), /must implement spawn/);
});

test('base class throws on inject()', async () => {
  const adapter = new AgentAdapter();
  await assert.rejects(() => adapter.inject('s1', 'ctx'), /must implement inject/);
});

test('base class throws on readOutput()', async () => {
  const adapter = new AgentAdapter();
  await assert.rejects(() => adapter.readOutput('s1'), /must implement readOutput/);
});

test('base class throws on isAlive()', async () => {
  const adapter = new AgentAdapter();
  await assert.rejects(() => adapter.isAlive('s1'), /must implement isAlive/);
});

test('base class throws on stop()', async () => {
  const adapter = new AgentAdapter();
  await assert.rejects(() => adapter.stop('s1'), /must implement stop/);
});

test('base class throws on getEnforcementStrategy()', () => {
  const adapter = new AgentAdapter();
  assert.throws(() => adapter.getEnforcementStrategy(), /must implement getEnforcementStrategy/);
});

test('base class throws on buildCommand()', () => {
  const adapter = new AgentAdapter();
  assert.throws(() => adapter.buildCommand({}), /must implement buildCommand/);
});

// ============================================================================
// TESTS: Concrete Adapter (MockAdapter)
// ============================================================================

console.log('\n=== Concrete Adapter ===\n');

test('mock adapter returns correct name', () => {
  const adapter = createMockAdapter();
  assert.strictEqual(adapter.name, 'mock');
});

test('mock adapter returns correct displayName', () => {
  const adapter = createMockAdapter();
  assert.strictEqual(adapter.displayName, 'Mock Agent');
});

test('mock adapter detect returns available=true', async () => {
  const adapter = createMockAdapter();
  const result = await adapter.detect();
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.version, '1.0.0');
});

test('mock adapter listModels returns model array', async () => {
  const adapter = createMockAdapter();
  const models = await adapter.listModels();
  assert.strictEqual(models.length, 2);
  assert.strictEqual(models[0].id, 'mock-fast');
  assert.strictEqual(models[1].id, 'mock-smart');
});

test('mock adapter spawn returns pid and sessionId', async () => {
  const adapter = createMockAdapter();
  const result = await adapter.spawn({ prompt: 'test', cwd: '/tmp' });
  assert.strictEqual(result.pid, 12345);
  assert.strictEqual(result.sessionId, 'mock-session-1');
});

test('mock adapter buildCommand returns valid string', () => {
  const adapter = createMockAdapter();
  const cmd = adapter.buildCommand({ prompt: 'hello', model: 'mock-fast' });
  assert.ok(cmd.includes('mock-agent'));
  assert.ok(cmd.includes('mock-fast'));
});

test('mock adapter getEnforcementStrategy returns strategy', () => {
  const adapter = createMockAdapter();
  const strategy = adapter.getEnforcementStrategy();
  assert.strictEqual(strategy.type, 'wrapper');
  assert.ok(strategy.details.wrapperScript);
});

test('mock adapter is instanceof AgentAdapter', () => {
  const adapter = createMockAdapter();
  assert.ok(adapter instanceof AgentAdapter);
});

// ============================================================================
// TESTS: AgentAdapterRegistry — Registration
// ============================================================================

console.log('\n=== Registry: Registration ===\n');

test('register accepts valid adapter', () => {
  const registry = new AgentAdapterRegistry();
  const adapter = createMockAdapter();
  registry.register(adapter);
  assert.strictEqual(registry.get('mock'), adapter);
});

test('register rejects non-AgentAdapter objects', () => {
  const registry = new AgentAdapterRegistry();
  assert.throws(() => registry.register(null), /must be an instance of AgentAdapter/);
  assert.throws(() => registry.register({ name: 'fake' }), /must be an instance of AgentAdapter/);
});

test('register rejects duplicate names', () => {
  const registry = new AgentAdapterRegistry();
  registry.register(createMockAdapter({ name: 'dup' }));
  assert.throws(() => registry.register(createMockAdapter({ name: 'dup' })), /already registered/);
});

test('getNames returns all registered adapter names', () => {
  const registry = new AgentAdapterRegistry();
  registry.register(createMockAdapter({ name: 'a' }));
  registry.register(createMockAdapter({ name: 'b' }));
  const names = registry.getNames();
  assert.deepStrictEqual(names.sort(), ['a', 'b']);
});

test('clear removes all adapters and detection results', () => {
  const registry = new AgentAdapterRegistry();
  registry.register(createMockAdapter({ name: 'x' }));
  registry.clear();
  assert.strictEqual(registry.getNames().length, 0);
  assert.strictEqual(registry.get('x'), undefined);
});

test('get returns undefined for unregistered name', () => {
  const registry = new AgentAdapterRegistry();
  assert.strictEqual(registry.get('nope'), undefined);
});

// ============================================================================
// TESTS: AgentAdapterRegistry — Detection
// ============================================================================

console.log('\n=== Registry: Detection ===\n');

testAsync('detectAll runs detection on all adapters', async () => {
  const registry = new AgentAdapterRegistry();
  registry.register(createMockAdapter({ name: 'alpha' }));
  registry.register(createMockAdapter({ name: 'beta' }));

  const results = await registry.detectAll();
  assert.strictEqual(results.size, 2);
  assert.strictEqual(results.get('alpha').available, true);
  assert.strictEqual(results.get('beta').available, true);
});

testAsync('detectAll merges models from listModels into detection', async () => {
  const registry = new AgentAdapterRegistry();
  registry.register(createMockAdapter({
    name: 'with-models',
    models: [{ id: 'test-m1', name: 'M1', provider: 'p', capabilities: [] }]
  }));

  const results = await registry.detectAll();
  const det = results.get('with-models');
  assert.strictEqual(det.available, true);
  assert.strictEqual(det.models.length, 1);
  assert.strictEqual(det.models[0].id, 'test-m1');
});

testAsync('detectAll handles detection failures gracefully', async () => {
  const registry = new AgentAdapterRegistry();
  registry.register(createMockAdapter({ name: 'good' }));
  registry.register(createMockAdapter({ name: 'bad', detectThrows: 'CLI not found' }));

  const results = await registry.detectAll();
  assert.strictEqual(results.get('good').available, true);
  assert.strictEqual(results.get('bad').available, false);
  assert.strictEqual(results.get('bad').error, 'CLI not found');
});

testAsync('detectAll handles unavailable adapters', async () => {
  const registry = new AgentAdapterRegistry();
  registry.register(createMockAdapter({
    name: 'missing',
    detectResult: { available: false }
  }));

  const results = await registry.detectAll();
  assert.strictEqual(results.get('missing').available, false);
});

testAsync('getAvailable returns only detected-available adapters', async () => {
  const registry = new AgentAdapterRegistry();
  registry.register(createMockAdapter({ name: 'installed' }));
  registry.register(createMockAdapter({
    name: 'missing',
    detectResult: { available: false }
  }));

  await registry.detectAll();
  const available = registry.getAvailable();
  assert.strictEqual(available.length, 1);
  assert.strictEqual(available[0].name, 'installed');
});

testAsync('getAvailable returns empty before detectAll', async () => {
  const registry = new AgentAdapterRegistry();
  registry.register(createMockAdapter({ name: 'any' }));
  assert.strictEqual(registry.getAvailable().length, 0);
});

testAsync('hasDetected is false before detectAll, true after', async () => {
  const registry = new AgentAdapterRegistry();
  registry.register(createMockAdapter({ name: 'x' }));
  assert.strictEqual(registry.hasDetected, false);
  await registry.detectAll();
  assert.strictEqual(registry.hasDetected, true);
});

testAsync('getDetection returns detection result', async () => {
  const registry = new AgentAdapterRegistry();
  registry.register(createMockAdapter({ name: 'test' }));
  await registry.detectAll();
  const det = registry.getDetection('test');
  assert.strictEqual(det.available, true);
  assert.strictEqual(det.version, '1.0.0');
});

// ============================================================================
// TESTS: AgentAdapterRegistry — Model Lookup
// ============================================================================

console.log('\n=== Registry: Model Lookup ===\n');

testAsync('getAdapterForModel finds correct adapter', async () => {
  const registry = new AgentAdapterRegistry();
  registry.register(createMockAdapter({
    name: 'claude',
    models: [{ id: 'claude-opus-4-6', name: 'Opus', provider: 'anthropic', capabilities: [] }]
  }));
  registry.register(createMockAdapter({
    name: 'aider',
    models: [{ id: 'gpt-4.5', name: 'GPT-4.5', provider: 'openai', capabilities: [] }]
  }));

  await registry.detectAll();
  const claudeAdapter = registry.getAdapterForModel('claude-opus-4-6');
  assert.strictEqual(claudeAdapter.name, 'claude');
  const aiderAdapter = registry.getAdapterForModel('gpt-4.5');
  assert.strictEqual(aiderAdapter.name, 'aider');
});

testAsync('getAdapterForModel returns null for unknown model', async () => {
  const registry = new AgentAdapterRegistry();
  registry.register(createMockAdapter({ name: 'one' }));
  await registry.detectAll();
  assert.strictEqual(registry.getAdapterForModel('nonexistent-model'), null);
});

testAsync('getAdapterForModel skips unavailable adapters', async () => {
  const registry = new AgentAdapterRegistry();
  registry.register(createMockAdapter({
    name: 'offline',
    detectResult: { available: false },
    models: [{ id: 'target-model', name: 'Target', provider: 'x', capabilities: [] }]
  }));

  await registry.detectAll();
  assert.strictEqual(registry.getAdapterForModel('target-model'), null);
});

testAsync('getAllModels aggregates models from all available adapters', async () => {
  const registry = new AgentAdapterRegistry();
  registry.register(createMockAdapter({
    name: 'a1',
    models: [
      { id: 'm1', name: 'M1', provider: 'p1', capabilities: [] },
      { id: 'm2', name: 'M2', provider: 'p1', capabilities: [] }
    ]
  }));
  registry.register(createMockAdapter({
    name: 'a2',
    models: [
      { id: 'm3', name: 'M3', provider: 'p2', capabilities: [] }
    ]
  }));

  await registry.detectAll();
  const allModels = registry.getAllModels();
  assert.strictEqual(allModels.length, 3);
  assert.strictEqual(allModels[0].adapter, 'a1');
  assert.strictEqual(allModels[2].adapter, 'a2');
});

testAsync('getAllModels excludes unavailable adapters', async () => {
  const registry = new AgentAdapterRegistry();
  registry.register(createMockAdapter({ name: 'online' }));
  registry.register(createMockAdapter({
    name: 'offline',
    detectResult: { available: false }
  }));

  await registry.detectAll();
  const allModels = registry.getAllModels();
  assert.strictEqual(allModels.length, 2);
  assert.ok(allModels.every(m => m.adapter === 'online'));
});

// ============================================================================
// TESTS: AgentAdapterRegistry — Summary
// ============================================================================

console.log('\n=== Registry: Summary ===\n');

testAsync('getSummary returns correct counts', async () => {
  const registry = new AgentAdapterRegistry();
  registry.register(createMockAdapter({ name: 'avail', displayName: 'Available' }));
  registry.register(createMockAdapter({
    name: 'missing',
    displayName: 'Missing',
    detectResult: { available: false }
  }));

  await registry.detectAll();
  const summary = registry.getSummary();
  assert.strictEqual(summary.adapters, 2);
  assert.strictEqual(summary.available, 1);
  assert.strictEqual(summary.models, 2); // only 'avail' models counted
  assert.strictEqual(summary.details.length, 2);
  assert.strictEqual(summary.details.find(a => a.name === 'avail').available, true);
  assert.strictEqual(summary.details.find(a => a.name === 'missing').available, false);
});

testAsync('getSummary on empty registry', async () => {
  const registry = new AgentAdapterRegistry();
  const summary = registry.getSummary();
  assert.strictEqual(summary.adapters, 0);
  assert.strictEqual(summary.available, 0);
  assert.strictEqual(summary.models, 0);
  assert.deepStrictEqual(summary.details, []);
});

testAsync('getSummary includes model IDs per adapter', async () => {
  const registry = new AgentAdapterRegistry();
  registry.register(createMockAdapter({
    name: 'test',
    models: [{ id: 'model-a', name: 'A', provider: 'p', capabilities: [] }]
  }));

  await registry.detectAll();
  const summary = registry.getSummary();
  const detail = summary.details.find(d => d.name === 'test');
  assert.deepStrictEqual(detail.models, ['model-a']);
  assert.strictEqual(detail.modelCount, 1);
});

// ============================================================================
// TESTS: Singleton
// ============================================================================

console.log('\n=== Singleton ===\n');

test('getRegistry returns same instance', () => {
  resetRegistry();
  const r1 = getRegistry();
  const r2 = getRegistry();
  assert.strictEqual(r1, r2);
});

test('resetRegistry creates new instance', () => {
  resetRegistry();
  const r1 = getRegistry();
  resetRegistry();
  const r2 = getRegistry();
  assert.notStrictEqual(r1, r2);
});

// ============================================================================
// TESTS: Edge Cases
// ============================================================================

console.log('\n=== Edge Cases ===\n');

testAsync('empty registry returns empty for all queries', async () => {
  const registry = new AgentAdapterRegistry();
  const detected = await registry.detectAll();
  assert.strictEqual(detected.size, 0);
  assert.strictEqual(registry.getAvailable().length, 0);
  assert.strictEqual(registry.getAdapterForModel('any'), null);
  assert.strictEqual(registry.getAllModels().length, 0);
});

testAsync('detectAll can be called multiple times (refreshes)', async () => {
  const registry = new AgentAdapterRegistry();

  let callCount = 0;
  class CountAdapter extends AgentAdapter {
    get name() { return 'counter'; }
    get displayName() { return 'Counter'; }
    async detect() {
      callCount++;
      return { available: callCount > 1, version: `${callCount}.0` };
    }
    async listModels() { return []; }
    async spawn() { return { pid: 1, sessionId: 's' }; }
    async inject() { return false; }
    async readOutput() { return ''; }
    async isAlive() { return { alive: false }; }
    async stop() {}
    getEnforcementStrategy() { return { type: 'wrapper', details: {} }; }
    buildCommand() { return 'counter'; }
  }

  registry.register(new CountAdapter());

  await registry.detectAll();
  assert.strictEqual(registry.getAvailable().length, 0);

  await registry.detectAll();
  assert.strictEqual(registry.getAvailable().length, 1);
  assert.strictEqual(callCount, 2);
});

testAsync('adapter with empty models array in listModels', async () => {
  const registry = new AgentAdapterRegistry();
  registry.register(createMockAdapter({
    name: 'no-models',
    models: []
  }));

  await registry.detectAll();
  const available = registry.getAvailable();
  assert.strictEqual(available.length, 1);
  assert.strictEqual(registry.getAllModels().length, 0);
});

testAsync('unavailable adapter does not call listModels', async () => {
  let listModelsCalled = false;

  class NoModelAdapter extends AgentAdapter {
    get name() { return 'nomodel'; }
    get displayName() { return 'NoModel'; }
    async detect() { return { available: false }; }
    async listModels() { listModelsCalled = true; return []; }
    async spawn() { return { pid: 0, sessionId: '' }; }
    async inject() { return false; }
    async readOutput() { return ''; }
    async isAlive() { return { alive: false }; }
    async stop() {}
    getEnforcementStrategy() { return { type: 'wrapper', details: {} }; }
    buildCommand() { return ''; }
  }

  const registry = new AgentAdapterRegistry();
  registry.register(new NoModelAdapter());
  await registry.detectAll();
  assert.strictEqual(listModelsCalled, false);
});

// ============================================================================
// RESULTS
// ============================================================================

async function run() {
  // Wait for all async tests to settle
  await new Promise(r => setTimeout(r, 200));

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
  }
  console.log('='.repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

run();
