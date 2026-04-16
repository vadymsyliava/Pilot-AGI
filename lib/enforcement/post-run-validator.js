/**
 * Post-Run Validator — Phase 6.7 (Pilot AGI-mkn)
 *
 * Validates agent output after an agent process completes.
 * Runs as the final gate before the PM daemon marks a task step as done.
 *
 * Validates:
 *   1. All changed files are within the agent's assigned area lock
 *   2. No protected files were modified (never_edit policy)
 *   3. Changes are within the scope of the approved plan
 *   4. Cost/token usage is within budget
 *   5. No uncommitted changes left behind (clean worktree)
 *
 * Returns a structured validation report consumed by pm-daemon and escalation engine.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// =============================================================================
// HELPERS
// =============================================================================

let loadPolicy, matchesPattern;
try {
  const policyMod = require(path.join(__dirname, '..', '..', '.claude', 'pilot', 'hooks', 'lib', 'policy'));
  loadPolicy = policyMod.loadPolicy;
  matchesPattern = policyMod.matchesPattern;
} catch (e) {
  loadPolicy = null;
  matchesPattern = (fp, patterns) => {
    if (!patterns || !Array.isArray(patterns)) return false;
    for (const p of patterns) {
      const re = p.replace(/\./g, '\\.').replace(/\*\*/g, '\x00').replace(/\*/g, '[^/]*').replace(/\x00/g, '.*');
      if (new RegExp(`^${re}$`).test(fp)) return true;
    }
    return false;
  };
}

let sessionMod;
try {
  sessionMod = require(path.join(__dirname, '..', '..', '.claude', 'pilot', 'hooks', 'lib', 'session'));
} catch (e) {
  sessionMod = null;
}

// =============================================================================
// GIT HELPERS
// =============================================================================

/**
 * Get files changed since a base ref (e.g., since the agent started).
 * Security: uses execFileSync (no shell) with constant args + safe ref.
 *
 * @param {string} cwd - Working directory
 * @param {string} [baseRef='HEAD~1'] - Git ref to diff against
 * @returns {string[]} List of changed file paths
 */
function getChangedFiles(cwd, baseRef) {
  try {
    const args = ['diff', '--name-only', '--diff-filter=ACMR'];
    if (baseRef) args.push(baseRef);
    const output = execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    });
    return output.trim().split('\n').filter(Boolean);
  } catch (e) {
    return [];
  }
}

/**
 * Check if the working tree is clean.
 *
 * @param {string} cwd - Working directory
 * @returns {{ clean: boolean, untracked: string[], modified: string[] }}
 */
function checkWorkingTree(cwd) {
  const result = { clean: true, untracked: [], modified: [] };

  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    });

    for (const line of status.trim().split('\n').filter(Boolean)) {
      const code = line.slice(0, 2);
      const file = line.slice(3);

      if (code.includes('?')) {
        result.untracked.push(file);
      } else {
        result.modified.push(file);
      }
    }

    result.clean = result.untracked.length === 0 && result.modified.length === 0;
  } catch (e) {
    // Git not available — assume clean
  }

  return result;
}

// =============================================================================
// VALIDATION CHECKS
// =============================================================================

/**
 * Validate 1: Area lock enforcement.
 * All changed files must be within the agent's assigned area.
 */
function validateAreaLocks(changedFiles, sessionId, policy) {
  if (policy.enforcement?.area_locking === false) return [];
  if (!sessionId || !sessionMod) return [];

  const violations = [];

  for (const file of changedFiles) {
    const area = sessionMod.getAreaForPath(file);
    if (!area) continue;

    const lock = sessionMod.isAreaLocked(area, sessionId);
    if (lock) {
      violations.push({
        type: 'area_lock',
        file,
        area,
        locked_by: lock.session_id,
        locked_task: lock.task_id
      });
    }
  }

  return violations;
}

/**
 * Validate 2: Protected files.
 */
function validateProtectedFiles(changedFiles, policy) {
  const neverEdit = policy.exceptions?.never_edit || [];
  const violations = [];

  for (const file of changedFiles) {
    if (matchesPattern(file, neverEdit)) {
      violations.push({
        type: 'protected_file',
        file,
        reason: 'File is in never_edit list (security policy)'
      });
    }
  }

  return violations;
}

/**
 * Validate 3: Plan scope.
 * If the plan lists specific files, check that the agent only modified those files.
 * This is a soft check — returns warnings, not hard violations.
 */
