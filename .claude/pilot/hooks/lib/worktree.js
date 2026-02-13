/**
 * Worktree Engine (Phase 2.1)
 *
 * Git worktree lifecycle management for multi-agent isolation.
 * Each Claude Code session gets its own worktree with a dedicated branch.
 *
 * Key design decisions:
 * - Squash merge to keep main history clean
 * - Conflict precheck before merge (abort and flag on conflict)
 * - Worktree lock during active session (prevents accidental removal)
 * - Agents must NEVER use git stash (shared across worktrees)
 *
 * Security note: All task IDs are sanitized via sanitizeId() before use
 * in shell commands. Only alphanumeric chars, hyphens, and underscores
 * are allowed. Config values come from policy.yaml (trusted input).
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { loadPolicy } = require('./policy');

/**
 * Get worktree configuration from policy (with fallback defaults)
 */
function getConfig() {
  try {
    const policy = loadPolicy();
    return policy.worktree || {};
  } catch (e) {
    return {
      enabled: false,
      base_dir: '.worktrees',
      branch_prefix: 'pilot/',
      merge_strategy: 'squash',
      conflict_action: 'flag',
      auto_cleanup: true,
      base_branch: 'main'
    };
  }
}

/**
 * Get the project root directory (where .git lives)
 */
function getProjectRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  } catch (e) {
    return process.cwd();
  }
}

/**
 * Sanitize task ID for use in branch names and directory names.
 * Only allows alphanumeric, hyphens, and underscores.
 */
function sanitizeId(taskId) {
  return taskId.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
}

/**
 * Quote a path for shell usage (handles spaces in paths).
 */
function q(p) {
  return '"' + p + '"';
}

/**
 * Create a worktree for a task.
 *
 * @param {string} taskId - The bd task ID
 * @param {string} sessionId - The session claiming this task
 * @returns {{ success: boolean, path?: string, branch?: string, error?: string }}
 */
function createWorktree(taskId, sessionId) {
  var config = getConfig();
  if (!config.enabled) {
    return { success: false, error: 'Worktree engine is disabled in policy' };
  }

  var root = getProjectRoot();
  var safeId = sanitizeId(taskId);
  var worktreePath = path.join(root, config.base_dir, safeId);
  var branchName = config.branch_prefix + safeId;
  var baseBranch = config.base_branch;

  // Check if worktree already exists for this task
  if (fs.existsSync(worktreePath)) {
    return {
      success: true,
      path: worktreePath,
      branch: branchName,
      reused: true
    };
  }

  // Ensure base directory exists
  var baseDir = path.join(root, config.base_dir);
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  try {
    // Check if branch already exists (from a previous incomplete cleanup)
    var branchExists = false;
    try {
      execSync('git rev-parse --verify ' + branchName, {
        cwd: root,
        stdio: 'pipe'
      });
      branchExists = true;
    } catch (ignored) {
      // Branch doesn't exist
    }

    if (branchExists) {
      execSync('git worktree add ' + q(worktreePath) + ' ' + branchName, {
        cwd: root,
        stdio: 'pipe'
      });
    } else {
      execSync(
        'git worktree add ' + q(worktreePath) + ' -b ' + branchName + ' ' + baseBranch,
        { cwd: root, stdio: 'pipe' }
      );
    }

    // Lock the worktree to prevent accidental removal
    var safeSessionId = sanitizeId(sessionId);
    execSync(
      'git worktree lock ' + q(worktreePath) + ' --reason "session ' + safeSessionId + ' active"',
      { cwd: root, stdio: 'pipe' }
    );

    return {
      success: true,
      path: worktreePath,
      branch: branchName,
      reused: false
    };
  } catch (e) {
    return {
      success: false,
      error: 'Failed to create worktree: ' + e.message
    };
  }
}

/**
 * Remove a worktree for a task.
 *
 * @param {string} taskId - The bd task ID
 * @returns {{ success: boolean, had_uncommitted?: boolean, error?: string }}
 */
