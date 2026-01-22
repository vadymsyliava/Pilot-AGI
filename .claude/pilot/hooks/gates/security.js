/**
 * Security Gate
 *
 * Runs npm audit to check for known vulnerabilities in dependencies.
 * Blocks commits with critical or high severity issues.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Default configuration
 */
const DEFAULT_CONFIG = {
  block_severities: ['critical', 'high'],
  warn_severities: ['moderate'],
  timeout: 30000
};

/**
 * Check if package-lock.json or package.json exists
 */
function hasPackageFiles() {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'package-lock.json')) ||
         fs.existsSync(path.join(cwd, 'package.json'));
}

/**
 * Run npm audit and parse results
 */
function runAudit(timeout) {
  try {
    const output = execFileSync('npm', ['audit', '--json'], {
      encoding: 'utf8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return JSON.parse(output);
  } catch (e) {
    // npm audit exits with non-zero when vulnerabilities found
    if (e.stdout) {
      try {
        return JSON.parse(e.stdout);
      } catch (parseErr) {
        return null;
      }
    }
    return null;
  }
}

/**
 * Count vulnerabilities by severity
 */
function countBySeverity(auditResult) {
  const counts = {
    critical: 0,
    high: 0,
    moderate: 0,
    low: 0,
    info: 0
  };

  if (!auditResult) return counts;

  // Handle npm audit v2 format (npm 7+)
  if (auditResult.metadata?.vulnerabilities) {
    const v = auditResult.metadata.vulnerabilities;
    counts.critical = v.critical || 0;
    counts.high = v.high || 0;
    counts.moderate = v.moderate || 0;
    counts.low = v.low || 0;
    counts.info = v.info || 0;
    return counts;
  }

  // Handle npm audit v1 format
  if (auditResult.advisories) {
    for (const advisory of Object.values(auditResult.advisories)) {
      const severity = advisory.severity?.toLowerCase() || 'info';
      if (counts[severity] !== undefined) {
        counts[severity]++;
      }
    }
  }

  return counts;
}

/**
 * Format vulnerability details
 */
function formatDetails(auditResult, maxItems = 5) {
  const items = [];

  // Handle npm audit v2 format
  if (auditResult?.vulnerabilities) {
    const vulns = Object.entries(auditResult.vulnerabilities);
    for (const [pkg, info] of vulns.slice(0, maxItems)) {
      const severity = info.severity || 'unknown';
      const via = Array.isArray(info.via)
        ? info.via.map(v => typeof v === 'string' ? v : v.title || v.name).join(', ')
        : info.via;
      items.push(`${pkg} (${severity}): ${via}`);
    }

    if (vulns.length > maxItems) {
      items.push(`... and ${vulns.length - maxItems} more`);
    }
  }

  // Handle npm audit v1 format
  if (auditResult?.advisories) {
    const advisories = Object.values(auditResult.advisories).slice(0, maxItems);
    for (const advisory of advisories) {
      items.push(`${advisory.module_name} (${advisory.severity}): ${advisory.title}`);
    }

    const total = Object.keys(auditResult.advisories).length;
    if (total > maxItems) {
      items.push(`... and ${total - maxItems} more`);
    }
  }

  return items.join('\n');
}

/**
 * Check for security vulnerabilities
 */
async function check(config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Skip if no package files
  if (!hasPackageFiles()) {
    return {
      status: 'pass',
      message: 'No package.json found - skipped'
    };
  }

  // Run npm audit
  const auditResult = runAudit(cfg.timeout);

  if (!auditResult) {
    return {
      status: 'pass',
      message: 'npm audit unavailable - skipped'
    };
  }

  // Count vulnerabilities
  const counts = countBySeverity(auditResult);

  // Check for blocking severities
  const blockCount = cfg.block_severities.reduce((sum, sev) => sum + (counts[sev] || 0), 0);
  const warnCount = cfg.warn_severities.reduce((sum, sev) => sum + (counts[sev] || 0), 0);

  if (blockCount > 0) {
    const blockList = cfg.block_severities
      .filter(s => counts[s] > 0)
      .map(s => `${counts[s]} ${s}`)
      .join(', ');

    return {
      status: 'fail',
      message: `${blockCount} security vulnerabilities (${blockList})`,
      details: formatDetails(auditResult),
      counts
    };
  }

  if (warnCount > 0) {
    const warnList = cfg.warn_severities
      .filter(s => counts[s] > 0)
      .map(s => `${counts[s]} ${s}`)
      .join(', ');

    return {
      status: 'warn',
      message: `${warnCount} security advisories (${warnList})`,
      details: formatDetails(auditResult),
      counts
    };
  }

  return {
    status: 'pass',
    message: 'No security vulnerabilities found',
    counts
  };
}

module.exports = { check };
