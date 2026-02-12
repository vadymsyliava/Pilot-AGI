/**
 * Confidence Scorer — Adaptive Plan Approval (Phase 5.1)
 *
 * Evaluates plan risk/familiarity and returns a confidence tier:
 *   - auto_approve   (>0.85) — routine, low-risk, familiar code area
 *   - notify_approve (0.60-0.85) — medium risk, proceed + notify human
 *   - require_approve (<0.60) — high risk, block until human approves
 *
 * Scoring dimensions:
 *   1. Scope factor — lines/files/steps (smaller = higher confidence)
 *   2. Code area familiarity — has this area been worked successfully before?
 *   3. Historical success rate — % of similar past plans that succeeded
 *   4. Risk assessment — data loss, security, user-facing, infra-touching
 *   5. Novelty penalty — new patterns/libraries reduce confidence
 *
 * State files:
 *   .claude/pilot/state/approval-history/<taskId>.json — per-task score
 *   .claude/pilot/state/approval-history/outcomes.jsonl — historical outcomes
 *
 * This module is intentionally lightweight — called during plan approval.
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const HISTORY_DIR = '.claude/pilot/state/approval-history';
const OUTCOMES_FILE = 'outcomes.jsonl';
const SCORES_LOG_FILE = 'scores.jsonl';

// Default confidence thresholds (overridden by policy.yaml)
const DEFAULT_THRESHOLDS = {
  auto_approve: 0.85,
  notify_approve: 0.60
};

// Default scoring weights
const DEFAULT_WEIGHTS = {
  scope: 0.20,
  familiarity: 0.30,
  historical_success: 0.25,
  risk: 0.25
};

// Risk tags that reduce confidence
const RISK_TAGS = {
  data_loss: 0.25,       // Could lose user data
  security_sensitive: 0.30, // Auth, crypto, permissions
  user_facing: 0.10,     // Visible to end users
  infra_touching: 0.20,  // CI, deploy, infra config
  auth_related: 0.25,    // Authentication/authorization
  database_migration: 0.30, // Schema changes
  dependency_update: 0.15   // Package version changes
};

// High-risk file patterns (reduce confidence)
const HIGH_RISK_PATTERNS = [
  /\.env/i,
  /auth/i,
  /security/i,
  /migration/i,
  /deploy/i,
  /infrastructure/i,
  /credentials/i,
  /secret/i,
  /password/i,
  /token/i,
  /permission/i
];

// Low-risk file patterns (increase confidence)
const LOW_RISK_PATTERNS = [
  /\.test\./i,
  /\.spec\./i,
  /test\//i,
  /tests\//i,
  /docs?\//i,
  /readme/i,
  /\.md$/i,
  /\.json$/i,
  /\.yaml$/i,
  /\.yml$/i
];

// ============================================================================
// PATH HELPERS
// ============================================================================

function getHistoryDir() {
  return path.join(process.cwd(), HISTORY_DIR);
}

function getScorePath(taskId) {
  const safe = taskId.replace(/\s+/g, '_');
  return path.join(getHistoryDir(), `${safe}.json`);
}

function getOutcomesPath() {
  return path.join(getHistoryDir(), OUTCOMES_FILE);
}

function getScoresLogPath() {
  return path.join(getHistoryDir(), SCORES_LOG_FILE);
}

function ensureHistoryDir() {
  const dir = getHistoryDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// ATOMIC FILE OPS (same pattern as cost-tracker.js)
// ============================================================================

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    // Corrupted — start fresh
  }
  return null;
}

function writeJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function appendJSONL(filePath, entry) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

// ============================================================================
// CONFIDENCE SCORING
// ============================================================================

/**
 * Score a plan and return confidence tier.
 *
 * @param {object} plan - Plan object with steps, files, summary
 * @param {object} task - Task object with id, title, description, labels
 * @param {object} opts - Optional overrides
 * @param {object} opts.thresholds - Custom thresholds
 * @param {object} opts.weights - Custom scoring weights
 * @param {string[]} opts.risk_tags - Explicit risk tags
 * @returns {{
 *   score: number,
 *   tier: 'auto_approve'|'notify_approve'|'require_approve',
 *   factors: object,
 *   risk_tags: string[],
 *   reasoning: string
 * }}
 */
