/**
 * Model Capability Registry (Phase 6.11)
 *
 * Structured profiles for all supported LLM models. Each profile includes
 * strengths, weaknesses, speed, cost, context window, and bestFor tags.
 *
 * Covers: Claude (Opus/Sonnet/Haiku), GPT (4.5/4o/o3-mini),
 * Gemini (2.5-pro/flash), Codex, Ollama local models.
 *
 * Community-extensible: custom profiles can be loaded from
 * .claude/pilot/models/*.json at runtime.
 *
 * Part of Phase 6.11 (Pilot AGI-bqq)
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// BUILT-IN MODEL PROFILES
// ============================================================================

const BUILTIN_MODELS = {
  // -- Anthropic Claude --

  'claude-opus-4-6': {
    provider: 'anthropic',
    adapter: 'claude',
    name: 'Claude Opus 4.6',
    strengths: ['complex-reasoning', 'architecture', 'refactoring', 'security', 'code-review'],
    weaknesses: ['slow', 'expensive'],
    speed: 0.3,
    cost: { input: 15.0, output: 75.0 },
    contextWindow: 200000,
    bestFor: ['backend-architecture', 'security-review', 'complex-refactor', 'merge-review'],
  },

  'claude-sonnet-4-5': {
    provider: 'anthropic',
    adapter: 'claude',
    name: 'Claude Sonnet 4.5',
    strengths: ['general', 'balanced', 'coding', 'fast-enough'],
    weaknesses: [],
    speed: 0.6,
    cost: { input: 3.0, output: 15.0 },
    contextWindow: 200000,
    bestFor: ['general-coding', 'feature-implementation', 'bug-fixes'],
  },

  'claude-haiku-4-5': {
    provider: 'anthropic',
    adapter: 'claude',
    name: 'Claude Haiku 4.5',
    strengths: ['very-fast', 'very-cheap', 'good-enough'],
    weaknesses: ['limited-reasoning'],
    speed: 0.9,
    cost: { input: 0.80, output: 4.0 },
    contextWindow: 200000,
    bestFor: ['documentation', 'simple-refactors', 'formatting', 'comments'],
  },

  // -- OpenAI GPT --

  'gpt-4.5': {
    provider: 'openai',
    adapter: 'aider',
    name: 'GPT-4.5',
    strengths: ['test-generation', 'patterns', 'general'],
    weaknesses: ['context-window'],
    speed: 0.5,
    cost: { input: 2.0, output: 10.0 },
    contextWindow: 128000,
    bestFor: ['test-generation', 'unit-tests', 'integration-tests'],
  },

  'gpt-4o': {
    provider: 'openai',
    adapter: 'aider',
    name: 'GPT-4o',
    strengths: ['multimodal', 'fast', 'general', 'tool-use'],
    weaknesses: ['less-creative'],
    speed: 0.7,
    cost: { input: 2.50, output: 10.0 },
    contextWindow: 128000,
    bestFor: ['general-coding', 'rapid-iteration', 'ui-review'],
  },

  'o3-mini': {
    provider: 'openai',
    adapter: 'aider',
    name: 'o3-mini',
    strengths: ['fast-reasoning', 'math', 'code-completion'],
    weaknesses: ['small-context'],
    speed: 0.75,
    cost: { input: 1.10, output: 4.40 },
    contextWindow: 128000,
    bestFor: ['algorithm-tasks', 'quick-fixes', 'code-completion'],
  },

  // -- Google Gemini --

  'gemini-2.5-pro': {
    provider: 'google',
    adapter: 'opencode',
    name: 'Gemini 2.5 Pro',
    strengths: ['fast', 'large-context', 'ui', 'multimodal'],
    weaknesses: ['less-precise-edits'],
    speed: 0.8,
    cost: { input: 1.25, output: 10.0 },
    contextWindow: 1000000,
    bestFor: ['frontend-ui', 'css', 'react-components', 'rapid-iteration'],
  },

  'gemini-2.5-flash': {
    provider: 'google',
    adapter: 'opencode',
    name: 'Gemini 2.5 Flash',
    strengths: ['very-fast', 'cheap', 'good-enough'],
    weaknesses: ['quality-ceiling'],
    speed: 0.95,
    cost: { input: 0.15, output: 0.60 },
    contextWindow: 1000000,
    bestFor: ['simple-tasks', 'bulk-changes', 'formatting'],
  },

  // -- Local / Ollama --

  'ollama:deepseek-coder-v3': {
    provider: 'local',
    adapter: 'ollama',
    name: 'DeepSeek Coder V3 (local)',
    strengths: ['free', 'private', 'code-focused'],
    weaknesses: ['slower-local', 'less-capable'],
    speed: 0.2,
    cost: { input: 0, output: 0 },
    contextWindow: 128000,
    bestFor: ['documentation', 'simple-refactors', 'private-code'],
  },

  'ollama:llama-3.3-70b': {
    provider: 'local',
    adapter: 'ollama',
    name: 'Llama 3.3 70B (local)',
    strengths: ['free', 'private', 'general'],
    weaknesses: ['slower-local', 'large-model'],
    speed: 0.15,
    cost: { input: 0, output: 0 },
    contextWindow: 128000,
    bestFor: ['documentation', 'readme', 'comments', 'private-code'],
  },

  'ollama:qwen-2.5-coder-32b': {
    provider: 'local',
    adapter: 'ollama',
    name: 'Qwen 2.5 Coder 32B (local)',
    strengths: ['free', 'private', 'code-focused', 'fast-local'],
    weaknesses: ['less-capable-than-cloud'],
    speed: 0.3,
    cost: { input: 0, output: 0 },
    contextWindow: 32000,
    bestFor: ['simple-refactors', 'code-completion', 'private-code'],
  },
};

// ============================================================================
// CUSTOM MODEL LOADING
// ============================================================================

const CUSTOM_MODELS_DIR = '.claude/pilot/models';

/**
 * Load custom model profiles from project directory.
 * Each JSON file in .claude/pilot/models/ adds/overrides a model profile.
 *
 * @param {string} projectRoot
 * @returns {object} Map of modelId -> profile
 */
