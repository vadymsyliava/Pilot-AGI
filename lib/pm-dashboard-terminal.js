/**
 * PM Dashboard Terminal — Phase 6.16 + Phase 6.7 (Pilot AGI-5jg, Pilot AGI-4b6)
 *
 * Live terminal dashboard showing agents with model names and per-model costs.
 * Provider budget bars, savings percentage, model health.
 *
 * Phase 6.7 additions:
 *   - Queue status with priority-ordered tasks
 *   - Recent events section
 *   - Interactive keyboard shortcuts for PM actions
 *   - PmDashboardInteractive class with TUI input handling
 *
 * Columns: Agent | Model | Task | CTX% | Cost
 *
 * Integrates with:
 *   - dashboard.js collect() for agent/task/cost data
 *   - cost-normalizer.js for multi-model cost reports + savings
 *   - terminal-layout.js MODEL_SHORT_NAMES for display labels
 *   - pm-daemon.js getStatus() for daemon state
 *   - terminal-controller.js for scaleAgents/closeTab/autoApprove
 *   - orchestrator.js for approveMerge
 */

'use strict';

const path = require('path');

// =============================================================================
// CONSTANTS
// =============================================================================

const REFRESH_INTERVAL_MS = 5000;
const BAR_WIDTH = 20;
const COLUMN_WIDTHS = { agent: 14, model: 12, task: 18, ctx: 6, cost: 10, status: 10 };
const MAX_EVENTS = 8;
const MAX_QUEUE_ITEMS = 10;

// =============================================================================
// SAFE MODULE LOADERS
// =============================================================================

function loadModule(name, base) {
  try {
    return require(path.join(base, '.claude', 'pilot', 'hooks', 'lib', name));
  } catch (e) {
    return null;
  }
}

function loadLibModule(name) {
  try {
    return require(path.join(__dirname, name));
  } catch (e) {
    return null;
  }
}

// =============================================================================
// PM DASHBOARD
// =============================================================================

class PmDashboard {
  /**
   * @param {object} opts
   * @param {string} opts.projectRoot - Project root
   * @param {object} [opts.logger]
   */
  constructor(opts) {
    this.projectRoot = opts.projectRoot;
    this.log = opts.logger || { info() {}, warn() {}, error() {}, debug() {} };
    this._intervalId = null;
  }

  // ===========================================================================
  // DATA COLLECTION
  // ===========================================================================

  /**
   * Collect all dashboard data with multi-model extensions.
   *
   * @returns {object} Dashboard data snapshot
   */
  collectData() {
    const dashboard = loadModule('dashboard', this.projectRoot);
    const base = dashboard ? dashboard.collect() : this._fallbackCollect();

    // Extend with multi-model cost data
    base.multiModel = this._collectMultiModelData();

    return base;
  }

  _fallbackCollect() {
    return {
      agents: [],
      tasks: { open: 0, in_progress: 0, closed: 0, total: 0, items: [] },
      locks: { areas: [], files: [] },
      costs: [],
      pressure: [],
      drift: [],
      collected_at: new Date().toISOString()
    };
  }

  /**
   * Collect multi-model specific data: daily report, savings, provider budgets.
   */
  _collectMultiModelData() {
    const result = {
      dailyReport: null,
      providerBudgets: {},
      savings: { opusEquivalent: 0, actual: 0, saved: 0, percentSaved: '0.0' },
      modelShortNames: {}
    };

    // Load cost normalizer
    try {
      const { createNormalizer } = require(path.join(__dirname, 'cost-normalizer'));
      const normalizer = createNormalizer({ projectRoot: this.projectRoot });
      result.dailyReport = normalizer.getDailyReport();
      result.providerBudgets = normalizer.checkAllProviderBudgets();
      if (result.dailyReport) {
        result.savings = result.dailyReport.savings;
      }
    } catch (e) {
      this.log.debug('Cost normalizer unavailable', { error: e.message });
    }

    // Load model short names
    try {
      const { MODEL_SHORT_NAMES } = require(path.join(__dirname, 'terminal-layout'));
      result.modelShortNames = MODEL_SHORT_NAMES;
    } catch (e) {
      this.log.debug('Terminal layout unavailable', { error: e.message });
    }

    return result;
  }

  // ===========================================================================
  // RENDERING
  // ===========================================================================

