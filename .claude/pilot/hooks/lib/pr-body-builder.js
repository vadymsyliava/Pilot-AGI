/**
 * PR Body Builder (Phase 5.11)
 *
 * Generates structured PR descriptions with plan steps, test results,
 * cost metrics, and files changed. Used by pr-automation.js when creating PRs.
 *
 * State sources:
 *   work/plans/ -- approved plan files
 *   .claude/pilot/state/costs/tasks/ -- cost tracking per task
 *   .claude/pilot/state/approved-plans/ -- approved plan JSON
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============================================================================
// HELPERS
// ============================================================================

function sanitizeTaskId(taskId) {
  return taskId.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

// ============================================================================
// PLAN EXTRACTION
// ============================================================================

/**
 * Load plan steps from approved plan state.
 * @param {string} taskId
 * @param {string} projectRoot
 * @returns {{ summary: string, steps: string[] }}
 */
function loadPlanSteps(taskId, projectRoot) {
  const result = { summary: '', steps: [] };
  const safeId = sanitizeTaskId(taskId);

  // Try approved plan JSON first
  try {
    const planPath = path.join(projectRoot, '.claude/pilot/state/approved-plans', safeId + '.json');
    if (fs.existsSync(planPath)) {
      const plan = readJSON(planPath);
      if (plan) {
        result.summary = plan.summary || plan.description || '';
        if (Array.isArray(plan.steps)) {
          result.steps = plan.steps.map(function(s) {
            return typeof s === 'string' ? s : (s.title || s.description || JSON.stringify(s));
          });
        }
        return result;
      }
    }
  } catch (e) { /* fall through */ }

  // Try markdown plan files
  try {
    const plansDir = path.join(projectRoot, 'work/plans');
    if (fs.existsSync(plansDir)) {
      const files = fs.readdirSync(plansDir)
        .filter(function(f) {
          return f.includes(safeId) || f.includes(taskId.replace(/\s+/g, '-'));
        });
      if (files.length > 0) {
        const content = fs.readFileSync(path.join(plansDir, files[0]), 'utf8');
        // Extract overview
        var overviewMatch = content.match(/## Overview\n\n(.+?)(?:\n\n|\n##)/s);
        if (overviewMatch) result.summary = overviewMatch[1].trim();
        // Extract steps
        var stepMatches = content.match(/### Step \d+:.+/g);
        if (stepMatches) {
          result.steps = stepMatches.map(function(s) { return s.replace(/^### /, ''); });
        }
      }
    }
  } catch (e) { /* no plan files */ }

  return result;
}

// ============================================================================
// DIFF STATS
// ============================================================================

/**
 * Get diff statistics between base branch and task branch.
 * @param {string} taskId
 * @param {object} opts - { projectRoot, baseBranch }
 * @returns {{ files: number, insertions: number, deletions: number, fileList: string[] }}
 */
function getDiffStats(taskId, opts) {
  var projectRoot = (opts && opts.projectRoot) || process.cwd();
  var baseBranch = (opts && opts.baseBranch) || 'main';
  var safeId = sanitizeTaskId(taskId);
  var branch = 'pilot/' + safeId;
  var result = { files: 0, insertions: 0, deletions: 0, fileList: [] };

  try {
    var stat = execFileSync('git', [
      'diff', '--shortstat', baseBranch + '...' + branch
    ], { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' }).trim();

    var filesMatch = stat.match(/(\d+) file/);
    var insMatch = stat.match(/(\d+) insertion/);
    var delMatch = stat.match(/(\d+) deletion/);
    if (filesMatch) result.files = parseInt(filesMatch[1], 10);
    if (insMatch) result.insertions = parseInt(insMatch[1], 10);
    if (delMatch) result.deletions = parseInt(delMatch[1], 10);
  } catch (e) { /* can't get stats */ }

  // Get file list
  try {
    var fileOutput = execFileSync('git', [
      'diff', '--name-only', baseBranch + '...' + branch
    ], { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' }).trim();
    if (fileOutput) {
      result.fileList = fileOutput.split('\n').filter(Boolean);
    }
  } catch (e) { /* can't get file list */ }

  return result;
}

// ============================================================================
// COST METRICS
// ============================================================================

/**
 * Load cost metrics for a task.
 * @param {string} taskId
 * @param {string} projectRoot
 * @returns {{ total_tokens: number, respawn_count: number } | null}
 */
function loadCostMetrics(taskId, projectRoot) {
  var costFile = taskId.replace(/\s+/g, '_') + '.json';
  var costPath = path.join(projectRoot, '.claude/pilot/state/costs/tasks', costFile);
  return readJSON(costPath);
}

// ============================================================================
// PR BODY BUILDER
// ============================================================================

/**
 * Build a structured PR body for a task.
 *
 * @param {string} taskId - The bd task ID
 * @param {object} [opts] - Options
 * @param {string} [opts.projectRoot] - Project root
 * @param {string} [opts.baseBranch] - Base branch (default: main)
 * @param {string} [opts.sessionId] - Agent session ID
 * @param {object} [opts.template] - Template options (include_plan_steps, etc.)
 * @returns {string} Markdown PR body
 */
function buildPRBody(taskId, opts) {
  var projectRoot = (opts && opts.projectRoot) || process.cwd();
  var baseBranch = (opts && opts.baseBranch) || 'main';
  var sessionId = (opts && opts.sessionId) || '';
  var template = (opts && opts.template) || {};

  var plan = loadPlanSteps(taskId, projectRoot);
  var diff = getDiffStats(taskId, { projectRoot: projectRoot, baseBranch: baseBranch });
  var cost = loadCostMetrics(taskId, projectRoot);

  var body = '## Summary\n';
  body += (plan.summary || ('Implementation of task ' + taskId));
  body += '\n\n';

  body += '## Changes\n';
  body += '- ' + diff.files + ' files changed\n';
  body += '- ' + diff.insertions + '+ / ' + diff.deletions + '-\n\n';

  if (template.include_plan_steps !== false && plan.steps.length > 0) {
    body += '## Plan Steps\n';
    for (var i = 0; i < plan.steps.length; i++) {
      body += '- [x] ' + plan.steps[i] + '\n';
    }
    body += '\n';
  }

  if (template.include_cost_metrics !== false && cost) {
    body += '## Cost\n';
    body += '- Tokens: ' + (cost.total_tokens || 0).toLocaleString() + '\n';
    if (cost.respawn_count) {
      body += '- Respawns: ' + cost.respawn_count + '\n';
    }
    body += '\n';
  }

  if (template.include_files_changed !== false && diff.fileList.length > 0) {
    body += '## Files Changed\n';
    var maxFiles = 20;
    var displayed = diff.fileList.slice(0, maxFiles);
    for (var j = 0; j < displayed.length; j++) {
      body += '- `' + displayed[j] + '`\n';
    }
    if (diff.fileList.length > maxFiles) {
      body += '- ... and ' + (diff.fileList.length - maxFiles) + ' more\n';
    }
    body += '\n';
  }

  body += '## Task Reference\n';
  body += '- bd: ' + taskId + '\n';
  if (sessionId) body += '- Agent: ' + sessionId + '\n';

  body += '\n---\n*Auto-generated by Pilot AGI*\n';

  return body;
}

/**
 * Build a PR title from task ID and commit messages.
 *
 * @param {string} taskId - The bd task ID
 * @param {string[]} [commitMessages] - Recent commit messages
 * @returns {string} PR title
 */
function buildPRTitle(taskId, commitMessages) {
  if (commitMessages && commitMessages.length > 0) {
    // Use first commit message as base, strip task ID reference
    var first = commitMessages[0]
      .replace(/\[.*?\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (first.length > 70) {
      first = first.substring(0, 67) + '...';
    }
    return first + ' [' + taskId + ']';
  }
  return '[' + taskId + '] Automated PR';
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  buildPRBody,
  buildPRTitle,
  loadPlanSteps,
  getDiffStats,
  loadCostMetrics,
  sanitizeTaskId
};
