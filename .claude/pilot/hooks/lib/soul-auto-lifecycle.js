/**
 * Soul Auto-Lifecycle — Phase 8.1 (Pilot AGI-lhdf)
 *
 * Makes M7 soul features fully automatic:
 * - Auto-restore soul from global backup on session start
 * - Auto-backup soul to global directory on task close
 * - Auto-take snapshot before soul mutations
 * - Surface skill gaps in agent context
 *
 * Integration points:
 * - session-start.js: call onSessionStart(role)
 * - post-tool-use.js / pilot-close: call onTaskClose(role, taskId)
 * - souls.js mutations: call beforeMutation(role) for snapshot
 */

const fs = require('fs');
const path = require('path');

// =============================================================================
// SESSION START — auto-restore + skill gaps
// =============================================================================

/**
 * Called on session start for an agent role.
 * - If no local soul exists but a global backup does, restore it
 * - Load skill gaps from self-assessment for context injection
 *
 * @param {string} role - Agent role
 * @param {object} opts - { projectRoot? }
 * @returns {{ restored, skill_gaps[], soul_size }}
 */
function onSessionStart(role, opts) {
  if (!role) return { restored: false, skill_gaps: [] };
  opts = opts || {};
  const projectRoot = opts.projectRoot || process.cwd();

  const result = { restored: false, skill_gaps: [], soul_size: 0 };

  try {
    const souls = require('./souls');
    const soulPersistence = require('./soul-persistence');

    // Auto-restore: if no local soul exists but global backup does
    if (!souls.soulExists(role)) {
      if (soulPersistence.hasGlobalBackup(role)) {
        const restoreResult = soulPersistence.restoreSoul(role, { overwrite: true });
        result.restored = restoreResult.success;
      } else {
        // No global backup — initialize fresh soul
        souls.initializeSoul(role);
      }
    }

    // Get soul size for context
    result.soul_size = souls.getSoulSize(role);

    // Load skill gaps from self-assessment
    try {
      const assessment = require('./self-assessment');
      const gaps = assessment.detectSkillGaps(role);
      if (gaps && gaps.gaps) {
        result.skill_gaps = gaps.gaps.slice(0, 5); // top 5 gaps
      }
    } catch (e) {
      // Self-assessment not available
    }

    // Load active growth goals
    try {
      const assessment = require('./self-assessment');
      const metrics = assessment.getMetrics(role);
      if (metrics && metrics.growth_goals) {
        result.growth_goals = metrics.growth_goals.filter(g => g.status === 'active');
      }
    } catch (e) {
      // Ignore
    }
  } catch (e) {
    // Fail gracefully — soul features are optional
  }

  return result;
}

// =============================================================================
// TASK CLOSE — auto-backup + snapshot
// =============================================================================

/**
 * Called when a task is closed.
 * - Take snapshot of current soul state
 * - Backup soul to global directory
 * - Record task completion in self-assessment
 *
 * @param {string} role - Agent role
 * @param {string} taskId - Completed task ID
 * @param {object} opts - { outcome?, area?, projectRoot? }
 * @returns {{ backed_up, snapshot_taken, assessment_recorded }}
 */
function onTaskClose(role, taskId, opts) {
  if (!role) return { backed_up: false, snapshot_taken: false, assessment_recorded: false };
  opts = opts || {};

  const result = { backed_up: false, snapshot_taken: false, assessment_recorded: false };

  try {
    const soulPersistence = require('./soul-persistence');

    // Take snapshot before backup
    const snapResult = soulPersistence.takeSnapshot(role);
    result.snapshot_taken = snapResult.success === true;

    // Backup to global directory
    const backupResult = soulPersistence.backupSoul(role);
    result.backed_up = backupResult.success === true;
  } catch (e) {
    // Soul persistence not available
  }

  // Record task completion in self-assessment
  try {
    const assessment = require('./self-assessment');
    const outcome = opts.outcome || 'success';
    const area = opts.area || inferAreaFromTask(taskId);

    assessment.recordTaskCompletion(role, taskId, area, outcome);
    result.assessment_recorded = true;

    // Auto-sync skills to soul after recording
    try {
      assessment.syncSkillsToSoul(role);
    } catch (e) {
      // Sync failed — non-critical
    }
  } catch (e) {
    // Self-assessment not available
  }

  return result;
}

// =============================================================================
// BEFORE MUTATION — auto-snapshot
// =============================================================================

/**
 * Called before any soul mutation to preserve state for diff tracking.
 *
 * @param {string} role - Agent role
 * @returns {{ snapshot_taken }}
 */
function beforeMutation(role) {
  if (!role) return { snapshot_taken: false };

  try {
    const soulPersistence = require('./soul-persistence');
    const result = soulPersistence.takeSnapshot(role);
    return { snapshot_taken: result.success === true };
  } catch (e) {
    return { snapshot_taken: false };
  }
}

// =============================================================================
// CONTEXT BUILDER — for session-start injection
// =============================================================================

/**
 * Build soul lifecycle context for injection into session start.
 *
 * @param {string} role - Agent role
 * @returns {object} Context object with soul lifecycle state
 */
function buildContext(role) {
  if (!role) return null;

  const context = {};

  // Skill gaps
  try {
    const assessment = require('./self-assessment');
    const gaps = assessment.detectSkillGaps(role);
    if (gaps && gaps.gaps && gaps.gaps.length > 0) {
      context.skill_gaps = gaps.gaps.slice(0, 5).map(g => ({
        area: g.area,
        score: g.score,
        suggestion: g.suggestion
      }));
    }
  } catch (e) {}

  // Growth goals
  try {
    const assessment = require('./self-assessment');
    const metrics = assessment.getMetrics(role);
    if (metrics && metrics.growth_goals) {
      const active = metrics.growth_goals.filter(g => g.status === 'active');
      if (active.length > 0) {
        context.growth_goals = active.map(g => ({
          area: g.area,
          target: g.target,
          progress: g.progress
        }));
      }
    }
  } catch (e) {}

  // Soul diff since last snapshot
  try {
    const soulPersistence = require('./soul-persistence');
    const diff = soulPersistence.diffSoul(role);
    if (diff.success && diff.changes && diff.changes.length > 0) {
      context.recent_soul_changes = diff.changes.length;
    }
  } catch (e) {}

  // Review stats
  try {
    const peerReview = require('./peer-review');
    const stats = peerReview.getReviewStats(role);
    if (stats) {
      context.review_stats = {
        as_author: stats.as_author,
        as_reviewer: stats.as_reviewer
      };
    }
  } catch (e) {}

  return Object.keys(context).length > 0 ? context : null;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Infer task area from task ID or title for self-assessment.
 */
function inferAreaFromTask(taskId) {
  if (!taskId) return 'general';
  const id = taskId.toLowerCase();
  if (id.includes('test')) return 'testing';
  if (id.includes('api') || id.includes('endpoint')) return 'api_design';
  if (id.includes('ui') || id.includes('component') || id.includes('style')) return 'styling';
  if (id.includes('db') || id.includes('schema') || id.includes('migration')) return 'database';
  if (id.includes('deploy') || id.includes('ci') || id.includes('docker')) return 'devops';
  if (id.includes('auth') || id.includes('security')) return 'security';
  if (id.includes('perf') || id.includes('optim')) return 'performance';
  return 'general';
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  onSessionStart,
  onTaskClose,
  beforeMutation,
  buildContext,
  inferAreaFromTask
};