function removeWorktree(taskId) {
  var config = getConfig();
  var root = getProjectRoot();
  var safeId = sanitizeId(taskId);
  var worktreePath = path.join(root, config.base_dir, safeId);
  var branchName = config.branch_prefix + safeId;

  if (!fs.existsSync(worktreePath)) {
    // Worktree already gone — clean up branch and admin files
    try {
      execSync('git branch -D ' + branchName, { cwd: root, stdio: 'pipe' });
    } catch (ignored) { /* Branch already gone */ }
    try {
      execSync('git worktree prune', { cwd: root, stdio: 'pipe' });
    } catch (ignored) { /* Best effort */ }
    return { success: true };
  }

  // Check for uncommitted changes
  var hadUncommitted = false;
  try {
    var status = execSync('git status --porcelain', {
      cwd: worktreePath,
      encoding: 'utf8'
    }).trim();
    hadUncommitted = status.length > 0;
  } catch (ignored) { /* Proceed anyway */ }

  try {
    // Unlock first (may fail if not locked)
    try {
      execSync('git worktree unlock ' + q(worktreePath), { cwd: root, stdio: 'pipe' });
    } catch (ignored) { /* Not locked */ }

    // Force remove (handles dirty working tree)
    execSync('git worktree remove --force ' + q(worktreePath), {
      cwd: root,
      stdio: 'pipe'
    });

    // Delete the branch
    try {
      execSync('git branch -D ' + branchName, { cwd: root, stdio: 'pipe' });
    } catch (ignored) { /* Branch may not exist */ }

    return { success: true, had_uncommitted: hadUncommitted };
  } catch (e) {
    // Try double-force for locked + dirty
    try {
      execSync('git worktree remove -f -f ' + q(worktreePath), {
        cwd: root,
        stdio: 'pipe'
      });
      try {
        execSync('git branch -D ' + branchName, { cwd: root, stdio: 'pipe' });
      } catch (ignored) { /* Best effort */ }
      return { success: true, had_uncommitted: hadUncommitted, forced: true };
    } catch (e2) {
      return {
        success: false,
        error: 'Failed to remove worktree: ' + e2.message
      };
    }
  }
}

/**
 * Merge a worktree branch back to the current branch.
 *
 * @param {string} taskId - The bd task ID
 * @param {string} commitMsg - Commit message for the merge
 * @returns {{ success: boolean, conflicts?: string[], error?: string }}
 */
