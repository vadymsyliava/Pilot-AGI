/**
 * Terminal Layout Manager — Phase 6.10 (Pilot AGI-vdx)
 *
 * Manages terminal tab layout for multi-LLM agent spawning.
 * Builds tab titles, resolves adapters for tasks, and coordinates
 * enforcement startup for non-Claude agents.
 *
 * Key responsibilities:
 *   - Build adapter-aware terminal commands via adapter.buildCommand()
 *   - Format tab titles with model name: [GPT-4.5] Task Title
 *   - Start file watcher + git hook enforcement for non-Claude agents
 *   - Track per-adapter enforcement processes
 *   - Short model name mapping for compact tab labels
 *
 * Used by: pm-daemon._spawnAgentViaTerminal() and process-spawner.spawnAgent()
 */

'use strict';

const path = require('path');

// =============================================================================
// MODEL SHORT NAMES — for compact tab titles
// =============================================================================

const MODEL_SHORT_NAMES = {
  'claude-opus-4-6': 'Opus',
  'claude-sonnet-4-5': 'Sonnet',
  'claude-haiku-4-5': 'Haiku',
  'gpt-4.5': 'GPT-4.5',
  'gpt-4o': 'GPT-4o',
  'o3-mini': 'o3-mini',
  'gemini-2.5-pro': 'Gemini Pro',
  'gemini-2.5-flash': 'Gemini Flash',
  'ollama:deepseek-coder-v3': 'DeepSeek',
  'ollama:llama-3.3-70b': 'Llama 3.3',
  'ollama:qwen-2.5-coder-32b': 'Qwen 2.5',
  'codex-mini': 'Codex',
  'o4-mini': 'o4-mini'
};

// =============================================================================
// TERMINAL LAYOUT MANAGER
// =============================================================================

class TerminalLayout {
  /**
   * @param {object} opts
   * @param {object} opts.adapterRegistry - AgentAdapterRegistry instance
   * @param {string} opts.projectRoot - Project root path
   * @param {object} [opts.logger] - Logger instance
   */
  constructor(opts) {
    this.adapterRegistry = opts.adapterRegistry;
    this.projectRoot = opts.projectRoot;
    this.log = opts.logger || { info() {}, warn() {}, error() {}, debug() {} };

    // Track active enforcement per session
    this._enforcementWatchers = new Map();
  }

  // ===========================================================================
  // TAB TITLE FORMATTING
  // ===========================================================================

  /**
   * Format a tab title with model name and task info.
   *
   * @param {string} modelId - Model ID from registry
   * @param {string} taskId - bd task ID
   * @param {string} [taskTitle] - Optional task title for display
   * @returns {string} Formatted title like "[GPT-4.5] bd-123 — Fix auth bug"
   */
  formatTabTitle(modelId, taskId, taskTitle) {
    const shortName = this.getModelShortName(modelId);
    const truncatedTitle = taskTitle
      ? ` — ${taskTitle.length > 30 ? taskTitle.slice(0, 30) + '...' : taskTitle}`
      : '';
    return `[${shortName}] ${taskId}${truncatedTitle}`;
  }

  /**
   * Get a short display name for a model.
   *
   * @param {string} modelId
   * @returns {string}
   */
  getModelShortName(modelId) {
    if (MODEL_SHORT_NAMES[modelId]) return MODEL_SHORT_NAMES[modelId];

    // Try to get from registry
    if (this.adapterRegistry) {
      try {
        const adapter = this.adapterRegistry.getAdapterForModel
          ? this.adapterRegistry.getAdapterForModel(modelId)
          : null;
        if (adapter) return adapter.displayName;
      } catch (e) { /* fallback */ }
    }

    // Fallback: capitalize first part
    return modelId.split(':').pop().split('-').map(w =>
      w.charAt(0).toUpperCase() + w.slice(1)
    ).join(' ');
  }

  // ===========================================================================
  // ADAPTER-AWARE COMMAND BUILDING
  // ===========================================================================

