/**
 * Agent Adapter Registry — Phase 6.1 (Pilot AGI-cni)
 *
 * Registry that holds all known agent adapters, detects which
 * CLIs are installed, caches detection results, and resolves
 * adapters by name or model ID.
 *
 * Used by PM Daemon on startup to discover available agent CLIs
 * and by the model-aware scheduler to route tasks.
 *
 * State: detection results are cached in-memory (re-detect on demand).
 */

'use strict';

const { AgentAdapter } = require('./agent-adapter');

// ============================================================================
// AGENT ADAPTER REGISTRY
// ============================================================================

class AgentAdapterRegistry {
  constructor() {
    /** @type {Map<string, AgentAdapter>} */
    this.adapters = new Map();

    /** @type {Map<string, { available: boolean, version?: string, path?: string, models?: Array, error?: string }>} */
    this.detected = new Map();

    /** @type {boolean} */
    this._hasDetected = false;
  }

  /**
   * Register an adapter instance.
   * @param {AgentAdapter} adapter
   * @throws if adapter is not an AgentAdapter instance or name is already registered
   */
  register(adapter) {
    if (!(adapter instanceof AgentAdapter)) {
      throw new Error('Adapter must be an instance of AgentAdapter');
    }
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Adapter '${adapter.name}' is already registered`);
    }
    this.adapters.set(adapter.name, adapter);
  }

  /**
   * Detect all registered agent CLIs on the system.
   * Runs detect() + listModels() on each adapter in parallel.
   * Failed detect() calls are stored as { available: false, error: message }.
   * @returns {Promise<Map<string, { available: boolean, version?: string, path?: string, models?: Array }>>}
   */
  async detectAll() {
    const entries = [...this.adapters.entries()];
    const results = await Promise.allSettled(
      entries.map(async ([name, adapter]) => {
        const detection = await adapter.detect();
        let models = detection.models || [];
        if (detection.available && (!models || models.length === 0)) {
          try {
            models = await adapter.listModels();
          } catch {
            // Models list failed — adapter is still available, just no model info
          }
        }
        return { name, detection: { ...detection, models } };
      })
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        const { name, detection } = result.value;
        this.detected.set(name, detection);
      } else {
        // Detection threw — mark as unavailable with error
        const name = entries[i][0];
        this.detected.set(name, { available: false, error: result.reason?.message });
      }
    }

    this._hasDetected = true;
    return new Map(this.detected);
  }

  /**
   * Get adapter by name.
   * @param {string} name
   * @returns {import('./agent-adapter').AgentAdapter | undefined}
   */
  get(name) {
    return this.adapters.get(name);
  }

  /**
   * Get all registered adapters (regardless of availability).
   * @returns {AgentAdapter[]}
   */
  getAll() {
    return [...this.adapters.values()];
  }

  /**
   * Get all registered adapter names.
   * @returns {string[]}
   */
  getNames() {
    return [...this.adapters.keys()];
  }

  /**
   * Remove all registered adapters and detection results.
   */
  clear() {
    this.adapters.clear();
    this.detected.clear();
    this._hasDetected = false;
  }

  /**
   * Get all available adapters (detected and installed).
   * Must call detectAll() first.
   * @returns {import('./agent-adapter').AgentAdapter[]}
   */
  getAvailable() {
    return [...this.adapters.values()].filter(a =>
      this.detected.get(a.name)?.available === true
    );
  }

  /**
   * Get detection result for an adapter.
   * @param {string} name
   * @returns {{ available: boolean, version?: string, path?: string, models?: Array } | undefined}
   */
  getDetection(name) {
    return this.detected.get(name);
  }

  /**
   * Get the best adapter for a given model ID.
   * Searches all available adapters' detected models.
   * @param {string} modelId
   * @returns {import('./agent-adapter').AgentAdapter | null}
   */
  getAdapterForModel(modelId) {
    for (const adapter of this.getAvailable()) {
      const detection = this.detected.get(adapter.name);
      const models = detection?.models || [];
      if (models.some(m => m.id === modelId)) {
        return adapter;
      }
    }
    return null;
  }

  /**
   * Get all available models across all detected adapters.
   * Each model entry includes the adapter name.
   * @returns {Array<{ id: string, name: string, provider: string, capabilities: string[], adapter: string }>}
   */
  getAllModels() {
    const models = [];
    for (const adapter of this.getAvailable()) {
      const detection = this.detected.get(adapter.name);
      for (const model of (detection?.models || [])) {
        models.push({ ...model, adapter: adapter.name });
      }
    }
    return models;
  }

  /**
   * Get a summary of detection results (for PM Daemon startup log).
   * @returns {{ adapters: number, available: number, models: number, details: Array }}
   */
  getSummary() {
    const details = [];
    for (const [name, adapter] of this.adapters) {
      const det = this.detected.get(name);
      details.push({
        name: adapter.name,
        displayName: adapter.displayName,
        available: det?.available || false,
        version: det?.version || null,
        path: det?.path || null,
        modelCount: det?.models?.length || 0,
        models: (det?.models || []).map(m => m.id)
      });
    }

    return {
      adapters: this.adapters.size,
      available: this.getAvailable().length,
      models: this.getAllModels().length,
      details
    };
  }

  /**
   * Whether detectAll() has been run.
   * @returns {boolean}
   */
  get hasDetected() {
    return this._hasDetected;
  }
}

// ============================================================================
// SINGLETON FACTORY
// ============================================================================

let _instance = null;

/**
 * Get or create the global registry instance.
 * @returns {AgentAdapterRegistry}
 */
function getRegistry() {
  if (!_instance) {
    _instance = new AgentAdapterRegistry();
  }
  return _instance;
}

/**
 * Reset the global registry (for testing).
 */
function resetRegistry() {
  _instance = null;
}

module.exports = {
  AgentAdapterRegistry,
  getRegistry,
  resetRegistry
};
