#!/usr/bin/env node

/**
 * Universal Pre-Commit Hook — Phase 6.7 (Pilot AGI-mkn)
 *
 * Git pre-commit hook that enforces Pilot AGI policy for ALL agent types.
 * Installed in each agent's worktree .git/hooks/pre-commit alongside the
 * existing bd-sync hook.
 *
 * Enforcement checks (in order):
 *   1. Active task required (PILOT_TASK_ID env var or bd in_progress)
 *   2. Plan approval required (approved-plans/{taskId}.json)
 *   3. Protected files check (never_edit patterns from policy.yaml)
 *   4. Area lock enforcement (staged files within assigned area)
 *   5. Budget check (cost-tracker per-task budget)
 *
 * Environment variables (set by process-spawner):
 *   PILOT_SESSION_ID — Current agent's session ID
 *   PILOT_TASK_ID    — Current task being worked on (bd issue ID)
 *   PILOT_AGENT_TYPE — Adapter name (claude, aider, ollama, opencode, codex)
 *
 * Exit codes:
 *   0 — All checks passed, commit proceeds
 *   1 — Policy violation, commit blocked
 *
 * Security: All execSync calls use hardcoded constant command strings only.
 * No user input is ever interpolated into shell commands.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// =============================================================================
// CONFIG
// =============================================================================

const PROJECT_ROOT = findProjectRoot();
const HOOKS_LIB = path.join(PROJECT_ROOT, '.claude', 'pilot', 'hooks', 'lib');
const STATE_DIR = path.join(PROJECT_ROOT, '.claude', 'pilot', 'state');

// =============================================================================
// HELPERS — Load shared modules from hooks/lib when available
// =============================================================================

let loadPolicy, matchesPattern, isException;
try {
  const policyMod = require(path.join(HOOKS_LIB, 'policy'));
  loadPolicy = policyMod.loadPolicy;
  matchesPattern = policyMod.matchesPattern;
  isException = policyMod.isException;
} catch (e) {
  // Fallback: minimal policy loading
  loadPolicy = () => ({
    enforcement: { require_active_task: true, require_plan_approval: true },
    exceptions: { never_edit: ['.env', '.env.*', '*.pem', '*.key'] }
  });
  matchesPattern = (fp, patterns) => {
    if (!patterns || !Array.isArray(patterns)) return false;
    for (const p of patterns) {
      const re = p.replace(/\./g, '\\.').replace(/\*\*/g, '\x00').replace(/\*/g, '[^/]*').replace(/\x00/g, '.*');
      if (new RegExp(`^${re}$`).test(fp)) return true;
    }
    return false;
  };
  isException = (fp, type, policy) => matchesPattern(fp, (policy.exceptions || {})[type]);
}

let sessionMod;
try {
  sessionMod = require(path.join(HOOKS_LIB, 'session'));
} catch (e) {
  sessionMod = null;
}

// =============================================================================
// PROJECT ROOT DISCOVERY
// =============================================================================

function findProjectRoot() {
  // Prefer env var set by process-spawner
  if (process.env.PILOT_PROJECT_ROOT) return process.env.PILOT_PROJECT_ROOT;

  // Walk up from cwd looking for .claude/pilot
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.claude', 'pilot'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // For worktrees: check git common dir
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    const mainRoot = path.dirname(path.resolve(commonDir));
    if (fs.existsSync(path.join(mainRoot, '.claude', 'pilot'))) return mainRoot;
  } catch (e) { /* not in git */ }

  return process.cwd();
}

// =============================================================================
// GIT HELPERS
// =============================================================================

/**
 * Get list of staged files (relative paths).
 * Security: uses execFileSync (no shell) with constant args.
 */
function getStagedFiles() {
  try {
    const output = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    });
    return output.trim().split('\n').filter(Boolean);
  } catch (e) {
    return [];
  }
}

/**
 * Get current git branch.
 * Security: uses execFileSync (no shell) with constant args.
 */
function getCurrentBranch() {
  try {
    return execFileSync('git', ['branch', '--show-current'], {
      encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
    }).trim() || null;
  } catch (e) {
    return null;
  }
}

// =============================================================================
// ENFORCEMENT CHECKS
// =============================================================================

/**
 * Check 1: Active task required.
 * Reads PILOT_TASK_ID env or falls back to bd in_progress check.
 */
function checkActiveTask(policy) {
  if (!policy.enforcement?.require_active_task) return null;

  const taskId = process.env.PILOT_TASK_ID;
  if (taskId) return null; // Task ID provided via env

  // Fallback: check bd for in_progress tasks
  try {
    const result = execFileSync('bd', ['list', '--status', 'in_progress', '--json'], {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    });
    const tasks = JSON.parse(result);
    if (tasks.length > 0) return null;
  } catch (e) { /* bd not available */ }

  return 'No active task. All commits must reference a task (set PILOT_TASK_ID or claim a bd task).';
}

/**
 * Check 2: Plan approval required.
 */
function checkPlanApproval(policy) {
  if (!policy.enforcement?.require_plan_approval) return null;

  const taskId = process.env.PILOT_TASK_ID;
  if (!taskId) return null; // Skip if no task (check 1 handles this)

  const approvalFile = path.join(STATE_DIR, 'approved-plans', `${taskId}.json`);

  if (!fs.existsSync(approvalFile)) {
    return `No approved plan for task ${taskId}. Create and approve a plan before committing.`;
  }

  try {
    const approval = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
    if (approval.approved !== true) {
      return `Plan for task ${taskId} is not approved.`;
    }
  } catch (e) {
    return `Failed to read plan approval for task ${taskId}: ${e.message}`;
  }

  return null;
}

