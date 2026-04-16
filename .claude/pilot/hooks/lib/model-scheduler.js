/**
 * Model-Aware Task Scheduler (Phase 6.12)
 *
 * Extends the existing scheduler (M3.4) with model selection.
 * Scores all available models for each task using multi-factor scoring:
 *   - Capability: 40% — how good is this model at this task type?
 *   - Cost: 30% — cheaper = higher score (inverted)
 *   - Speed: 20% — how fast? (simple tasks weight speed more)
 *   - Reliability: 10% — historical success rate for this model+taskType
 *
 * Supports:
 *   - Policy preferences (backend→Opus, frontend→Gemini, tests→GPT, docs→Llama)
 *   - Force model override (for testing)
 *   - Provider budget filtering (skip over-budget providers)
 *   - Historical learning from task outcomes
 *
 * Part of Phase 6.12 (Pilot AGI-5ww)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const OUTCOMES_DIR = '.claude/pilot/state/model-outcomes';

const DEFAULT_WEIGHTS = {
  capability: 0.40,
  cost: 0.30,
  speed: 0.20,
  reliability: 0.10,
};

// Maximum cost ceiling for normalization (Claude Opus output $/M tokens)
const MAX_OUTPUT_COST = 75.0;

// Default token estimates for cost estimation
const DEFAULT_INPUT_TOKENS = 50000;
const DEFAULT_OUTPUT_TOKENS = 20000;

// ============================================================================
// FILE I/O
// ============================================================================

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch { /* corrupted — start fresh */ }
  return null;
}

function writeJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// ============================================================================
// TASK TYPE CLASSIFICATION
// ============================================================================

/**
 * Classify a task into a type category for model matching.
 * Examines title, description, labels, and files to determine type.
 *
 * @param {object} task
 * @returns {string} Task type (e.g., 'test-generation', 'frontend-ui')
 */
function classifyTaskType(task) {
  const text = `${task.title || ''} ${task.description || ''} ${(task.labels || []).join(' ')}`.toLowerCase();
  const files = (task.files || []).map(f => f.toLowerCase());

  // Check in order of specificity
  if (/\btest|spec\b/.test(text) || files.some(f => f.includes('.test.') || f.includes('.spec.'))) {
    return 'test-generation';
  }
  if (/\bsecuri|vulnerab|auth.*review|penetrat/i.test(text)) {
    return 'security-review';
  }
  if (/\brefactor|restructur|rewrite|reorganiz/i.test(text)) {
    return 'complex-refactor';
  }
  if (/\bdoc|readme|changelog|comment/i.test(text) || files.some(f => f.endsWith('.md'))) {
    return 'documentation';
  }
  if (/\bcss|style|ui|component|react|frontend|layout|design/i.test(text) ||
      files.some(f => /\.(css|scss|tsx|jsx)$/.test(f))) {
    return 'frontend-ui';
  }
  if (/\bformat|lint|prettier|eslint/i.test(text)) {
    return 'formatting';
  }
  if (/\bsimple|trivial|typo|rename|bump/i.test(text)) {
    return 'simple-tasks';
  }
  if (/\bapi|endpoint|server|database|backend|migration/i.test(text)) {
    return 'backend-architecture';
  }
  if (/\bbug|fix|patch|issue|error/i.test(text)) {
    return 'bug-fixes';
  }

  return 'general-coding';
}

// ============================================================================
// MODEL SCHEDULER CLASS
// ============================================================================

class ModelScheduler {
  /**
   * @param {import('./model-registry').ModelRegistry} modelRegistry
   * @param {object} policy - Loaded policy object
   * @param {string} [projectRoot] - Project root for state files
   */
  constructor(modelRegistry, policy, projectRoot) {
    this.models = modelRegistry;
    this.policy = policy || {};
    this.projectRoot = projectRoot || process.cwd();

    const modelPolicy = this.policy.models || {};
    this.weights = { ...DEFAULT_WEIGHTS, ...(modelPolicy.scheduling?.model_weights || {}) };
    this.preferences = modelPolicy.preferences || {};
    this.forceModel = modelPolicy.force_model || null;
    this.defaultModel = modelPolicy.default || 'claude-sonnet-4-5';
    this.providerBudgets = modelPolicy.provider_budgets || {};
  }

