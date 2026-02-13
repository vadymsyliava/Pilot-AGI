/**
 * Quality Metrics to Soul Feedback — Phase 8.13 (Pilot AGI-mf4h)
 *
 * Quality scores feed back into agent self-assessment.
 * Agents that produce cleaner code get higher skill scores.
 * Soul preferences auto-update based on quality outcomes.
 */

const fs = require('fs');
const path = require('path');

// =============================================================================
// QUALITY → SOUL SKILL MAPPING
// =============================================================================

/**
 * Map quality sweep scores to soul skill adjustments.
 *
 * @param {object} sweepScores - { duplicates, dead_code, naming, patterns, overall }
 * @param {string} agentRole - Agent role (e.g. "developer")
 * @returns {Array<{ skill, adjustment, reason }>}
 */
function mapScoresToSkills(sweepScores) {
  if (!sweepScores) return [];

  const adjustments = [];

  // Duplicate score → code_reuse skill
  if (sweepScores.duplicates !== undefined) {
    const adj = scoreToAdjustment(sweepScores.duplicates);
    if (adj !== 0) {
      adjustments.push({
        skill: 'code_reuse',
        adjustment: adj,
        reason: `Code duplication score: ${sweepScores.duplicates}`
      });
    }
  }

  // Dead code score → code_cleanliness skill
  if (sweepScores.dead_code !== undefined) {
    const adj = scoreToAdjustment(sweepScores.dead_code);
    if (adj !== 0) {
      adjustments.push({
        skill: 'code_cleanliness',
        adjustment: adj,
        reason: `Dead code score: ${sweepScores.dead_code}`
      });
    }
  }

  // Naming score → naming_consistency skill
  if (sweepScores.naming !== undefined) {
    const adj = scoreToAdjustment(sweepScores.naming);
    if (adj !== 0) {
      adjustments.push({
        skill: 'naming_consistency',
        adjustment: adj,
        reason: `Naming consistency score: ${sweepScores.naming}`
      });
    }
  }

  // Pattern score → pattern_adherence skill
  if (sweepScores.patterns !== undefined) {
    const adj = scoreToAdjustment(sweepScores.patterns);
    if (adj !== 0) {
      adjustments.push({
        skill: 'pattern_adherence',
        adjustment: adj,
        reason: `Pattern compliance score: ${sweepScores.patterns}`
      });
    }
  }

  return adjustments;
}

/**
 * Convert a 0-1 score to a skill adjustment (-0.2 to +0.2).
 */
function scoreToAdjustment(score) {
  if (score >= 0.95) return 0.1;
  if (score >= 0.85) return 0.05;
  if (score >= 0.70) return 0;
  if (score >= 0.50) return -0.05;
  return -0.1;
}

// =============================================================================
// SOUL UPDATE
// =============================================================================

/**
 * Apply quality-based skill adjustments to the agent soul.
 *
 * @param {string} role - Agent role
 * @param {object} sweepScores - Quality scores
 * @param {object} opts - { projectRoot? }
 * @returns {{ success, adjustments, soul_updated }}
 */
