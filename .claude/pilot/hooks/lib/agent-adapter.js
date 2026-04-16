/**
 * Agent Adapter Interface — Phase 6.1 (Pilot AGI-cni)
 *
 * Abstract base class that every supported agent CLI must implement.
 * Provides: spawn, inject, monitor, enforce across any coding agent CLI.
 *
 * Adapters: claude, aider, opencode, codex, ollama
 */

'use strict';

// ============================================================================
// AGENT ADAPTER — Abstract Interface
// ============================================================================

class AgentAdapter {
  /**
   * @returns {string} Adapter name (e.g., 'claude', 'aider', 'opencode')
   */
  get name() {
    throw new Error(`${this.constructor.name} must implement get name()`);
  }

  /**
   * @returns {string} Display name (e.g., 'Claude Code', 'Aider', 'OpenCode')
   */
  get displayName() {
    throw new Error(`${this.constructor.name} must implement get displayName()`);
  }

  /**
   * Check if this agent CLI is installed and available.
   * @returns {Promise<{ available: boolean, version?: string, path?: string, models?: Array }>}
   */
  async detect() {
    throw new Error(`${this.constructor.name} must implement detect()`);
  }

  /**
   * Get the models this adapter supports.
   * @returns {Promise<Array<{ id: string, name: string, provider: string, capabilities: string[] }>>}
   */
  async listModels() {
    throw new Error(`${this.constructor.name} must implement listModels()`);
  }

  /**
   * Spawn an agent process with a task.
   * @param {object} opts
   * @param {string} opts.prompt - The task prompt (plain text)
   * @param {string} [opts.model] - Model ID to use
   * @param {string} opts.cwd - Working directory
   * @param {object} [opts.env] - Environment variables
   * @param {string} [opts.contextFile] - Path to context capsule JSON
   * @param {number} [opts.maxTokens] - Token budget for this task
   * @returns {Promise<{ pid: number, sessionId: string, process?: object }>}
   */
  async spawn(opts) {
    throw new Error(`${this.constructor.name} must implement spawn()`);
  }

  /**
   * Inject context into a running agent (if supported).
   * For CLI agents, this may mean writing to stdin or a watched file.
   * @param {string} sessionId
   * @param {string} content - Context to inject
   * @returns {Promise<boolean>} Whether injection was successful
   */
  async inject(sessionId, content) {
    throw new Error(`${this.constructor.name} must implement inject()`);
  }

  /**
   * Read recent output from the agent.
   * @param {string} sessionId
   * @param {number} [lines=50] - Number of lines to read
   * @returns {Promise<string>}
   */
  async readOutput(sessionId, lines = 50) {
    throw new Error(`${this.constructor.name} must implement readOutput()`);
  }

  /**
   * Check if agent process is still running.
   * @param {string} sessionId
   * @returns {Promise<{ alive: boolean, exitCode?: number }>}
   */
  async isAlive(sessionId) {
    throw new Error(`${this.constructor.name} must implement isAlive()`);
  }

  /**
   * Gracefully stop an agent.
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async stop(sessionId) {
    throw new Error(`${this.constructor.name} must implement stop()`);
  }

  /**
   * Get the enforcement strategy for this adapter.
   * Claude Code uses hooks. Others use git hooks, wrappers, or file watchers.
   * @returns {{ type: 'hooks'|'git-hooks'|'wrapper'|'file-watcher', details: object }}
   */
  getEnforcementStrategy() {
    throw new Error(`${this.constructor.name} must implement getEnforcementStrategy()`);
  }

  /**
   * Build the CLI command string for spawning.
   * @param {object} opts - Same as spawn opts
   * @returns {string} The shell command to run
   */
  buildCommand(opts) {
    throw new Error(`${this.constructor.name} must implement buildCommand()`);
  }
}

module.exports = { AgentAdapter };