/**
 * Check 3: Protected files (never_edit).
 */
function checkProtectedFiles(stagedFiles, policy) {
  const neverEdit = policy.exceptions?.never_edit || [];
  const violations = [];

  for (const file of stagedFiles) {
    if (matchesPattern(file, neverEdit)) {
      violations.push(file);
    }
  }

  if (violations.length > 0) {
    return `Protected files cannot be edited (security policy):\n  ${violations.join('\n  ')}`;
  }

  return null;
}

/**
 * Check 4: Protected branches.
 */
function checkProtectedBranches(policy) {
  const protectedBranches = policy.enforcement?.protected_branches || [];
  const branch = getCurrentBranch();

  if (branch && protectedBranches.includes(branch)) {
    return `Cannot commit on protected branch '${branch}'. Create a feature branch first.`;
  }

  return null;
}

/**
 * Check 5: Area lock enforcement.
 * Verifies staged files are within the area assigned to this session.
 */
function checkAreaLocks(stagedFiles, policy) {
  if (policy.enforcement?.area_locking === false) return null;

  const sessionId = process.env.PILOT_SESSION_ID;
  if (!sessionId) return null; // Can't check without session ID

  if (!sessionMod) return null; // Session module not available

  for (const file of stagedFiles) {
    // Skip exception files
    if (isException(file, 'no_task_required', policy)) continue;

    const area = sessionMod.getAreaForPath(file);
    if (!area) continue; // File not in any defined area

    const lock = sessionMod.isAreaLocked(area, sessionId);
    if (lock) {
      return `Area '${area}' is locked by another session (${lock.session_id}).\n  File: ${file}\n  Task: ${lock.task_id || 'unknown'}`;
    }
  }

  return null;
}

/**
 * Check 6: Budget enforcement.
 * Checks if the task has exceeded its token budget.
 */
function checkBudget() {
  const taskId = process.env.PILOT_TASK_ID;
  if (!taskId) return null;

  try {
    const costTracker = require(path.join(HOOKS_LIB, 'cost-tracker'));
    const result = costTracker.checkBudget(taskId);
    if (result && result.exceeded) {
      return `Token budget exceeded for task ${taskId}. Used: ${result.used}, Limit: ${result.limit}`;
    }
  } catch (e) {
    // cost-tracker not available — skip budget check
  }

  return null;
}

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

/**
 * Run all pre-commit enforcement checks.
 * @param {object} [options] - Override options for testing
 * @param {string[]} [options.stagedFiles] - Override staged files list
 * @param {object} [options.policy] - Override policy object
 * @param {object} [options.env] - Override environment variables
 * @returns {{ passed: boolean, violations: string[] }}
 */
function runChecks(options = {}) {
  // Allow env override for testing
  const originalEnv = {};
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) {
      originalEnv[k] = process.env[k];
      if (v === undefined || v === null) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }

  try {
    const policy = options.policy || loadPolicy();
    const stagedFiles = options.stagedFiles || getStagedFiles();
    const violations = [];

    // Run checks in order
    const checks = [
      () => checkActiveTask(policy),
      () => checkPlanApproval(policy),
      () => checkProtectedBranches(policy),
      () => checkProtectedFiles(stagedFiles, policy),
      () => checkAreaLocks(stagedFiles, policy),
      () => checkBudget()
    ];

    for (const check of checks) {
      const result = check();
      if (result) violations.push(result);
    }

    return {
      passed: violations.length === 0,
      violations
    };
  } finally {
    // Restore original env
    if (options.env) {
      for (const [k, v] of Object.entries(originalEnv)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  }
}

/**
 * Generate the shell script content for a git pre-commit hook
 * that calls this module. To be installed in worktree .git/hooks/pre-commit.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot - Absolute path to the main project root
 * @param {string} [opts.sessionId] - Session ID to embed
 * @param {string} [opts.taskId] - Task ID to embed
 * @param {string} [opts.agentType] - Agent adapter name
 * @returns {string} Shell script content
 */
function generateHookScript(opts) {
  const scriptPath = path.join(opts.projectRoot, 'lib', 'enforcement', 'universal-pre-commit.js');
  const envLines = [];
  if (opts.sessionId) envLines.push(`export PILOT_SESSION_ID="${opts.sessionId}"`);
  if (opts.taskId) envLines.push(`export PILOT_TASK_ID="${opts.taskId}"`);
  if (opts.agentType) envLines.push(`export PILOT_AGENT_TYPE="${opts.agentType}"`);
  envLines.push(`export PILOT_PROJECT_ROOT="${opts.projectRoot}"`);

  return `#!/bin/sh
# Pilot AGI Universal Pre-Commit Hook
# Auto-generated — do not edit manually
${envLines.join('\n')}

# Run bd sync flush first (preserve existing behavior)
if command -v bd >/dev/null 2>&1 && [ -d ".beads" ]; then
  bd sync --flush-only >/dev/null 2>&1 || true
  if [ -f ".beads/issues.jsonl" ]; then
    git add ".beads/issues.jsonl" 2>/dev/null || true
  fi
fi

# Run universal enforcement checks
node "${scriptPath}" "$@"
exit $?
`;
}

// =============================================================================
// CLI EXECUTION (when run directly as git hook)
// =============================================================================

if (require.main === module) {
  const result = runChecks();

  if (!result.passed) {
    console.error('BLOCKED by Pilot AGI policy:');
    for (const v of result.violations) {
      console.error(`  - ${v}`);
    }
    process.exit(1);
  }

  process.exit(0);
}

module.exports = { runChecks, generateHookScript, checkActiveTask, checkPlanApproval, checkProtectedFiles, checkProtectedBranches, checkAreaLocks, checkBudget };
