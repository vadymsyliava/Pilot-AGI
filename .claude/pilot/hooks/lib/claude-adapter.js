/**
 * Claude Code Adapter — Phase 6.2 (Pilot AGI-0ub)
 *
 * Reference adapter wrapping existing Pilot AGI integration.
 * Maps to existing `claude -p` spawn + hooks enforcement.
 * Supports Opus 4.6, Sonnet 4.5, Haiku 4.5 model selection.
 *
 * This is the "gold standard" adapter — everything that works
 * today continues to work through this interface.
 */

'use strict';

const cp = require('child_process');
const { AgentAdapter } = require('./agent-adapter');

// ============================================================================
// CONSTANTS
// ============================================================================

const CLAUDE_MODELS = [
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    provider: 'anthropic',
    capabilities: ['reasoning', 'architecture', 'refactoring', 'complex-logic', 'security', 'code-review']
  },
  {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    capabilities: ['general', 'fast', 'balanced', 'coding']
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    capabilities: ['fast', 'cheap', 'docs', 'simple']
  }
];

const DEFAULT_MODEL = 'claude-sonnet-4-5';

// ============================================================================
// CLAUDE ADAPTER
// ============================================================================

class ClaudeAdapter extends AgentAdapter {
  constructor() {
    super();
    /** @type {Map<string, { process: object, pid: number }>} */
    this._processes = new Map();
  }

  get name() {
    return 'claude';
  }

  get displayName() {
    return 'Claude Code';
  }

  /**
   * Detect if Claude CLI is installed.
   * Runs `claude --version` to check availability.
   */
  async detect() {
    return new Promise((resolve) => {
      cp.execFile('claude', ['--version'], { timeout: 10000 }, (err, stdout) => {
        if (err) {
          resolve({ available: false });
          return;
        }
        resolve({
          available: true,
          version: stdout.trim(),
          path: 'claude'
        });
      });
    });
  }

  /**
   * List supported Claude models.
   */
  async listModels() {
    return CLAUDE_MODELS;
  }

  /**
   * Spawn a Claude Code agent process.
   *
   * @param {object} opts
   * @param {string} opts.prompt - Task prompt
   * @param {string} [opts.model] - Model ID (default: claude-sonnet-4-5)
   * @param {string} opts.cwd - Working directory
   * @param {object} [opts.env] - Extra environment variables
   * @param {string} [opts.contextFile] - Path to context capsule JSON
   * @param {number} [opts.maxTokens] - Token budget
   * @returns {Promise<{ pid: number, sessionId: string, process: object }>}
   */
  async spawn(opts) {
    const model = opts.model || DEFAULT_MODEL;
    const args = ['-p', opts.prompt, '--model', model, '--permission-mode', 'acceptEdits'];

    // Build environment
    const env = { ...process.env, ...(opts.env || {}) };

    if (opts.contextFile) {
      env.PILOT_CONTEXT_FILE = opts.contextFile;
    }
    if (opts.maxTokens) {
      env.PILOT_TOKEN_BUDGET = String(opts.maxTokens);
    }

    const proc = cp.spawn('claude', args, {
      cwd: opts.cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    proc.unref();

    const sessionId = env.PILOT_SESSION_ID || `claude-${proc.pid}-${Date.now()}`;

    this._processes.set(sessionId, { process: proc, pid: proc.pid });

    return {
      pid: proc.pid,
      sessionId,
      process: proc
    };
  }

  /**
   * Inject context into a running Claude agent via stdin.
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
   * Read recent output from a Claude agent.
   * Claude Code writes output to stdout which we capture.
   */
  async readOutput(sessionId, lines = 50) {
    const entry = this._processes.get(sessionId);
    if (!entry || !entry.process) return '';

    // In practice, output is captured by agent-logger.js
    // This is a best-effort fallback
    return '';
  }

  /**
   * Check if the Claude agent process is still running.
   */
  async isAlive(sessionId) {
    const entry = this._processes.get(sessionId);
    if (!entry) return { alive: false };

    try {
      // Signal 0 = check if process exists without killing
      process.kill(entry.pid, 0);
      return { alive: true };
    } catch {
      return { alive: false, exitCode: entry.process.exitCode };
    }
  }

  /**
   * Gracefully stop a Claude agent.
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
   * Claude Code enforcement uses the native hooks system.
   */
  getEnforcementStrategy() {
    return {
      type: 'hooks',
      details: {
        sessionStart: '.claude/pilot/hooks/session-start.js',
        preToolUse: '.claude/pilot/hooks/pre-tool-use.js',
        postToolUse: '.claude/pilot/hooks/post-tool-use.js',
        userPromptSubmit: '.claude/pilot/hooks/user-prompt-submit.js'
      }
    };
  }

  /**
   * Build the CLI command string for spawning.
   */
  buildCommand(opts) {
    const model = opts.model || DEFAULT_MODEL;
    const parts = ['claude', '-p', JSON.stringify(opts.prompt), '--model', model];
    if (opts.env && opts.env.PILOT_CONTEXT_FILE) {
      parts.unshift(`PILOT_CONTEXT_FILE=${opts.env.PILOT_CONTEXT_FILE}`);
    }
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
  ClaudeAdapter,
  CLAUDE_MODELS,
  DEFAULT_MODEL
};