function mergeWorktree(taskId, commitMsg) {
  var config = getConfig();
  var root = getProjectRoot();
  var safeId = sanitizeId(taskId);
  var branchName = config.branch_prefix + safeId;

  // Verify branch exists
  try {
    execSync('git rev-parse --verify ' + branchName, { cwd: root, stdio: 'pipe' });
  } catch (e) {
    return { success: false, error: 'Branch ' + branchName + ' does not exist' };
  }

  // Check if there are any commits to merge
  try {
    var diff = execSync(
      'git log ' + config.base_branch + '..' + branchName + ' --oneline',
      { cwd: root, encoding: 'utf8' }
    ).trim();
    if (!diff) {
      return { success: true, no_changes: true };
    }
  } catch (ignored) { /* Proceed anyway */ }

  // Conflict precheck
  try {
    execSync('git merge --no-commit --no-ff ' + branchName, {
      cwd: root,
      stdio: 'pipe'
    });
    // Clean — abort the test merge
    execSync('git merge --abort', { cwd: root, stdio: 'pipe' });
  } catch (e) {
    // Conflicts detected
    var conflicts = [];
    try {
      conflicts = execSync('git diff --name-only --diff-filter=U', {
        cwd: root,
        encoding: 'utf8'
      }).trim().split('\n').filter(Boolean);
    } catch (ignored) { /* Can't get conflict list */ }
    try {
      execSync('git merge --abort', { cwd: root, stdio: 'pipe' });
    } catch (ignored) { /* May already be aborted */ }

    // Attempt semantic auto-resolution if enabled
    var mergeResolution = config.merge_resolution || {};
    if (mergeResolution.enabled && conflicts.length > 0) {
      try {
        var resolver = require('./merge-conflict-resolver');
        // Re-attempt merge to leave conflict markers in files
        try {
          execSync('git merge --no-commit --no-ff ' + branchName, { cwd: root, stdio: 'pipe' });
        } catch (ignored) { /* expected — conflicts will be in files */ }

        var resolution = resolver.resolveAllConflicts(conflicts, {
          projectRoot: root,
          oursCommitMsg: commitMsg,
          oursTaskId: taskId
        });

        if (resolution.success && !resolution.needsEscalation) {
          var applied = resolver.applyResolutions(resolution, root);
          if (applied.applied.length === conflicts.length && applied.failed.length === 0) {
            // Stage resolved files and complete merge
            try {
              for (var f = 0; f < applied.applied.length; f++) {
                execSync('git add ' + q(applied.applied[f]), { cwd: root, stdio: 'pipe' });
              }
              return {
                success: true,
                auto_resolved: true,
                resolution: {
                  resolvedCount: resolution.resolvedCount,
                  confidence: resolution.overallConfidence,
                  files: applied.applied
                }
              };
            } catch (stageErr) {
              try { execSync('git merge --abort', { cwd: root, stdio: 'pipe' }); } catch (ignored) {}
            }
          } else {
            try { execSync('git merge --abort', { cwd: root, stdio: 'pipe' }); } catch (ignored) {}
          }
        } else {
          try { execSync('git merge --abort', { cwd: root, stdio: 'pipe' }); } catch (ignored) {}
        }
      } catch (resolverErr) {
        try { execSync('git merge --abort', { cwd: root, stdio: 'pipe' }); } catch (ignored) {}
      }
    }

    return { success: false, conflicts: conflicts, error: 'Merge conflicts detected' };
  }

  // Perform actual merge using temp file for commit message
  try {
    var tmpMsg = path.join(root, '.git', 'PILOT_MERGE_MSG');
    fs.writeFileSync(tmpMsg, commitMsg);

    if (config.merge_strategy === 'squash') {
      execSync('git merge --squash ' + branchName, { cwd: root, stdio: 'pipe' });
      execSync('git commit -F ' + q(tmpMsg), { cwd: root, stdio: 'pipe' });
    } else {
      execSync('git merge --no-ff ' + branchName + ' -F ' + q(tmpMsg), {
        cwd: root,
        stdio: 'pipe'
      });
    }

    try { fs.unlinkSync(tmpMsg); } catch (ignored) { /* best effort */ }

    // Phase 5.11: Trigger PR automation after successful merge
    var prResult = null;
    try {
      var prAutomation = require('./pr-automation');
      var ghPolicy = prAutomation.loadGitHubPolicy(root);
      if (ghPolicy.enabled) {
        prResult = prAutomation.handleTaskComplete(taskId, {
          projectRoot: root
        });
      }
    } catch (prErr) {
      // PR automation is optional -- never block merge
      prResult = { success: false, error: prErr.message };
    }

    return { success: true, pr_automation: prResult };
  } catch (e) {
    try {
      // execSync is safe here: branchName is sanitized via sanitizeId()
      execSync('git merge --abort', { cwd: root, stdio: 'pipe' });
    } catch (ignored) { /* Best effort */ }
    return { success: false, error: 'Merge failed: ' + e.message };
  }
}

/**
 * List all linked worktrees with their status.
 *
 * @returns {Array<{ path: string, head: string, branch: string, locked?: string }>}
 */