  // ==========================================================================
  // MAIN API
  // ==========================================================================

  /**
   * Score all available models for a task and return ranked list.
   *
   * @param {object} task - Task with title, description, labels, files, etc.
   * @param {string[]} availableAdapters - Names of available adapter CLIs
   * @returns {Array<{ modelId: string, adapterId: string, score: number, breakdown: object, estimatedCost: number }>}
   */
  scoreModels(task, availableAdapters) {
    // If force_model is set, return only that model
    if (this.forceModel) {
      const profile = this.models.get(this.forceModel);
      if (profile && availableAdapters.includes(profile.adapter)) {
        return [{
          modelId: this.forceModel,
          adapterId: profile.adapter,
          score: 1.0,
          breakdown: { capability: 1, cost: 1, speed: 1, reliability: 1, forced: true },
          estimatedCost: this._estimateCost(profile, task),
        }];
      }
      // Force model not available — fall through to normal scoring
    }

    const taskType = classifyTaskType(task);
    const candidates = [];

    for (const [modelId, profile] of Object.entries(this.models.models)) {
      // Skip if adapter not available
      if (!availableAdapters.includes(profile.adapter)) continue;

      // Skip if provider over budget
      if (this._isProviderOverBudget(profile.provider)) continue;

      // Skip if model exceeds task budget
      const estimatedCost = this._estimateCost(profile, task);
      if (task.budget && estimatedCost > task.budget) continue;

      const capability = this._scoreCapability(profile, task, taskType);
      const cost = this._scoreCost(profile);
      const speed = this._scoreSpeed(profile, task);
      const reliability = this._scoreReliability(modelId, taskType);

      let score =
        capability * this.weights.capability +
        cost * this.weights.cost +
        speed * this.weights.speed +
        reliability * this.weights.reliability;

      // Apply preference boost
      const preferenceBoost = this._getPreferenceBoost(modelId, taskType);
      score += preferenceBoost;

      candidates.push({
        modelId,
        adapterId: profile.adapter,
        score,
        breakdown: {
          capability,
          cost,
          speed,
          reliability,
          preferenceBoost,
          taskType,
        },
        estimatedCost,
      });
    }

    return candidates.sort((a, b) => b.score - a.score);
  }

  /**
   * Select the best model for a task.
   * Returns the top-scored model, or the default if nothing matches.
   *
   * @param {object} task
   * @param {string[]} availableAdapters
   * @returns {{ modelId: string, adapterId: string, score: number, breakdown: object, estimatedCost: number } | null}
   */
  selectModel(task, availableAdapters) {
    const ranked = this.scoreModels(task, availableAdapters);

    if (ranked.length > 0) {
      return ranked[0];
    }

    // Fallback to default model
    const defaultProfile = this.models.get(this.defaultModel);
    if (defaultProfile && availableAdapters.includes(defaultProfile.adapter)) {
      return {
        modelId: this.defaultModel,
        adapterId: defaultProfile.adapter,
        score: 0,
        breakdown: { fallback: true, reason: 'No model scored — using default' },
        estimatedCost: this._estimateCost(defaultProfile, task),
      };
    }

    return null;
  }

  // ==========================================================================
  // SCORING SUB-FUNCTIONS
  // ==========================================================================

  /**
   * Score model capability for a task.
   * Checks bestFor match, strength overlap, and task requirements.
   *
   * @param {object} profile
   * @param {object} task
   * @param {string} taskType
   * @returns {number} 0-1
   */
  _scoreCapability(profile, task, taskType) {
    const bestFor = profile.bestFor || [];
    const strengths = profile.strengths || [];

    // bestFor exact match (highest signal)
    const bestForMatch = bestFor.includes(taskType) ? 1.0 : 0;

    // bestFor partial match (task type substring)
    const bestForPartial = bestFor.some(b => taskType.includes(b) || b.includes(taskType)) ? 0.5 : 0;

    // Strength overlap with task requirements
    const requirements = task.requirements || [];
    let strengthScore = 0;
    if (requirements.length > 0) {
      const hits = strengths.filter(s => requirements.includes(s)).length;
      strengthScore = hits / requirements.length;
    }

    // Combine: exact bestFor > partial bestFor > strength overlap
    if (bestForMatch > 0) {
      return bestForMatch * 0.6 + strengthScore * 0.4;
    }
    if (bestForPartial > 0) {
      return bestForPartial * 0.6 + strengthScore * 0.4;
    }
    return strengthScore * 0.4;
  }

