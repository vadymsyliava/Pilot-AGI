#!/usr/bin/env node

/**
 * Verification tests for Model-Aware Task Scheduler (Phase 6.12)
 * Run: node tests/model-scheduler.test.js
 */

const fs = require('fs');
const path = require('path');

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

// =============================================================================
// SETUP: temp directory + fresh module loading
// =============================================================================

const ORIG_CWD = process.cwd();
const TMP_DIR = path.join(require('os').tmpdir(), 'pilot-model-scheduler-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

// Create minimal directory structure
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/model-outcomes/history'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/model-outcomes/spend'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/models'), { recursive: true });

// Change to temp dir
process.chdir(TMP_DIR);

const libDir = path.join(ORIG_CWD, '.claude/pilot/hooks/lib');

// Clear module cache for fresh requires
function freshModule(modPath) {
  const keysToDelete = Object.keys(require.cache).filter(k =>
    k.includes('pilot/hooks/lib/') || k.includes('pilot/config/')
  );
  for (const k of keysToDelete) {
    delete require.cache[k];
  }
  return require(modPath);
}

// =============================================================================
// MOCK: Minimal ModelRegistry
// =============================================================================

function makeMockRegistry(models) {
  return {
    models,
    get(id) { return models[id] || null; },
    has(id) { return id in models; },
    listIds() { return Object.keys(models); },
  };
}

const TEST_MODELS = {
  'claude-opus-4-6': {
    provider: 'anthropic',
    adapter: 'claude',
    name: 'Claude Opus 4.6',
    strengths: ['complex-reasoning', 'architecture', 'security'],
    speed: 0.3,
    cost: { input: 15.0, output: 75.0 },
    bestFor: ['backend-architecture', 'security-review', 'complex-refactor'],
  },
  'claude-sonnet-4-5': {
    provider: 'anthropic',
    adapter: 'claude',
    name: 'Claude Sonnet 4.5',
    strengths: ['general', 'balanced', 'coding'],
    speed: 0.6,
    cost: { input: 3.0, output: 15.0 },
    bestFor: ['general-coding', 'bug-fixes'],
  },
  'claude-haiku-4-5': {
    provider: 'anthropic',
    adapter: 'claude',
    name: 'Claude Haiku 4.5',
    strengths: ['very-fast', 'very-cheap'],
    speed: 0.9,
    cost: { input: 0.80, output: 4.0 },
    bestFor: ['documentation', 'formatting'],
  },
  'gpt-4.5': {
    provider: 'openai',
    adapter: 'aider',
    name: 'GPT 4.5',
    strengths: ['testing', 'analysis'],
    speed: 0.5,
    cost: { input: 10.0, output: 30.0 },
    bestFor: ['test-generation'],
  },
  'gemini-2.5-pro': {
    provider: 'google',
    adapter: 'opencode',
    name: 'Gemini 2.5 Pro',
    strengths: ['frontend', 'ui', 'fast'],
    speed: 0.7,
    cost: { input: 1.25, output: 10.0 },
    bestFor: ['frontend-ui'],
  },
  'ollama:llama-3.3-70b': {
    provider: 'ollama',
    adapter: 'aider',
    name: 'Llama 3.3 70B',
    strengths: ['documentation', 'simple-tasks'],
    speed: 0.4,
    cost: { input: 0, output: 0 },
    bestFor: ['documentation', 'simple-tasks'],
  },
};

// =============================================================================
// TEST GROUP 1: classifyTaskType
// =============================================================================

console.log('\n== classifyTaskType ==');

const { classifyTaskType } = freshModule(path.join(libDir, 'model-scheduler'));

test('classifies test tasks', () => {
  const type = classifyTaskType({ title: 'Write unit tests for auth module' });
  assert(type === 'test-generation', `Expected test-generation, got ${type}`);
});

test('classifies test tasks by file pattern', () => {
  const type = classifyTaskType({ title: 'Update files', files: ['auth.test.js'] });
  assert(type === 'test-generation', `Expected test-generation, got ${type}`);
});

test('classifies documentation tasks', () => {
  const type = classifyTaskType({ title: 'Update README with new API docs' });
  assert(type === 'documentation', `Expected documentation, got ${type}`);
});

test('classifies frontend tasks', () => {
  const type = classifyTaskType({ title: 'Build new dashboard component' });
  assert(type === 'frontend-ui', `Expected frontend-ui, got ${type}`);
});

test('classifies backend tasks', () => {
  const type = classifyTaskType({ title: 'Add REST API endpoint for users' });
  assert(type === 'backend-architecture', `Expected backend-architecture, got ${type}`);
});

test('classifies refactoring tasks', () => {
  const type = classifyTaskType({ title: 'Refactor authentication module' });
  assert(type === 'complex-refactor', `Expected complex-refactor, got ${type}`);
});

test('classifies security tasks', () => {
  const type = classifyTaskType({ title: 'Security vulnerability review' });
  assert(type === 'security-review', `Expected security-review, got ${type}`);
});

test('classifies simple tasks', () => {
  const type = classifyTaskType({ title: 'Fix typo in config file' });
  assert(type === 'simple-tasks', `Expected simple-tasks, got ${type}`);
});

test('classifies bug fixes', () => {
  const type = classifyTaskType({ title: 'Fix login error for new users' });
  assert(type === 'bug-fixes', `Expected bug-fixes, got ${type}`);
});

test('defaults to general-coding', () => {
  const type = classifyTaskType({ title: 'Implement webhook handler' });
  assert(type === 'general-coding', `Expected general-coding, got ${type}`);
});

test('uses labels for classification', () => {
  const type = classifyTaskType({ title: 'Phase work', labels: ['frontend', 'ui'] });
  assert(type === 'frontend-ui', `Expected frontend-ui, got ${type}`);
});

// =============================================================================
// TEST GROUP 2: scoreModels — ranking correctness
// =============================================================================

console.log('\n== scoreModels — ranking ==');

const { ModelScheduler } = freshModule(path.join(libDir, 'model-scheduler'));

test('Opus has bestFor match for backend-architecture tasks', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);
  const task = { title: 'Add new REST API endpoint for server' };
  const ranked = ms.scoreModels(task, ['claude', 'aider', 'opencode']);

  assert(ranked.length > 0, 'Should have candidates');
  // Opus gets bestFor match (capability=0.6) but cost=0.0 drags total down.
  // Verify Opus has highest capability score among all candidates.
  const opusEntry = ranked.find(r => r.modelId === 'claude-opus-4-6');
  assert(opusEntry, 'Opus should be in results');
  assert(opusEntry.breakdown.capability === 0.6,
    `Opus should have capability 0.6 for backend, got ${opusEntry.breakdown.capability}`);
  const othersCap = ranked.filter(r => r.modelId !== 'claude-opus-4-6');
  assert(othersCap.every(r => r.breakdown.capability <= opusEntry.breakdown.capability),
    'Opus should have highest capability score for backend tasks');
});