function scorePlan(plan, task, opts = {}) {
  const thresholds = opts.thresholds || loadThresholds();
  const weights = opts.weights || loadWeights();

  // Compute individual factors
  const scopeFactor = computeScopeFactor(plan);
  const familiarityFactor = computeFamiliarityFactor(plan);
  const historicalFactor = computeHistoricalFactor(task);
  const riskResult = computeRiskFactor(plan, task, opts.risk_tags);

  // Weighted sum (support both 'historical_success' and 'history' key names)
  const historyWeight = weights.historical_success || weights.history || DEFAULT_WEIGHTS.historical_success;
  const rawScore = (
    scopeFactor * (weights.scope || DEFAULT_WEIGHTS.scope) +
    familiarityFactor * (weights.familiarity || DEFAULT_WEIGHTS.familiarity) +
    historicalFactor * historyWeight +
    riskResult.factor * (weights.risk || DEFAULT_WEIGHTS.risk)
  );

  // Clamp to [0, 1]
  const score = Math.max(0, Math.min(1, rawScore));

  // Determine tier
  let tier;
  if (score >= thresholds.auto_approve) {
    tier = 'auto_approve';
  } else if (score >= thresholds.notify_approve) {
    tier = 'notify_approve';
  } else {
    tier = 'require_approve';
  }

  const factors = {
    scope: round(scopeFactor),
    familiarity: round(familiarityFactor),
    historical_success: round(historicalFactor),
    risk: round(riskResult.factor)
  };

  const reasoning = buildReasoning(factors, riskResult.tags, tier, score, thresholds);

  return {
    score: round(score),
    tier,
    factors,
    risk_tags: riskResult.tags,
    reasoning
  };
}

/**
 * Score and persist the result. Returns the same as scorePlan plus writes state.
 *
 * @param {object} plan - Plan object
 * @param {object} task - Task object
 * @param {object} opts - Options
 * @returns {object} Score result (same as scorePlan)
 */
function scoreAndRecord(plan, task, opts = {}) {
  const result = scorePlan(plan, task, opts);

  ensureHistoryDir();

  // Write per-task score file
  const scoreState = {
    task_id: task.id,
    scored_at: new Date().toISOString(),
    ...result,
    plan_step_count: (plan.steps || []).length,
    plan_file_count: getAllPlanFiles(plan).length
  };
  writeJSON(getScorePath(task.id), scoreState);

  // Append to scores log
  appendJSONL(getScoresLogPath(), {
    ts: new Date().toISOString(),
    task_id: task.id,
    score: result.score,
    tier: result.tier,
    risk_tags: result.risk_tags
  });

  return result;
}

// ============================================================================
// SCORING FACTORS
// ============================================================================

/**
 * Scope factor: smaller plans = higher confidence.
 * 1-2 steps, 1-3 files → 1.0
 * 3-5 steps, 4-8 files → 0.7
 * 6-10 steps, 9-15 files → 0.4
 * 10+ steps or 15+ files → 0.2
 */
function computeScopeFactor(plan) {
  const steps = (plan.steps || []).length;
  const files = getAllPlanFiles(plan).length;

  let stepScore;
  if (steps <= 2) stepScore = 1.0;
  else if (steps <= 5) stepScore = 0.7;
  else if (steps <= 10) stepScore = 0.4;
  else stepScore = 0.2;

  let fileScore;
  if (files <= 3) fileScore = 1.0;
  else if (files <= 8) fileScore = 0.7;
  else if (files <= 15) fileScore = 0.4;
  else fileScore = 0.2;

  return (stepScore + fileScore) / 2;
}

/**
 * Familiarity factor: has this code area been worked successfully before?
 * Reads outcomes.jsonl for past plans touching the same files.
 */
function computeFamiliarityFactor(plan) {
  const planFiles = getAllPlanFiles(plan);
  if (planFiles.length === 0) return 0.8; // No files → assume moderate familiarity

  const outcomes = readOutcomes();
  if (outcomes.length === 0) return 0.5; // No history → neutral

  // Count how many plan files appear in successful past outcomes
  const successfulFiles = new Set();
  for (const outcome of outcomes) {
    if (outcome.success && outcome.files) {
      for (const f of outcome.files) {
        successfulFiles.add(f);
      }
    }
  }

  if (successfulFiles.size === 0) return 0.5;

  const familiarCount = planFiles.filter(f =>
    [...successfulFiles].some(sf => f.endsWith(sf) || sf.endsWith(f))
  ).length;

  return Math.min(1.0, 0.3 + (familiarCount / planFiles.length) * 0.7);
}