  /**
   * Score cost efficiency (cheaper = higher score).
   * Normalized: free=1.0, most expensive=0.0
   *
   * @param {object} profile
   * @returns {number} 0-1
   */
  _scoreCost(profile) {
    const outputCost = profile.cost?.output || 0;
    if (outputCost === 0) return 1.0; // Free model
    return Math.max(0, 1 - (outputCost / MAX_OUTPUT_COST));
  }

  /**
   * Score speed. Simple/low-risk tasks weight speed more.
   *
   * @param {object} profile
   * @param {object} task
   * @returns {number} 0-1
   */
  _scoreSpeed(profile, task) {
    const baseSpeed = profile.speed || 0.5;
    const complexity = task.complexity || 'medium';

    // Simple tasks benefit more from speed
    const multiplier = complexity === 'simple' ? 1.3 : complexity === 'complex' ? 0.8 : 1.0;
    return Math.min(baseSpeed * multiplier, 1.0);
  }

  /**
   * Score reliability from historical outcomes.
   * Unknown models get neutral 0.5.
   *
   * @param {string} modelId
   * @param {string} taskType
   * @returns {number} 0-1
   */
  _scoreReliability(modelId, taskType) {
    const history = this._readHistory(modelId, taskType);
    if (history.total === 0) return 0.5; // Unknown = neutral
    return history.success / history.total;
  }

  /**
   * Estimate dollar cost for a task on a model.
   *
   * @param {object} profile
   * @param {object} task
   * @returns {number} Estimated cost in dollars
   */
  _estimateCost(profile, task) {
    const inputTokens = task.estimatedTokens?.input || DEFAULT_INPUT_TOKENS;
    const outputTokens = task.estimatedTokens?.output || DEFAULT_OUTPUT_TOKENS;
    const inputCost = profile.cost?.input || 0;
    const outputCost = profile.cost?.output || 0;
    return (inputTokens * inputCost / 1000000) + (outputTokens * outputCost / 1000000);
  }

  // ==========================================================================
  // PREFERENCE SYSTEM
  // ==========================================================================

  /**
   * Get preference boost for a model on a task type.
   * If policy.yaml has models.preferences.testing = 'gpt-4.5',
   * then gpt-4.5 gets a boost for test-generation tasks.
   *
   * @param {string} modelId
   * @param {string} taskType
   * @returns {number} Boost value (0 or positive)
   */
  _getPreferenceBoost(modelId, taskType) {
    if (!this.preferences || Object.keys(this.preferences).length === 0) return 0;

    // Map task types to preference categories
    const typeToCategory = {
      'backend-architecture': 'backend',
      'frontend-ui': 'frontend',
      'test-generation': 'testing',
      'documentation': 'documentation',
      'simple-tasks': 'simple',
      'formatting': 'simple',
      'security-review': 'security',
      'complex-refactor': 'backend',
      'bug-fixes': 'backend',
      'general-coding': 'backend',
    };

    const category = typeToCategory[taskType];
    if (!category) return 0;

    const preferredModel = this.preferences[category];
    if (!preferredModel) return 0;

    // Exact match gives full boost
    if (modelId === preferredModel) return 0.3;

    // Partial match (e.g., 'ollama:llama-3.3-70b' matches 'ollama:llama')
    if (modelId.startsWith(preferredModel) || preferredModel.startsWith(modelId)) return 0.15;

    return 0;
  }

  // ==========================================================================
  // PROVIDER BUDGET FILTERING
  // ==========================================================================

