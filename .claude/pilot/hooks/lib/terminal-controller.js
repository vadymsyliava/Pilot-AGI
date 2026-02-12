/**
 * Terminal Controller — Unified Interface (Phase 6.3)
 *
 * Abstracts AppleScript bridge and iTerm2 bridge behind a single API.
 * Provider auto-detection on startup. Maintains a tab registry mapping
 * tabId → { role, taskId, state, provider }. Sync loop reconciles
 * registry with actual terminal state.
 *
 * High-level operations for PM Daemon:
 * - scaleAgents, autoApprove, answerQuestion
 * - checkpointRespawn, broadcastToAll
 *
 * Monitoring:
 * - getGroundTruth, detectStalled, getTabMetrics
 *
 * Part of Phase 6.3 (Pilot AGI-l6p)
 */

// Lazy-loaded to avoid circular requires
let _applescriptBridge = null;
let _iterm2Bridge = null;

function getAppleScriptBridge() {
  if (!_applescriptBridge) _applescriptBridge = require('./applescript-bridge');
  return _applescriptBridge;
}

function getITerm2Bridge() {
  if (!_iterm2Bridge) _iterm2Bridge = require('./iterm2-bridge');
  return _iterm2Bridge;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const SYNC_INTERVAL_MS = 5000;
const STALLED_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes with no state change

/**
 * @typedef {Object} TabEntry
 * @property {string} tabId - Provider-specific tab identifier
 * @property {string} role - Agent role (frontend, backend, pm, etc.)
 * @property {string} taskId - Assigned bd task ID
 * @property {string} state - Last detected state (idle, working, error, etc.)
 * @property {string} provider - Provider name (applescript | iterm2)
 * @property {number} stateChangedAt - Timestamp of last state change
 * @property {number} createdAt - Timestamp when tab was opened
 */

// ============================================================================
// TERMINAL CONTROLLER
// ============================================================================

class TerminalController {
  /**
   * @param {object} [opts]
   * @param {object} [opts.policy] - Policy config (terminal section)
   * @param {object} [opts.logger] - Logger instance
   */
  constructor(opts = {}) {
    this.policy = opts.policy || {};
    this.log = opts.logger || { info() {}, warn() {}, error() {}, debug() {} };

    /** @type {Map<string, TabEntry>} */
    this.registry = new Map();

    /** @type {'applescript'|'iterm2'|null} */
    this.activeProvider = null;

    /** @type {object|null} iTerm2Bridge instance if using iterm2 */
    this._iterm2Instance = null;

    this._syncTimer = null;
    this._started = false;
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /**
   * Initialize the controller: detect provider, start sync loop.
   *
   * @returns {Promise<{provider: string}>}
   */
  async start() {
    if (this._started) return { provider: this.activeProvider };

    const provider = await this._detectProvider();
    this.activeProvider = provider;
    this._started = true;

    this.log.info('Terminal controller started', { provider });

    // Start sync loop
    this._syncTimer = setInterval(() => this.sync().catch(e => {
      this.log.error('Sync loop error', { error: e.message });
    }), this.policy.syncIntervalMs || SYNC_INTERVAL_MS);

    return { provider };
  }

  /**
   * Stop the controller: clear sync loop, close iTerm2 bridge.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
    if (this._iterm2Instance) {
      await this._iterm2Instance.stop();
      this._iterm2Instance = null;
    }
    this._started = false;
    this.activeProvider = null;
    this.log.info('Terminal controller stopped');
  }

  // ==========================================================================
  // PROVIDER DETECTION
  // ==========================================================================

  /**
   * Detect the best available terminal provider.
   * Priority: iTerm2 Python API > AppleScript (Terminal.app)
   *
   * @returns {Promise<string>} Provider name
   */
  async _detectProvider() {
    const forced = this.policy.provider;
    if (forced && forced !== 'auto') {
      if (forced === 'iterm2') return 'iterm2';
      if (forced === 'terminal' || forced === 'applescript') return 'applescript';
      return 'applescript';
    }

    // Try iTerm2 first
    try {
      const { checkAvailability } = getITerm2Bridge();
      const status = await checkAvailability();
      if (status.available) {
        return 'iterm2';
      }
    } catch (e) {
      this.log.debug('iTerm2 detection failed', { error: e.message });
    }

    // Fallback to AppleScript/Terminal.app
    try {
      const bridge = getAppleScriptBridge();
      if (await bridge.isAvailable()) {
        return 'applescript';
      }
    } catch (e) {
      this.log.debug('AppleScript detection failed', { error: e.message });
    }

    throw new Error('No terminal provider available');
  }

  /**
   * Get or create the iTerm2 bridge instance.
   *
   * @returns {Promise<object>} ITerm2Bridge instance
   */
  async _getITerm2() {
    if (!this._iterm2Instance) {
      const { ITerm2Bridge } = getITerm2Bridge();
      this._iterm2Instance = new ITerm2Bridge();
      await this._iterm2Instance.start();
    }
    return this._iterm2Instance;
  }

  // ==========================================================================
  // CORE TAB OPERATIONS
  // ==========================================================================

  /**
   * Open a new terminal tab for an agent.
   *
   * @param {object} opts
   * @param {string} opts.command - Command to run
   * @param {string} opts.taskId - bd task ID
   * @param {string} [opts.role] - Agent role
   * @param {string} [opts.title] - Tab title
   * @param {string} [opts.cwd] - Working directory
   * @param {object} [opts.env] - Environment variables
   * @param {string} [opts.badge] - Badge text (iTerm2 only)
   * @returns {Promise<TabEntry>}
   */
  async openTab(opts) {
    const title = opts.title || `pilot-${opts.taskId}`;
    let tabId;

    if (this.activeProvider === 'iterm2') {
      const bridge = await this._getITerm2();
      const result = await bridge.openTab({
        command: opts.command,
        title,
        cwd: opts.cwd,
        env: opts.env,
        badge: opts.badge,
        target: this.policy.spawnMode || 'tab',
      });
      tabId = result.tabId;
    } else {
      const bridge = getAppleScriptBridge();
      const result = await bridge.openTab({
        command: opts.command,
        title,
        cwd: opts.cwd,
        env: opts.env,
      });
      tabId = result.tabId;
    }

    const entry = {
      tabId,
      role: opts.role || 'agent',
      taskId: opts.taskId,
      state: 'starting',
      provider: this.activeProvider,
      stateChangedAt: Date.now(),
      createdAt: Date.now(),
    };

    this.registry.set(tabId, entry);
    this.log.info('Tab opened', { tabId, taskId: opts.taskId, role: opts.role });
    return entry;
  }

  /**
   * Send a command to a terminal tab.
   *
   * @param {string} tabId
   * @param {string} command
   * @returns {Promise<void>}
   */
  async sendToTab(tabId, command) {
    const entry = this.registry.get(tabId);
    const provider = entry ? entry.provider : this.activeProvider;

    if (provider === 'iterm2') {
      const bridge = await this._getITerm2();
      await bridge.sendToTab(tabId, command);
    } else {
      const bridge = getAppleScriptBridge();
      await bridge.sendToTab(tabId, command);
    }
  }

  /**
   * Read output from a terminal tab.
   *
   * @param {string} tabId
   * @param {object} [opts]
   * @param {number} [opts.lines]
   * @returns {Promise<string>}
   */
  async readTab(tabId, opts = {}) {
    const entry = this.registry.get(tabId);
    const provider = entry ? entry.provider : this.activeProvider;

    if (provider === 'iterm2') {
      const bridge = await this._getITerm2();
      return bridge.readTab(tabId, opts);
    } else {
      const bridge = getAppleScriptBridge();
      return bridge.readTab(tabId, opts);
    }
  }

  /**
   * Close a terminal tab and remove from registry.
   *
   * @param {string} tabId
   * @returns {Promise<boolean>}
   */
  async closeTab(tabId) {
    const entry = this.registry.get(tabId);
    const provider = entry ? entry.provider : this.activeProvider;
    let result;

    if (provider === 'iterm2') {
      const bridge = await this._getITerm2();
      result = await bridge.closeTab(tabId);
    } else {
      const bridge = getAppleScriptBridge();
      result = await bridge.closeTab(tabId);
    }

    this.registry.delete(tabId);
    this.log.info('Tab closed', { tabId });
    return result;
  }

  /**
   * Detect the state of a terminal tab.
   *
   * @param {string} tabId
   * @returns {Promise<{state: string, match: string|null}>}
   */
  async detectState(tabId) {
    const entry = this.registry.get(tabId);
    const provider = entry ? entry.provider : this.activeProvider;

    if (provider === 'iterm2') {
      const bridge = await this._getITerm2();
      return bridge.detectState(tabId);
    } else {
      const bridge = getAppleScriptBridge();
      return bridge.detectState(tabId);
    }
  }

  // ==========================================================================
  // REGISTRY OPERATIONS
  // ==========================================================================

  /**
   * Get a tab entry from the registry.
   *
   * @param {string} tabId
   * @returns {TabEntry|undefined}
   */
  getTab(tabId) {
    return this.registry.get(tabId);
  }

  /**
   * Find a tab by task ID.
   *
   * @param {string} taskId
   * @returns {TabEntry|undefined}
   */
  findByTaskId(taskId) {
    for (const entry of this.registry.values()) {
      if (entry.taskId === taskId) return entry;
    }
    return undefined;
  }

  /**
   * Find tabs by role.
   *
   * @param {string} role
   * @returns {TabEntry[]}
   */
  findByRole(role) {
    const results = [];
    for (const entry of this.registry.values()) {
      if (entry.role === role) results.push(entry);
    }
    return results;
  }

  /**
   * Get all tab entries.
   *
   * @returns {TabEntry[]}
   */
  getAllTabs() {
    return Array.from(this.registry.values());
  }

  // ==========================================================================
  // SYNC LOOP
  // ==========================================================================

  /**
   * Reconcile registry with actual terminal state.
   * - Update state for each registered tab
   * - Remove entries for closed tabs
   * - Detect orphaned tabs (open but not in registry)
   *
   * @returns {Promise<{updated: number, removed: number, orphaned: number}>}
   */
  async sync() {
    let updated = 0;
    let removed = 0;
    let orphaned = 0;

    // Check each registered tab
    for (const [tabId, entry] of this.registry) {
      try {
        const { state, match } = await this.detectState(tabId);
        if (state !== entry.state) {
          entry.state = state;
          entry.stateChangedAt = Date.now();
          updated++;
        }
      } catch (e) {
        // Tab likely closed — remove from registry
        this.registry.delete(tabId);
        removed++;
        this.log.info('Tab removed from registry (closed)', { tabId, taskId: entry.taskId });
      }
    }

    // Check for orphaned tabs (only for applescript which can scan all)
    if (this.activeProvider === 'applescript') {
      try {
        const bridge = getAppleScriptBridge();
        const allTabs = await bridge.listTabs();
        for (const tab of allTabs) {
          if (!this.registry.has(tab.tabId)) {
            orphaned++;
          }
        }
      } catch (e) {
        // Non-critical
      }
    }

    return { updated, removed, orphaned };
  }

  // ==========================================================================
  // HIGH-LEVEL OPERATIONS
  // ==========================================================================

  /**
   * Scale agent count to target by opening/closing tabs.
   *
   * @param {number} targetCount - Desired number of agent tabs
   * @param {object} opts
   * @param {Function} opts.buildCommand - (index) => command string
   * @param {string} [opts.role] - Role for new agents
   * @param {string} [opts.cwd] - Working directory
   * @returns {Promise<{opened: number, closed: number}>}
   */
  async scaleAgents(targetCount, opts = {}) {
    const currentTabs = this.getAllTabs().filter(t => t.role !== 'pm');
    const current = currentTabs.length;

    if (targetCount > current) {
      // Scale up
      const toOpen = targetCount - current;
      for (let i = 0; i < toOpen; i++) {
        const cmd = opts.buildCommand ? opts.buildCommand(current + i) : '';
        await this.openTab({
          command: cmd,
          taskId: `scale-${Date.now()}-${i}`,
          role: opts.role || 'agent',
          cwd: opts.cwd,
        });
      }
      return { opened: toOpen, closed: 0 };
    } else if (targetCount < current) {
      // Scale down — close from the end
      const toClose = current - targetCount;
      const tabsToClose = currentTabs.slice(-toClose);
      for (const tab of tabsToClose) {
        await this.closeTab(tab.tabId);
      }
      return { opened: 0, closed: toClose };
    }

    return { opened: 0, closed: 0 };
  }

  /**
   * Auto-approve a pending plan in a terminal tab.
   * Sends "yes" or approval keystroke.
   *
   * @param {string} tabId
   * @returns {Promise<void>}
   */
  async autoApprove(tabId) {
    await this.sendToTab(tabId, 'yes');
    this.log.info('Auto-approved', { tabId });
  }

  /**
   * Answer a question in a terminal tab.
   *
   * @param {string} tabId
   * @param {string} answer
   * @returns {Promise<void>}
   */
  async answerQuestion(tabId, answer) {
    await this.sendToTab(tabId, answer);
    this.log.info('Answered question', { tabId, answer });
  }

  /**
   * Trigger a checkpoint respawn in a terminal tab.
   * Sends the checkpoint command.
   *
   * @param {string} tabId
   * @returns {Promise<void>}
   */
  async checkpointRespawn(tabId) {
    await this.sendToTab(tabId, '/pilot-checkpoint');
    this.log.info('Checkpoint respawn triggered', { tabId });
  }

  /**
   * Broadcast a command to all registered tabs.
   *
   * @param {string} command
   * @param {object} [opts]
   * @param {string} [opts.excludeRole] - Skip tabs with this role
   * @returns {Promise<number>} Number of tabs that received the command
   */
  async broadcastToAll(command, opts = {}) {
    let sent = 0;
    for (const [tabId, entry] of this.registry) {
      if (opts.excludeRole && entry.role === opts.excludeRole) continue;
      try {
        await this.sendToTab(tabId, command);
        sent++;
      } catch (e) {
        this.log.warn('Broadcast failed for tab', { tabId, error: e.message });
      }
    }
    return sent;
  }

  // ==========================================================================
  // MONITORING
  // ==========================================================================

  /**
   * Get ground truth state for all tabs by reading actual terminal output.
   *
   * @returns {Promise<Array<{tabId: string, taskId: string, role: string, state: string}>>}
   */
  async getGroundTruth() {
    const results = [];
    for (const [tabId, entry] of this.registry) {
      try {
        const { state } = await this.detectState(tabId);
        results.push({
          tabId,
          taskId: entry.taskId,
          role: entry.role,
          state,
        });
      } catch (e) {
        results.push({
          tabId,
          taskId: entry.taskId,
          role: entry.role,
          state: 'unreachable',
        });
      }
    }
    return results;
  }

  /**
   * Detect stalled tabs (state unchanged for too long).
   *
   * @param {number} [thresholdMs] - Override stalled threshold
   * @returns {TabEntry[]}
   */
  detectStalled(thresholdMs) {
    const threshold = thresholdMs || STALLED_THRESHOLD_MS;
    const now = Date.now();
    const stalled = [];

    for (const entry of this.registry.values()) {
      const elapsed = now - entry.stateChangedAt;
      if (elapsed > threshold && entry.state !== 'complete') {
        stalled.push(entry);
      }
    }

    return stalled;
  }

  /**
   * Get metrics for all tabs.
   *
   * @returns {{total: number, byState: object, byRole: object, stalled: number}}
   */
  getTabMetrics() {
    const byState = {};
    const byRole = {};
    let stalled = 0;

    for (const entry of this.registry.values()) {
      byState[entry.state] = (byState[entry.state] || 0) + 1;
      byRole[entry.role] = (byRole[entry.role] || 0) + 1;
      if (this.detectStalled().some(s => s.tabId === entry.tabId)) {
        stalled++;
      }
    }

    return {
      total: this.registry.size,
      byState,
      byRole,
      stalled,
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  TerminalController,
  SYNC_INTERVAL_MS,
  STALLED_THRESHOLD_MS,
};
