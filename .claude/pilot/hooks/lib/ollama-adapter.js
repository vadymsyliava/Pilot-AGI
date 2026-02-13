/**
 * Ollama Adapter — Phase 6.6 (Pilot AGI-5w6)
 *
 * Adapter for Ollama (local open-source models).
 * Zero API cost — runs models locally (Llama, DeepSeek, Qwen, Mistral).
 *
 * Unlike other adapters, Ollama doesn't have a native coding CLI.
 * Spawns via a Node.js wrapper script (ollama-agent-wrapper.js) that:
 *   1. Reads task context
 *   2. Calls Ollama HTTP API (localhost:11434)
 *   3. Parses code blocks from response
 *   4. Applies file changes
 *
 * Enforcement: full control via wrapper script + git hooks.
 */

'use strict';

const path = require('path');
const cp = require('child_process');
const { AgentAdapter } = require('./agent-adapter');

// ============================================================================
// CONSTANTS
// ============================================================================

const OLLAMA_MODELS = [
  {
    id: 'ollama:llama-3.3-70b',
    name: 'Llama 3.3 70B',
    provider: 'local',
    capabilities: ['general', 'free', 'private']
  },
  {
    id: 'ollama:deepseek-coder-v3',
    name: 'DeepSeek Coder V3',
    provider: 'local',
    capabilities: ['code-gen', 'free', 'private', 'code-focused']
  },
  {
    id: 'ollama:qwen-2.5-coder',
    name: 'Qwen 2.5 Coder',
    provider: 'local',
    capabilities: ['code-gen', 'free', 'private', 'fast-local']
  }
];

const DEFAULT_MODEL = 'ollama:llama-3.3-70b';

const WRAPPER_SCRIPT = path.join(__dirname, '..', 'scripts', 'ollama-agent-wrapper.js');

// ============================================================================
// OLLAMA ADAPTER
// ============================================================================

class OllamaAdapter extends AgentAdapter {
  constructor() {
    super();
    /** @type {Map<string, { process: object, pid: number }>} */
    this._processes = new Map();
  }

  get name() {
    return 'ollama';
  }

  get displayName() {
    return 'Ollama (Local)';
  }

  /**
   * Detect if Ollama is installed by running `ollama list`.
   * Parses available models from the output.
   */
  async detect() {
    return new Promise((resolve) => {
      cp.execFile('ollama', ['list'], { timeout: 10000 }, (err, stdout) => {
        if (err) {
          resolve({ available: false });
          return;
        }
        const pulledModels = this._parseOllamaList(stdout);
        resolve({
          available: true,
          version: 'local',
          path: 'ollama',
          pulledModels
        });
      });
    });
  }

  /**
   * List supported models.
   * Returns the static model list; dynamic models from `ollama list`
   * are available via detect().pulledModels.
   */
  async listModels() {
    return OLLAMA_MODELS;
  }

  /**
   * Spawn an Ollama agent via the wrapper script.
   *
   * @param {object} opts
   * @param {string} opts.prompt - Task prompt
   * @param {string} [opts.model] - Model ID (default: ollama:llama-3.3-70b)
   * @param {string} opts.cwd - Working directory
   * @param {object} [opts.env] - Extra environment variables
   * @param {string} [opts.contextFile] - Path to context capsule JSON
   * @param {number} [opts.maxTokens] - Token budget
   */
  async spawn(opts) {
    const model = opts.model || DEFAULT_MODEL;
    // Strip ollama: prefix for the actual model name passed to wrapper
    const modelName = model.startsWith('ollama:') ? model.slice(7) : model;

    const args = [
      WRAPPER_SCRIPT,
      '--model', modelName,
      '--prompt', opts.prompt
    ];

    if (opts.contextFile) {
      args.push('--task', opts.contextFile);
    }

    // Build environment
    const env = { ...process.env, ...(opts.env || {}) };

    if (opts.contextFile) {
      env.PILOT_CONTEXT_FILE = opts.contextFile;
    }
    if (opts.maxTokens) {
      env.PILOT_TOKEN_BUDGET = String(opts.maxTokens);
    }

    const proc = cp.spawn('node', args, {
      cwd: opts.cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    proc.unref();

    const sessionId = env.PILOT_SESSION_ID || `ollama-${proc.pid}-${Date.now()}`;
    this._processes.set(sessionId, { process: proc, pid: proc.pid });

    return {
      pid: proc.pid,
      sessionId,
      process: proc
    };
  }

  /**
   * Inject context into a running Ollama wrapper via stdin.
   */
  async inject(sessionId, content) {
    const entry = this._processes.get(sessionId);
    if (!entry || !entry.process) return false;

    try {
      if (entry.process.stdin && entry.process.stdin.writable) {
        entry.process.stdin.write(content + '\n');
        return true;
      }
    } catch {
      // Process stdin closed
    }
    return false;
  }

  /**
   * Read recent output from an Ollama agent.
   */
  async readOutput(sessionId, lines = 50) {
    const entry = this._processes.get(sessionId);
    if (!entry || !entry.process) return '';
    return '';
  }

  /**
   * Check if the Ollama wrapper process is still running.
   */
  async isAlive(sessionId) {
    const entry = this._processes.get(sessionId);
    if (!entry) return { alive: false };

    try {
      process.kill(entry.pid, 0);
      return { alive: true };
    } catch {
      return { alive: false, exitCode: entry.process.exitCode };
    }
  }

  /**
   * Gracefully stop an Ollama agent.
   */
  async stop(sessionId) {
    const entry = this._processes.get(sessionId);
    if (!entry) return;

    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {
      // Already dead
    }

    this._processes.delete(sessionId);
  }

  /**
   * Ollama enforcement — full control via wrapper script.
   * The wrapper handles all governance since it mediates between Pilot and Ollama API.
   */
  getEnforcementStrategy() {
    return {
      type: 'wrapper',
      details: {
        wrapperScript: 'scripts/ollama-agent-wrapper.js',
        preCommit: '.git/hooks/pre-commit',
        fullControl: true
      }
    };
  }

  /**
   * Build the CLI command string for spawning.
   */
  buildCommand(opts) {
    const model = opts.model || DEFAULT_MODEL;
    const modelName = model.startsWith('ollama:') ? model.slice(7) : model;
    const parts = [
      'node', 'scripts/ollama-agent-wrapper.js',
      '--model', modelName
    ];

    if (opts.contextFile) {
      parts.push('--task', opts.contextFile);
    }

    return parts.join(' ');
  }

  /**
   * Parse `ollama list` output into model objects.
   * Format: NAME  ID  SIZE  MODIFIED
   */
  _parseOllamaList(stdout) {
    return stdout.split('\n').slice(1).filter(Boolean).map(line => {
      const parts = line.trim().split(/\s+/);
      return { name: parts[0], size: parts[2] || 'unknown' };
    });
  }

  /**
   * Infer capabilities from model name.
   */
  _inferCapabilities(modelName) {
    const name = (modelName || '').toLowerCase();
    const caps = ['free', 'private'];
    if (name.includes('code') || name.includes('coder')) caps.push('code-gen');
    if (name.includes('llama')) caps.push('general');
    if (name.includes('deepseek')) caps.push('code-focused');
    if (name.includes('qwen')) caps.push('fast-local');
    if (name.includes('mistral')) caps.push('balanced');
    return caps.length > 2 ? caps : [...caps, 'general'];
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  OllamaAdapter,
  OLLAMA_MODELS,
  DEFAULT_MODEL,
  WRAPPER_SCRIPT
};
