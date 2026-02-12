/**
 * Cross-Model Cost Normalizer — Phase 6.13 (Pilot AGI-bro)
 *
 * Normalizes costs to USD for fair cross-model comparison.
 * Uses model-registry.js pricing data for per-model cost calculation.
 *
 * Key concepts:
 *   - "Normalized tokens": Converts any model's cost to "Sonnet-equivalent tokens"
 *     so you can compare cost-efficiency across models on the same scale.
 *   - "Savings report": Shows actual cost vs what it would have cost using only Opus.
 *   - "Provider budgets": Per-provider daily limits from policy.yaml.
 *   - "Cost per line": Efficiency metric for model comparison.
 *
 * State files:
 *   .claude/pilot/state/costs/daily/<date>.json — daily cost entries per model
 */

'use strict';

const fs = require('fs');
const path = require('path');

// =============================================================================
// CONSTANTS
// =============================================================================

// Claude Sonnet 4.5 output rate — normalization baseline
const SONNET_OUTPUT_RATE = 15.0; // $/1M tokens
const DAILY_COSTS_DIR = '.claude/pilot/state/costs/daily';

// Fallback pricing when model not found in registry
const FALLBACK_PRICING = { input: 10.0, output: 10.0 };

// =============================================================================
// COST NORMALIZER
// =============================================================================

class CostNormalizer {
  /**
   * @param {object} modelRegistry - ModelRegistry instance or model map
   * @param {object} [opts]
   * @param {string} [opts.projectRoot] - Project root for state files
   * @param {object} [opts.providerBudgets] - Per-provider daily budgets { anthropic: 50, openai: 30, ... }
   */
  constructor(modelRegistry, opts = {}) {
    // Accept either ModelRegistry instance (with .get()) or plain object
    if (modelRegistry && typeof modelRegistry.get === 'function') {
      this._registry = modelRegistry;
      this._models = null;
    } else {
      this._registry = null;
      this._models = modelRegistry || {};
    }

    this.projectRoot = opts.projectRoot || process.cwd();
    this.providerBudgets = opts.providerBudgets || {};
  }

  /**
   * Look up a model profile.
   * @param {string} modelId
   * @returns {object|null}
   */
  _getModel(modelId) {
    if (this._registry) return this._registry.get(modelId);
    return this._models[modelId] || null;
  }

  // ===========================================================================
  // COST CALCULATION
  // ===========================================================================

  /**
   * Calculate actual cost for a model execution in USD.
   *
   * @param {string} modelId - Model ID from registry
   * @param {object} usage - Token usage
   * @param {number} usage.inputTokens - Input tokens consumed
   * @param {number} usage.outputTokens - Output tokens produced
   * @returns {{ dollars: number, normalizedTokens: number, provider: string }}
   */
  calculateCost(modelId, usage) {
    const profile = this._getModel(modelId);
    const pricing = profile?.cost || FALLBACK_PRICING;
    const provider = profile?.provider || 'unknown';

    const inputCost = (usage.inputTokens / 1_000_000) * pricing.input;
    const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
    const dollars = inputCost + outputCost;

    // Normalize to "Sonnet-equivalent tokens" for fair cross-model comparison
    const normalizedTokens = SONNET_OUTPUT_RATE > 0
      ? Math.round((dollars / SONNET_OUTPUT_RATE) * 1_000_000)
      : 0;

    return {
      dollars: roundCost(dollars),
      normalizedTokens,
      provider,
      breakdown: {
        input: roundCost(inputCost),
        output: roundCost(outputCost)
      }
    };
  }

  /**
   * Calculate cost-per-line-of-code changed.
   * Used to compare model efficiency on similar tasks.
   *
   * @param {string} modelId
   * @param {object} usage - { inputTokens, outputTokens }
   * @param {number} linesChanged - Lines of code added/modified
   * @returns {number} Cost per line in USD
   */
  costPerLine(modelId, usage, linesChanged) {
    const { dollars } = this.calculateCost(modelId, usage);
    return linesChanged > 0 ? roundCost(dollars / linesChanged) : 0;
  }

  // ===========================================================================
  // DAILY COST TRACKING
  // ===========================================================================

  /**
   * Record a cost entry for today.
   *
   * @param {object} entry
   * @param {string} entry.modelId
   * @param {number} entry.inputTokens
   * @param {number} entry.outputTokens
   * @param {string} [entry.taskId]
   * @param {string} [entry.sessionId]
   */
  recordDailyCost(entry) {
    const cost = this.calculateCost(entry.modelId, {
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens
    });

    const today = new Date().toISOString().split('T')[0];
    const dailyPath = this._getDailyPath(today);

    const state = this._readJSON(dailyPath) || {
      date: today,
      entries: [],
      created_at: new Date().toISOString()
    };

    state.entries.push({
      modelId: entry.modelId,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      dollars: cost.dollars,
      normalizedTokens: cost.normalizedTokens,
      provider: cost.provider,
      taskId: entry.taskId || null,
      sessionId: entry.sessionId || null,
      timestamp: new Date().toISOString()
    });

    state.updated_at = new Date().toISOString();
    this._writeJSON(dailyPath, state);
  }

  /**
   * Get daily cost report broken down by provider.
   *
   * @param {string} [date] - Date string (YYYY-MM-DD), defaults to today
   * @returns {{ date: string, total: number, byProvider: object, byModel: object, savings: object }}
   */
  getDailyReport(date) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    const entries = this._readDailyCosts(targetDate);

    const byProvider = {};
    const byModel = {};

