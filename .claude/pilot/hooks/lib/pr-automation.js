/**
 * PR Automation & Remote Push (Phase 5.11)
 *
 * Core PR lifecycle: push branches, create PRs via gh CLI,
 * monitor CI checks, auto-merge, cleanup.
 *
 * Opt-in via policy.yaml github.enabled: true.
 * Falls back to local merge when gh/remote unavailable.
 *
 * State files:
 *   .claude/pilot/state/pr-status/<taskId>.json — PR tracking per task
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

// =============================================================================
// CONSTANTS
// =============================================================================

const PR_STATUS_DIR = '.claude/pilot/state/pr-status';

const DEFAULT_POLICY = {
  enabled: false,
  pr_on_complete: true,
  auto_merge: false,
  auto_push: true,
  merge_strategy: 'squash',
  delete_branch_after_merge: true,
  pr_template: 'default',
  require_checks_pass: true,
  commit_enforcement: {
    max_lines_per_commit: 500,
    require_conventional: true,
    block_on_violation: false
  },
  labels: ['pilot-agi', 'auto-generated'],
  reviewers: [],
  base_branch: 'main'
};

const CONVENTIONAL_REGEX = /^(feat|fix|refactor|test|docs|chore|perf|ci|build|style|revert)(\(.+\))?!?:\s.+/;

// =============================================================================
// HELPERS
// =============================================================================

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function resolvePath(projectRoot, relPath) {
  return path.join(projectRoot, relPath);
}

function getStatusPath(taskId, projectRoot) {
  return resolvePath(projectRoot, path.join(PR_STATUS_DIR, taskId.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json'));
}

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

function execQuiet(cmd, opts) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...opts }).trim();
}

function sanitizeTaskId(taskId) {
  return taskId.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '_');
}

// =============================================================================
// POLICY
// =============================================================================

/**
 * Load github policy from policy.yaml
 * @param {string} projectRoot
 * @returns {object} merged policy with defaults
 */