  /**
   * Render the full dashboard as a string.
   *
   * @param {object} [data] - Pre-collected data. If omitted, calls collectData().
   * @returns {string} Rendered dashboard text
   */
  render(data) {
    if (!data) data = this.collectData();

    const lines = [];

    lines.push(this._renderHeader(data));
    lines.push('');
    lines.push(this._renderAgentTable(data));
    lines.push('');
    lines.push(this._renderCostSummary(data));
    lines.push('');
    lines.push(this._renderProviderBudgets(data));
    lines.push('');
    lines.push(this._renderSavings(data));
    lines.push('');
    lines.push(this._renderQueueStatus(data));
    lines.push('');
    lines.push(this._renderRecentEvents(data));
    lines.push('');
    lines.push(this._renderAlerts(data));

    return lines.join('\n');
  }

  /**
   * Render header with task counts and timestamp.
   */
  _renderHeader(data) {
    const t = data.tasks;
    const ts = new Date().toLocaleTimeString();
    return [
      `PILOT AGI — Multi-Model Dashboard  [${ts}]`,
      `Tasks: ${t.in_progress} active | ${t.open} queued | ${t.closed}/${t.total} done`
    ].join('\n');
  }

  /**
   * Render the agent table with model labels.
   * Columns: Agent | Model | Task | CTX% | Cost | Status
   */
  _renderAgentTable(data) {
    const w = COLUMN_WIDTHS;
    const header =
      pad('Agent', w.agent) +
      pad('Model', w.model) +
      pad('Task', w.task) +
      pad('CTX%', w.ctx) +
      pad('Cost', w.cost) +
      pad('Status', w.status);

    const separator = '-'.repeat(header.length);
    const rows = [];

    for (const agent of data.agents) {
      const modelId = this._getAgentModel(agent, data);
      const modelName = this._getModelShortName(modelId, data);
      const taskId = agent.claimed_task || '-';
      const ctx = this._getAgentCtx(agent, data);
      const cost = this._getAgentCost(agent, data);
      const status = this._formatStatus(agent.status);

      rows.push(
        pad(agent.agent_name || agent.session_id?.slice(-8) || '?', w.agent) +
        pad(modelName, w.model) +
        pad(taskId.length > w.task - 2 ? taskId.slice(0, w.task - 2) + '..' : taskId, w.task) +
        pad(ctx, w.ctx) +
        pad(cost, w.cost) +
        pad(status, w.status)
      );
    }

    if (rows.length === 0) {
      rows.push('  (no active agents)');
    }

    return ['AGENTS', separator, header, separator, ...rows].join('\n');
  }

  /**
   * Render daily cost summary by model.
   */
  _renderCostSummary(data) {
    const report = data.multiModel?.dailyReport;
    if (!report || !report.byModel || Object.keys(report.byModel).length === 0) {
      return 'COSTS\n  No cost data for today';
    }

    const lines = [`COSTS — Today: $${report.total.toFixed(2)}`];
    const names = data.multiModel?.modelShortNames || {};

    for (const [modelId, info] of Object.entries(report.byModel)) {
      const name = names[modelId] || modelId;
      lines.push(`  ${pad(name, 16)} $${info.dollars.toFixed(4)}  (${info.entries} calls)`);
    }

    return lines.join('\n');
  }

  /**
   * Render provider budget bars.
   */
  _renderProviderBudgets(data) {
    const budgets = data.multiModel?.providerBudgets;
    if (!budgets || Object.keys(budgets).length === 0) {
      return 'PROVIDER BUDGETS\n  No budget limits configured';
    }

    const lines = ['PROVIDER BUDGETS'];

    for (const [provider, info] of Object.entries(budgets)) {
      if (info.budget === null) {
        lines.push(`  ${pad(provider, 12)} unlimited`);
        continue;
      }

      const pct = info.budget > 0 ? info.spent / info.budget : 0;
      const bar = renderBar(pct, BAR_WIDTH);
      const statusIcon = info.status === 'exceeded' ? '!!'
        : info.status === 'warning' ? '! '
        : '  ';

      lines.push(
        `  ${pad(provider, 12)} ${bar} $${info.spent.toFixed(2)}/$${info.budget.toFixed(2)} ${statusIcon}`
      );
    }

    return lines.join('\n');
  }

