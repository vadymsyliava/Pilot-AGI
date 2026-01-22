/**
 * Benchmark Utilities
 *
 * Aggregates and reports performance metrics for Pilot AGI workflows.
 */

const fs = require('fs');
const path = require('path');

/**
 * Default benchmark targets
 */
const DEFAULT_TARGETS = {
  init_to_commit_minutes: 15,
  test_coverage_percent: 80,
  security_critical_high: 0,
  duplicate_percent: 5,
  file_size_violations: 0
};

/**
 * Load benchmark configuration
 */
function loadConfig() {
  const configPaths = [
    path.join(process.cwd(), '.claude', 'pilot', 'config.json'),
    path.join(process.env.HOME || '', '.claude', 'pilot', 'config.json'),
    path.join(__dirname, '..', '..', 'config.default.json')
  ];

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return config.benchmarks || { targets: DEFAULT_TARGETS };
      } catch (e) {
        continue;
      }
    }
  }

  return { targets: DEFAULT_TARGETS };
}

/**
 * Calculate status icon and color based on value vs target
 */
function getStatus(value, target, lowerIsBetter = true) {
  if (value === null || value === undefined) {
    return { icon: '?', status: 'unknown' };
  }

  const isGood = lowerIsBetter ? value <= target : value >= target;
  const isClose = lowerIsBetter
    ? value <= target * 1.2
    : value >= target * 0.8;

  if (isGood) {
    return { icon: '✓', status: 'pass' };
  } else if (isClose) {
    return { icon: '⚠', status: 'warn' };
  }
  return { icon: '✗', status: 'fail' };
}

/**
 * Format a benchmark report
 */
function formatReport(metrics, targets = null) {
  const config = loadConfig();
  const t = targets || config.targets || DEFAULT_TARGETS;

  const lines = [
    '╔══════════════════════════════════════════════════════════════╗',
    '║  PERFORMANCE BENCHMARKS                                      ║',
    '╚══════════════════════════════════════════════════════════════╝',
    ''
  ];

  // Init to commit
  if (metrics.init_to_commit_minutes !== undefined) {
    const { icon } = getStatus(metrics.init_to_commit_minutes, t.init_to_commit_minutes);
    lines.push(`  ${icon} Init to commit: ${metrics.init_to_commit_minutes}m (target: <${t.init_to_commit_minutes}m)`);
  }

  // Test coverage
  if (metrics.test_coverage_percent !== undefined) {
    const { icon } = getStatus(metrics.test_coverage_percent, t.test_coverage_percent, false);
    lines.push(`  ${icon} Test coverage: ${metrics.test_coverage_percent}% (target: >${t.test_coverage_percent}%)`);
  }

  // Security vulnerabilities
  if (metrics.security_critical_high !== undefined) {
    const { icon } = getStatus(metrics.security_critical_high, t.security_critical_high);
    lines.push(`  ${icon} Security (critical/high): ${metrics.security_critical_high} (target: ${t.security_critical_high})`);
  }

  // Duplicate code
  if (metrics.duplicate_percent !== undefined) {
    const { icon } = getStatus(metrics.duplicate_percent, t.duplicate_percent);
    lines.push(`  ${icon} Duplicate code: ${metrics.duplicate_percent}% (target: <${t.duplicate_percent}%)`);
  }

  // File size violations
  if (metrics.file_size_violations !== undefined) {
    const { icon } = getStatus(metrics.file_size_violations, t.file_size_violations);
    lines.push(`  ${icon} File size violations: ${metrics.file_size_violations} (target: ${t.file_size_violations})`);
  }

  // Quality gate timing
  if (metrics.quality_gate_duration_ms !== undefined) {
    lines.push(`  ⏱ Quality gates: ${metrics.quality_gate_duration_ms}ms`);
  }

  lines.push('');
  lines.push('────────────────────────────────────────────────────────────────');

  return lines.join('\n');
}

/**
 * Save metrics to file
 */
function saveMetrics(metrics, metricsFile = null) {
  const config = loadConfig();
  const filePath = metricsFile || config.tracking?.metrics_file || 'work/metrics/benchmarks.json';
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);

  // Ensure directory exists
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Load existing metrics or start fresh
  let allMetrics = [];
  if (fs.existsSync(fullPath)) {
    try {
      allMetrics = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      if (!Array.isArray(allMetrics)) {
        allMetrics = [allMetrics];
      }
    } catch (e) {
      allMetrics = [];
    }
  }

  // Add timestamp and append
  const entry = {
    timestamp: new Date().toISOString(),
    ...metrics
  };
  allMetrics.push(entry);

  // Keep last 100 entries
  if (allMetrics.length > 100) {
    allMetrics = allMetrics.slice(-100);
  }

  fs.writeFileSync(fullPath, JSON.stringify(allMetrics, null, 2));
  return fullPath;
}

/**
 * Load and summarize recent metrics
 */
function loadRecentMetrics(metricsFile = null, count = 10) {
  const config = loadConfig();
  const filePath = metricsFile || config.tracking?.metrics_file || 'work/metrics/benchmarks.json';
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);

  if (!fs.existsSync(fullPath)) {
    return [];
  }

  try {
    let allMetrics = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    if (!Array.isArray(allMetrics)) {
      allMetrics = [allMetrics];
    }
    return allMetrics.slice(-count);
  } catch (e) {
    return [];
  }
}

/**
 * Calculate trend from recent metrics
 */
function calculateTrend(recentMetrics, field) {
  const values = recentMetrics
    .map(m => m[field])
    .filter(v => v !== null && v !== undefined);

  if (values.length < 2) {
    return { trend: 'stable', change: 0 };
  }

  const recent = values.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, values.length);
  const older = values.slice(0, -3).reduce((a, b) => a + b, 0) / Math.max(1, values.length - 3);

  if (older === 0) {
    return { trend: 'stable', change: 0 };
  }

  const change = ((recent - older) / older) * 100;

  if (Math.abs(change) < 5) {
    return { trend: 'stable', change: Math.round(change) };
  } else if (change > 0) {
    return { trend: 'up', change: Math.round(change) };
  }
  return { trend: 'down', change: Math.round(change) };
}

module.exports = {
  loadConfig,
  formatReport,
  saveMetrics,
  loadRecentMetrics,
  calculateTrend,
  getStatus,
  DEFAULT_TARGETS
};