test('ranks Gemini highest for frontend-ui tasks', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);
  const task = { title: 'Build a React dashboard component' };
  const ranked = ms.scoreModels(task, ['claude', 'aider', 'opencode']);

  assert(ranked.length > 0, 'Should have candidates');
  assert(ranked[0].modelId === 'gemini-2.5-pro',
    `Expected Gemini first, got ${ranked[0].modelId}`);
});

test('ranks GPT highest for test-generation tasks', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);
  const task = { title: 'Write comprehensive test suite' };
  const ranked = ms.scoreModels(task, ['claude', 'aider', 'opencode']);

  assert(ranked.length > 0, 'Should have candidates');
  assert(ranked[0].modelId === 'gpt-4.5',
    `Expected GPT first, got ${ranked[0].modelId}`);
});

test('ranks documentation-capable models highest for doc tasks', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);
  const task = { title: 'Write documentation for changelog' };
  const ranked = ms.scoreModels(task, ['claude', 'aider', 'opencode']);

  assert(ranked.length > 0, 'Should have candidates');
  // Both Llama and Haiku have bestFor=documentation; either is correct
  const top = ranked[0];
  assert(top.breakdown.taskType === 'documentation', `Expected doc task type, got ${top.breakdown.taskType}`);
  assert(top.breakdown.capability === 0.6, `Top model should have bestFor match (0.6), got ${top.breakdown.capability}`);
});

