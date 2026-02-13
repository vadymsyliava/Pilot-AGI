/**
 * OpenCode Adapter — Phase 6.4 (Pilot AGI-pg3)
 *
 * Adapter for OpenCode CLI (Google Gemini models).
 * Supports Gemini 2.5 Pro and Gemini 2.5 Flash.
 * Uses -m flag for non-interactive mode.
 *
 * Enforcement: wrapper (MCP server potential) + git hooks + file watcher.
 * Context injection: environment variables (PILOT_CONTEXT_FILE).
 */

'use strict';

const cp = require('child_process');
const { AgentAdapter } = require('./agent-adapter');

// ============================================================================
// CONSTANTS
// ============================================================================

const OPENCODE_MODELS = [
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'google',
    capabilities: ['fast', 'ui', 'multimodal', 'large-context']
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'google',
    capabilities: ['very-fast', 'cheap', 'simple']
  }
];

const DEFAULT_MODEL = 'gemini-2.5-pro';

// ============================================================================
// OPENCODE ADAPTER
// ============================================================================

class OpenCodeAdapter extends AgentAdapter {
  constructor() {
    super();
    /** @type {Map<string, { process: object, pid: number }>} */
    this._processes = new Map();
  }

  get name() {
    return 'opencode';
  }

  get displayName() {
    return 'OpenCode';
  }

  /**
   * Detect if OpenCode CLI is installed.
   */
  async detect() {
    return new Promise((resolve) => {
      cp.execFile('opencode', ['--version'], { timeout: 10000 }, (err, stdout) => {
        if (err) {
          resolve({ available: false });
          return;
        }
        resolve({
          available: true,
          version: stdout.trim(),
          path: 'opencode'
        });
      });
    });
  }

  /**
   * List supported models via OpenCode.
   */
  async listModels() {
    return OPENCODE_MODELS;
  }

  /**
   * Spawn an OpenCode agent process.
   *
   * @param {object} opts
   * @param {string} opts.prompt - Task prompt
   * @param {string} [opts.model] - Model ID (default: gemini-2.5-pro)
   * @param {string} opts.cwd - Working directory
   * @param {object} [opts.env] - Extra environment variables
   * @param {string} [opts.contextFile] - Path to context capsule JSON
   * @param {number} [opts.maxTokens] - Token budget
   */
  async spawn(opts) {
    const model = opts.model || DEFAULT_MODEL;
    const args = ['-m', opts.prompt];

    // Add model selection
    if (opts.model) {
      args.push('--model', opts.model);
    } else {
      args.push('--model', DEFAULT_MODEL);
    }

    // Build environment
    const env = { ...process.env, ...(opts.env || {}) };

    // Inject context file via environment variable
    if (opts.contextFile) {
      env.PILOT_CONTEXT_FILE = opts.contextFile;
    }

    if (opts.maxTokens) {
      env.PILOT_TOKEN_BUDGET = String(opts.maxTokens);
    }

    const proc = cp.spawn('opencode', args, {
      cwd: opts.cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    proc.unref();

    const sessionId = env.PILOT_SESSION_ID || `opencode-${proc.pid}-${Date.now()}`;
    this._processes.set(sessionId, { process: proc, pid: proc.pid });

    return {
      pid: proc.pid,
      sessionId,
      process: proc
    };
  }

  /**
   * Inject context into a running OpenCode agent via stdin.
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
   * Read recent output from an OpenCode agent.
   */
  async readOutput(sessionId, lines = 50) {
    const entry = this._processes.get(sessionId);
    if (!entry || !entry.process) return '';
    return '';
  }

  /**
   * Check if the OpenCode process is still running.
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
   * Gracefully stop an OpenCode agent.
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
   * OpenCode enforcement uses wrapper + git hooks + file watcher.
   * OpenCode supports MCP servers — can potentially load Pilot governance as MCP.
   */
  getEnforcementStrategy() {
    return {
      type: 'wrapper',
      details: {
        mcpServer: true,
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
      'opencode',
      '-m', JSON.stringify(opts.prompt),
      '--model', model
    ];

    return parts.join(' ');
  }

  /**
   * Clean up tracked process state (for testing or shutdown).
   */
  _clearProcesses() {
    this._processes.clear();
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  OpenCodeAdapter,
  OPENCODE_MODELS,
  DEFAULT_MODEL
};