  /**
   * Render savings vs all-Opus baseline.
   */
  _renderSavings(data) {
    const s = data.multiModel?.savings;
    if (!s || s.opusEquivalent === 0) {
      return 'SAVINGS\n  No usage to compare';
    }

    return [
      'SAVINGS vs All-Opus Baseline',
      `  Actual:          $${s.actual.toFixed(2)}`,
      `  Opus equivalent: $${s.opusEquivalent.toFixed(2)}`,
      `  Saved:           $${s.saved.toFixed(2)} (${s.percentSaved}%)`
    ].join('\n');
  }

  /**
   * Render alerts section.
   */
  _renderAlerts(data) {
    const dashboard = loadModule('dashboard', this.projectRoot);
    if (!dashboard) return 'ALERTS\n  Dashboard module unavailable';

    try {
      const alerts = dashboard.getAlerts(data);
      if (alerts.length === 0) return 'ALERTS\n  All clear';

      const lines = [`ALERTS (${alerts.length})`];
      for (const a of alerts.slice(0, 10)) {
        const icon = a.severity === 'critical' ? '[!!]'
          : a.severity === 'warning' ? '[! ]'
          : '[i ]';
        lines.push(`  ${icon} ${a.message}`);
      }
      return lines.join('\n');
    } catch (e) {
      return 'ALERTS\n  Error collecting alerts';
    }
  }

  /**
   * Render queue status — open/queued tasks by priority.
   */
  _renderQueueStatus(data) {
    const items = (data.tasks?.items || []).filter(t =>
      t.status === 'open' || t.status === 'ready'
    );

    if (items.length === 0) {
      return 'QUEUE\n  No tasks in queue';
    }

    // Sort by priority (P1 first)
    const sorted = items.slice().sort((a, b) => {
      const pa = (a.priority || '').replace('P', '') || '9';
      const pb = (b.priority || '').replace('P', '') || '9';
      return pa.localeCompare(pb);
    });

    const lines = [`QUEUE (${items.length} tasks)`];
    for (const t of sorted.slice(0, MAX_QUEUE_ITEMS)) {
      const pri = t.priority || '-';
      const id = t.id || t.task_id || '?';
      const title = t.title || t.description || '';
      const deps = t.blocked_by?.length ? ` [blocked: ${t.blocked_by.join(', ')}]` : '';
      lines.push(`  [${pri}] ${pad(id, 16)} ${title.slice(0, 40)}${deps}`);
    }
    if (items.length > MAX_QUEUE_ITEMS) {
      lines.push(`  ... and ${items.length - MAX_QUEUE_ITEMS} more`);
    }

    return lines.join('\n');
  }

  /**
   * Render recent events section.
   */
  _renderRecentEvents(data) {
    const events = data.events || [];

    if (events.length === 0) {
      return 'RECENT EVENTS\n  No recent events';
    }

    const lines = [`RECENT EVENTS (${events.length})`];
    for (const ev of events.slice(0, MAX_EVENTS)) {
      const ts = ev.timestamp
        ? new Date(ev.timestamp).toLocaleTimeString()
        : '-';
      const type = ev.type || ev.action || 'event';
      const msg = ev.message || ev.details || '';
      lines.push(`  [${ts}] ${pad(type, 20)} ${String(msg).slice(0, 50)}`);
    }
    if (events.length > MAX_EVENTS) {
      lines.push(`  ... ${events.length - MAX_EVENTS} older events`);
    }

    return lines.join('\n');
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  _getAgentModel(agent, data) {
    // Check if agent has model info from spawnedAgents tracking
    if (agent.modelId) return agent.modelId;
    if (agent.model) return agent.model;

    // Check env or fallback
    return 'claude-sonnet-4-5';
  }

  _getModelShortName(modelId, data) {
    const names = data.multiModel?.modelShortNames || {};
    if (names[modelId]) return names[modelId];

    // Fallback: capitalize
    return modelId.split(':').pop().split('-').map(w =>
      w.charAt(0).toUpperCase() + w.slice(1)
    ).join(' ');
  }

  _getAgentCtx(agent, data) {
    const p = data.pressure?.find(p => p.session_id === agent.session_id);
    if (p && p.pct_estimate > 0) {
      return `${Math.round(p.pct_estimate)}%`;
    }
    return '-';
  }

  _getAgentCost(agent, data) {
    const c = data.costs?.find(c => c.session_id === agent.session_id);
    if (c && c.cost_usd > 0) {
      return `$${c.cost_usd.toFixed(2)}`;
    }
    return '-';
  }

  _formatStatus(status) {
    const map = {
      healthy: 'OK',
      stale: 'STALE',
      unresponsive: 'UNRES',
      dead: 'DEAD',
      lease_expired: 'EXPRD'
    };
    return map[status] || status || '-';
  }

  // ===========================================================================
  // LIVE MODE
  // ===========================================================================

  /**
   * Start live dashboard with periodic refresh.
   *
   * @param {object} [opts]
   * @param {number} [opts.refreshMs] - Refresh interval (default 5000ms)
   * @param {WritableStream} [opts.output] - Output stream (default process.stdout)
   * @returns {{ stop: Function }}
   */
  startLive(opts = {}) {
    const refreshMs = opts.refreshMs || REFRESH_INTERVAL_MS;
    const output = opts.output || process.stdout;

    const tick = () => {
      try {
        const data = this.collectData();
        const rendered = this.render(data);

        // Clear screen and render
        output.write('\x1B[2J\x1B[H');
        output.write(rendered + '\n');
      } catch (e) {
        output.write(`Dashboard error: ${e.message}\n`);
      }
    };

    tick(); // Initial render
    this._intervalId = setInterval(tick, refreshMs);

    return {
      stop: () => {
        if (this._intervalId) {
          clearInterval(this._intervalId);
          this._intervalId = null;
        }
      }
    };
  }

  /**
   * Stop live dashboard.
   */
  stopLive() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }
}