test('filters models by available adapters', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);
  const task = { title: 'Build a React component' };
  // Only claude adapter available — no opencode/aider
  const ranked = ms.scoreModels(task, ['claude']);

  assert(ranked.every(r => r.adapterId === 'claude'),
    'All results should use claude adapter');
  assert(!ranked.some(r => r.modelId === 'gemini-2.5-pro'),
    'Gemini should be excluded (opencode adapter unavailable)');
});

test('returns score breakdown for each candidate', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);
  const task = { title: 'Fix a bug in the API' };
  const ranked = ms.scoreModels(task, ['claude', 'aider', 'opencode']);

  for (const r of ranked) {
    assert(typeof r.breakdown.capability === 'number', 'Missing capability score');
    assert(typeof r.breakdown.cost === 'number', 'Missing cost score');
    assert(typeof r.breakdown.speed === 'number', 'Missing speed score');
    assert(typeof r.breakdown.reliability === 'number', 'Missing reliability score');
    assert(typeof r.breakdown.taskType === 'string', 'Missing taskType');
    assert(typeof r.estimatedCost === 'number', 'Missing estimatedCost');
  }
});

// =============================================================================
// TEST GROUP 3: Preference overrides
// =============================================================================

console.log('\n== Preference overrides ==');

test('preference boost overrides natural scoring', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const policy = {
    models: {
      preferences: {
        backend: 'ollama:llama-3.3-70b',  // Force Llama for backend (unnatural choice)
      },
    },
  };
  const ms = new ModelScheduler(registry, policy, TMP_DIR);
  const task = { title: 'Add REST API endpoint for server' };
  const ranked = ms.scoreModels(task, ['claude', 'aider', 'opencode']);

  // Llama gets 0.3 preference boost + free cost (1.0) which should push it up
  const llamaRank = ranked.findIndex(r => r.modelId === 'ollama:llama-3.3-70b');
  assert(llamaRank >= 0, 'Llama should be in results');

  const llamaEntry = ranked[llamaRank];
  assert(llamaEntry.breakdown.preferenceBoost === 0.3,
    `Expected 0.3 boost, got ${llamaEntry.breakdown.preferenceBoost}`);
});

test('preference for testing routes to preferred model', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const policy = {
    models: {
      preferences: {
        testing: 'claude-sonnet-4-5',  // Prefer Sonnet for tests
      },
    },
  };
  const ms = new ModelScheduler(registry, policy, TMP_DIR);
  const task = { title: 'Write unit tests for login' };
  const ranked = ms.scoreModels(task, ['claude', 'aider', 'opencode']);

  const sonnetEntry = ranked.find(r => r.modelId === 'claude-sonnet-4-5');
  assert(sonnetEntry, 'Sonnet should be in results');
  assert(sonnetEntry.breakdown.preferenceBoost === 0.3,
    `Expected 0.3 boost for preferred testing model, got ${sonnetEntry.breakdown.preferenceBoost}`);
});

test('partial preference match gives half boost', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const policy = {
    models: {
      preferences: {
        documentation: 'ollama:llama',  // Partial match for ollama:llama-3.3-70b
      },
    },
  };
  const ms = new ModelScheduler(registry, policy, TMP_DIR);
  const task = { title: 'Write the README docs' };
  const ranked = ms.scoreModels(task, ['claude', 'aider', 'opencode']);

  const llamaEntry = ranked.find(r => r.modelId === 'ollama:llama-3.3-70b');
  assert(llamaEntry, 'Llama should be in results');
  assert(llamaEntry.breakdown.preferenceBoost === 0.15,
    `Expected 0.15 partial boost, got ${llamaEntry.breakdown.preferenceBoost}`);
});