/**
 * Historical success factor: what % of recent plans succeeded?
 * Considers plans with similar labels/scope.
 */
function computeHistoricalFactor(task) {
  const outcomes = readOutcomes();
  if (outcomes.length === 0) return 0.5; // No history → neutral

  // Use last 30 outcomes
  const recent = outcomes.slice(-30);
  const successCount = recent.filter(o => o.success).length;
  const rate = successCount / recent.length;

  // If task labels match past successful outcomes, boost
  const taskLabels = new Set((task.labels || []).map(l => l.toLowerCase()));
  let labelBoost = 0;
  if (taskLabels.size > 0) {
    const matchingSuccess = recent.filter(o =>
      o.success && o.labels && o.labels.some(l => taskLabels.has(l.toLowerCase()))
    ).length;
    labelBoost = matchingSuccess > 2 ? 0.1 : 0;
  }

  return Math.min(1.0, rate + labelBoost);
}

/**
 * Load risk patterns from policy.yaml, merging with defaults.
 */
function loadRiskPatterns() {
  try {
    const { loadPolicy } = require('./policy');
    const policy = loadPolicy();
    const approval = policy.approval || {};
    return approval.risk_patterns || null;
  } catch (e) {
    return null;
  }
}

/**
 * Load override lists from policy.yaml.
 */
function loadOverrides() {
  try {
    const { loadPolicy } = require('./policy');
    const policy = loadPolicy();
    const approval = policy.approval || {};
    return {
      always_require: approval.always_require_approval || [],
      always_auto: approval.always_auto_approve || []
    };
  } catch (e) {
    return { always_require: [], always_auto: [] };
  }
}

/**
 * Risk factor: higher risk → lower score.
 * Examines file patterns, task description, and explicit risk tags.
 */
function computeRiskFactor(plan, task, explicitTags) {
  const tags = new Set(explicitTags || []);
  const planFiles = getAllPlanFiles(plan);
  const text = `${task.title || ''} ${task.description || ''} ${(task.labels || []).join(' ')}`.toLowerCase();

  // Check policy-defined risk patterns (from approval.risk_patterns in policy.yaml)
  const policyPatterns = loadRiskPatterns();
  if (policyPatterns) {
    for (const file of planFiles) {
      for (const [dimension, dimPatterns] of Object.entries(policyPatterns)) {
        for (const p of dimPatterns) {
          if (file.includes(p) || (p.startsWith('*.') && file.endsWith(p.slice(1)))) {
            // Map policy dimension names to risk tags
            if (dimension === 'data_loss') tags.add('data_loss');
            else if (dimension === 'security_sensitive') tags.add('security_sensitive');
            else if (dimension === 'user_facing') tags.add('user_facing');
            else if (dimension === 'infra_touching') tags.add('infra_touching');
          }
        }
      }
    }
  }

  // Check file patterns for risk signals (built-in patterns)
  for (const file of planFiles) {
    for (const pattern of HIGH_RISK_PATTERNS) {
      if (pattern.test(file)) {
        // Infer risk tag from pattern
        if (/auth|permission|password/i.test(pattern.source)) tags.add('auth_related');
        else if (/security|secret|credential|token/i.test(pattern.source)) tags.add('security_sensitive');
        else if (/migration/i.test(pattern.source)) tags.add('database_migration');
        else if (/deploy|infrastructure/i.test(pattern.source)) tags.add('infra_touching');
        else if (/\.env/i.test(pattern.source)) tags.add('security_sensitive');
      }
    }
  }

  // Check task text for risk signals
  if (/\b(delete|drop|remove|destroy|wipe)\b/i.test(text)) tags.add('data_loss');
  if (/\b(auth|login|session|jwt|oauth|rbac|permission)\b/i.test(text)) tags.add('auth_related');
  if (/\b(encrypt|decrypt|hash|secret|credential|api.?key)\b/i.test(text)) tags.add('security_sensitive');
  if (/\b(deploy|infra|ci|cd|pipeline|terraform|docker)\b/i.test(text)) tags.add('infra_touching');
  if (/\b(ui|page|screen|component|button|form|user.?facing)\b/i.test(text)) tags.add('user_facing');
  if (/\b(migration|schema|alter.?table)\b/i.test(text)) tags.add('database_migration');
  if (/\b(upgrade|downgrade|bump|dependency|package)\b/i.test(text)) tags.add('dependency_update');

  // Compute risk penalty from tags
  let riskPenalty = 0;
  const tagArray = [...tags];
  for (const tag of tagArray) {
    riskPenalty += RISK_TAGS[tag] || 0.10;
  }
  // Cap penalty at 0.8 (always leave some score possible)
  riskPenalty = Math.min(0.8, riskPenalty);

  // Check if files are mostly low-risk
  let lowRiskBonus = 0;
  if (planFiles.length > 0) {
    const lowRiskCount = planFiles.filter(f =>
      LOW_RISK_PATTERNS.some(p => p.test(f))
    ).length;
    if (lowRiskCount === planFiles.length) lowRiskBonus = 0.2;
    else if (lowRiskCount > planFiles.length / 2) lowRiskBonus = 0.1;
  }

  // Risk factor: 1.0 = no risk, 0.0 = maximum risk
  return {
    factor: Math.max(0, Math.min(1.0, 1.0 - riskPenalty + lowRiskBonus)),
    tags: tagArray
  };
}