function applyToSoul(role, sweepScores, opts) {
  opts = opts || {};

  const adjustments = mapScoresToSkills(sweepScores);
  if (adjustments.length === 0) return { success: true, adjustments: [], soul_updated: false };

  let souls;
  let soul;
  try {
    souls = require('./souls');
    soul = souls.loadSoul(role);
  } catch (e) {
    return { success: false, error: 'soul module not available', adjustments };
  }

  if (!soul) {
    return { success: false, error: 'no soul found for role', adjustments };
  }

  // Apply adjustments to soul meta (custom quality skill keys)
  if (!soul.meta) soul.meta = {};

  for (const adj of adjustments) {
    const current = parseFloat(soul.meta[adj.skill] || '0.5');
    const newValue = Math.max(0, Math.min(1, current + adj.adjustment));
    soul.meta[adj.skill] = String(Math.round(newValue * 100) / 100);
  }

  // Record quality insight as a lesson learned
  if (!soul.lessons_learned) soul.lessons_learned = [];

  const today = new Date().toISOString().split('T')[0];
  const skillSummary = adjustments.map(a => `${a.skill}:${a.adjustment > 0 ? '+' : ''}${a.adjustment}`).join(', ');
  soul.lessons_learned.push({
    date: today,
    task_id: null,
    lesson: `Quality sweep score: ${sweepScores.overall} (${skillSummary})`
  });

  // Keep last 50 lessons
  if (soul.lessons_learned.length > 50) {
    soul.lessons_learned = soul.lessons_learned.slice(-50);
  }

  // Save updated soul
  try {
    souls.writeSoul(role, soul);
  } catch (e) {
    return { success: false, error: 'failed to save soul', adjustments };
  }

  return { success: true, adjustments, soul_updated: true };
}

// =============================================================================
// QUALITY LEARNING
// =============================================================================

/**
 * Record which patterns led to good/bad quality outcomes.
 * This feeds into canonical-patterns for pattern evolution.
 *
 * @param {object} sweepResult - Full sweep result
 * @param {object} opts - { role?, taskId? }
 * @returns {{ patterns_observed }}
 */
function learnFromSweep(sweepResult, opts) {
  opts = opts || {};
  let patternsObserved = 0;

  if (!sweepResult || !sweepResult.scores) return { patterns_observed: 0 };

  let canonicalPatterns;
  try {
    canonicalPatterns = require('./canonical-patterns');
  } catch (e) {
    return { patterns_observed: 0 };
  }

  // If quality is high, reinforce current patterns
  if (sweepResult.scores.overall >= 0.9) {
    const canonical = canonicalPatterns.listCanonical();
    for (const pattern of canonical) {
      canonicalPatterns.recordUsage(pattern.id);
      patternsObserved++;
    }
  }

  // If specific issues found, try to observe anti-patterns
  if (sweepResult.issues) {
    for (const issue of sweepResult.issues) {
      if (issue.type === 'duplicate_function') {
        canonicalPatterns.observe({
          purpose: 'avoid function duplication',
          category: 'imports',
          name: 'single source of truth for functions',
          rule: 'Each function should exist in exactly one file. Import instead of re-implementing.'
        });
        patternsObserved++;
      }

      if (issue.type === 'naming_inconsistency') {
        canonicalPatterns.observe({
          purpose: 'cross-layer naming consistency',
          category: 'naming',
          name: 'consistent concept naming',
          rule: 'Use the same base term across DB, API, component, and page layers.'
        });
        patternsObserved++;
      }
    }
  }

  return { patterns_observed: patternsObserved };
}

// =============================================================================
// CONTEXT BUILDER
// =============================================================================

/**
 * Build quality context for agent session start.
 * Shows quality trends and areas needing attention.
 */
function buildContext() {
  let qualitySweep;
  try {
    qualitySweep = require('./quality-sweep');
  } catch (e) {
    return null;
  }

  const history = qualitySweep.loadScoreHistory();
  if (history.length === 0) return null;

  const latest = history[history.length - 1];
  const trend = qualitySweep.checkTrend(5);

  const context = {
    latest_score: latest.scores.overall,
    latest_issues: latest.issue_count,
    trending_down: trend.trending_down
  };

  // Highlight weak areas
  const weakAreas = [];
  for (const [key, value] of Object.entries(latest.scores)) {
    if (key !== 'overall' && value < 0.85) {
      weakAreas.push({ area: key, score: value });
    }
  }
  if (weakAreas.length > 0) {
    context.attention_areas = weakAreas;
  }

  return context;
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Score mapping
  mapScoresToSkills,
  scoreToAdjustment,

  // Soul integration
  applyToSoul,

  // Learning
  learnFromSweep,

  // Context
  buildContext
};