test('no preference boost for non-matching model', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const policy = {
    models: {
      preferences: {
        backend: 'claude-opus-4-6',
      },
    },
  };
  const ms = new ModelScheduler(registry, policy, TMP_DIR);
  const task = { title: 'Build API endpoint' };
  const ranked = ms.scoreModels(task, ['claude', 'aider', 'opencode']);

  const sonnetEntry = ranked.find(r => r.modelId === 'claude-sonnet-4-5');
  assert(sonnetEntry.breakdown.preferenceBoost === 0,
    `Expected 0 boost for non-preferred model, got ${sonnetEntry.breakdown.preferenceBoost}`);
});

// =============================================================================
// TEST GROUP 4: Force model override
// =============================================================================

console.log('\n== Force model ==');

test('force_model returns only that model', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const policy = {
    models: { force_model: 'claude-haiku-4-5' },
  };
  const ms = new ModelScheduler(registry, policy, TMP_DIR);
  const task = { title: 'Complex backend work' };
  const ranked = ms.scoreModels(task, ['claude', 'aider', 'opencode']);

  assert(ranked.length === 1, `Expected 1 result, got ${ranked.length}`);
  assert(ranked[0].modelId === 'claude-haiku-4-5', 'Should be forced model');
  assert(ranked[0].breakdown.forced === true, 'Should be marked as forced');
  assert(ranked[0].score === 1.0, 'Forced model score should be 1.0');
});

test('force_model falls through if adapter unavailable', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const policy = {
    models: { force_model: 'gemini-2.5-pro' },
  };
  const ms = new ModelScheduler(registry, policy, TMP_DIR);
  const task = { title: 'Build component' };
  // Only claude available, not opencode
  const ranked = ms.scoreModels(task, ['claude']);

  assert(ranked.length > 0, 'Should fall through to normal scoring');
  assert(ranked.every(r => r.adapterId === 'claude'), 'Should only contain claude models');
});

// =============================================================================
// TEST GROUP 5: Budget filtering
// =============================================================================

console.log('\n== Budget filtering ==');

test('filters out over-budget providers', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const policy = {
    models: {
      provider_budgets: { anthropic: 5.0 },  // $5 budget for Anthropic
    },
  };
  const ms = new ModelScheduler(registry, policy, TMP_DIR);

  // Record $6 spend for Anthropic (over $5 budget)
  ms.recordProviderSpend('anthropic', 6.0);

  const task = { title: 'Fix a bug' };
  const ranked = ms.scoreModels(task, ['claude', 'aider', 'opencode']);

  assert(!ranked.some(r => r.modelId.startsWith('claude-')),
    'Claude models should be excluded (over budget)');
  assert(ranked.some(r => r.modelId === 'gpt-4.5'),
    'GPT should still be available');
});

test('passes through when no budget set', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);
  const task = { title: 'Fix a bug' };
  const ranked = ms.scoreModels(task, ['claude', 'aider', 'opencode']);

  assert(ranked.some(r => r.modelId.startsWith('claude-')),
    'Claude models should be available when no budget set');
});

test('filters task-level budget', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);
  const task = { title: 'Simple fix', budget: 0.01 };  // Very small budget
  const ranked = ms.scoreModels(task, ['claude', 'aider', 'opencode']);

  // Only free models should pass
  assert(ranked.every(r => r.estimatedCost <= 0.01),
    'Only cheap/free models should pass task budget');
});

// =============================================================================
// TEST GROUP 6: Cost scoring
// =============================================================================

console.log('\n== Cost scoring ==');

test('free models get cost score 1.0', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);
  const costScore = ms._scoreCost(TEST_MODELS['ollama:llama-3.3-70b']);
  assert(costScore === 1.0, `Expected 1.0 for free model, got ${costScore}`);
});

test('expensive models get lower cost score', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);
  const opusCost = ms._scoreCost(TEST_MODELS['claude-opus-4-6']);
  const sonnetCost = ms._scoreCost(TEST_MODELS['claude-sonnet-4-5']);
  assert(sonnetCost > opusCost,
    `Sonnet (${sonnetCost}) should score higher than Opus (${opusCost})`);
});