  /**
   * Resolve the adapter for a given model ID or adapter name.
   *
   * @param {string} modelId - Model ID (e.g., 'gpt-4.5')
   * @param {string} [adapterName] - Explicit adapter name (e.g., 'aider')
   * @returns {{ adapter: object, adapterName: string } | null}
   */
  resolveAdapter(modelId, adapterName) {
    if (!this.adapterRegistry) return null;

    // Direct adapter name lookup
    if (adapterName) {
      const adapter = this.adapterRegistry.adapters
        ? this.adapterRegistry.adapters.get(adapterName)
        : null;
      if (adapter) return { adapter, adapterName };
    }

    // Model-to-adapter resolution
    try {
      const adapter = this.adapterRegistry.getAdapterForModel(modelId);
      if (adapter) return { adapter, adapterName: adapter.name };
    } catch (e) {
      this.log.warn('Adapter resolution failed', { modelId, error: e.message });
    }

    return null;
  }

  /**
   * Build the full spawn command for a task using the appropriate adapter.
   *
   * @param {object} opts
   * @param {string} opts.modelId - Model ID to use
   * @param {string} opts.prompt - Task prompt text
   * @param {string} opts.cwd - Working directory
   * @param {string} [opts.adapterName] - Explicit adapter (overrides model lookup)
   * @param {string} [opts.contextFile] - Path to context capsule JSON
   * @param {number} [opts.maxTokens] - Token budget
   * @param {object} [opts.env] - Extra environment variables
   * @returns {{ command: string, adapterName: string, isClaudeNative: boolean }}
   */
  buildSpawnCommand(opts) {
    const resolution = this.resolveAdapter(opts.modelId, opts.adapterName);

    if (!resolution) {
      // Fallback: assume Claude Code
      this.log.warn('No adapter found, falling back to claude', { modelId: opts.modelId });
      return {
        command: this._buildClaudeFallbackCommand(opts),
        adapterName: 'claude',
        isClaudeNative: true
      };
    }

    const { adapter, adapterName } = resolution;
    const isClaudeNative = adapterName === 'claude';

    try {
      const command = adapter.buildCommand({
        prompt: opts.prompt,
        model: opts.modelId,
        cwd: opts.cwd,
        contextFile: opts.contextFile,
        env: opts.env,
        maxTokens: opts.maxTokens
      });

      return { command, adapterName, isClaudeNative };
    } catch (e) {
      this.log.error('Adapter buildCommand failed', {
        adapter: adapterName, modelId: opts.modelId, error: e.message
      });
      return {
        command: this._buildClaudeFallbackCommand(opts),
        adapterName: 'claude',
        isClaudeNative: true
      };
    }
  }

