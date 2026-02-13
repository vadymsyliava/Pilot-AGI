/**
 * Drift Guardrails Engine (Phase 5.6)
 *
 * Course-correction injection system. When drift predictor detects
 * potential deviation from the plan, this engine determines the
 * appropriate guardrail action:
 *
 *   - allow:    No intervention, action proceeds normally
 *   - warn:     Log warning, allow execution (medium risk)
 *   - redirect: Suggest correct action, block execution (high risk)
 *   - refresh:  Force context refresh with plan step details
 *
 * Integrates with:
 *   - drift-predictor.js — provides similarity scores
 *   - pre-tool-use.js — blocks/allows tool execution
 *   - pm-loop.js — aggregate monitoring
 *
 * Zero external dependencies.
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_REFRESHES_PER_STEP = 3;
const GUARDRAIL_STATS_PATH = '.claude/pilot/state/drift-predictions/guardrail-stats.json';

// ============================================================================
// GUARDRAIL EVALUATION
// ============================================================================

/**
 * Evaluate the appropriate guardrail for a drift prediction.
 *
 * @param {object} prediction - Result from predictDrift
 *   { score, level, reasons, suggestion, breakdown }
 * @param {object} context - Execution context
 *   { sessionId, planStep, planStepIndex, toolName, toolInput, policy }
 * @returns {{
 *   action: 'allow'|'warn'|'redirect'|'refresh',
 *   message: string|null,
 *   correctedAction: object|null,
 *   refreshPrompt: string|null
 * }}
 */
function evaluateGuardrail(prediction, context = {}) {
  const policy = context.policy || loadGuardrailPolicy();

  // Aligned — no intervention
  if (prediction.level === 'aligned') {
    return { action: 'allow', message: null, correctedAction: null, refreshPrompt: null };
  }

  // Monitor level — warn if policy allows
  if (prediction.level === 'monitor') {
    if (policy.warn_on_monitor) {
      const message = `Drift warning (score: ${prediction.score}): ${prediction.reasons.join('; ')}`;
      incrementStats('warned');
      return {
        action: 'warn',
        message,
        correctedAction: null,
        refreshPrompt: null
      };
    }
    // Monitor but no warning configured — allow
    incrementStats('allowed');
    return { action: 'allow', message: null, correctedAction: null, refreshPrompt: null };
  }

  // Divergent level — redirect or refresh
  if (prediction.level === 'divergent') {
    // Check refresh count to avoid infinite loops
    const driftPredictor = require('./drift-predictor');
    const sessionId = context.sessionId;
    const stepIndex = context.planStepIndex ?? 0;

    if (sessionId) {
      const refreshCount = driftPredictor.getRefreshCount(sessionId, stepIndex);

      // If we've refreshed too many times, escalate to redirect
      if (refreshCount >= MAX_REFRESHES_PER_STEP) {
        if (policy.block_on_divergent) {
          const message = buildRedirectMessage(prediction, context);
          incrementStats('redirected');
          if (sessionId) driftPredictor.incrementRedirectCount(sessionId);
          return {
            action: 'redirect',
            message,
            correctedAction: null,
            refreshPrompt: null
          };
        }
      }

      // Auto-refresh: inject plan context
      if (policy.auto_refresh) {
        const refreshPrompt = buildRefreshPrompt(context);
        driftPredictor.incrementRefreshCount(sessionId, stepIndex);
        incrementStats('refreshed');
        return {
          action: 'refresh',
          message: `Context refresh triggered (score: ${prediction.score}). Refreshing plan step context.`,
          correctedAction: null,
          refreshPrompt
        };
      }
    }

    // Redirect — block the action
    if (policy.block_on_divergent) {
      const message = buildRedirectMessage(prediction, context);
      incrementStats('redirected');
      if (sessionId) driftPredictor.incrementRedirectCount(sessionId);
      return {
        action: 'redirect',
        message,
        correctedAction: null,
        refreshPrompt: null
      };
    }

    // Divergent but no blocking configured — warn
    const message = `Drift detected (score: ${prediction.score}): ${prediction.reasons.join('; ')}`;
    incrementStats('warned');
    return {
      action: 'warn',
      message,
      correctedAction: null,
      refreshPrompt: null
    };
  }

  // Default — allow
  incrementStats('allowed');
  return { action: 'allow', message: null, correctedAction: null, refreshPrompt: null };
}

