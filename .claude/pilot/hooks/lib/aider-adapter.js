/**
 * Aider Adapter — Phase 6.3 (Pilot AGI-7u3)
 *
 * Adapter for Aider CLI (https://aider.chat).
 * Supports OpenAI models (GPT-4.5, GPT-4o, o3-mini) and DeepSeek.
 * Uses --message for non-interactive mode, --yes-always for auto-accept.
 *
 * Enforcement: git hooks + file watcher (no native hook system).
 * Context injection: --read flag for read-only context files.
 */

'use strict';

const cp = require('child_process');
const { AgentAdapter } = require('./agent-adapter');

// ============================================================================
// CONSTANTS
// ============================================================================

const AIDER_MODELS = [
  {
    id: 'gpt-4.5',
    name: 'GPT-4.5',
    provider: 'openai',
    capabilities: ['general', 'testing', 'patterns']
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    capabilities: ['fast', 'balanced', 'multimodal']
  },
  {
    id: 'o3-mini',
    name: 'o3-mini',
    provider: 'openai',
    capabilities: ['reasoning', 'math', 'logic']
  },
  {
    id: 'deepseek-chat',
    name: 'DeepSeek V3',
    provider: 'deepseek',
    capabilities: ['bulk', 'cheap', 'code-gen']
  }
];

const DEFAULT_MODEL = 'gpt-4.5';

// ============================================================================
// AIDER ADAPTER
// ============================================================================

class AiderAdapter extends AgentAdapter {
  constructor() {
    super();
    /** @type {Map<string, { process: object, pid: number }>} */
    this._processes = new Map();
  }

  get name() {
    return 'aider';
  }

  get displayName() {
    return 'Aider';
  }

  /**
   * Detect if Aider CLI is installed.
   */
  async detect() {
    return new Promise((resolve) => {
      cp.execFile('aider', ['--version'], { timeout: 10000 }, (err, stdout) => {
        if (err) {
          resolve({ available: false });
          return;
        }
        resolve({
          available: true,
          version: stdout.trim(),
          path: 'aider'
        });
      });
    });
  }

  /**
   * List supported models via Aider.
   */
  async listModels() {
    return AIDER_MODELS;
  }

  /**
   * Spawn an Aider agent process.
   *
   * @param {object} opts
   * @param {string} opts.prompt - Task prompt
   * @param {string} [opts.model] - Model ID (default: gpt-4.5)
   * @param {string} opts.cwd - Working directory
   * @param {object} [opts.env] - Extra environment variables
   * @param {string} [opts.contextFile] - Path to context capsule JSON
   * @param {number} [opts.maxTokens] - Token budget
   */
  async spawn(opts) {
    const model = opts.model || DEFAULT_MODEL;
    const args = [
      '--message', opts.prompt,
      '--model', model,
      '--yes-always',
      '--no-auto-commits',
      '--no-suggest-shell-commands'
    ];

    // Inject context via --read flag (read-only context files)
    if (opts.contextFile) {
      args.push('--read', opts.contextFile);
    }

    // Build environment
    const env = { ...process.env, ...(opts.env || {}) };

    // Aider supports AIDER_MODEL env var as override
    if (opts.model) {
      env.AIDER_MODEL = opts.model;
    }

    const proc = cp.spawn('aider', args, {
      cwd: opts.cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    proc.unref();

    const sessionId = env.PILOT_SESSION_ID || `aider-${proc.pid}-${Date.now()}`;
    this._processes.set(sessionId, { process: proc, pid: proc.pid });

    return {
      pid: proc.pid,
      sessionId,
      process: proc
    };
  }

  /**
   * Inject context into a running Aider agent via stdin.
   * Aider accepts commands via stdin in chat mode.
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
   * Read recent output from an Aider agent.
   */
  async readOutput(sessionId, lines = 50) {
    const entry = this._processes.get(sessionId);
    if (!entry || !entry.process) return '';
    return '';
  }

  /**
   * Check if the Aider process is still running.
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
   * Gracefully stop an Aider agent.
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
   * Aider enforcement uses git hooks + file watcher.
   * No native hook system like Claude Code.
   */
  getEnforcementStrategy() {
    return {
      type: 'git-hooks',
      details: {
        preCommit: '.git/hooks/pre-commit',
        fileWatcher: true,
        postRun: true
      }
    };
  }

  /**
   * Build the CLI command string for spawning.
   */
  buildCommand(opts) {
    const model = opts.model || DEFAULT_MODEL;
    const parts = [
      'aider',
      '--message', JSON.stringify(opts.prompt),
      '--model', model,
      '--yes-always',
      '--no-auto-commits',
      '--no-suggest-shell-commands'
    ];

    if (opts.contextFile) {
      parts.push('--read', opts.contextFile);
    }

    return parts.join(' ');
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  AiderAdapter,
  AIDER_MODELS,
  DEFAULT_MODEL
};
