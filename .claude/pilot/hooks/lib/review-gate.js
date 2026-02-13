/**
 * Auto Peer Review Gate — Phase 8.3 (Pilot AGI-s6n3)
 *
 * Blocks merge unless peer review is completed. Auto-selects reviewer,
 * auto-executes lightweight review for small diffs.
 *
 * Integration:
 * - PM loop review_merge handler calls checkReviewGate() before approving
 * - Policy config: enforcement.require_peer_review (boolean)
 * - Auto-lightweight for diffs under threshold (default 50 lines)
 *
 * State: .claude/pilot/state/review-gates/<taskId>.json
 */

const fs = require('fs');
const path = require('path');

const REVIEW_GATES_DIR = '.claude/pilot/state/review-gates';

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getGatePath(taskId) {
  return path.join(process.cwd(), REVIEW_GATES_DIR, `${taskId}.json`);
}

// =============================================================================
// REVIEW GATE CHECK
// =============================================================================

/**
 * Check if a task has passed the peer review gate.
 *
 * @param {string} taskId - Task to check
 * @param {object} opts - { projectRoot?, policy? }
 * @returns {{ passed, reason, review_id? }}
 */
function checkReviewGate(taskId, opts) {
  if (!taskId) return { passed: false, reason: 'no task ID' };
  opts = opts || {};

  // Check if peer review is required by policy
  const policy = opts.policy || loadPolicyQuiet();
  if (!policy?.enforcement?.require_peer_review) {
    return { passed: true, reason: 'peer review not required by policy' };
  }

  // Check for existing gate state
  const gatePath = getGatePath(taskId);
  if (fs.existsSync(gatePath)) {
    try {
      const gate = JSON.parse(fs.readFileSync(gatePath, 'utf8'));
      if (gate.status === 'approved') {
        return { passed: true, reason: 'peer review approved', review_id: gate.review_id };
      }
      if (gate.status === 'rejected') {
        return { passed: false, reason: `peer review rejected: ${gate.rejection_reason || 'no reason'}` };
      }
    } catch (e) {
      // Corrupted gate file — treat as not reviewed
    }
  }

  return { passed: false, reason: 'peer review not completed' };
}

// =============================================================================
// AUTO-REVIEW (execute review automatically)
// =============================================================================

/**
 * Auto-execute peer review for a task.
 * - Selects reviewer based on soul expertise
 * - For small diffs: auto-lightweight review
 * - For large diffs: full review with checklist
 *
 * @param {string} taskId - Task to review
 * @param {string} authorRole - Author's agent role
 * @param {string} diff - Git diff content
 * @param {object} opts - { projectRoot?, policy? }
 * @returns {{ reviewed, approved, feedback?, reviewer? }}
 */
function autoReview(taskId, authorRole, diff, opts) {
  if (!taskId || !diff) return { reviewed: false, error: 'taskId and diff required' };
  opts = opts || {};

  try {
    const peerReview = require('./peer-review');

    // requestReview auto-selects reviewer and executes review in one call
    const result = peerReview.requestReview(taskId, authorRole, diff, {
      projectRoot: opts.projectRoot
    });

    if (result.error) {
      return { reviewed: false, error: result.error };
    }

    // Determine approval: skipped counts as approved, otherwise check result
    const approved = result.skipped === true ||
                     (result.approved !== false && !result.blocking_issues);

    // Record gate state
    const gateState = {
      task_id: taskId,
      reviewer: result.reviewer || null,
      author: authorRole,
      status: approved ? 'approved' : 'rejected',
      rejection_reason: approved ? null : (result.summary || 'blocking issues found'),
      reviewed_at: new Date().toISOString(),
      lightweight: peerReview.isLightweight(diff),
      diff_lines: peerReview.countDiffLines(diff)
    };

    ensureDir(path.join(process.cwd(), REVIEW_GATES_DIR));
    const tmpPath = getGatePath(taskId) + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(gateState, null, 2), 'utf8');
    fs.renameSync(tmpPath, getGatePath(taskId));

    // Learn from review (update souls)
    try {
      peerReview.learnFromReview(taskId, { projectRoot: opts.projectRoot });
    } catch (e) {
      // Learning is optional
    }

    return {
      reviewed: true,
      approved,
      reviewer: gateState.reviewer,
      lightweight: gateState.lightweight,
      feedback: result.summary || null
    };
  } catch (e) {
    return { reviewed: false, error: e.message };
  }
}

// =============================================================================
// GATE MANAGEMENT
// =============================================================================

/**
 * Get review gate status for a task.
 */
function getGateStatus(taskId) {
  if (!taskId) return null;
  const gatePath = getGatePath(taskId);
  if (!fs.existsSync(gatePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(gatePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Clear review gate (e.g., after task reopened).
 */
function clearGate(taskId) {
  if (!taskId) return false;
  const gatePath = getGatePath(taskId);
  try {
    if (fs.existsSync(gatePath)) fs.unlinkSync(gatePath);
    return true;
  } catch (e) {
    return false;
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function loadPolicyQuiet() {
  try {
    const { loadPolicy } = require('./policy');
    return loadPolicy();
  } catch (e) {
    return null;
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  checkReviewGate,
  autoReview,
  getGateStatus,
  clearGate,
  REVIEW_GATES_DIR
};