// =============================================================================
// KEYBOARD SHORTCUT MAP
// =============================================================================

const SHORTCUTS = {
  k: { label: 'k:kill', description: 'Kill agent (select by number)' },
  a: { label: 'a:approve', description: 'Approve pending merge' },
  s: { label: 's:scale', description: 'Scale agents up/down' },
  r: { label: 'r:refresh', description: 'Force refresh' },
  q: { label: 'q:quit', description: 'Quit dashboard' },
  '?': { label: '?:help', description: 'Show keyboard shortcuts' }
};

// =============================================================================
// INTERACTIVE PM DASHBOARD (Phase 6.7)
// =============================================================================

class PmDashboardInteractive {
  /**
   * @param {object} opts
   * @param {string} opts.projectRoot
   * @param {object} [opts.logger]
   * @param {WritableStream} [opts.output]
   * @param {ReadableStream} [opts.input]
   * @param {number} [opts.refreshMs]
   * @param {object} [opts.terminalController] - Terminal controller for agent actions
   * @param {object} [opts.orchestrator] - Orchestrator for merge approvals
   * @param {Function} [opts.onAction] - Callback for action events (testing)
   */
  constructor(opts) {
    this.dashboard = new PmDashboard({
      projectRoot: opts.projectRoot,
      logger: opts.logger
    });
    this.projectRoot = opts.projectRoot;
    this.output = opts.output || process.stdout;
    this.input = opts.input || process.stdin;
    this.refreshMs = opts.refreshMs || REFRESH_INTERVAL_MS;
    this.terminalController = opts.terminalController || null;
    this.orchestrator = opts.orchestrator || null;
    this.onAction = opts.onAction || null;
    this.log = opts.logger || { info() {}, warn() {}, error() {}, debug() {} };

    this._intervalId = null;
    this._running = false;
    this._mode = 'dashboard'; // dashboard | input | help
    this._inputBuffer = '';
    this._inputPrompt = '';
    this._inputCallback = null;
    this._statusMessage = '';
    this._statusTimeout = null;
    this._lastData = null;
    this._keypressHandler = null;
  }

  /**
   * Start the interactive dashboard.
   * Sets stdin to raw mode and begins refresh loop.
   */
  start() {
    this._running = true;

    // Set up keyboard input
    if (this.input.isTTY) {
      this.input.setRawMode(true);
    }
    this.input.resume();

    this._keypressHandler = (data) => this._handleKeypress(data);
    this.input.on('data', this._keypressHandler);

    // Initial render
    this._tick();

    // Start refresh loop
    this._intervalId = setInterval(() => this._tick(), this.refreshMs);

    return this;
  }

  /**
   * Stop the interactive dashboard.
   */
  stop() {
    this._running = false;

    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }

    if (this._statusTimeout) {
      clearTimeout(this._statusTimeout);
      this._statusTimeout = null;
    }