function loadCustomModels(projectRoot) {
  const dir = path.join(projectRoot, CUSTOM_MODELS_DIR);
  if (!fs.existsSync(dir)) return {};

  const models = {};
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      const data = JSON.parse(content);
      if (data.id && data.provider) {
        models[data.id] = data;
      }
    } catch { /* skip invalid files */ }
  }

  return models;
}

// ============================================================================
// REGISTRY CLASS
// ============================================================================

class ModelRegistry {
  /**
   * @param {object} [opts]
   * @param {string} [opts.projectRoot] - For loading custom models
   */
  constructor(opts = {}) {
    this.models = { ...BUILTIN_MODELS };

    if (opts.projectRoot) {
      const custom = loadCustomModels(opts.projectRoot);
      Object.assign(this.models, custom);
    }
  }

  // ==========================================================================
  // LOOKUP
  // ==========================================================================

  /**
   * Get a model profile by ID.
   * @param {string} modelId
   * @returns {object|null}
   */
  get(modelId) {
    return this.models[modelId] || null;
  }

  /**
   * Check if a model exists in the registry.
   * @param {string} modelId
   * @returns {boolean}
   */
  has(modelId) {
    return modelId in this.models;
  }

  /**
   * List all registered model IDs.
   * @returns {string[]}
   */
  listIds() {
    return Object.keys(this.models);
  }

  /**
   * List all registered model profiles.
   * @returns {object[]} Array of { id, ...profile }
   */
  listAll() {
    return Object.entries(this.models).map(([id, profile]) => ({ id, ...profile }));
  }

  // ==========================================================================
  // CAPABILITY QUERIES
  // ==========================================================================

  /**
   * Find models with a specific strength.
   * @param {string} strength - e.g., 'fast', 'code-focused', 'security'
   * @returns {object[]} Array of { id, ...profile }
   */
  findByStrength(strength) {
    return this.listAll().filter(m =>
      m.strengths && m.strengths.includes(strength)
    );
  }