// ============================================================================
// MESSAGE BUILDERS
// ============================================================================

/**
 * Build a redirect message explaining the drift and expected action.
 */
function buildRedirectMessage(prediction, context) {
  const planStep = context.planStep;
  const parts = [];

  parts.push(`Action blocked: drift detected (score: ${prediction.score}).`);

  if (prediction.reasons.length > 0) {
    parts.push(`Reasons: ${prediction.reasons.join('; ')}.`);
  }

  if (planStep) {
    const desc = planStep.description || planStep.title || '';
    parts.push(`Current plan step: "${desc.substring(0, 150)}".`);

    if (planStep.files && planStep.files.length > 0) {
      parts.push(`Expected files: ${planStep.files.join(', ')}.`);
    }
  }

  parts.push('Please review the plan step and adjust your action to match.');

  return parts.join('\n');
}

/**
 * Build a context refresh prompt for the agent.
 */
function buildRefreshPrompt(context) {
  const planStep = context.planStep;
  const stepIndex = context.planStepIndex ?? '?';

  if (!planStep) {
    return 'Unable to determine current plan step. Please review the approved plan.';
  }

  const desc = planStep.description || planStep.title || 'No description';
  const files = planStep.files || [];

  const parts = [
    `You are on step ${stepIndex} of the plan: "${desc}".`,
    `Your last action appears to diverge from this step.`
  ];

  if (files.length > 0) {
    parts.push(`This step targets files: ${files.join(', ')}.`);
  }

  parts.push('Please review the plan step and proceed accordingly.');

  return parts.join(' ');
}

// ============================================================================
// GUARDRAIL STATS
// ============================================================================

/**
 * Get guardrail statistics.
 *
 * @returns {{ total: number, warned: number, redirected: number, refreshed: number, allowed: number }}
 */
function getGuardrailStats() {
  const statsPath = path.join(process.cwd(), GUARDRAIL_STATS_PATH);
  try {
    if (fs.existsSync(statsPath)) {
      return JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    }
  } catch (e) { /* corrupted */ }

  return { total: 0, warned: 0, redirected: 0, refreshed: 0, allowed: 0 };
}

/**
 * Increment a guardrail stat counter.
 */
function incrementStats(action) {
  const statsPath = path.join(process.cwd(), GUARDRAIL_STATS_PATH);
  let stats = getGuardrailStats();

  stats.total = (stats.total || 0) + 1;
  stats[action] = (stats[action] || 0) + 1;

  try {
    const dir = path.dirname(statsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = statsPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
    fs.renameSync(tmp, statsPath);
  } catch (e) { /* best effort */ }
}

/**
 * Reset guardrail statistics (for testing).
 */
function resetStats() {
  const statsPath = path.join(process.cwd(), GUARDRAIL_STATS_PATH);
  try {
    if (fs.existsSync(statsPath)) {
      fs.unlinkSync(statsPath);
    }
  } catch (e) { /* best effort */ }
}

// ============================================================================
// POLICY LOADING
// ============================================================================

/**
 * Load guardrail policy from drift prevention config.
 */
function loadGuardrailPolicy() {
  try {
    const driftPredictor = require('./drift-predictor');
    const policy = driftPredictor.loadDriftPolicy();
    return policy.guardrails || {
      warn_on_monitor: true,
      block_on_divergent: true,
      auto_refresh: true
    };
  } catch (e) {
    return {
      warn_on_monitor: true,
      block_on_divergent: true,
      auto_refresh: true
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Core
  evaluateGuardrail,

  // Message builders (exported for testing)
  buildRedirectMessage,
  buildRefreshPrompt,

  // Stats
  getGuardrailStats,
  resetStats,

  // Policy
  loadGuardrailPolicy,

  // Constants
  MAX_REFRESHES_PER_STEP,
  GUARDRAIL_STATS_PATH
};
