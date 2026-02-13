/**
 * Tests for Model Capability Registry — Phase 6.11 (Pilot AGI-bqq)
 *
 * Tests:
 * - Built-in model count and completeness
 * - Lookup by ID (get, has)
 * - Listing (listIds, listAll)
 * - Capability queries (findByStrength, findForTask, findByProvider, findByAdapter)
 * - Cost/speed optimization (findCheapest, findFastest)
 * - Context window filtering
 * - Cost estimation
 * - Custom model registration
 * - Custom model file loading
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/model-registry.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================================
// TEST INFRASTRUCTURE
// ============================================================================

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

// ============================================================================
// MODULE LOAD
// ============================================================================

function freshModule() {
  Object.keys(require.cache).forEach(key => {
    if (key.includes('model-registry')) delete require.cache[key];
  });
  return require('../model-registry');
}

// ============================================================================
// BUILT-IN PROFILES TESTS
// ============================================================================

async function builtinTests() {
  console.log('\n--- Built-in Model Profiles ---');

  const { BUILTIN_MODELS, ModelRegistry } = freshModule();

  await test('has at least 10 built-in models', () => {
    const count = Object.keys(BUILTIN_MODELS).length;
    assert.ok(count >= 10, `Expected >=10, got ${count}`);
  });

  await test('all models have required fields', () => {
    const required = ['provider', 'adapter', 'name', 'strengths', 'weaknesses', 'speed', 'cost', 'contextWindow', 'bestFor'];
    for (const [id, model] of Object.entries(BUILTIN_MODELS)) {
      for (const field of required) {
        assert.ok(field in model, `${id} missing field: ${field}`);
      }
    }
  });

  await test('all models have valid cost structure', () => {
    for (const [id, model] of Object.entries(BUILTIN_MODELS)) {
      assert.ok(typeof model.cost.input === 'number', `${id} cost.input not a number`);
      assert.ok(typeof model.cost.output === 'number', `${id} cost.output not a number`);
      assert.ok(model.cost.input >= 0, `${id} cost.input negative`);
      assert.ok(model.cost.output >= 0, `${id} cost.output negative`);
    }
  });

  await test('all models have speed 0-1', () => {
    for (const [id, model] of Object.entries(BUILTIN_MODELS)) {
      assert.ok(model.speed >= 0 && model.speed <= 1, `${id} speed out of range: ${model.speed}`);
    }
  });

  await test('all models have contextWindow > 0', () => {
    for (const [id, model] of Object.entries(BUILTIN_MODELS)) {
      assert.ok(model.contextWindow > 0, `${id} contextWindow: ${model.contextWindow}`);
    }
  });

  await test('includes Claude Opus 4.6', () => {
    assert.ok(BUILTIN_MODELS['claude-opus-4-6'], 'Missing claude-opus-4-6');
    assert.strictEqual(BUILTIN_MODELS['claude-opus-4-6'].provider, 'anthropic');
  });

  await test('includes Claude Sonnet 4.5', () => {
    assert.ok(BUILTIN_MODELS['claude-sonnet-4-5'], 'Missing claude-sonnet-4-5');
  });

  await test('includes Claude Haiku 4.5', () => {
    assert.ok(BUILTIN_MODELS['claude-haiku-4-5'], 'Missing claude-haiku-4-5');
  });

  await test('includes GPT-4.5', () => {
    assert.ok(BUILTIN_MODELS['gpt-4.5'], 'Missing gpt-4.5');
    assert.strictEqual(BUILTIN_MODELS['gpt-4.5'].provider, 'openai');
  });

  await test('includes GPT-4o', () => {
    assert.ok(BUILTIN_MODELS['gpt-4o'], 'Missing gpt-4o');
  });

  await test('includes o3-mini', () => {
    assert.ok(BUILTIN_MODELS['o3-mini'], 'Missing o3-mini');
  });

  await test('includes Gemini 2.5 Pro', () => {
    assert.ok(BUILTIN_MODELS['gemini-2.5-pro'], 'Missing gemini-2.5-pro');
    assert.strictEqual(BUILTIN_MODELS['gemini-2.5-pro'].provider, 'google');
  });

  await test('includes Gemini 2.5 Flash', () => {
    assert.ok(BUILTIN_MODELS['gemini-2.5-flash'], 'Missing gemini-2.5-flash');
  });

  await test('includes Ollama deepseek-coder', () => {
    assert.ok(BUILTIN_MODELS['ollama:deepseek-coder-v3'], 'Missing ollama:deepseek-coder-v3');
    assert.strictEqual(BUILTIN_MODELS['ollama:deepseek-coder-v3'].provider, 'local');
  });

  await test('includes Ollama llama-3.3', () => {
    assert.ok(BUILTIN_MODELS['ollama:llama-3.3-70b'], 'Missing ollama:llama-3.3-70b');
  });

  await test('local models have zero cost', () => {
    for (const [id, model] of Object.entries(BUILTIN_MODELS)) {
      if (model.provider === 'local') {
        assert.strictEqual(model.cost.input, 0, `${id} local model should have 0 input cost`);
        assert.strictEqual(model.cost.output, 0, `${id} local model should have 0 output cost`);
      }
    }
  });
}

// ============================================================================
// LOOKUP TESTS
// ============================================================================

async function lookupTests() {
  console.log('\n--- Lookup ---');

  const { ModelRegistry } = freshModule();
  const reg = new ModelRegistry();

  await test('get: returns profile for known model', () => {
    const model = reg.get('claude-opus-4-6');
    assert.ok(model, 'Should return profile');
    assert.strictEqual(model.provider, 'anthropic');
    assert.strictEqual(model.name, 'Claude Opus 4.6');
  });

  await test('get: returns null for unknown model', () => {
    const model = reg.get('nonexistent-model');
    assert.strictEqual(model, null);
  });

  await test('has: true for known model', () => {
    assert.strictEqual(reg.has('claude-sonnet-4-5'), true);
  });

  await test('has: false for unknown model', () => {
    assert.strictEqual(reg.has('foo-bar'), false);
  });

  await test('listIds: returns all model IDs', () => {
    const ids = reg.listIds();
    assert.ok(ids.length >= 10, `Expected >=10 IDs, got ${ids.length}`);
    assert.ok(ids.includes('claude-opus-4-6'), 'Should include claude-opus-4-6');
    assert.ok(ids.includes('gpt-4.5'), 'Should include gpt-4.5');
  });

  await test('listAll: returns array with id field', () => {
    const all = reg.listAll();
    assert.ok(Array.isArray(all), 'Should be array');
    assert.ok(all.length >= 10);
    const first = all[0];
    assert.ok(first.id, 'Each entry should have id');
    assert.ok(first.provider, 'Each entry should have provider');
  });
}

// ============================================================================
// CAPABILITY QUERY TESTS
// ============================================================================

async function capabilityTests() {
  console.log('\n--- Capability Queries ---');

  const { ModelRegistry } = freshModule();
  const reg = new ModelRegistry();

  await test('findByStrength: finds models with "fast" strength', () => {
    const results = reg.findByStrength('fast');
    assert.ok(results.length > 0, 'Should find at least one model');
    assert.ok(results.every(m => m.strengths.includes('fast')),
      'All results should have "fast" strength');
  });

  await test('findByStrength: finds models with "free" strength', () => {
    const results = reg.findByStrength('free');
    assert.ok(results.length >= 2, 'Should find local models');
    assert.ok(results.every(m => m.provider === 'local'),
      'Free models should be local');
  });

  await test('findByStrength: returns empty for unknown strength', () => {
    const results = reg.findByStrength('telekinesis');
    assert.strictEqual(results.length, 0);
  });

  await test('findForTask: finds models for "test-generation"', () => {
    const results = reg.findForTask('test-generation');
    assert.ok(results.length > 0, 'Should find models for test generation');
    // GPT-4.5 should rank high (bestFor match)
    assert.ok(results.some(m => m.id === 'gpt-4.5'),
      'GPT-4.5 should be good for test-generation');
  });

  await test('findForTask: finds models for "frontend-ui"', () => {
    const results = reg.findForTask('frontend-ui');
    assert.ok(results.length > 0);
    assert.ok(results.some(m => m.id === 'gemini-2.5-pro'),
      'Gemini 2.5 Pro should be good for frontend-ui');
  });

  await test('findForTask: finds models for "documentation"', () => {
    const results = reg.findForTask('documentation');
    assert.ok(results.length >= 2, 'Multiple models good for docs');
  });

  await test('findForTask: returns empty for unknown task type', () => {
    const results = reg.findForTask('quantum-computing');
    assert.strictEqual(results.length, 0);
  });

  await test('findByProvider: lists anthropic models', () => {
    const results = reg.findByProvider('anthropic');
    assert.strictEqual(results.length, 3, 'Should have 3 Claude models');
    assert.ok(results.every(m => m.provider === 'anthropic'));
  });

  await test('findByProvider: lists openai models', () => {
    const results = reg.findByProvider('openai');
    assert.ok(results.length >= 3, 'Should have 3+ OpenAI models');
  });

  await test('findByProvider: lists local models', () => {
    const results = reg.findByProvider('local');
    assert.ok(results.length >= 2, 'Should have 2+ local models');
  });

  await test('findByAdapter: lists claude adapter models', () => {
    const results = reg.findByAdapter('claude');
    assert.strictEqual(results.length, 3);
  });

  await test('findByAdapter: lists ollama adapter models', () => {
    const results = reg.findByAdapter('ollama');
    assert.ok(results.length >= 2);
  });
}

// ============================================================================
// OPTIMIZATION QUERY TESTS
// ============================================================================

async function optimizationTests() {
  console.log('\n--- Optimization Queries ---');

  const { ModelRegistry } = freshModule();
  const reg = new ModelRegistry();

  await test('findCheapest: for test-generation returns a model', () => {
    const result = reg.findCheapest('test-generation');
    assert.ok(result, 'Should return a model');
    assert.ok(result.cost, 'Should have cost');
  });

  await test('findCheapest: across all models finds a local model', () => {
    const result = reg.findCheapest();
    assert.ok(result, 'Should return a model');
    assert.strictEqual(result.cost.input, 0, 'Cheapest should be free (local)');
  });

  await test('findFastest: for test-generation returns a model', () => {
    const result = reg.findFastest('test-generation');
    assert.ok(result, 'Should return a model');
    assert.ok(result.speed > 0, 'Should have positive speed');
  });

  await test('findFastest: across all models returns high-speed model', () => {
    const result = reg.findFastest();
    assert.ok(result, 'Should return a model');
    assert.ok(result.speed >= 0.9, `Fastest should be >=0.9, got ${result.speed}`);
  });

  await test('findByContextWindow: 500K filters to Gemini models', () => {
    const results = reg.findByContextWindow(500000);
    assert.ok(results.length >= 2, 'Should find Gemini models');
    assert.ok(results.every(m => m.contextWindow >= 500000));
  });

  await test('findByContextWindow: 200K includes Claude models', () => {
    const results = reg.findByContextWindow(200000);
    assert.ok(results.some(m => m.provider === 'anthropic'),
      'Should include Claude models');
  });

  await test('findByContextWindow: 2M returns empty', () => {
    const results = reg.findByContextWindow(2000000);
    assert.strictEqual(results.length, 0);
  });
}

// ============================================================================
// COST ESTIMATION TESTS
// ============================================================================

async function costEstimationTests() {
  console.log('\n--- Cost Estimation ---');

  const { ModelRegistry } = freshModule();
  const reg = new ModelRegistry();

  await test('estimateCost: Claude Opus 1M input + 500K output', () => {
    const result = reg.estimateCost('claude-opus-4-6', 1000000, 500000);
    assert.ok(result, 'Should return estimate');
    assert.strictEqual(result.breakdown.input, 15.0);  // 1M * $15/1M
    assert.strictEqual(result.breakdown.output, 37.5);  // 0.5M * $75/1M
    assert.strictEqual(result.cost, 52.5);
  });

  await test('estimateCost: Haiku is much cheaper', () => {
    const opus = reg.estimateCost('claude-opus-4-6', 100000, 50000);
    const haiku = reg.estimateCost('claude-haiku-4-5', 100000, 50000);
    assert.ok(haiku.cost < opus.cost, 'Haiku should be cheaper than Opus');
  });

  await test('estimateCost: local models are free', () => {
    const result = reg.estimateCost('ollama:deepseek-coder-v3', 1000000, 1000000);
    assert.strictEqual(result.cost, 0);
  });

  await test('estimateCost: unknown model returns null', () => {
    const result = reg.estimateCost('nonexistent', 100, 100);
    assert.strictEqual(result, null);
  });

  await test('estimateCost: zero tokens = zero cost', () => {
    const result = reg.estimateCost('claude-opus-4-6', 0, 0);
    assert.strictEqual(result.cost, 0);
  });
}

// ============================================================================
// REGISTRATION TESTS
// ============================================================================

async function registrationTests() {
  console.log('\n--- Custom Registration ---');

  const { ModelRegistry } = freshModule();
  const reg = new ModelRegistry();

  await test('register: adds a custom model', () => {
    reg.register('custom-model-1', {
      provider: 'custom',
      adapter: 'custom',
      name: 'Custom Model 1',
      strengths: ['testing'],
      weaknesses: [],
      speed: 0.5,
      cost: { input: 1.0, output: 2.0 },
      contextWindow: 50000,
      bestFor: ['testing'],
    });

    assert.ok(reg.has('custom-model-1'));
    assert.strictEqual(reg.get('custom-model-1').provider, 'custom');
  });

  await test('register: throws without id', () => {
    assert.throws(() => {
      reg.register('', { provider: 'x' });
    }, /must have an id/);
  });

  await test('register: throws without provider', () => {
    assert.throws(() => {
      reg.register('foo', {});
    }, /must have an id and provider/);
  });

  await test('unregister: removes a model', () => {
    reg.register('temp-model', { provider: 'temp', adapter: 'temp', name: 'Temp' });
    assert.ok(reg.has('temp-model'));
    const removed = reg.unregister('temp-model');
    assert.strictEqual(removed, true);
    assert.strictEqual(reg.has('temp-model'), false);
  });

  await test('unregister: returns false for unknown model', () => {
    const removed = reg.unregister('nonexistent');
    assert.strictEqual(removed, false);
  });
}

// ============================================================================
// CUSTOM FILE LOADING TESTS
// ============================================================================

async function customFileTests() {
  console.log('\n--- Custom Model File Loading ---');

  const { ModelRegistry, loadCustomModels } = freshModule();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-registry-test-'));
  const modelsDir = path.join(tmpDir, '.claude/pilot/models');
  fs.mkdirSync(modelsDir, { recursive: true });

  await test('loadCustomModels: loads valid JSON profiles', () => {
    fs.writeFileSync(path.join(modelsDir, 'my-model.json'), JSON.stringify({
      id: 'my-custom-model',
      provider: 'custom-corp',
      adapter: 'custom',
      name: 'My Custom LLM',
      strengths: ['specialized'],
      weaknesses: [],
      speed: 0.5,
      cost: { input: 5.0, output: 10.0 },
      contextWindow: 64000,
      bestFor: ['domain-specific'],
    }));

    const models = loadCustomModels(tmpDir);
    assert.ok(models['my-custom-model'], 'Should load custom model');
    assert.strictEqual(models['my-custom-model'].provider, 'custom-corp');
  });

  await test('loadCustomModels: skips invalid JSON', () => {
    fs.writeFileSync(path.join(modelsDir, 'broken.json'), 'not valid json{{{');
    const models = loadCustomModels(tmpDir);
    // Should still have the valid model, not crash
    assert.ok(models['my-custom-model'], 'Valid model should still load');
  });

  await test('loadCustomModels: skips files without id/provider', () => {
    fs.writeFileSync(path.join(modelsDir, 'incomplete.json'), JSON.stringify({
      name: 'No ID or provider',
    }));
    const models = loadCustomModels(tmpDir);
    // Only the valid model should be present
    const keys = Object.keys(models);
    assert.strictEqual(keys.length, 1, 'Should only have 1 valid model');
  });

  await test('ModelRegistry with projectRoot: includes custom models', () => {
    const reg = new ModelRegistry({ projectRoot: tmpDir });
    assert.ok(reg.has('my-custom-model'), 'Should have custom model');
    assert.ok(reg.has('claude-opus-4-6'), 'Should also have built-in models');
  });

  await test('loadCustomModels: returns empty for missing directory', () => {
    const models = loadCustomModels('/tmp/nonexistent-dir-xyz');
    assert.deepStrictEqual(models, {});
  });

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
}

// ============================================================================
// SINGLETON TESTS
// ============================================================================

async function singletonTests() {
  console.log('\n--- Singleton ---');

  const { getRegistry, resetRegistry } = freshModule();

  await test('getRegistry: returns same instance on repeated calls', () => {
    resetRegistry();
    const reg1 = getRegistry();
    const reg2 = getRegistry();
    assert.strictEqual(reg1, reg2, 'Should be same instance');
  });

  await test('resetRegistry: creates fresh instance', () => {
    const reg1 = getRegistry();
    resetRegistry();
    const reg2 = getRegistry();
    assert.notStrictEqual(reg1, reg2, 'Should be different instance after reset');
  });
}

// ============================================================================
// RUN ALL
// ============================================================================

async function main() {
  console.log('Model Capability Registry Tests (Phase 6.11)\n');

  await builtinTests();
  await lookupTests();
  await capabilityTests();
  await optimizationTests();
  await costEstimationTests();
  await registrationTests();
  await customFileTests();
  await singletonTests();

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(50)}`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const { name, error } of failures) {
      console.log(`  ✗ ${name}`);
      console.log(`    ${error.stack || error.message}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
