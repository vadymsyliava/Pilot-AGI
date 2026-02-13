/**
 * Quality Regression Prevention — Phase 8.15 (Pilot AGI-w7ej)
 *
 * Quality score floor: commits that drop score below threshold are blocked.
 * Per-area thresholds, grace periods for new features, trend alerts.
 */

const fs = require('fs');
const path = require('path');

const GATE_CONFIG_FILE = '.claude/pilot/registry/quality-gate.json';
const DEFAULT_THRESHOLD = 0.70;
const DEFAULT_GRACE_DAYS = 7;

// =============================================================================
// GATE CHECK
// =============================================================================

/**
 * Check if a commit/merge should be allowed based on quality score.
 *
 * @param {object} currentScores - Current quality scores from sweep
 * @param {object} opts - { area?, taskId?, isNewFeature? }
 * @returns {{ allowed, reason?, warnings? }}
 */
function checkGate(currentScores, opts) {
  opts = opts || {};
  if (!currentScores) return { allowed: true };

  const config = loadConfig();
  const warnings = [];

  // Get threshold for this area (or default)
  const area = opts.area || 'default';
  const threshold = getThreshold(config, area);

  // Check grace period for new features
  if (opts.isNewFeature || opts.taskId) {
    const grace = checkGracePeriod(config, opts.taskId);
    if (grace.active) {
      // During grace period, use a relaxed threshold
      const relaxedThreshold = threshold * 0.85; // 15% relaxation
      if (currentScores.overall < relaxedThreshold) {
        return {
          allowed: false,
          reason: `Quality score ${currentScores.overall} is below relaxed threshold ${relaxedThreshold} (grace period active for ${grace.remaining_days} more days)`
        };
      }
      warnings.push(`Grace period active: threshold relaxed from ${threshold} to ${relaxedThreshold}`);
      return { allowed: true, warnings };
    }
  }

  // Main threshold check
  if (currentScores.overall < threshold) {
    return {
      allowed: false,
      reason: `Quality score ${currentScores.overall} is below threshold ${threshold} for area "${area}". Fix quality issues before merging.`
    };
  }

  // Per-metric checks
  const metricThresholds = config.metric_thresholds || {};
  for (const [metric, minScore] of Object.entries(metricThresholds)) {
    if (currentScores[metric] !== undefined && currentScores[metric] < minScore) {
      warnings.push(`${metric} score ${currentScores[metric]} is below metric threshold ${minScore}`);
    }
  }

  // Trend check
  const trendAlert = checkTrendAlert(config);
  if (trendAlert) {
    warnings.push(trendAlert);
  }

  return { allowed: true, warnings: warnings.length > 0 ? warnings : undefined };
}

// =============================================================================
// THRESHOLD MANAGEMENT
// =============================================================================

/**
 * Get the quality threshold for an area.
 */
function getThreshold(config, area) {
  if (config.area_thresholds && config.area_thresholds[area]) {
    return config.area_thresholds[area];
  }
  return config.default_threshold || DEFAULT_THRESHOLD;
}

/**
 * Set a threshold for a specific area.
 */
function setThreshold(area, threshold) {
  if (threshold < 0 || threshold > 1) return { success: false, error: 'threshold must be between 0 and 1' };

  const config = loadConfig();
  if (!config.area_thresholds) config.area_thresholds = {};

  if (area === 'default') {
    config.default_threshold = threshold;
  } else {
    config.area_thresholds[area] = threshold;
  }

  saveConfig(config);
  return { success: true };
}

/**
 * List all configured thresholds.
 */
function listThresholds() {
  const config = loadConfig();
  return {
    default: config.default_threshold || DEFAULT_THRESHOLD,
    areas: config.area_thresholds || {}
  };
}

// =============================================================================
// GRACE PERIODS
// =============================================================================

/**
 * Grant a grace period for a new feature task.
 *
 * @param {string} taskId - Task getting the grace period
 * @param {number} days - Number of days
 * @returns {{ success }}
 */
