/**
 * Codex CLI Adapter — Phase 6.5 (Pilot AGI-eud)
 *
 * Adapter for OpenAI Codex CLI.
 * Supports Codex Mini and o4-mini models.
 * Uses positional argument for prompt, --approval-mode full-auto.
 *
 * Enforcement: sandbox (Codex default) + git hooks + file watcher.
 */

'use strict';

const cp = require('child_process');
const { AgentAdapter } = require('./agent-adapter');

// ============================================================================
// CONSTANTS
// ============================================================================

const CODEX_MODELS = [
  {
    id: 'codex-mini',
    name: 'Codex Mini',
    provider: 'openai',
    capabilities: ['fast', 'code-gen', 'balanced']
  },
  {
    id: 'o4-mini',
    name: 'o4-mini',
    provider: 'openai',
    capabilities: ['reasoning', 'general']
  }
];

const DEFAULT_MODEL = 'codex-mini';

// ============================================================================
// CODEX ADAPTER
// ============================================================================

class CodexAdapter extends AgentAdapter {
  constructor() {
    super();
    /** @type {Map<string, { process: object, pid: number }>} */
    this._processes = new Map();
  }

  get name() {
    return 'codex';
  }

  get displayName() {
    return 'Codex CLI';
  }

  /**
   * Detect if Codex CLI is installed.
   */
  async detect() {
    return new Promise((resolve) => {
      cp.execFile('codex', ['--version'], { timeout: 10000 }, (err, stdout) => {
        if (err) {
          resolve({ available: false });
          return;
        }
        resolve({
          available: true,
          version: stdout.trim(),
          path: 'codex'
        });
      });
    });
  }

  /**
   * List supported models via Codex CLI.
   */
  async listModels() {
    return CODEX_MODELS;
  }

  /**
   * Spawn a Codex CLI agent process.
   *
   * @param {object} opts
   * @param {string} opts.prompt - Task prompt
   * @param {string} [opts.model] - Model ID (default: codex-mini)
   * @param {string} opts.cwd - Working directory
   * @param {object} [opts.env] - Extra environment variables
   * @param {string} [opts.contextFile] - Path to context capsule JSON
   * @param {number} [opts.maxTokens] - Token budget
   */
  async spawn(opts) {
    const model = opts.model || DEFAULT_MODEL;
    // Codex CLI uses positional argument for prompt
    const args = [opts.prompt];

    if (opts.model) {
      args.push('--model', opts.model);
    } else {
      args.push('--model', DEFAULT_MODEL);
    }

    // Full-auto approval — governance is external via Pilot
    args.push('--approval-mode', 'full-auto');
    // Machine-friendly output
    args.push('--quiet');

    // Build environment
    const env = { ...process.env, ...(opts.env || {}) };

    if (opts.contextFile) {
      env.PILOT_CONTEXT_FILE = opts.contextFile;
    }
    if (opts.maxTokens) {
      env.PILOT_TOKEN_BUDGET = String(opts.maxTokens);
    }

    const proc = cp.spawn('codex', args, {
      cwd: opts.cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    proc.unref();

    const sessionId = env.PILOT_SESSION_ID || `codex-${proc.pid}-${Date.now()}`;
    this._processes.set(sessionId, { process: proc, pid: proc.pid });

    return {
      pid: proc.pid,
      sessionId,
      process: proc
    };
  }

  /**
   * Inject context into a running Codex agent via stdin.
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
   * Read recent output from a Codex agent.
   */
  async readOutput(sessionId, lines = 50) {
    const entry = this._processes.get(sessionId);
    if (!entry || !entry.process) return '';
    return '';
  }

  /**
   * Check if the Codex process is still running.
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
   * Gracefully stop a Codex agent.
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
   * Codex enforcement uses sandbox + git hooks + file watcher.
   * Codex runs in a sandbox by default; Pilot adds pre-commit hook,
   * file watcher, and post-run validation.
   */
  getEnforcementStrategy() {
    return {
      type: 'wrapper',
      details: {
        sandbox: true,
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
      'codex',
      JSON.stringify(opts.prompt),
      '--model', model,
      '--approval-mode', 'full-auto',
      '--quiet'
    ];

    return parts.join(' ');
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  CodexAdapter,
  CODEX_MODELS,
  DEFAULT_MODEL
};