function loadGitHubPolicy(projectRoot) {
  try {
    const yaml = fs.readFileSync(
      resolvePath(projectRoot, '.claude/pilot/policy.yaml'), 'utf8'
    );
    // Simple YAML parser for github section
    const policy = Object.assign({}, DEFAULT_POLICY);
    const lines = yaml.split('\n');
    let inGithub = false;
    let inCommitEnforcement = false;
    let inLabels = false;
    let inReviewers = false;

    for (const line of lines) {
      const trimmed = line.trimStart();
      // Detect github: top-level section
      if (/^github:\s*$/.test(line)) {
        inGithub = true;
        inCommitEnforcement = false;
        inLabels = false;
        inReviewers = false;
        continue;
      }
      // Exit github section on next top-level key
      if (inGithub && /^\S/.test(line) && !/^github:/.test(line)) {
        inGithub = false;
        inCommitEnforcement = false;
        inLabels = false;
        inReviewers = false;
        continue;
      }
      if (!inGithub) continue;

      // Subsection: commit_enforcement
      if (/^\s+commit_enforcement:\s*$/.test(line)) {
        inCommitEnforcement = true;
        inLabels = false;
        inReviewers = false;
        continue;
      }
      // Subsection: labels
      if (/^\s+labels:\s*$/.test(line)) {
        inLabels = true;
        inCommitEnforcement = false;
        inReviewers = false;
        policy.labels = [];
        continue;
      }
      // Subsection: reviewers
      if (/^\s+reviewers:\s*$/.test(line)) {
        inReviewers = true;
        inCommitEnforcement = false;
        inLabels = false;
        policy.reviewers = [];
        continue;
      }

      // List items
      if (inLabels) {
        const m = trimmed.match(/^-\s+"?([^"]+)"?\s*$/);
        if (m) { policy.labels.push(m[1]); continue; }
        if (/^\s+\w+:/.test(line)) { inLabels = false; /* fall through */ }
        else if (/^\s+\[\]\s*$/.test(line.substring(line.indexOf('labels:')))) { continue; }
        else { continue; }
      }
      if (inReviewers) {
        const m = trimmed.match(/^-\s+"?([^"]+)"?\s*$/);
        if (m) { policy.reviewers.push(m[1]); continue; }
        if (/^\s+\w+:/.test(line)) { inReviewers = false; /* fall through */ }
        else { continue; }
      }

      // KV in commit_enforcement
      if (inCommitEnforcement) {
        const m = trimmed.match(/^(\w+):\s*(.+)$/);
        if (m) {
          const key = m[1];
          let val = m[2].replace(/#.*$/, '').trim();
          if (val === 'true') val = true;
          else if (val === 'false') val = false;
          else if (/^\d+$/.test(val)) val = parseInt(val, 10);
          else val = val.replace(/^["']|["']$/g, '');
          policy.commit_enforcement[key] = val;
        }
        // Check if we've left the subsection
        if (/^\s{2}\w+:/.test(line) && !/^\s{4}/.test(line)) {
          inCommitEnforcement = false;
        }
        continue;
      }

      // Top-level github KV
      const m = trimmed.match(/^(\w+):\s*(.+)$/);
      if (m) {
        const key = m[1];
        let val = m[2].replace(/#.*$/, '').trim();
        if (val === 'true') val = true;
        else if (val === 'false') val = false;
        else if (/^\d+$/.test(val)) val = parseInt(val, 10);
        else if (val === '[]') {
          // empty array inline
          if (key === 'labels') policy.labels = [];
          if (key === 'reviewers') policy.reviewers = [];
          continue;
        }
        else val = val.replace(/^["']|["']$/g, '');
        if (key !== 'commit_enforcement' && key !== 'labels' && key !== 'reviewers') {
          policy[key] = val;
        }
      }
    }

    return policy;
  } catch (e) {
    return Object.assign({}, DEFAULT_POLICY);
  }
}

// =============================================================================
// PREREQUISITES
// =============================================================================

/**
 * Check if gh CLI, git remote, and auth are available.
 * @param {string} projectRoot
 * @returns {{ available: boolean, gh: boolean, remote: boolean, auth: boolean, errors: string[] }}
 */
function checkPrerequisites(projectRoot) {
  const result = { available: false, gh: false, remote: false, auth: false, errors: [] };

  // Check gh CLI
  try {
    execQuiet('gh --version');
    result.gh = true;
  } catch (e) {
    result.errors.push('gh CLI not installed');
  }

  // Check git remote
  try {
    const remotes = execQuiet('git remote -v', { cwd: projectRoot });
    result.remote = remotes.length > 0;
    if (!result.remote) {
      result.errors.push('No git remote configured');
    }
  } catch (e) {
    result.errors.push('git remote check failed: ' + e.message);
  }

  // Check gh auth
  if (result.gh) {
    try {
      execQuiet('gh auth status');
      result.auth = true;
    } catch (e) {
      result.errors.push('gh not authenticated (run: gh auth login)');
    }
  }

  result.available = result.gh && result.remote && result.auth;
  return result;
}

// =============================================================================
// COMMIT VALIDATION
// =============================================================================

/**
 * Validate commits on the task branch for atomicity.
 * @param {string} taskId
 * @param {object} opts - { projectRoot, baseBranch, policy }
 * @returns {{ valid: boolean, violations: Array, commits: Array }}
 */
function validateCommits(taskId, opts) {
  const { projectRoot, baseBranch = 'main', policy = {} } = opts || {};
  const root = projectRoot || process.cwd();
  const enforcement = policy.commit_enforcement || DEFAULT_POLICY.commit_enforcement;
  const safeId = sanitizeTaskId(taskId);
  const branch = 'pilot/' + safeId;

  const result = { valid: true, violations: [], commits: [] };

  try {
    // Get commit log for the branch
    const log = execQuiet(
      'git log ' + baseBranch + '..' + branch + ' --pretty=format:"%H|%s" --no-merges',
      { cwd: root }
    );
    if (!log) return result;

    const lines = log.split('\n').filter(Boolean);

    for (const line of lines) {
      const sep = line.indexOf('|');
      const sha = line.substring(0, sep).replace(/"/g, '');
      const msg = line.substring(sep + 1).replace(/"$/, '');
      const commit = { sha, message: msg, violations: [] };

      // Check conventional commit format
      if (enforcement.require_conventional && !CONVENTIONAL_REGEX.test(msg)) {
        commit.violations.push({
          type: 'non_conventional',
          message: 'Commit message does not follow conventional format: ' + msg
        });
      }

      // Check for mixed concerns (feat + fix in same commit)
      const typeMatch = msg.match(/^(feat|fix|refactor|test|docs|chore|perf|ci|build|style|revert)/);
      if (typeMatch) {
        const commitType = typeMatch[1];
        // Check if message body mentions another type
        const otherTypes = ['feat', 'fix', 'refactor'].filter(t => t !== commitType);
        for (const ot of otherTypes) {
          if (msg.toLowerCase().includes(' ' + ot + ':') || msg.toLowerCase().includes(' ' + ot + '(')) {
            commit.violations.push({
              type: 'mixed_concerns',
              message: 'Commit mixes ' + commitType + ' and ' + ot
            });
          }
        }
      }

      // Check lines changed
      try {
        const stat = execQuiet(
          'git diff --shortstat ' + sha + '~1 ' + sha,
          { cwd: root }
        );
        const insertionsMatch = stat.match(/(\d+) insertion/);
        const deletionsMatch = stat.match(/(\d+) deletion/);
        const insertions = insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0;
        const deletions = deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0;
        const totalLines = insertions + deletions;
        commit.lines_changed = totalLines;

        if (totalLines > enforcement.max_lines_per_commit) {
          commit.violations.push({
            type: 'too_large',
            message: 'Commit changes ' + totalLines + ' lines (max: ' + enforcement.max_lines_per_commit + ')'
          });
        }
      } catch (e) {
        // Can't get diff stats — skip size check
      }

      // Check for task ID reference
      if (!msg.includes(taskId) && !msg.includes('[' + taskId + ']')) {
        commit.violations.push({
          type: 'missing_task_id',
          message: 'Commit does not reference task ID: ' + taskId
        });
      }

      if (commit.violations.length > 0) {
        result.valid = false;
      }
      result.commits.push(commit);
    }
  } catch (e) {
    // Branch may not exist or no commits — treat as valid (nothing to validate)
  }

  return result;
}

// =============================================================================
// PR BODY
// =============================================================================

/**
 * Build structured PR body from task metadata.
 * @param {string} taskId
 * @param {object} opts - { projectRoot, baseBranch, sessionId }
 * @returns {string} markdown body
 */
function buildPRBody(taskId, opts) {
  const { projectRoot, baseBranch = 'main', sessionId = '' } = opts || {};
  const root = projectRoot || process.cwd();
  const safeId = sanitizeTaskId(taskId);
  const branch = 'pilot/' + safeId;

  let planSummary = '';
  let planSteps = [];
  let testResults = '';
  let costInfo = '';
  let diffStats = { files: 0, insertions: 0, deletions: 0 };

  // Try to read plan
  try {
    const planFiles = fs.readdirSync(resolvePath(root, 'work/plans'))
      .filter(f => f.includes(safeId) || f.includes(taskId.replace(/\s+/g, '-')));
    if (planFiles.length > 0) {
      const plan = fs.readFileSync(
        resolvePath(root, 'work/plans/' + planFiles[0]), 'utf8'
      );
      // Extract overview
      const overviewMatch = plan.match(/## Overview\n\n(.+?)(?:\n\n|\n##)/s);
      if (overviewMatch) planSummary = overviewMatch[1].trim();
      // Extract steps
      const stepMatches = plan.match(/### Step \d+:.+/g);
      if (stepMatches) {
        planSteps = stepMatches.map(s => s.replace(/^### /, ''));
      }
    }
  } catch (e) { /* no plan file */ }

  // Get diff stats
  try {
    const stat = execQuiet(
      'git diff --shortstat ' + baseBranch + '...' + branch,
      { cwd: root }
    );
    const filesMatch = stat.match(/(\d+) file/);
    const insMatch = stat.match(/(\d+) insertion/);
    const delMatch = stat.match(/(\d+) deletion/);
    if (filesMatch) diffStats.files = parseInt(filesMatch[1], 10);
    if (insMatch) diffStats.insertions = parseInt(insMatch[1], 10);
    if (delMatch) diffStats.deletions = parseInt(delMatch[1], 10);
  } catch (e) { /* can't get stats */ }

  // Try to read cost data
  try {
    const costPath = resolvePath(root, '.claude/pilot/state/costs/tasks/' + taskId.replace(/\s+/g, '_') + '.json');
    const cost = readJSON(costPath);
    if (cost) {
      costInfo = '- Tokens: ' + (cost.total_tokens || 0).toLocaleString() + '\n';
      if (cost.respawn_count) costInfo += '- Respawns: ' + cost.respawn_count + '\n';
    }
  } catch (e) { /* no cost data */ }

  // Build body
  let body = '## Summary\n';
  body += planSummary || ('Implementation of task ' + taskId) ;
  body += '\n\n';

  body += '## Changes\n';
  body += '- ' + diffStats.files + ' files changed\n';
  body += '- ' + diffStats.insertions + '+ / ' + diffStats.deletions + '-\n\n';

  if (planSteps.length > 0) {
    body += '## Plan Steps\n';
    for (const step of planSteps) {
      body += '- [x] ' + step + '\n';
    }
    body += '\n';
  }

  if (costInfo) {
    body += '## Cost\n' + costInfo + '\n';
  }

  body += '## Task Reference\n';
  body += '- bd: ' + taskId + '\n';
  if (sessionId) body += '- Agent: ' + sessionId + '\n';
  body += '\n---\n*Auto-generated by Pilot AGI*\n';

  return body;
}

// =============================================================================
// CORE PR OPERATIONS
// =============================================================================

/**
 * Push branch to remote.
 * @param {string} taskId
 * @param {object} opts - { projectRoot, remote }
 * @returns {{ success: boolean, branch: string, remote: string, error?: string }}
 */
function pushBranch(taskId, opts) {
  const { projectRoot, remote = 'origin' } = opts || {};
  const root = projectRoot || process.cwd();
  const safeId = sanitizeTaskId(taskId);
  const branch = 'pilot/' + safeId;

  try {
    execQuiet('git push -u ' + remote + ' ' + branch, { cwd: root });
    return { success: true, branch, remote };
  } catch (e) {
    // Retry once
    try {
      execQuiet('git push -u ' + remote + ' ' + branch, { cwd: root });
      return { success: true, branch, remote, retried: true };
    } catch (e2) {
      return { success: false, branch, remote, error: e2.message };
    }
  }
}

/**
 * Create PR via gh CLI.
 * @param {string} taskId
 * @param {object} opts - { projectRoot, baseBranch, title, body, labels, reviewers }
 * @returns {{ success: boolean, pr_number?: number, pr_url?: string, error?: string }}
 */
function createPR(taskId, opts) {
  const {
    projectRoot,
    baseBranch = 'main',
    title,
    body,
    labels = [],
    reviewers = []
  } = opts || {};
  const root = projectRoot || process.cwd();
  const safeId = sanitizeTaskId(taskId);
  const branch = 'pilot/' + safeId;

  // Check if PR already exists
  const existing = getPRForTask(taskId, { projectRoot: root });
  if (existing) {
    return { success: true, pr_number: existing.pr_number, pr_url: existing.pr_url, existing: true };
  }

  const prTitle = title || ('[' + taskId + '] ' + safeId);
  const prBody = body || buildPRBody(taskId, opts);

  try {
    const args = [
      'pr', 'create',
      '--base', baseBranch,
      '--head', branch,
      '--title', prTitle,
      '--body', prBody
    ];

    if (labels.length > 0) {
      args.push('--label', labels.join(','));
    }
    if (reviewers.length > 0) {
      args.push('--reviewer', reviewers.join(','));
    }

    const output = execFileSync('gh', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    // gh pr create outputs the PR URL
    const prUrl = output;
    const prNumMatch = prUrl.match(/\/pull\/(\d+)/);
    const prNumber = prNumMatch ? parseInt(prNumMatch[1], 10) : null;

    // Save PR state
    const statusPath = getStatusPath(taskId, root);
    writeJSON(statusPath, {
      task_id: taskId,
      pr_number: prNumber,
      pr_url: prUrl,
      branch,
      base_branch: baseBranch,
      created_at: new Date().toISOString(),
      status: 'open',
      checks_passed: null,
      merged: false
    });

    return { success: true, pr_number: prNumber, pr_url: prUrl };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Check PR status (CI checks, reviews, mergeability).
 * @param {number} prNumber
 * @param {object} opts - { projectRoot }
 * @returns {{ checks_passed: boolean|null, reviews: object, mergeable: boolean, state: string }}
 */
function checkPRStatus(prNumber, opts) {
  const { projectRoot } = opts || {};
  const root = projectRoot || process.cwd();

  try {
    const json = execFileSync('gh', [
      'pr', 'view', String(prNumber),
      '--json', 'statusCheckRollup,reviewDecision,mergeable,state'
    ], { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

    const data = JSON.parse(json);

    // Parse check status
    let checksPassed = null;
    if (data.statusCheckRollup && data.statusCheckRollup.length > 0) {
      const allPassed = data.statusCheckRollup.every(
        c => c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.status === 'COMPLETED'
      );
      const anyFailed = data.statusCheckRollup.some(
        c => c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT'
      );
      const anyPending = data.statusCheckRollup.some(
        c => c.status === 'IN_PROGRESS' || c.status === 'QUEUED' || c.status === 'PENDING'
      );
      if (anyFailed) checksPassed = false;
      else if (anyPending) checksPassed = null;
      else if (allPassed) checksPassed = true;
    }

    return {
      checks_passed: checksPassed,
      reviews: data.reviewDecision || 'NONE',
      mergeable: data.mergeable === 'MERGEABLE',
      state: data.state || 'UNKNOWN'
    };
  } catch (e) {
    return {
      checks_passed: null,
      reviews: 'UNKNOWN',
      mergeable: false,
      state: 'ERROR',
      error: e.message
    };
  }
}

/**
 * Merge PR via gh CLI.
 * @param {number} prNumber
 * @param {object} opts - { projectRoot, strategy, deleteAfter }
 * @returns {{ success: boolean, merge_sha?: string, error?: string }}
 */
function mergePR(prNumber, opts) {
  const { projectRoot, strategy = 'squash', deleteAfter = true } = opts || {};
  const root = projectRoot || process.cwd();

  const strategyFlag = strategy === 'rebase' ? '--rebase'
    : strategy === 'merge' ? '--merge'
    : '--squash';

  try {
    const args = [
      'pr', 'merge', String(prNumber),
      strategyFlag,
      '--auto'
    ];

    if (deleteAfter) {
      args.push('--delete-branch');
    }

    execFileSync('gh', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Close PR with reason.
 * @param {number} prNumber
 * @param {object} opts - { projectRoot, reason }
 * @returns {{ success: boolean, error?: string }}
 */
function closePR(prNumber, opts) {
  const { projectRoot, reason } = opts || {};
  const root = projectRoot || process.cwd();

  try {
    const args = ['pr', 'close', String(prNumber)];
    if (reason) {
      args.push('--comment', reason);
    }

    execFileSync('gh', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Delete remote branch after merge.
 * @param {string} taskId
 * @param {object} opts - { projectRoot, remote }
 * @returns {{ success: boolean, error?: string }}
 */
function cleanupBranch(taskId, opts) {
  const { projectRoot, remote = 'origin' } = opts || {};
  const root = projectRoot || process.cwd();
  const safeId = sanitizeTaskId(taskId);
  const branch = 'pilot/' + safeId;

  try {
    execQuiet('git push ' + remote + ' --delete ' + branch, { cwd: root });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Find existing PR for task branch.
 * @param {string} taskId
 * @param {object} opts - { projectRoot }
 * @returns {{ pr_number: number, pr_url: string } | null}
 */
function getPRForTask(taskId, opts) {
  const { projectRoot } = opts || {};
  const root = projectRoot || process.cwd();
  const safeId = sanitizeTaskId(taskId);
  const branch = 'pilot/' + safeId;

  // Check local state first
  const statusPath = getStatusPath(taskId, root);
  const cached = readJSON(statusPath);
  if (cached && cached.pr_number && cached.status !== 'closed') {
    return { pr_number: cached.pr_number, pr_url: cached.pr_url };
  }

  // Check GitHub
  try {
    const json = execFileSync('gh', [
      'pr', 'list',
      '--head', branch,
      '--json', 'number,url',
      '--limit', '1'
    ], { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

    const prs = JSON.parse(json);
    if (prs.length > 0) {
      return { pr_number: prs[0].number, pr_url: prs[0].url };
    }
  } catch (e) {
    // gh not available or query failed
  }

  return null;
}

// =============================================================================
// ORCHESTRATION
// =============================================================================

/**
 * Handle task completion — full PR flow.
 * Called by PM daemon or agent loop when task finishes.
 *
 * @param {string} taskId
 * @param {object} opts - { projectRoot, sessionId, policy }
 * @returns {{ success: boolean, action: string, pr_url?: string, error?: string, violations?: Array }}
 */
function handleTaskComplete(taskId, opts) {
  const { projectRoot, sessionId = '', policy: policyOverride } = opts || {};
  const root = projectRoot || process.cwd();
  const self = module.exports;

  // Load policy
  const policy = policyOverride || self.loadGitHubPolicy(root);
  if (!policy.enabled) {
    return { success: true, action: 'local_merge', reason: 'github.enabled is false' };
  }

  // Check prerequisites
  const prereqs = self.checkPrerequisites(root);
  if (!prereqs.available) {
    return {
      success: true,
      action: 'local_merge',
      reason: 'prerequisites not met: ' + prereqs.errors.join(', ')
    };
  }

  // Step 1: Validate commits
  if (policy.commit_enforcement) {
    const validation = self.validateCommits(taskId, {
      projectRoot: root,
      baseBranch: policy.base_branch,
      policy
    });

    if (!validation.valid && policy.commit_enforcement.block_on_violation) {
      return {
        success: false,
        action: 'blocked',
        reason: 'commit validation failed',
        violations: validation.violations
      };
    }

    // Warn but continue
    if (!validation.valid) {
      // Could log warnings here
    }
  }

  // Step 2: Push branch
  if (policy.auto_push) {
    const push = self.pushBranch(taskId, { projectRoot: root });
    if (!push.success) {
      return {
        success: false,
        action: 'push_failed',
        error: push.error
      };
    }
  }

  // Step 3: Create PR
  if (policy.pr_on_complete) {
    const pr = self.createPR(taskId, {
      projectRoot: root,
      baseBranch: policy.base_branch,
      labels: policy.labels,
      reviewers: policy.reviewers,
      sessionId
    });

    if (!pr.success) {
      return {
        success: false,
        action: 'pr_creation_failed',
        error: pr.error
      };
    }

    // Step 4: Enable auto-merge if policy allows
    if (policy.auto_merge && pr.pr_number) {
      self.mergePR(pr.pr_number, {
        projectRoot: root,
        strategy: policy.merge_strategy,
        deleteAfter: policy.delete_branch_after_merge
      });
    }

    return {
      success: true,
      action: 'pr_created',
      pr_number: pr.pr_number,
      pr_url: pr.pr_url,
      existing: pr.existing || false
    };
  }

  return { success: true, action: 'push_only' };
}

/**
 * Get all open PR statuses for the project.
 * Used by PM loop for _prStatusScan().
 * @param {string} projectRoot
 * @returns {Array<object>} array of PR status objects
 */
function getOpenPRs(projectRoot) {
  const root = projectRoot || process.cwd();
  const statusDir = resolvePath(root, PR_STATUS_DIR);
  const results = [];

  if (!fs.existsSync(statusDir)) return results;

  try {
    const files = fs.readdirSync(statusDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const data = readJSON(path.join(statusDir, file));
      if (data && data.status === 'open' && !data.merged) {
        results.push(data);
      }
    }
  } catch (e) { /* can't read status dir */ }

  return results;
}

/**
 * Update local PR status after checking GitHub.
 * @param {string} taskId
 * @param {object} statusUpdate - partial status to merge
 * @param {string} projectRoot
 */
function updatePRStatus(taskId, statusUpdate, projectRoot) {
  const root = projectRoot || process.cwd();
  const statusPath = getStatusPath(taskId, root);
  const existing = readJSON(statusPath) || {};
  writeJSON(statusPath, Object.assign(existing, statusUpdate, {
    updated_at: new Date().toISOString()
  }));
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Policy
  loadGitHubPolicy,
  DEFAULT_POLICY,

  // Prerequisites
  checkPrerequisites,

  // Commit validation
  validateCommits,

  // PR body
  buildPRBody,

  // Core operations
  pushBranch,
  createPR,
  checkPRStatus,
  mergePR,
  closePR,
  cleanupBranch,
  getPRForTask,

  // Orchestration
  handleTaskComplete,
  getOpenPRs,
  updatePRStatus,

  // Internals (for testing)
  _getStatusPath: getStatusPath,
  _sanitizeTaskId: sanitizeTaskId,
  _PR_STATUS_DIR: PR_STATUS_DIR,
  _CONVENTIONAL_REGEX: CONVENTIONAL_REGEX
};
