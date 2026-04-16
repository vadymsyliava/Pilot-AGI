/**
 * CI Check Monitor (Phase 5.11)
 *
 * Watches and responds to CI check results on GitHub PRs.
 * Polls `gh pr checks` for status, extracts failure details,
 * and signals PM for merge approval on success.
 *
 * Used by PM loop's _prMonitorScan() to track CI progress.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds

// ============================================================================
// STATUS CHECKING
// ============================================================================

/**
 * Check CI status for a PR (single poll).
 *
 * @param {number} prNumber - PR number
 * @param {object} [opts] - Options
 * @param {string} [opts.projectRoot] - Project root
 * @returns {{ status: string, checks: Array, summary: object }}
 */
function checkStatus(prNumber, opts) {
  var cwd = (opts && opts.projectRoot) || process.cwd();

  try {
    var output = execFileSync('gh', [
      'pr', 'view', String(prNumber),
      '--json', 'statusCheckRollup'
    ], { cwd: cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

    var data = JSON.parse(output);
    var checks = data.statusCheckRollup || [];

    var passed = 0;
    var failed = 0;
    var pending = 0;
    var total = checks.length;

    for (var i = 0; i < checks.length; i++) {
      var c = checks[i];
      if (c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL') {
        passed++;
      } else if (c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT') {
        failed++;
      } else {
        pending++;
      }
    }

    var status;
    if (total === 0) {
      status = 'no_checks';
    } else if (failed > 0) {
      status = 'fail';
    } else if (pending > 0) {
      status = 'pending';
    } else {
      status = 'pass';
    }

    return {
      status: status,
      checks: checks.map(function(c) {
        return {
          name: c.name || c.context || 'unknown',
          status: c.status || 'UNKNOWN',
          conclusion: c.conclusion || null,
          url: c.detailsUrl || c.targetUrl || null
        };
      }),
      summary: {
        total: total,
        passed: passed,
        failed: failed,
        pending: pending
      }
    };
  } catch (e) {
    return {
      status: 'error',
      checks: [],
      summary: { total: 0, passed: 0, failed: 0, pending: 0 },
      error: e.message
    };
  }
}

/**
 * Wait for CI checks to complete (blocking poll loop).
 * Used for synchronous workflows; PM loop uses checkStatus() directly.
 *
 * @param {number} prNumber - PR number
 * @param {object} [opts] - Options
 * @param {number} [opts.timeout] - Timeout in ms (default: 30 min)
 * @param {number} [opts.pollInterval] - Poll interval in ms (default: 30s)
 * @param {string} [opts.projectRoot] - Project root
 * @returns {{ status: string, checks: Array, duration: number }}
 */
function waitForChecks(prNumber, opts) {
  var timeout = (opts && opts.timeout) || DEFAULT_TIMEOUT_MS;
  var pollInterval = (opts && opts.pollInterval) || POLL_INTERVAL_MS;
  var projectRoot = (opts && opts.projectRoot) || process.cwd();
  var startTime = Date.now();

  while (true) {
    var elapsed = Date.now() - startTime;
    if (elapsed >= timeout) {
      return {
        status: 'timeout',
        checks: [],
        duration: elapsed
      };
    }

    var result = checkStatus(prNumber, { projectRoot: projectRoot });
    if (result.status === 'pass' || result.status === 'fail' || result.status === 'no_checks') {
      result.duration = Date.now() - startTime;
      return result;
    }

    // Sleep for poll interval (blocking)
    try {
      execFileSync('sleep', [String(pollInterval / 1000)], { stdio: 'pipe' });
    } catch (e) {
      // sleep not available on all platforms — use busy wait
      var sleepEnd = Date.now() + pollInterval;
      while (Date.now() < sleepEnd) { /* busy wait */ }
    }
  }
}

/**
 * Extract failure details from check results.
 *
 * @param {Array} checks - Array of check objects from checkStatus()
 * @returns {{ failing: Array<{name: string, url: string}>, details: string }}
 */
function extractFailureDetails(checks) {
  var failing = [];
  for (var i = 0; i < checks.length; i++) {
    var c = checks[i];
    if (c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT') {
      failing.push({
        name: c.name || 'unknown',
        conclusion: c.conclusion,
        url: c.url || null
      });
    }
  }

  var details = failing.length === 0
    ? 'No failures detected'
    : failing.map(function(f) {
        return f.name + ' (' + f.conclusion + ')' + (f.url ? ' - ' + f.url : '');
      }).join('\n');

  return { failing: failing, details: details };
}

/**
 * Determine if checks have passed and PR is ready to merge.
 *
 * @param {number} prNumber - PR number
 * @param {object} [opts] - Options
 * @param {string} [opts.projectRoot] - Project root
 * @param {boolean} [opts.requireChecks] - Require CI checks to pass (default: true)
 * @returns {{ ready: boolean, reason: string }}
 */
function isReadyToMerge(prNumber, opts) {
  var projectRoot = (opts && opts.projectRoot) || process.cwd();
  var requireChecks = opts && opts.requireChecks !== undefined ? opts.requireChecks : true;

  var result = checkStatus(prNumber, { projectRoot: projectRoot });

  if (result.status === 'error') {
    return { ready: false, reason: 'Cannot check status: ' + result.error };
  }

  if (result.status === 'no_checks' && !requireChecks) {
    return { ready: true, reason: 'No checks configured, merge allowed' };
  }

  if (result.status === 'no_checks') {
    return { ready: false, reason: 'No CI checks configured' };
  }

  if (result.status === 'pending') {
    return { ready: false, reason: 'CI checks still running (' + result.summary.pending + ' pending)' };
  }

  if (result.status === 'fail') {
    var failures = extractFailureDetails(result.checks);
    return { ready: false, reason: 'CI checks failed: ' + failures.details };
  }

  return { ready: true, reason: 'All ' + result.summary.passed + ' checks passed' };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  checkStatus,
  waitForChecks,
  extractFailureDetails,
  isReadyToMerge,
  DEFAULT_TIMEOUT_MS,
  POLL_INTERVAL_MS
};