// ============================================================================
// HISTORICAL OUTCOMES
// ============================================================================

/**
 * Record the outcome of a plan execution for future learning.
 *
 * @param {string} taskId - Task ID
 * @param {boolean} success - Did the plan succeed?
 * @param {object} details - Additional outcome details
 */
function recordOutcome(taskId, success, details = {}) {
  ensureHistoryDir();

  const scoreState = readJSON(getScorePath(taskId));

  const outcome = {
    ts: new Date().toISOString(),
    task_id: taskId,
    success,
    score: scoreState?.score || null,
    tier: scoreState?.tier || null,
    files: details.files || scoreState?.plan_files || [],
    labels: details.labels || [],
    steps_completed: details.steps_completed || null,
    total_steps: details.total_steps || null,
    rework_count: details.rework_count || 0,
    failure_reason: details.failure_reason || null
  };

  appendJSONL(getOutcomesPath(), outcome);
  return outcome;
}

/**
 * Read all historical outcomes.
 * @returns {Array<object>}
 */
function readOutcomes() {
  const outcomesPath = getOutcomesPath();
  if (!fs.existsSync(outcomesPath)) return [];

  try {
    const lines = fs.readFileSync(outcomesPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);

    return lines.map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

/**
 * Get accuracy metrics for the confidence scorer.
 * Compares predicted tiers vs actual outcomes.
 *
 * @returns {{ total: number, correct_auto: number, false_auto: number, correct_require: number, accuracy: number }}
 */
function getAccuracyMetrics() {
  const outcomes = readOutcomes();
  if (outcomes.length === 0) {
    return { total: 0, correct_auto: 0, false_auto: 0, correct_require: 0, accuracy: 0 };
  }

  let correctAuto = 0;  // auto_approved and succeeded
  let falseAuto = 0;    // auto_approved but failed
  let correctRequire = 0; // require_approved and would have failed

  for (const o of outcomes) {
    if (!o.tier) continue;

    if (o.tier === 'auto_approve') {
      if (o.success) correctAuto++;
      else falseAuto++;
    } else if (o.tier === 'require_approve') {
      if (!o.success) correctRequire++;
    }
  }

  const scoredOutcomes = outcomes.filter(o => o.tier);
  const total = scoredOutcomes.length;
  const correctCount = correctAuto + correctRequire +
    scoredOutcomes.filter(o => o.tier === 'notify_approve' && o.success).length;

  return {
    total,
    correct_auto: correctAuto,
    false_auto: falseAuto,
    correct_require: correctRequire,
    accuracy: total > 0 ? round(correctCount / total) : 0
  };
}

/**
 * Suggest threshold adjustments based on historical accuracy.
 * If false auto-approvals are > 10%, suggest raising auto_approve threshold.
 * If correct auto-approvals are > 95%, suggest lowering auto_approve threshold.
 *
 * @returns {{ adjust_auto_approve?: number, adjust_notify_approve?: number, reason: string } | null}
 */
function suggestThresholdAdjustment() {
  const metrics = getAccuracyMetrics();
  if (metrics.total < 10) return null; // Not enough data

  const autoTotal = metrics.correct_auto + metrics.false_auto;
  if (autoTotal === 0) return null;

  const falseRate = metrics.false_auto / autoTotal;

  if (falseRate > 0.10) {
    // Too many false auto-approvals — raise threshold
    return {
      adjust_auto_approve: 0.02, // Raise by 2%
      reason: `False auto-approve rate ${round(falseRate * 100)}% > 10%. Raising auto_approve threshold.`
    };
  }

  if (falseRate < 0.02 && autoTotal >= 10) {
    // Almost no false auto-approvals — could lower threshold slightly
    return {
      adjust_auto_approve: -0.01, // Lower by 1%
      reason: `False auto-approve rate ${round(falseRate * 100)}% < 2%. Can lower auto_approve threshold.`
    };
  }

  return null;
}

// ============================================================================
// PLAN HELPERS
// ============================================================================

/**
 * Extract all file paths from a plan object.
 */
function getAllPlanFiles(plan) {
  const files = new Set();

  if (plan.files && Array.isArray(plan.files)) {
    plan.files.forEach(f => files.add(f));
  }

  if (plan.steps && Array.isArray(plan.steps)) {
    for (const step of plan.steps) {
      if (step.files && Array.isArray(step.files)) {
        step.files.forEach(f => files.add(f));
      }
    }
  }

  return [...files];
}

// ============================================================================
// POLICY LOADING
// ============================================================================

/**
 * Load confidence thresholds from policy.yaml.
 */
function loadThresholds() {
  try {
    const { loadPolicy } = require('./policy');
    const policy = loadPolicy();
    const approval = policy.approval || {};
    const thresholds = approval.confidence_thresholds || {};

    return {
      auto_approve: thresholds.auto || DEFAULT_THRESHOLDS.auto_approve,
      notify_approve: thresholds.notify || DEFAULT_THRESHOLDS.notify_approve
    };
  } catch (e) {
    return { ...DEFAULT_THRESHOLDS };
  }
}

/**
 * Load scoring weights from policy.yaml.
 */
function loadWeights() {
  try {
    const { loadPolicy } = require('./policy');
    const policy = loadPolicy();
    const approval = policy.approval || {};
    return approval.confidence_weights || { ...DEFAULT_WEIGHTS };
  } catch (e) {
    return { ...DEFAULT_WEIGHTS };
  }
}

/**
 * Load the score for a previously scored task.
 *
 * @param {string} taskId
 * @returns {object|null}
 */
function loadScore(taskId) {
  return readJSON(getScorePath(taskId));
}

// ============================================================================
// REASONING
// ============================================================================

function buildReasoning(factors, riskTags, tier, score, thresholds) {
  const parts = [];

  if (factors.scope >= 0.7) parts.push('small scope');
  else if (factors.scope >= 0.4) parts.push('medium scope');
  else parts.push('large scope');

  if (factors.familiarity >= 0.7) parts.push('familiar code area');
  else if (factors.familiarity >= 0.4) parts.push('partially familiar area');
  else parts.push('unfamiliar code area');

  if (factors.historical_success >= 0.7) parts.push('strong history');
  else if (factors.historical_success >= 0.4) parts.push('mixed history');
  else parts.push('weak/no history');

  if (riskTags.length === 0) parts.push('no risk signals');
  else parts.push(`risk: ${riskTags.join(', ')}`);

  const tierLabel = tier === 'auto_approve' ? 'auto-approve'
    : tier === 'notify_approve' ? 'notify-approve'
    : 'require human approval';

  return `Score ${score.toFixed(2)} → ${tierLabel}. ${parts.join('; ')}.`;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Core scoring
  scorePlan,
  scoreAndRecord,

  // Individual factors (for testing)
  computeScopeFactor,
  computeFamiliarityFactor,
  computeHistoricalFactor,
  computeRiskFactor,

  // Historical outcomes
  recordOutcome,
  readOutcomes,
  getAccuracyMetrics,
  suggestThresholdAdjustment,

  // Plan helpers
  getAllPlanFiles,

  // Policy loading
  loadThresholds,
  loadWeights,
  loadScore,
  loadRiskPatterns,
  loadOverrides,

  // Constants (for testing)
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  RISK_TAGS,
  HIGH_RISK_PATTERNS,
  LOW_RISK_PATTERNS,
  HISTORY_DIR
};