function validatePlanScope(changedFiles, taskId, projectRoot) {
  if (!taskId) return [];

  // Try to read the plan files list
  const planFile = path.join(projectRoot, 'work', 'plans', `${taskId}.md`);
  const approvalFile = path.join(projectRoot, '.claude', 'pilot', 'state', 'approved-plans', `${taskId}.json`);

  let planFiles = null;

  // Try approval file first (may contain planned_files)
  try {
    const approval = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
    if (approval.planned_files && Array.isArray(approval.planned_files)) {
      planFiles = approval.planned_files;
    }
  } catch (e) { /* no approval file */ }

  if (!planFiles) return []; // No file list in plan — skip scope check

  const outOfScope = changedFiles.filter(f => !planFiles.some(pf => f.includes(pf) || pf.includes(f)));

  return outOfScope.map(file => ({
    type: 'out_of_scope',
    file,
    reason: 'File not listed in approved plan'
  }));
}

/**
 * Validate 4: Budget check.
 */
function validateBudget(taskId, projectRoot) {
  if (!taskId) return [];

  try {
    const costTracker = require(path.join(projectRoot, '.claude', 'pilot', 'hooks', 'lib', 'cost-tracker'));
    const result = costTracker.checkBudget(taskId);
    if (result && result.exceeded) {
      return [{
        type: 'budget_exceeded',
        task_id: taskId,
        used: result.used,
        limit: result.limit
      }];
    }
  } catch (e) {
    // cost-tracker not available
  }

  return [];
}

/**
 * Validate 5: Clean working tree.
 */
function validateCleanWorktree(cwd) {
  const tree = checkWorkingTree(cwd);

  if (!tree.clean) {
    const warnings = [];
    if (tree.modified.length > 0) {
      warnings.push({
        type: 'uncommitted_changes',
        files: tree.modified,
        reason: 'Agent left uncommitted changes'
      });
    }
    if (tree.untracked.length > 0) {
      warnings.push({
        type: 'untracked_files',
        files: tree.untracked,
        reason: 'Agent created untracked files'
      });
    }
    return warnings;
  }

  return [];
}

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

/**
 * Run post-run validation for a completed agent session.
 *
 * @param {object} opts
 * @param {string} opts.cwd - Agent's working directory
 * @param {string} [opts.sessionId] - Agent's session ID
 * @param {string} [opts.taskId] - Task ID
 * @param {string} [opts.projectRoot] - Main project root
 * @param {string} [opts.baseRef] - Git ref to diff against (for changed files)
 * @param {object} [opts.policy] - Override policy (for testing)
 * @param {string[]} [opts.changedFiles] - Override changed files (for testing)
 * @returns {{ passed: boolean, violations: object[], warnings: object[], summary: object }}
 */
function validate(opts) {
  const cwd = opts.cwd || process.cwd();
  const projectRoot = opts.projectRoot || cwd;

  let policy;
  if (opts.policy) {
    policy = opts.policy;
  } else if (loadPolicy) {
    policy = loadPolicy();
  } else {
    policy = {
      enforcement: { require_active_task: true, area_locking: true },
      exceptions: { never_edit: ['.env', '.env.*', '*.pem', '*.key'] }
    };
  }

  const changedFiles = opts.changedFiles || getChangedFiles(cwd, opts.baseRef);
  const violations = [];
  const warnings = [];

  // Hard violations — these indicate policy breaches
  violations.push(...validateAreaLocks(changedFiles, opts.sessionId, policy));
  violations.push(...validateProtectedFiles(changedFiles, policy));
  violations.push(...validateBudget(opts.taskId, projectRoot));

  // Soft warnings — these are informational
  warnings.push(...validatePlanScope(changedFiles, opts.taskId, projectRoot));
  warnings.push(...validateCleanWorktree(cwd));

  const passed = violations.length === 0;

  const report = {
    passed,
    violations,
    warnings,
    summary: {
      files_changed: changedFiles.length,
      violation_count: violations.length,
      warning_count: warnings.length,
      session_id: opts.sessionId || null,
      task_id: opts.taskId || null,
      validated_at: new Date().toISOString()
    }
  };

  // Write validation report to state
  if (opts.taskId) {
    try {
      const reportDir = path.join(projectRoot, '.claude', 'pilot', 'state', 'validations');
      if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
      const reportFile = path.join(reportDir, `${opts.taskId}.json`);
      fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    } catch (e) {
      // Best effort — don't fail validation on write error
    }
  }

  return report;
}

module.exports = { validate, validateAreaLocks, validateProtectedFiles, validatePlanScope, validateBudget, validateCleanWorktree };