function grantGracePeriod(taskId, days) {
  if (!taskId) return { success: false, error: 'taskId required' };
  days = days || DEFAULT_GRACE_DAYS;

  const config = loadConfig();
  if (!config.grace_periods) config.grace_periods = {};

  const expires = new Date();
  expires.setDate(expires.getDate() + days);

  config.grace_periods[taskId] = {
    granted_at: new Date().toISOString(),
    expires_at: expires.toISOString(),
    days
  };

  saveConfig(config);
  return { success: true, expires_at: expires.toISOString() };
}

/**
 * Check if a task has an active grace period.
 */
function checkGracePeriod(config, taskId) {
  if (!taskId || !config.grace_periods || !config.grace_periods[taskId]) {
    return { active: false };
  }

  const grace = config.grace_periods[taskId];
  const expires = new Date(grace.expires_at);
  const now = new Date();

  if (now >= expires) {
    return { active: false, expired: true };
  }

  const remainingMs = expires - now;
  const remainingDays = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));

  return { active: true, remaining_days: remainingDays };
}

/**
 * Revoke a grace period (tighten threshold after stabilization).
 */
function revokeGracePeriod(taskId) {
  if (!taskId) return { success: false, error: 'taskId required' };

  const config = loadConfig();
  if (config.grace_periods && config.grace_periods[taskId]) {
    delete config.grace_periods[taskId];
    saveConfig(config);
    return { success: true };
  }

  return { success: false, error: 'no grace period found' };
}

// =============================================================================
// TREND ALERTS
// =============================================================================

/**
 * Check if quality is trending down and generate alert.
 */
function checkTrendAlert(config) {
  let qualitySweep;
  try {
    qualitySweep = require('./quality-sweep');
  } catch (e) {
    return null;
  }

  const windowSize = config.trend_window || 5;
  const trend = qualitySweep.checkTrend(windowSize);

  if (trend.trending_down) {
    return `Quality trending down: ${trend.decline_amount} decline over last ${windowSize} sweeps. Consider addressing quality issues.`;
  }

  return null;
}

// =============================================================================
// SCORE COMPARISON (before/after)
// =============================================================================

/**
 * Check if proposed changes would regress quality below the floor.
 *
 * @param {object} beforeScores - Scores before the change
 * @param {object} afterScores - Scores after the change
 * @param {object} opts - { area?, maxRegression? }
 * @returns {{ allowed, regressions }}
 */
function checkRegression(beforeScores, afterScores, opts) {
  opts = opts || {};
  if (!beforeScores || !afterScores) return { allowed: true, regressions: [] };

  const maxRegression = opts.maxRegression || 0.05; // 5% max drop per commit
  const regressions = [];

  for (const key of ['duplicates', 'dead_code', 'naming', 'patterns', 'overall']) {
    const before = beforeScores[key];
    const after = afterScores[key];

    if (before !== undefined && after !== undefined) {
      const drop = before - after;
      if (drop > maxRegression) {
        regressions.push({
          metric: key,
          before,
          after,
          drop: Math.round(drop * 100) / 100
        });
      }
    }
  }

  return {
    allowed: regressions.length === 0,
    regressions
  };
}

// =============================================================================
// CONFIG STORAGE
// =============================================================================

function getConfigPath() {
  return path.join(process.cwd(), GATE_CONFIG_FILE);
}

function loadConfig() {
  const filePath = getConfigPath();
  if (!fs.existsSync(filePath)) {
    return {
      default_threshold: DEFAULT_THRESHOLD,
      area_thresholds: {},
      metric_thresholds: {},
      grace_periods: {},
      trend_window: 5
    };
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return { default_threshold: DEFAULT_THRESHOLD };
  }
}

function saveConfig(config) {
  const dir = path.dirname(getConfigPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = getConfigPath();
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Gate check
  checkGate,
  checkRegression,

  // Thresholds
  getThreshold,
  setThreshold,
  listThresholds,

  // Grace periods
  grantGracePeriod,
  checkGracePeriod,
  revokeGracePeriod,

  // Config
  loadConfig,
  saveConfig,

  // Constants
  DEFAULT_THRESHOLD,
  DEFAULT_GRACE_DAYS
};