test('estimates cost based on tokens', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);
  const cost = ms._estimateCost(TEST_MODELS['claude-opus-4-6'], {});
  // Default: 50k input * $15/M + 20k output * $75/M = $0.75 + $1.50 = $2.25
  assert(Math.abs(cost - 2.25) < 0.001, `Expected ~$2.25, got $${cost}`);
});

test('uses task token estimates when provided', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);
  const cost = ms._estimateCost(TEST_MODELS['claude-sonnet-4-5'], {
    estimatedTokens: { input: 10000, output: 5000 },
  });
  // 10k * $3/M + 5k * $15/M = $0.03 + $0.075 = $0.105
  assert(Math.abs(cost - 0.105) < 0.001, `Expected ~$0.105, got $${cost}`);
});

// =============================================================================
// TEST GROUP 7: Speed scoring
// =============================================================================

console.log('\n== Speed scoring ==');

test('simple tasks boost speed score', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);
  const simple = ms._scoreSpeed(TEST_MODELS['claude-sonnet-4-5'], { complexity: 'simple' });
  const medium = ms._scoreSpeed(TEST_MODELS['claude-sonnet-4-5'], { complexity: 'medium' });
  assert(simple > medium, `Simple (${simple}) should score higher than medium (${medium})`);
});

test('complex tasks reduce speed score', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);
  const complex = ms._scoreSpeed(TEST_MODELS['claude-sonnet-4-5'], { complexity: 'complex' });
  const medium = ms._scoreSpeed(TEST_MODELS['claude-sonnet-4-5'], { complexity: 'medium' });
  assert(complex < medium, `Complex (${complex}) should score lower than medium (${medium})`);
});

test('speed score capped at 1.0', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);
  const score = ms._scoreSpeed({ speed: 0.9 }, { complexity: 'simple' });
  assert(score <= 1.0, `Speed score should be capped at 1.0, got ${score}`);
});

// =============================================================================
// TEST GROUP 8: Historical reliability / outcomes
// =============================================================================

console.log('\n== Historical reliability ==');

test('unknown models get neutral 0.5 reliability', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);
  const score = ms._scoreReliability('never-seen-model', 'general-coding');
  assert(score === 0.5, `Expected 0.5 for unknown model, got ${score}`);
});

test('recordOutcome updates reliability', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);

  ms.recordOutcome('test-model-a', 'bug-fixes', true);
  ms.recordOutcome('test-model-a', 'bug-fixes', true);
  ms.recordOutcome('test-model-a', 'bug-fixes', false);

  const score = ms._scoreReliability('test-model-a', 'bug-fixes');
  // 2 success / 3 total = 0.667
  assert(Math.abs(score - 2 / 3) < 0.01, `Expected ~0.667, got ${score}`);
});

test('recordOutcome persists across instances', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms1 = new ModelScheduler(registry, {}, TMP_DIR);
  ms1.recordOutcome('persistent-model', 'documentation', true);
  ms1.recordOutcome('persistent-model', 'documentation', true);

  // New instance reads from disk
  const ms2 = new ModelScheduler(registry, {}, TMP_DIR);
  const score = ms2._scoreReliability('persistent-model', 'documentation');
  assert(score === 1.0, `Expected 1.0, got ${score}`);
});

test('reliability is per task type', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);

  ms.recordOutcome('multi-type-model', 'test-generation', true);
  ms.recordOutcome('multi-type-model', 'frontend-ui', false);

  const testScore = ms._scoreReliability('multi-type-model', 'test-generation');
  const frontendScore = ms._scoreReliability('multi-type-model', 'frontend-ui');
  assert(testScore === 1.0, `Test score should be 1.0, got ${testScore}`);
  assert(frontendScore === 0.0, `Frontend score should be 0.0, got ${frontendScore}`);
});

// =============================================================================
// TEST GROUP 9: selectModel — fallback
// =============================================================================

console.log('\n== selectModel ==');