    for (const entry of entries) {
      const provider = entry.provider || 'unknown';

      // Aggregate by provider
      if (!byProvider[provider]) {
        byProvider[provider] = { dollars: 0, tasks: new Set(), tokens: 0, entries: 0 };
      }
      byProvider[provider].dollars += entry.dollars;
      if (entry.taskId) byProvider[provider].tasks.add(entry.taskId);
      byProvider[provider].tokens += (entry.inputTokens || 0) + (entry.outputTokens || 0);
      byProvider[provider].entries += 1;

      // Aggregate by model
      if (!byModel[entry.modelId]) {
        byModel[entry.modelId] = { dollars: 0, tokens: 0, entries: 0 };
      }
      byModel[entry.modelId].dollars += entry.dollars;
      byModel[entry.modelId].tokens += (entry.inputTokens || 0) + (entry.outputTokens || 0);
      byModel[entry.modelId].entries += 1;
    }

    // Convert Sets to counts
    for (const p of Object.values(byProvider)) {
      p.tasks = p.tasks.size;
      p.dollars = roundCost(p.dollars);
    }
    for (const m of Object.values(byModel)) {
      m.dollars = roundCost(m.dollars);
    }

    const total = roundCost(Object.values(byProvider).reduce((sum, p) => sum + p.dollars, 0));

    return {
      date: targetDate,
      total,
      byProvider,
      byModel,
      savings: this._calculateSavings(entries),
      entryCount: entries.length
    };
  }

  // ===========================================================================
  // SAVINGS CALCULATION
  // ===========================================================================

  /**
   * Calculate savings vs all-Opus baseline.
   * Shows how much money was saved by using cheaper models.
   *
   * @param {object[]} entries - Daily cost entries
   * @returns {{ opusEquivalent: number, actual: number, saved: number, percentSaved: string }}
   */
  _calculateSavings(entries) {
    const opusProfile = this._getModel('claude-opus-4-6');
    const opusPricing = opusProfile?.cost || { input: 15.0, output: 75.0 };

    let opusCost = 0;
    let actualCost = 0;

    for (const entry of entries) {
      opusCost +=
        ((entry.inputTokens || 0) / 1_000_000) * opusPricing.input +
        ((entry.outputTokens || 0) / 1_000_000) * opusPricing.output;
      actualCost += entry.dollars || 0;
    }

    const saved = opusCost - actualCost;

    return {
      opusEquivalent: roundCost(opusCost),
      actual: roundCost(actualCost),
      saved: roundCost(saved),
      percentSaved: opusCost > 0
        ? ((saved / opusCost) * 100).toFixed(1)
        : '0.0'
    };
  }

  // ===========================================================================
  // PROVIDER BUDGET ENFORCEMENT
  // ===========================================================================

  /**
   * Check if a provider's daily budget is exceeded.
   *
   * @param {string} provider - Provider name (anthropic, openai, google, local)
   * @param {string} [date] - Date to check, defaults to today
   * @returns {{ status: 'ok'|'warning'|'exceeded', spent: number, budget: number|null }}
   */
  checkProviderBudget(provider, date) {
    const budget = this.providerBudgets[provider];
    if (budget === null || budget === undefined) {
      return { status: 'ok', spent: 0, budget: null };
    }

    const report = this.getDailyReport(date);
    const providerData = report.byProvider[provider];
    const spent = providerData ? providerData.dollars : 0;

    if (spent >= budget) {
      return { status: 'exceeded', spent: roundCost(spent), budget };
    }
    if (spent >= budget * 0.8) {
      return { status: 'warning', spent: roundCost(spent), budget };
    }

    return { status: 'ok', spent: roundCost(spent), budget };
  }

  /**
   * Check all provider budgets at once.
   *
   * @param {string} [date]
   * @returns {object} Map of provider -> budget status
   */
  checkAllProviderBudgets(date) {
    const results = {};
    for (const provider of Object.keys(this.providerBudgets)) {
      results[provider] = this.checkProviderBudget(provider, date);
    }
    return results;
  }

  // ===========================================================================
  // FILE I/O
  // ===========================================================================

  _getDailyPath(date) {
    return path.join(this.projectRoot, DAILY_COSTS_DIR, `${date}.json`);
  }

  _readDailyCosts(date) {
    const dailyPath = this._getDailyPath(date);
    const state = this._readJSON(dailyPath);
    return state?.entries || [];
  }

  _readJSON(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    } catch (e) { /* corrupted — start fresh */ }
    return null;
  }

  _writeJSON(filePath, data) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = filePath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, filePath);
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function roundCost(value) {
  return Math.round(value * 10000) / 10000;
}

// =============================================================================
// CONVENIENCE FACTORY
// =============================================================================

/**
 * Create a CostNormalizer with the default model registry and policy budgets.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectRoot]
 * @returns {CostNormalizer}
 */
function createNormalizer(opts = {}) {
  const projectRoot = opts.projectRoot || process.cwd();

  // Load model registry
  let registry;
  try {
    const { getRegistry } = require(path.join(projectRoot, '.claude', 'pilot', 'hooks', 'lib', 'model-registry'));
    registry = getRegistry(projectRoot);
  } catch (e) {
    registry = {};
  }

  // Load provider budgets from policy.yaml
  let providerBudgets = {};
  try {
    const { loadPolicy } = require(path.join(projectRoot, '.claude', 'pilot', 'hooks', 'lib', 'policy'));
    const policy = loadPolicy();
    providerBudgets = policy.models?.provider_budgets || {};
  } catch (e) { /* no policy */ }

  return new CostNormalizer(registry, { projectRoot, providerBudgets });
}

module.exports = {
  CostNormalizer,
  createNormalizer,
  SONNET_OUTPUT_RATE,
  DAILY_COSTS_DIR,
  FALLBACK_PRICING
};
