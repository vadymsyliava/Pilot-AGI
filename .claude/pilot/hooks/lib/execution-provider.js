/**
 * Execution Provider Interface (Phase 5.10)
 *
 * Pluggable execution providers abstraction for running agents locally,
 * via SSH on remote machines, or in Docker containers.
 *
 * Provider interface:
 *   { name, spawn(task, options), kill(processId), getStatus(processId),
 *     getLogs(processId, options), isAvailable() }
 *
 * API:
 *   registerProvider(name, provider) — register a new execution provider
 *   getProvider(name)                — get provider by name
 *   getActiveProvider()              — get the configured active provider
 *   listProviders()                  — list all registered providers
 *   spawnViaProvider(task, options)  — spawn using active provider
 */

const path = require('path');

// ============================================================================
// LAZY DEPS
// ============================================================================

let _policy = null;
function getPolicy() {
  if (!_policy) {
    try { _policy = require('./policy'); } catch (e) { _policy = null; }
  }
  return _policy;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const REQUIRED_METHODS = ['spawn', 'kill', 'getStatus', 'getLogs', 'isAvailable'];
const DEFAULT_ACTIVE_PROVIDER = 'local';

// ============================================================================
// PROVIDER REGISTRY
// ============================================================================

/** @type {Map<string, object>} */
const _providers = new Map();

/**
 * Validate that a provider implements the required interface.
 *
 * @param {object} provider
 * @returns {{ valid: boolean, missing: string[] }}
 */
function validateProvider(provider) {
  const missing = [];
  if (!provider || typeof provider !== 'object') {
    return { valid: false, missing: REQUIRED_METHODS };
  }
  if (!provider.name || typeof provider.name !== 'string') {
    missing.push('name');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof provider[method] !== 'function') {
      missing.push(method);
    }
  }
  return { valid: missing.length === 0, missing };
}

/**
 * Register a new execution provider.
 *
 * @param {string} name
 * @param {object} provider — must implement the provider interface
 * @returns {{ success: boolean, error?: string }}
 */
function registerProvider(name, provider) {
  if (!name || typeof name !== 'string') {
    return { success: false, error: 'Provider name must be a non-empty string' };
  }
  const validation = validateProvider(provider);
  if (!validation.valid) {
    return { success: false, error: `Provider missing: ${validation.missing.join(', ')}` };
  }
  _providers.set(name, provider);
  return { success: true };
}

/**
 * Unregister a provider.
 *
 * @param {string} name
 * @returns {boolean} true if removed
 */
function unregisterProvider(name) {
  return _providers.delete(name);
}

/**
 * Get a provider by name.
 *
 * @param {string} name
 * @returns {object|null}
 */
function getProvider(name) {
  return _providers.get(name) || null;
}

/**
 * List all registered providers.
 *
 * @returns {string[]}
 */
function listProviders() {
  return Array.from(_providers.keys());
}

/**
 * Load the active provider name from policy.yaml.
 *
 * @param {string} [projectRoot]
 * @returns {string}
 */
function getActiveProviderName(projectRoot) {
  try {
    const pol = getPolicy();
    if (pol) {
      const policy = pol.loadPolicy(projectRoot);
      const execConfig = policy.execution || {};
      return execConfig.active_provider || DEFAULT_ACTIVE_PROVIDER;
    }
  } catch (e) { /* fallback */ }
  return DEFAULT_ACTIVE_PROVIDER;
}

/**
 * Get the configured active provider instance.
 *
 * @param {string} [projectRoot]
 * @returns {object|null}
 */
function getActiveProvider(projectRoot) {
  const name = getActiveProviderName(projectRoot);
  return getProvider(name);
}

/**
 * Load execution config from policy.yaml.
 *
 * @param {string} [projectRoot]
 * @returns {object}
 */
function loadExecutionConfig(projectRoot) {
  try {
    const pol = getPolicy();
    if (pol) {
      const policy = pol.loadPolicy(projectRoot);
      return policy.execution || {};
    }
  } catch (e) { /* fallback */ }
  return { active_provider: DEFAULT_ACTIVE_PROVIDER };
}

/**
 * Spawn a task using the active execution provider.
 * Falls back to local provider if active provider is unavailable.
 *
 * @param {object} task — { id, title, description, labels }
 * @param {object} options — provider-specific options + { projectRoot }
 * @returns {Promise<{ success: boolean, processId?: string, provider?: string, error?: string }>}
 */
async function spawnViaProvider(task, options = {}) {
  const { projectRoot } = options;
  const activeName = getActiveProviderName(projectRoot);
  let provider = getProvider(activeName);

  // Check availability, fallback to local
  if (provider) {
    try {
      const available = await Promise.resolve(provider.isAvailable());
      if (!available) {
        const local = getProvider('local');
        if (local && activeName !== 'local') {
          provider = local;
        } else {
          return { success: false, error: `Provider '${activeName}' is not available and no fallback` };
        }
      }
    } catch (e) {
      const local = getProvider('local');
      if (local && activeName !== 'local') {
        provider = local;
      } else {
        return { success: false, error: `Provider availability check failed: ${e.message}` };
      }
    }
  } else {
    return { success: false, error: `No provider registered with name '${activeName}'` };
  }

  try {
    const result = await Promise.resolve(provider.spawn(task, options));
    return { ...result, provider: provider.name };
  } catch (e) {
    return { success: false, error: e.message, provider: provider.name };
  }
}

/**
 * Clear all registered providers (for testing).
 */
function clearProviders() {
  _providers.clear();
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  registerProvider,
  unregisterProvider,
  getProvider,
  getActiveProvider,
  getActiveProviderName,
  listProviders,
  loadExecutionConfig,
  spawnViaProvider,
  validateProvider,
  clearProviders,
  REQUIRED_METHODS,
  DEFAULT_ACTIVE_PROVIDER
};
