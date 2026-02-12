/**
 * Tests for Phase 6.13: Cross-Model Cost Normalization (Pilot AGI-bro)
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-cost-norm-'));
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

function freshModule(modPath) {
  const resolved = require.resolve(modPath);
  delete require.cache[resolved];
  return require(resolved);
}

// =============================================================================
// MOCK MODEL DATA
// =============================================================================

const MOCK_MODELS = {
  'claude-opus-4-6': {
    provider: 'anthropic',
    name: 'Claude Opus 4.6',
    cost: { input: 15.0, output: 75.0 }
  },
  'claude-sonnet-4-5': {
    provider: 'anthropic',
    name: 'Claude Sonnet 4.5',
    cost: { input: 3.0, output: 15.0 }
  },
  'claude-haiku-4-5': {
    provider: 'anthropic',
    name: 'Claude Haiku 4.5',
    cost: { input: 0.80, output: 4.0 }
  },
  'gpt-4.5': {
    provider: 'openai',
    name: 'GPT-4.5',
    cost: { input: 2.0, output: 10.0 }
  },
  'gemini-2.5-flash': {
    provider: 'google',
    name: 'Gemini 2.5 Flash',
    cost: { input: 0.15, output: 0.60 }
  },
  'ollama:llama-3.3-70b': {
    provider: 'local',
    name: 'Llama 3.3 70B',
    cost: { input: 0, output: 0 }
  }
};

// =============================================================================
// TESTS
// =============================================================================

describe('CostNormalizer', () => {
  let mod, tmpDir;

  beforeEach(() => {
    mod = freshModule('../lib/cost-normalizer');
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  describe('calculateCost()', () => {
    it('should calculate cost for Claude Opus', () => {
      const normalizer = new mod.CostNormalizer(MOCK_MODELS, { projectRoot: tmpDir });

      const result = normalizer.calculateCost('claude-opus-4-6', {
        inputTokens: 100_000,
        outputTokens: 50_000
      });

      // Input: 100K * $15/1M = $1.50
      // Output: 50K * $75/1M = $3.75
      // Total: $5.25
      assert.equal(result.dollars, 5.25);
      assert.equal(result.provider, 'anthropic');
      assert.ok(result.normalizedTokens > 0);
      assert.equal(result.breakdown.input, 1.5);
      assert.equal(result.breakdown.output, 3.75);
    });

    it('should calculate cost for Claude Sonnet', () => {
      const normalizer = new mod.CostNormalizer(MOCK_MODELS, { projectRoot: tmpDir });

      const result = normalizer.calculateCost('claude-sonnet-4-5', {
        inputTokens: 100_000,
        outputTokens: 50_000
      });

      // Input: 100K * $3/1M = $0.30
      // Output: 50K * $15/1M = $0.75
      // Total: $1.05
      assert.equal(result.dollars, 1.05);
      assert.equal(result.provider, 'anthropic');
    });

    it('should calculate zero cost for local models', () => {
      const normalizer = new mod.CostNormalizer(MOCK_MODELS, { projectRoot: tmpDir });

      const result = normalizer.calculateCost('ollama:llama-3.3-70b', {
        inputTokens: 1_000_000,
        outputTokens: 500_000
      });

      assert.equal(result.dollars, 0);
      assert.equal(result.normalizedTokens, 0);
      assert.equal(result.provider, 'local');
    });

    it('should use fallback pricing for unknown models', () => {
      const normalizer = new mod.CostNormalizer(MOCK_MODELS, { projectRoot: tmpDir });

      const result = normalizer.calculateCost('unknown-model', {
        inputTokens: 100_000,
        outputTokens: 100_000
      });

      // Fallback: $10/1M for both input and output
      // (100K * $10/1M) * 2 = $2.0
      assert.equal(result.dollars, 2.0);
      assert.equal(result.provider, 'unknown');
    });

    it('should normalize tokens to Sonnet-equivalent', () => {
      const normalizer = new mod.CostNormalizer(MOCK_MODELS, { projectRoot: tmpDir });

      // Opus: $5.25 for 100K input + 50K output
      const opus = normalizer.calculateCost('claude-opus-4-6', {
        inputTokens: 100_000,
        outputTokens: 50_000
      });

      // Sonnet: $1.05 for the same tokens
      const sonnet = normalizer.calculateCost('claude-sonnet-4-5', {
        inputTokens: 100_000,
        outputTokens: 50_000
      });

      // Opus normalized tokens should be ~5x Sonnet's
      assert.ok(opus.normalizedTokens > sonnet.normalizedTokens);
      assert.ok(opus.normalizedTokens / sonnet.normalizedTokens > 4.5);
    });
  });

  describe('costPerLine()', () => {
    it('should calculate cost per line of code', () => {
      const normalizer = new mod.CostNormalizer(MOCK_MODELS, { projectRoot: tmpDir });

      const cpl = normalizer.costPerLine('claude-sonnet-4-5',
        { inputTokens: 100_000, outputTokens: 50_000 },
        100 // 100 lines changed
      );

      // $1.05 / 100 lines = $0.0105
      assert.equal(cpl, 0.0105);
    });

    it('should return 0 for zero lines changed', () => {
      const normalizer = new mod.CostNormalizer(MOCK_MODELS, { projectRoot: tmpDir });

      const cpl = normalizer.costPerLine('claude-sonnet-4-5',
        { inputTokens: 100_000, outputTokens: 50_000 },
        0
      );

      assert.equal(cpl, 0);
    });

    it('should return 0 for local models', () => {
      const normalizer = new mod.CostNormalizer(MOCK_MODELS, { projectRoot: tmpDir });

      const cpl = normalizer.costPerLine('ollama:llama-3.3-70b',
        { inputTokens: 100_000, outputTokens: 50_000 },
        100
      );

      assert.equal(cpl, 0);
    });
  });

  describe('recordDailyCost() + getDailyReport()', () => {
    it('should record and aggregate daily costs', () => {
      const normalizer = new mod.CostNormalizer(MOCK_MODELS, { projectRoot: tmpDir });

      normalizer.recordDailyCost({
        modelId: 'claude-sonnet-4-5',
        inputTokens: 50_000,
        outputTokens: 20_000,
        taskId: 'bd-task-1',
        sessionId: 'S-test-1'
      });

      normalizer.recordDailyCost({
        modelId: 'gpt-4.5',
        inputTokens: 80_000,
        outputTokens: 30_000,
        taskId: 'bd-task-2',
        sessionId: 'S-test-2'
      });

      const report = normalizer.getDailyReport();

      assert.equal(report.entryCount, 2);
      assert.ok(report.total > 0);
      assert.ok(report.byProvider.anthropic);
      assert.ok(report.byProvider.openai);
      assert.equal(report.byProvider.anthropic.tasks, 1);
      assert.equal(report.byProvider.openai.tasks, 1);
    });

    it('should aggregate by model', () => {
      const normalizer = new mod.CostNormalizer(MOCK_MODELS, { projectRoot: tmpDir });

      normalizer.recordDailyCost({
        modelId: 'claude-sonnet-4-5',
        inputTokens: 50_000,
        outputTokens: 20_000
      });
      normalizer.recordDailyCost({
        modelId: 'claude-sonnet-4-5',
        inputTokens: 30_000,
        outputTokens: 10_000
      });

      const report = normalizer.getDailyReport();

      assert.equal(report.byModel['claude-sonnet-4-5'].entries, 2);
      assert.ok(report.byModel['claude-sonnet-4-5'].dollars > 0);
    });

    it('should return empty report for days with no data', () => {
      const normalizer = new mod.CostNormalizer(MOCK_MODELS, { projectRoot: tmpDir });

      const report = normalizer.getDailyReport('2020-01-01');

      assert.equal(report.total, 0);
      assert.equal(report.entryCount, 0);
      assert.deepEqual(report.byProvider, {});
    });
  });

  describe('savings calculation', () => {
    it('should calculate savings vs all-Opus baseline', () => {
      const normalizer = new mod.CostNormalizer(MOCK_MODELS, { projectRoot: tmpDir });

      // Record costs using cheap models
      normalizer.recordDailyCost({
        modelId: 'gemini-2.5-flash',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        taskId: 'bd-cheap-1'
      });

      const report = normalizer.getDailyReport();

      // Actual: Gemini Flash — very cheap
      // Opus equivalent: same tokens at Opus rates — very expensive
      assert.ok(report.savings.opusEquivalent > report.savings.actual);
      assert.ok(report.savings.saved > 0);
      assert.ok(parseFloat(report.savings.percentSaved) > 90, 'Flash should save >90% vs Opus');
    });

    it('should show 0% savings when using only Opus', () => {
      const normalizer = new mod.CostNormalizer(MOCK_MODELS, { projectRoot: tmpDir });

      normalizer.recordDailyCost({
        modelId: 'claude-opus-4-6',
        inputTokens: 100_000,
        outputTokens: 50_000
      });

      const report = normalizer.getDailyReport();

      assert.equal(report.savings.percentSaved, '0.0');
      assert.equal(report.savings.saved, 0);
    });

    it('should handle local model savings', () => {
      const normalizer = new mod.CostNormalizer(MOCK_MODELS, { projectRoot: tmpDir });

      normalizer.recordDailyCost({
        modelId: 'ollama:llama-3.3-70b',
        inputTokens: 500_000,
        outputTokens: 200_000
      });

      const report = normalizer.getDailyReport();

      assert.equal(report.savings.actual, 0);
      assert.ok(report.savings.opusEquivalent > 0);
      assert.equal(report.savings.percentSaved, '100.0');
    });
  });

  describe('provider budget enforcement', () => {
    it('should report ok when under budget', () => {
      const normalizer = new mod.CostNormalizer(MOCK_MODELS, {
        projectRoot: tmpDir,
        providerBudgets: { anthropic: 50.0, openai: 30.0 }
      });

      normalizer.recordDailyCost({
        modelId: 'claude-sonnet-4-5',
        inputTokens: 50_000,
        outputTokens: 20_000
      });

      const result = normalizer.checkProviderBudget('anthropic');
      assert.equal(result.status, 'ok');
      assert.equal(result.budget, 50.0);
      assert.ok(result.spent < 50.0);
    });

    it('should report exceeded when over budget', () => {
      const normalizer = new mod.CostNormalizer(MOCK_MODELS, {
        projectRoot: tmpDir,
        providerBudgets: { anthropic: 0.01 }
      });

      normalizer.recordDailyCost({
        modelId: 'claude-opus-4-6',
        inputTokens: 100_000,
        outputTokens: 100_000
      });

      const result = normalizer.checkProviderBudget('anthropic');
      assert.equal(result.status, 'exceeded');
    });

    it('should report warning when at 80%+', () => {
      const normalizer = new mod.CostNormalizer(MOCK_MODELS, {
        projectRoot: tmpDir,
        providerBudgets: { anthropic: 1.20 }
      });

      // Sonnet: $0.45 + $0.30 = $1.05 -> 87.5% of $1.20 budget
      normalizer.recordDailyCost({
        modelId: 'claude-sonnet-4-5',
        inputTokens: 100_000,
        outputTokens: 50_000
      });

      const result = normalizer.checkProviderBudget('anthropic');
      assert.equal(result.status, 'warning');
    });

    it('should report ok for providers with no budget', () => {
      const normalizer = new mod.CostNormalizer(MOCK_MODELS, {
        projectRoot: tmpDir,
        providerBudgets: { local: null }
      });

      const result = normalizer.checkProviderBudget('local');
      assert.equal(result.status, 'ok');
      assert.equal(result.budget, null);
    });

    it('should check all provider budgets at once', () => {
      const normalizer = new mod.CostNormalizer(MOCK_MODELS, {
        projectRoot: tmpDir,
        providerBudgets: { anthropic: 50.0, openai: 30.0, local: null }
      });

      const results = normalizer.checkAllProviderBudgets();
      assert.ok('anthropic' in results);
      assert.ok('openai' in results);
      assert.ok('local' in results);
    });
  });

  describe('works with ModelRegistry interface', () => {
    it('should accept objects with get() method', () => {
      const mockRegistry = {
        get(modelId) {
          return MOCK_MODELS[modelId] || null;
        }
      };

      const normalizer = new mod.CostNormalizer(mockRegistry, { projectRoot: tmpDir });
      const result = normalizer.calculateCost('claude-sonnet-4-5', {
        inputTokens: 100_000,
        outputTokens: 50_000
      });

      assert.equal(result.dollars, 1.05);
    });
  });

  describe('createNormalizer()', () => {
    it('should create a normalizer (may use fallback if registry unavailable)', () => {
      // In test env, model-registry may not be loadable — factory should not throw
      const normalizer = mod.createNormalizer({ projectRoot: tmpDir });
      assert.ok(normalizer instanceof mod.CostNormalizer);

      // Should still calculate using fallback pricing
      const result = normalizer.calculateCost('unknown-model', {
        inputTokens: 100_000,
        outputTokens: 100_000
      });
      assert.ok(result.dollars > 0);
    });
  });

  describe('constants', () => {
    it('should export normalization constants', () => {
      assert.equal(mod.SONNET_OUTPUT_RATE, 15.0);
      assert.ok(mod.DAILY_COSTS_DIR);
      assert.ok(mod.FALLBACK_PRICING);
    });
  });
});