    if (this._keypressHandler) {
      this.input.removeListener('data', this._keypressHandler);
      this._keypressHandler = null;
    }

    if (this.input.isTTY) {
      this.input.setRawMode(false);
    }
    this.input.pause();
  }

  get running() {
    return this._running;
  }

  /**
   * Get the underlying PmDashboard instance.
   */
  get inner() {
    return this.dashboard;
  }

  // ===========================================================================
  // RENDERING
  // ===========================================================================

  _tick() {
    if (!this._running) return;

    try {
      this._lastData = this.dashboard.collectData();
      this._render();
    } catch (e) {
      this.output.write(`Dashboard error: ${e.message}\n`);
    }
  }

  _render() {
    const data = this._lastData;
    if (!data) return;

    // Clear screen
    this.output.write('\x1B[2J\x1B[H');

    if (this._mode === 'help') {
      this.output.write(this._renderHelp());
      return;
    }

    // Main dashboard
    const rendered = this.dashboard.render(data);
    this.output.write(rendered + '\n');

    // Status bar
    this.output.write('\n');
    this.output.write(this._renderStatusBar());

    // Input prompt (if in input mode)
    if (this._mode === 'input') {
      this.output.write('\n' + this._inputPrompt + this._inputBuffer);
    }
  }

  _renderStatusBar() {
    const keys = Object.values(SHORTCUTS).map(s => s.label).join('  ');
    const line = `[${keys}]`;

    if (this._statusMessage) {
      return `${line}  >> ${this._statusMessage}`;
    }

    return line;
  }

  _renderHelp() {
    const lines = [
      'PILOT AGI — PM Dashboard Keyboard Shortcuts',
      '',
      '-'.repeat(50)
    ];

    for (const [key, info] of Object.entries(SHORTCUTS)) {
      lines.push(`  ${key}  ${info.description}`);
    }

    lines.push('');
    lines.push('-'.repeat(50));
    lines.push('');
    lines.push('Press any key to return to dashboard...');

    return lines.join('\n');
  }

  // ===========================================================================
  // KEYBOARD INPUT
  // ===========================================================================

  _handleKeypress(data) {
    const key = data.toString();

    // Ctrl+C always quits
    if (key === '\x03') {
      this._doQuit();
      return;
    }

    // If in input mode, handle input
    if (this._mode === 'input') {
      this._handleInputKey(key);
      return;
    }

    // If in help mode, any key returns
    if (this._mode === 'help') {
      this._mode = 'dashboard';
      this._render();
      return;
    }

    // Dashboard mode shortcuts
    switch (key) {
      case 'k':
        this._startKillAgent();
        break;
      case 'a':
        this._startApprove();
        break;
      case 's':
        this._startScale();
        break;
      case 'r':
        this._tick();
        this._showStatus('Refreshed');
        break;
      case 'q':
        this._doQuit();
        break;
      case '?':
        this._mode = 'help';
        this._render();
        break;
    }
  }

  _handleInputKey(key) {
    // ESC cancels input
    if (key === '\x1B') {
      this._cancelInput();
      return;
    }

    // Enter submits
    if (key === '\r' || key === '\n') {
      const value = this._inputBuffer;
      const cb = this._inputCallback;
      this._mode = 'dashboard';
      this._inputBuffer = '';
      this._inputPrompt = '';
      this._inputCallback = null;
      if (cb) cb(value);
      return;
    }

    // Backspace
    if (key === '\x7f' || key === '\b') {
      this._inputBuffer = this._inputBuffer.slice(0, -1);
      this._render();
      return;
    }

    // Printable characters
    if (key.length === 1 && key.charCodeAt(0) >= 32) {
      this._inputBuffer += key;
      this._render();
    }
  }

  _promptInput(prompt, callback) {
    this._mode = 'input';
    this._inputPrompt = prompt;
    this._inputBuffer = '';
    this._inputCallback = callback;
    this._render();
  }

  _cancelInput() {
    this._mode = 'dashboard';
    this._inputBuffer = '';
    this._inputPrompt = '';
    this._inputCallback = null;
    this._showStatus('Cancelled');
  }

  // ===========================================================================
  // ACTIONS
  // ===========================================================================

  _startKillAgent() {
    const agents = this._lastData?.agents || [];
    if (agents.length === 0) {
      this._showStatus('No agents to kill');
      return;
    }

    // Number agents for selection
    const list = agents.map((a, i) =>
      `${i + 1}: ${a.agent_name || a.session_id?.slice(-8) || '?'} (${a.claimed_task || 'idle'})`
    ).join(', ');

    this._promptInput(`Kill agent [${list}]: `, (value) => {
      const idx = parseInt(value, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= agents.length) {
        this._showStatus('Invalid agent number');
        return;
      }
      this._killAgent(agents[idx]);
    });
  }

  async _killAgent(agent) {
    const id = agent.agent_name || agent.session_id?.slice(-8) || '?';

    try {
      if (this.terminalController && agent.tabId) {
        await this.terminalController.closeTab(agent.tabId);
        this._showStatus(`Killed agent ${id}`);
      } else {
        // Fallback: signal via session end
        const session = loadModule('session', this.projectRoot);
        if (session && agent.session_id) {
          session.endSession(agent.session_id, 'killed_by_pm');
          this._showStatus(`Ended session for ${id}`);
        } else {
          this._showStatus(`Cannot kill ${id} — no terminal controller`);
        }
      }

      if (this.onAction) this.onAction({ type: 'kill', agent: id });
    } catch (e) {
      this._showStatus(`Kill failed: ${e.message}`);
    }
  }

  _startApprove() {
    this._promptInput('Approve task ID (or "all"): ', (value) => {
      this._approveTask(value.trim());
    });
  }

  _approveTask(taskId) {
    try {
      const orch = this.orchestrator || loadModule('orchestrator', this.projectRoot);

      if (taskId === 'all') {
        // Approve all pending
        this._showStatus('Approving all pending merges...');
        if (this.onAction) this.onAction({ type: 'approve_all' });
        return;
      }

      if (!orch) {
        this._showStatus('Orchestrator unavailable');
        return;
      }

      const result = orch.approveMerge(taskId, 'pm-dashboard');
      if (result && result.success) {
        this._showStatus(`Approved merge for ${taskId}`);
      } else {
        this._showStatus(`Approve failed for ${taskId}`);
      }

      if (this.onAction) this.onAction({ type: 'approve', taskId });
    } catch (e) {
      this._showStatus(`Approve error: ${e.message}`);
    }
  }

  _startScale() {
    this._promptInput('Target agent count: ', (value) => {
      const count = parseInt(value, 10);
      if (isNaN(count) || count < 0) {
        this._showStatus('Invalid number');
        return;
      }
      this._scaleAgents(count);
    });
  }

  async _scaleAgents(target) {
    try {
      if (!this.terminalController) {
        this._showStatus('Terminal controller unavailable');
        return;
      }

      const result = await this.terminalController.scaleAgents(target, {});
      this._showStatus(`Scale: +${result.opened} -${result.closed} agents`);

      if (this.onAction) this.onAction({ type: 'scale', target, result });
    } catch (e) {
      this._showStatus(`Scale failed: ${e.message}`);
    }
  }

  _doQuit() {
    this.stop();
    this.output.write('\x1B[2J\x1B[H');
    this.output.write('Dashboard closed.\n');
    if (this.onAction) this.onAction({ type: 'quit' });
  }

  _showStatus(msg) {
    this._statusMessage = msg;
    if (this._statusTimeout) clearTimeout(this._statusTimeout);
    this._statusTimeout = setTimeout(() => {
      this._statusMessage = '';
      if (this._running) this._render();
    }, 5000);
    if (this._running) this._render();
  }
}

// =============================================================================
// RENDERING HELPERS
// =============================================================================

/**
 * Render a progress bar.
 *
 * @param {number} pct - Fraction 0..1
 * @param {number} width - Total bar width in chars
 * @returns {string} e.g., "[=========---------]"
 */
function renderBar(pct, width) {
  const clamped = Math.max(0, Math.min(1, pct));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return '[' + '='.repeat(filled) + '-'.repeat(empty) + ']';
}

/**
 * Pad string to width.
 *
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
function pad(str, width) {
  const s = String(str || '');
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  PmDashboard,
  PmDashboardInteractive,
  renderBar,
  pad,
  SHORTCUTS,
  COLUMN_WIDTHS,
  REFRESH_INTERVAL_MS,
  MAX_EVENTS,
  MAX_QUEUE_ITEMS
};