  /**
   * Fallback Claude command when adapter resolution fails.
   */
  _buildClaudeFallbackCommand(opts) {
    const escapedPrompt = opts.prompt.replace(/'/g, "'\\''");
    return `claude -p '${escapedPrompt}' --permission-mode acceptEdits`;
  }

  // ===========================================================================
  // ENVIRONMENT SETUP
  // ===========================================================================

  /**
   * Build the full environment for a spawned agent.
   *
   * @param {object} opts
   * @param {string} opts.taskId - bd task ID
   * @param {string} opts.sessionId - Session ID
   * @param {string} opts.modelId - Model ID
   * @param {string} opts.adapterName - Adapter name
   * @param {string} [opts.contextFile] - Path to context capsule
   * @param {string} [opts.worktreePath] - Worktree path
   * @param {number} [opts.respawnCount] - Respawn count
   * @returns {object} Environment variables to merge
   */
  buildSpawnEnv(opts) {
    const env = {
      PILOT_DAEMON_SPAWNED: '1',
      PILOT_TASK_ID: opts.taskId,
      PILOT_SESSION_ID: opts.sessionId || '',
      PILOT_MODEL: opts.modelId || '',
      PILOT_ADAPTER: opts.adapterName || 'claude',
      PILOT_AGENT_TYPE: opts.agentType || 'general',
      PILOT_PROJECT_ROOT: this.projectRoot
    };

    if (opts.contextFile) env.PILOT_CONTEXT_FILE = opts.contextFile;
    if (opts.worktreePath) env.PILOT_WORKTREE_PATH = opts.worktreePath;
    if (opts.respawnCount > 0) env.PILOT_RESPAWN_COUNT = String(opts.respawnCount);

    return env;
  }

  // ===========================================================================
  // ENFORCEMENT STARTUP
  // ===========================================================================

  /**
   * Start enforcement mechanisms for a non-Claude agent.
   * Claude agents use native hooks; others need git hooks + file watcher.
   *
   * @param {object} opts
   * @param {string} opts.taskId
   * @param {string} opts.sessionId
   * @param {string} opts.adapterName
   * @param {string} opts.cwd - Agent working directory
   * @returns {{ gitHookInstalled: boolean, fileWatcherStarted: boolean }}
   */
  startEnforcement(opts) {
    const result = { gitHookInstalled: false, fileWatcherStarted: false };

    if (opts.adapterName === 'claude') {
      // Claude uses native hooks — no external enforcement needed
      return result;
    }

    // 1. Install universal pre-commit hook in worktree
    try {
      const { generateHookScript } = require(path.join(__dirname, 'enforcement', 'universal-pre-commit'));
      const hookScript = generateHookScript({
        projectRoot: this.projectRoot,
        sessionId: opts.sessionId,
        taskId: opts.taskId,
        agentType: opts.adapterName
      });

      const hookPath = path.join(opts.cwd, '.git', 'hooks', 'pre-commit');
      const fs = require('fs');
      const hookDir = path.dirname(hookPath);
      if (!fs.existsSync(hookDir)) fs.mkdirSync(hookDir, { recursive: true });
      fs.writeFileSync(hookPath, hookScript, { mode: 0o755 });
      result.gitHookInstalled = true;

      this.log.info('Installed universal pre-commit hook', {
        adapter: opts.adapterName, taskId: opts.taskId, path: hookPath
      });
    } catch (e) {
      this.log.warn('Failed to install pre-commit hook', {
        adapter: opts.adapterName, error: e.message
      });
    }

    // 2. Start file watcher for real-time enforcement
    try {
      const { loadPolicy } = require(path.join(this.projectRoot, '.claude', 'pilot', 'hooks', 'lib', 'policy'));
      const { createWatcher } = require(path.join(__dirname, 'enforcement', 'file-watcher'));

      const watcher = createWatcher({
        watchPath: opts.cwd,
        sessionId: opts.sessionId,
        policy: loadPolicy(),
        projectRoot: this.projectRoot,
        taskId: opts.taskId,
        onViolation: (type, detail) => {
          this.log.warn('File watcher violation', { type, ...detail });
        }
      });

      this._enforcementWatchers.set(opts.sessionId, watcher);
      result.fileWatcherStarted = true;

      this.log.info('Started file watcher enforcement', {
        adapter: opts.adapterName, taskId: opts.taskId
      });
    } catch (e) {
      this.log.warn('Failed to start file watcher', {
        adapter: opts.adapterName, error: e.message
      });
    }

    return result;
  }

  /**
   * Stop enforcement for a completed agent session.
   *
   * @param {string} sessionId
   * @returns {{ stopped: boolean, metrics?: object }}
   */
  stopEnforcement(sessionId) {
    const watcher = this._enforcementWatchers.get(sessionId);
    if (!watcher) return { stopped: false };

    const result = watcher.stop();
    this._enforcementWatchers.delete(sessionId);

    return { stopped: true, metrics: result.metrics };
  }

  // ===========================================================================
  // POST-RUN VALIDATION
  // ===========================================================================

  /**
   * Run post-run validation for a completed agent.
   *
   * @param {object} opts
   * @param {string} opts.cwd - Agent working directory
   * @param {string} opts.sessionId
   * @param {string} opts.taskId
   * @param {string} opts.adapterName
   * @returns {{ passed: boolean, violations: object[], warnings: object[] }}
   */
  validatePostRun(opts) {
    if (opts.adapterName === 'claude') {
      // Claude Code handles its own post-tool-use validation
      return { passed: true, violations: [], warnings: [], summary: {} };
    }

    try {
      const { validate } = require(path.join(__dirname, 'enforcement', 'post-run-validator'));
      return validate({
        cwd: opts.cwd,
        sessionId: opts.sessionId,
        taskId: opts.taskId,
        projectRoot: this.projectRoot
      });
    } catch (e) {
      this.log.warn('Post-run validation failed', { error: e.message });
      return { passed: true, violations: [], warnings: [], summary: {} };
    }
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  TerminalLayout,
  MODEL_SHORT_NAMES
};
