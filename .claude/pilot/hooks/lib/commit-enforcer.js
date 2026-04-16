/**
 * Commit Atomicity Enforcer (Phase 5.11)
 *
 * Validates that commits are small and atomic:
 *   - Max files per commit (configurable, default 10)
 *   - Max lines changed per commit (configurable, default 500)
 *   - Reject commits that mix unrelated changes
 *   - Conventional commit format enforcement
 *
 * Used by pr-automation.js before pushing branches.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const CONVENTIONAL_REGEX = /^(feat|fix|refactor|test|docs|chore|perf|ci|build|style|revert)(\(.+\))?!?:\s.+/;

const DEFAULT_LIMITS = {
  max_files_per_commit: 10,
  max_lines_per_commit: 500,
  enforce_atomic: true
};

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate staged files before committing.
 *
 * @param {string[]} stagedFiles - Array of staged file paths
 * @param {object} [opts] - Options
 * @param {number} [opts.maxFiles] - Max files per commit
 * @param {number} [opts.maxLines] - Max lines per commit
 * @param {string} [opts.projectRoot] - Project root for git commands
 * @returns {{ valid: boolean, violations: Array<{type: string, message: string}>, suggestions: string[] }}
 */
function validateCommit(stagedFiles, opts) {
  var maxFiles = (opts && opts.maxFiles) || DEFAULT_LIMITS.max_files_per_commit;
  var maxLines = (opts && opts.maxLines) || DEFAULT_LIMITS.max_lines_per_commit;
  var projectRoot = (opts && opts.projectRoot) || process.cwd();
  var enforceAtomic = opts && opts.enforceAtomic !== undefined ? opts.enforceAtomic : DEFAULT_LIMITS.enforce_atomic;

  var violations = [];
  var suggestions = [];

  if (!stagedFiles || stagedFiles.length === 0) {
    return { valid: true, violations: [], suggestions: [] };
  }

  // Check file count
  if (stagedFiles.length > maxFiles) {
    violations.push({
      type: 'too_many_files',
      message: 'Commit has ' + stagedFiles.length + ' files (max: ' + maxFiles + ')'
    });
    suggestions.push('Split into multiple commits with fewer files each');
  }

  // Check total lines changed
  var totalLines = 0;
  try {
    var stat = execFileSync('git', ['diff', '--cached', '--shortstat'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: 'pipe'
    }).trim();
    var insMatch = stat.match(/(\d+) insertion/);
    var delMatch = stat.match(/(\d+) deletion/);
    totalLines = (insMatch ? parseInt(insMatch[1], 10) : 0) +
                 (delMatch ? parseInt(delMatch[1], 10) : 0);
  } catch (e) {
    // Estimate from file count
    totalLines = stagedFiles.length * 50;
  }

  if (totalLines > maxLines) {
    violations.push({
      type: 'too_many_lines',
      message: 'Commit changes ' + totalLines + ' lines (max: ' + maxLines + ')'
    });
    suggestions.push('Break large changes into smaller, incremental commits');
  }

  // Check for mixed concerns (different directories + different types)
  if (enforceAtomic && stagedFiles.length > 1) {
    var mixed = detectMixedConcerns(stagedFiles);
    if (mixed.isMixed) {
      violations.push({
        type: 'mixed_concerns',
        message: 'Commit mixes changes across unrelated areas: ' + mixed.areas.join(', ')
      });
      var groups = suggestSplit(stagedFiles);
      if (groups.length > 1) {
        suggestions.push('Split into ' + groups.length + ' commits by area');
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations: violations,
    suggestions: suggestions
  };
}

/**
 * Detect if staged files mix unrelated concerns.
 *
 * @param {string[]} files - File paths
 * @returns {{ isMixed: boolean, areas: string[] }}
 */
function detectMixedConcerns(files) {
  var areas = new Set();

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var ext = path.extname(file);
    var dir = path.dirname(file).split(path.sep)[0] || 'root';

    // Classify by purpose
    if (file.includes('test') || file.includes('spec')) {
      areas.add('tests');
    } else if (ext === '.md' || ext === '.txt' || ext === '.rst') {
      areas.add('docs');
    } else if (file.includes('.github') || file.includes('docker') || file.includes('ci')) {
      areas.add('infra');
    } else if (ext === '.json' || ext === '.yaml' || ext === '.yml' || ext === '.toml') {
      areas.add('config');
    } else {
      areas.add('src/' + dir);
    }
  }

  // Mixed if we have 3+ distinct areas, or mix src with non-src
  var areaList = Array.from(areas);
  var srcAreas = areaList.filter(function(a) { return a.startsWith('src/'); });
  var nonSrcAreas = areaList.filter(function(a) { return !a.startsWith('src/'); });

  var isMixed = (srcAreas.length > 0 && nonSrcAreas.length > 0 && areaList.length >= 3) ||
                (srcAreas.length > 2);

  return { isMixed: isMixed, areas: areaList };
}

/**
 * Suggest how to split staged files into logical commit groups.
 *
 * @param {string[]} stagedFiles - File paths
 * @returns {Array<{name: string, files: string[]}>} Suggested commit groups
 */
function suggestSplit(stagedFiles) {
  var groups = {};

  for (var i = 0; i < stagedFiles.length; i++) {
    var file = stagedFiles[i];
    var ext = path.extname(file);
    var group;

    if (file.includes('test') || file.includes('spec')) {
      group = 'tests';
    } else if (ext === '.md' || ext === '.txt' || ext === '.rst') {
      group = 'docs';
    } else if (file.includes('.github') || file.includes('docker') || file.includes('ci')) {
      group = 'infra';
    } else if (ext === '.json' || ext === '.yaml' || ext === '.yml' || ext === '.toml') {
      group = 'config';
    } else {
      // Group by top-level directory
      var topDir = path.dirname(file).split(path.sep)[0] || 'root';
      group = topDir;
    }

    if (!groups[group]) {
      groups[group] = [];
    }
    groups[group].push(file);
  }

  return Object.keys(groups).map(function(name) {
    return { name: name, files: groups[name] };
  });
}

/**
 * Validate a commit message against conventional commit format.
 *
 * @param {string} message - Commit message
 * @returns {{ valid: boolean, type?: string, scope?: string, error?: string }}
 */
function validateMessage(message) {
  if (!message || !message.trim()) {
    return { valid: false, error: 'Empty commit message' };
  }

  var match = message.match(CONVENTIONAL_REGEX);
  if (!match) {
    return { valid: false, error: 'Does not follow conventional format: type(scope): description' };
  }

  return {
    valid: true,
    type: match[1],
    scope: match[2] ? match[2].replace(/[()]/g, '') : null
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  validateCommit,
  validateMessage,
  detectMixedConcerns,
  suggestSplit,
  CONVENTIONAL_REGEX,
  DEFAULT_LIMITS
};