  /**
   * Check if a provider has exceeded its daily budget.
   *
   * @param {string} provider
   * @returns {boolean}
   */
  _isProviderOverBudget(provider) {
    const budget = this.providerBudgets[provider];
    if (budget === null || budget === undefined) return false; // No limit

    const spent = this._getProviderDailySpend(provider);
    return spent >= budget;
  }

  /**
   * Get total spend for a provider today.
   * Reads from cost-tracker state files.
   *
   * @param {string} provider
   * @returns {number} Total spend in dollars today
   */
  _getProviderDailySpend(provider) {
    const today = new Date().toISOString().split('T')[0];
    const spendPath = path.join(
      this.projectRoot,
      OUTCOMES_DIR,
      'spend',
      `${provider}-${today}.json`
    );

    const data = readJSON(spendPath);
    return data?.total || 0;
  }

  /**
   * Record spend for a provider.
   *
   * @param {string} provider
   * @param {number} amount - Dollar amount
   */
  recordProviderSpend(provider, amount) {
    const today = new Date().toISOString().split('T')[0];
    const spendDir = path.join(this.projectRoot, OUTCOMES_DIR, 'spend');
    const spendPath = path.join(spendDir, `${provider}-${today}.json`);

    const data = readJSON(spendPath) || { provider, date: today, total: 0, entries: [] };
    data.total += amount;
    data.entries.push({ amount, timestamp: new Date().toISOString() });

    writeJSON(spendPath, data);
  }

  // ==========================================================================
  // HISTORICAL RELIABILITY
  // ==========================================================================

  /**
   * Read historical outcomes for a model+taskType pair.
   *
   * @param {string} modelId
   * @param {string} taskType
   * @returns {{ success: number, total: number }}
   */
  _readHistory(modelId, taskType) {
    const safe = modelId.replace(/[:/]/g, '_');
    const histPath = path.join(
      this.projectRoot,
      OUTCOMES_DIR,
      'history',
      `${safe}.json`
    );

    const data = readJSON(histPath);
    if (!data || !data.taskTypes || !data.taskTypes[taskType]) {
      return { success: 0, total: 0 };
    }

    return data.taskTypes[taskType];
  }

  /**
   * Record a task outcome for historical learning.
   *
   * @param {string} modelId
   * @param {string} taskType
   * @param {boolean} success
   */
  recordOutcome(modelId, taskType, success) {
    const safe = modelId.replace(/[:/]/g, '_');
    const histDir = path.join(this.projectRoot, OUTCOMES_DIR, 'history');
    const histPath = path.join(histDir, `${safe}.json`);

    const data = readJSON(histPath) || { modelId, taskTypes: {} };
    if (!data.taskTypes[taskType]) {
      data.taskTypes[taskType] = { success: 0, total: 0 };
    }

    data.taskTypes[taskType].total += 1;
    if (success) {
      data.taskTypes[taskType].success += 1;
    }

    data.lastUpdated = new Date().toISOString();
    writeJSON(histPath, data);
  }
}

// ============================================================================
// SINGLETON + EXPORTS
// ============================================================================

let _instance = null;

/**
 * Get or create the default ModelScheduler.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectRoot]
 * @returns {ModelScheduler}
 */
function getModelScheduler(opts = {}) {
  if (!_instance) {
    const { ModelRegistry, getRegistry } = require('./model-registry');
    let loadPolicy;
    try {
      loadPolicy = require('./policy').loadPolicy;
    } catch {
      loadPolicy = () => ({});
    }
    const projectRoot = opts.projectRoot || process.cwd();
    const registry = getRegistry(projectRoot);
    const policy = loadPolicy();
    _instance = new ModelScheduler(registry, policy, projectRoot);
  }
  return _instance;
}

/**
 * Reset the singleton (for testing).
 */
function resetModelScheduler() {
  _instance = null;
}

module.exports = {
  ModelScheduler,
  getModelScheduler,
  resetModelScheduler,
  classifyTaskType,
  DEFAULT_WEIGHTS,
  OUTCOMES_DIR,
};