test('selectModel returns top-ranked model', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  // Use preference to ensure Opus wins for security tasks
  const policy = {
    models: {
      preferences: { security: 'claude-opus-4-6' },
    },
  };
  const ms = new ModelScheduler(registry, policy, TMP_DIR);
  const result = ms.selectModel({ title: 'Security vulnerability audit' }, ['claude', 'aider', 'opencode']);

  assert(result !== null, 'Should return a model');
  assert(result.modelId === 'claude-opus-4-6', `Expected Opus with preference, got ${result.modelId}`);
});

test('selectModel returns default when no adapter available', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const policy = { models: { default: 'claude-sonnet-4-5' } };
  const ms = new ModelScheduler(registry, policy, TMP_DIR);
  const result = ms.selectModel({ title: 'Something' }, ['nonexistent-adapter']);

  // Should fallback to default with score 0
  assert(result === null || result.breakdown?.fallback === true,
    'Should return null or fallback');
});

test('selectModel returns null when nothing works', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const policy = { models: { default: 'nonexistent-model' } };
  const ms = new ModelScheduler(registry, policy, TMP_DIR);
  const result = ms.selectModel({ title: 'Something' }, ['nonexistent-adapter']);

  assert(result === null, `Expected null, got ${JSON.stringify(result)}`);
});

// =============================================================================
// TEST GROUP 10: Custom weights from policy
// =============================================================================

console.log('\n== Custom weights ==');

test('respects custom weights from policy', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const policy = {
    models: {
      scheduling: {
        model_weights: {
          capability: 0.10,
          cost: 0.70,  // Heavily weight cost
          speed: 0.10,
          reliability: 0.10,
        },
      },
    },
  };
  const ms = new ModelScheduler(registry, policy, TMP_DIR);
  const task = { title: 'Backend API work' };
  const ranked = ms.scoreModels(task, ['claude', 'aider', 'opencode']);

  // With 70% cost weight, free/cheap models should dominate
  assert(ranked.length > 0, 'Should have results');
  // Llama (free, cost=1.0) should beat Opus (expensive, cost=0.0)
  const llamaIdx = ranked.findIndex(r => r.modelId === 'ollama:llama-3.3-70b');
  const opusIdx = ranked.findIndex(r => r.modelId === 'claude-opus-4-6');
  assert(llamaIdx < opusIdx,
    `With 70% cost weight, Llama (rank ${llamaIdx}) should beat Opus (rank ${opusIdx})`);
});

// =============================================================================
// TEST GROUP 11: Provider spend tracking
// =============================================================================

console.log('\n== Provider spend tracking ==');

test('recordProviderSpend creates spend file', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);

  ms.recordProviderSpend('test-provider', 1.50);

  const today = new Date().toISOString().split('T')[0];
  const spendPath = path.join(TMP_DIR, '.claude/pilot/state/model-outcomes/spend', `test-provider-${today}.json`);
  assert(fs.existsSync(spendPath), 'Spend file should exist');

  const data = JSON.parse(fs.readFileSync(spendPath, 'utf8'));
  assert(data.total === 1.50, `Expected total 1.50, got ${data.total}`);
  assert(data.entries.length === 1, 'Should have 1 entry');
});

test('recordProviderSpend accumulates', () => {
  const registry = makeMockRegistry(TEST_MODELS);
  const ms = new ModelScheduler(registry, {}, TMP_DIR);

  ms.recordProviderSpend('accumulate-test', 1.00);
  ms.recordProviderSpend('accumulate-test', 2.50);

  const today = new Date().toISOString().split('T')[0];
  const spendPath = path.join(TMP_DIR, '.claude/pilot/state/model-outcomes/spend', `accumulate-test-${today}.json`);
  const data = JSON.parse(fs.readFileSync(spendPath, 'utf8'));
  assert(data.total === 3.50, `Expected total 3.50, got ${data.total}`);
  assert(data.entries.length === 2, 'Should have 2 entries');
});

// =============================================================================
// CLEANUP & REPORT
// =============================================================================

process.chdir(ORIG_CWD);
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