function listWorktrees() {
  var root = getProjectRoot();

  try {
    var output = execSync('git worktree list --porcelain', {
      cwd: root,
      encoding: 'utf8'
    });

    var worktrees = [];
    var current = null;
    var lines = output.split('\n');

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.startsWith('worktree ')) {
        if (current) worktrees.push(current);
        current = { path: line.slice(9) };
      } else if (line.startsWith('HEAD ') && current) {
        current.head = line.slice(5);
      } else if (line.startsWith('branch ') && current) {
        current.branch = line.slice(7);
      } else if (line.startsWith('locked') && current) {
        current.locked = line.slice(7).trim() || true;
      } else if (line.startsWith('detached') && current) {
        current.detached = true;
      }
    }
    if (current) worktrees.push(current);

    // Filter out the main worktree
    return worktrees.filter(function(wt) { return wt.path !== root; });
  } catch (e) {
    return [];
  }
}

/**
 * Clean up orphaned worktrees.
 *
 * @param {Array<{ session_id: string }>} activeSessions - Currently active sessions
 * @returns {{ cleaned: number, errors: string[] }}
 */
function cleanupOrphanedWorktrees(activeSessions) {
  var root = getProjectRoot();
  var config = getConfig();
  var activeIds = new Set(activeSessions.map(function(s) { return s.session_id; }));
  var cleaned = 0;
  var errors = [];

  try {
    execSync('git worktree prune', { cwd: root, stdio: 'pipe' });
  } catch (ignored) { /* Best effort */ }

  var worktrees = listWorktrees();
  var prefix = 'refs/heads/' + config.branch_prefix;

  for (var i = 0; i < worktrees.length; i++) {
    var wt = worktrees[i];

    // Check if worktree is locked by an active session
    if (wt.locked && typeof wt.locked === 'string') {
      var sessionMatch = wt.locked.match(/session (S-[^ ]+)/);
      if (sessionMatch && activeIds.has(sessionMatch[1])) {
        continue; // Session still active, skip
      }
    }

    // Check if it's a pilot-managed worktree
    if (wt.branch && wt.branch.startsWith(prefix)) {
      var taskId = wt.branch.replace(prefix, '');
      var result = removeWorktree(taskId);
      if (result.success) {
        cleaned++;
      } else {
        errors.push(taskId + ': ' + result.error);
      }
    }
  }

  return { cleaned: cleaned, errors: errors };
}

/**
 * Get the status of a worktree (dirty/clean, list of changed files).
 *
 * @param {string} taskId - The bd task ID
 * @returns {{ exists: boolean, dirty?: boolean, files?: string[], branch?: string }}
 */
function getWorktreeStatus(taskId) {
  var config = getConfig();
  var root = getProjectRoot();
  var safeId = sanitizeId(taskId);
  var worktreePath = path.join(root, config.base_dir, safeId);
  var branchName = config.branch_prefix + safeId;

  if (!fs.existsSync(worktreePath)) {
    return { exists: false };
  }

  try {
    var status = execSync('git status --porcelain', {
      cwd: worktreePath,
      encoding: 'utf8'
    }).trim();

    var files = status ? status.split('\n').map(function(l) { return l.trim(); }) : [];

    return {
      exists: true,
      dirty: files.length > 0,
      files: files,
      branch: branchName,
      path: worktreePath
    };
  } catch (e) {
    return { exists: true, error: e.message };
  }
}

/**
 * Standalone semantic conflict resolution (without merge).
 * Useful for resolving conflicts in an existing dirty merge state.
 *
 * @param {string[]} conflictFiles - Files with conflicts
 * @param {object} opts - Resolution options
 * @returns {object} Resolution results from merge-conflict-resolver
 */
function resolveConflicts(conflictFiles, opts) {
  var resolver = require('./merge-conflict-resolver');
  return resolver.resolveAllConflicts(conflictFiles, opts);
}

module.exports = {
  createWorktree: createWorktree,
  removeWorktree: removeWorktree,
  mergeWorktree: mergeWorktree,
  resolveConflicts: resolveConflicts,
  listWorktrees: listWorktrees,
  cleanupOrphanedWorktrees: cleanupOrphanedWorktrees,
  getWorktreeStatus: getWorktreeStatus,
  getConfig: getConfig,
  sanitizeId: sanitizeId
};