  /**
   * Find models best suited for a task type.
   * @param {string} taskType - e.g., 'test-generation', 'frontend-ui'
   * @returns {object[]} Sorted by relevance (bestFor match first, then speed)
   */
  findForTask(taskType) {
    const all = this.listAll();

    // Score: bestFor match = 10, strength match = 3, then by speed
    const scored = all.map(m => {
      let score = 0;
      if (m.bestFor && m.bestFor.includes(taskType)) score += 10;
      if (m.strengths && m.strengths.includes(taskType)) score += 3;
      return { ...m, _score: score };
    });

    return scored
      .filter(m => m._score > 0)
      .sort((a, b) => b._score - a._score || b.speed - a.speed)
      .map(({ _score, ...m }) => m);
  }

  /**
   * Find models by provider.
   * @param {string} provider - e.g., 'anthropic', 'openai', 'google', 'local'
   * @returns {object[]}
   */
  findByProvider(provider) {
    return this.listAll().filter(m => m.provider === provider);
  }

  /**
   * Find models by adapter type.
   * @param {string} adapter - e.g., 'claude', 'aider', 'opencode', 'ollama'
   * @returns {object[]}
   */
  findByAdapter(adapter) {
    return this.listAll().filter(m => m.adapter === adapter);
  }

  /**
   * Find the cheapest model for a task type.
   * @param {string} taskType
   * @returns {object|null}
   */
  findCheapest(taskType) {
    const candidates = taskType ? this.findForTask(taskType) : this.listAll();
    if (candidates.length === 0) return null;

    return candidates.reduce((best, m) => {
      const mCost = (m.cost.input + m.cost.output) / 2;
      const bestCost = (best.cost.input + best.cost.output) / 2;
      return mCost < bestCost ? m : best;
    });
  }

  /**
   * Find the fastest model for a task type.
   * @param {string} taskType
   * @returns {object|null}
   */
  findFastest(taskType) {
    const candidates = taskType ? this.findForTask(taskType) : this.listAll();
    if (candidates.length === 0) return null;

    return candidates.reduce((best, m) =>
      m.speed > best.speed ? m : best
    );
  }

  /**
   * Find models with context window >= required size.
   * @param {number} minTokens
   * @returns {object[]}
   */
  findByContextWindow(minTokens) {
    return this.listAll().filter(m => m.contextWindow >= minTokens);
  }

  /**
   * Estimate cost for a given token count.
   * @param {string} modelId
   * @param {number} inputTokens
   * @param {number} outputTokens
   * @returns {{ cost: number, breakdown: { input: number, output: number } } | null}
   */
  estimateCost(modelId, inputTokens, outputTokens) {
    const model = this.get(modelId);
    if (!model) return null;

    const inputCost = (inputTokens / 1000000) * model.cost.input;
    const outputCost = (outputTokens / 1000000) * model.cost.output;

    return {
      cost: inputCost + outputCost,
      breakdown: { input: inputCost, output: outputCost },
    };
  }

  // ==========================================================================
  // MUTATION
  // ==========================================================================

  /**
   * Register a custom model profile.
   * @param {string} modelId
   * @param {object} profile
   */
  register(modelId, profile) {
    if (!modelId || !profile || !profile.provider) {
      throw new Error('Model must have an id and provider');
    }
    this.models[modelId] = profile;
  }

  /**
   * Remove a model from the registry.
   * @param {string} modelId
   * @returns {boolean} true if removed
   */
  unregister(modelId) {
    if (modelId in this.models) {
      delete this.models[modelId];
      return true;
    }
    return false;
  }
}

// ============================================================================
// SINGLETON + EXPORTS
// ============================================================================

let _defaultRegistry = null;

/**
 * Get the default registry (singleton, lazy init).
 * @param {string} [projectRoot]
 * @returns {ModelRegistry}
 */
function getRegistry(projectRoot) {
  if (!_defaultRegistry) {
    _defaultRegistry = new ModelRegistry({ projectRoot });
  }
  return _defaultRegistry;
}

/**
 * Reset the default registry (for testing).
 */
function resetRegistry() {
  _defaultRegistry = null;
}

module.exports = {
  ModelRegistry,
  getRegistry,
  resetRegistry,
  BUILTIN_MODELS,
  CUSTOM_MODELS_DIR,
  loadCustomModels,
};
