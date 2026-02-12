/**
 * PM Dashboard Terminal — Phase 6.16 (Pilot AGI-5jg)
 *
 * Live terminal dashboard showing agents with model names and per-model costs.
 * Provider budget bars, savings percentage, model health.
 *
 * Columns: Agent | Model | Task | CTX% | Cost
 *
 * Integrates with:
 *   - dashboard.js collect() for agent/task/cost data
 *   - cost-normalizer.js for multi-model cost reports + savings
 *   - terminal-layout.js MODEL_SHORT_NAMES for display labels
 *   - pm-daemon.js getStatus() for daemon state
 */

'use strict';

const path = require('path');

// =============================================================================
// CONSTANTS
// =============================================================================

const REFRESH_INTERVAL_MS = 5000;
const BAR_WIDTH = 20;
const COLUMN_WIDTHS = { agent: 14, model: 12, task: 18, ctx: 6, cost: 10, status: 10 };

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
  renderBar,
  pad,
  COLUMN_WIDTHS,
  REFRESH_INTERVAL_MS
};
