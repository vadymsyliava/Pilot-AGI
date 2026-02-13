/**
 * Post-Merge Quality Sweep — Phase 8.12 (Pilot AGI-9cdp)
 *
 * After every merge, runs full quality scan. Detects new duplicates,
 * dead code, naming inconsistencies. Tracks quality score trends.
 * Auto-creates follow-up tasks for issues found.
 */

const fs = require('fs');
const path = require('path');

const SCORES_FILE = '.claude/pilot/registry/quality-scores.json';
const SWEEP_LOG = '.claude/pilot/registry/sweep-log.jsonl';

// =============================================================================
// QUALITY SCORE CALCULATION
// =============================================================================

/**
 * Run a full quality sweep on the project.
 *
 * @param {object} opts - { projectRoot?, changedFiles? }
 * @returns {object} Sweep result with scores
 */
function runSweep(opts) {
  opts = opts || {};
  const projectRoot = opts.projectRoot || process.cwd();
  const timestamp = new Date().toISOString();

  const scores = {
    duplicates: 1.0,
    dead_code: 1.0,
    naming: 1.0,
    patterns: 1.0,
    overall: 1.0
  };

  const issues = [];

  // 1. Check for duplicate functions
  try {
    const dupDetector = require('./duplicate-detector');
    const stats = dupDetector.getStats();
    if (stats.total_functions > 0) {
      const index = dupDetector.loadIndex();
      const bodyHashes = {};
      let dupCount = 0;

      for (const entry of index) {
        if (!entry.body_hash || entry.body_hash === '') continue;
        if (bodyHashes[entry.body_hash]) {
          dupCount++;
          issues.push({
            type: 'duplicate_function',
            severity: 'warning',
            description: `"${entry.name}" in ${entry.file_path} duplicates "${bodyHashes[entry.body_hash].name}" in ${bodyHashes[entry.body_hash].file_path}`
          });
        } else {
          bodyHashes[entry.body_hash] = entry;
        }
      }

      scores.duplicates = Math.max(0, 1 - (dupCount * 0.1));
    }
  } catch (e) { /* module not available */ }

  // 2. Check naming consistency
  try {
    const namingEnforcer = require('./naming-enforcer');
    const inconsistencies = namingEnforcer.detectInconsistencies({ projectRoot });
    if (inconsistencies.length > 0) {
      for (const inc of inconsistencies) {
        issues.push({
          type: 'naming_inconsistency',
          severity: 'warning',
          description: `Concept "${inc.concept}" has inconsistent names: ${inc.base_names.join(', ')}`
        });
      }
      scores.naming = Math.max(0, 1 - (inconsistencies.length * 0.15));
    }
  } catch (e) { /* module not available */ }

  // 3. Check canonical pattern compliance
  try {
    const canonicalPatterns = require('./canonical-patterns');
    const conflicts = canonicalPatterns.getAllConflicts();
    if (conflicts.length > 0) {
      for (const conflict of conflicts) {
        issues.push({
          type: 'pattern_conflict',
          severity: 'info',
          description: `Conflicting patterns in ${conflict.category}: "${conflict.pattern_a.name}" vs "${conflict.pattern_b.name}"`
        });
      }
      scores.patterns = Math.max(0, 1 - (conflicts.length * 0.1));
    }
  } catch (e) { /* module not available */ }

  // Calculate overall
  scores.overall = (
    scores.duplicates * 0.30 +
    scores.dead_code * 0.25 +
    scores.naming * 0.25 +
    scores.patterns * 0.20
  );
  scores.overall = Math.round(scores.overall * 100) / 100;

  const result = {
    timestamp,
    scores,
    issues,
    issue_count: issues.length,
    changed_files: opts.changedFiles || []
  };

  // Save score history
  saveScore(result);

  // Log sweep
  logSweep(result);

  return result;
}

// =============================================================================
// SCORE COMPARISON
// =============================================================================

/**
 * Compare current sweep with previous to detect regressions.
 *
 * @param {object} current - Current sweep result
 * @returns {{ regressed, improved, changes }}
 */
function compareWithPrevious(current) {
  const history = loadScoreHistory();
  if (history.length < 2) return { regressed: false, improved: false, changes: [] };

  const previous = history[history.length - 2]; // second-to-last
  const changes = [];

  for (const key of ['duplicates', 'dead_code', 'naming', 'patterns', 'overall']) {
    const prev = previous.scores[key] || 1;
    const curr = current.scores[key] || 1;
    const diff = curr - prev;

    if (Math.abs(diff) > 0.01) {
      changes.push({
        metric: key,
        previous: prev,
        current: curr,
        diff: Math.round(diff * 100) / 100,
        direction: diff > 0 ? 'improved' : 'regressed'
      });
    }
  }

  const regressed = changes.some(c => c.direction === 'regressed');
  const improved = changes.some(c => c.direction === 'improved');

  return { regressed, improved, changes };
}

// =============================================================================
// FOLLOW-UP TASK GENERATION
// =============================================================================

/**
 * Generate follow-up tasks from sweep issues.
 *
 * @param {object} sweepResult - Output from runSweep
 * @returns {Array<{ title, description, type, priority }>}
 */
function generateFollowUpTasks(sweepResult) {
  if (!sweepResult || !sweepResult.issues) return [];

  const tasks = [];
  const grouped = {};

  // Group issues by type
  for (const issue of sweepResult.issues) {
    if (!grouped[issue.type]) grouped[issue.type] = [];
    grouped[issue.type].push(issue);
  }

  // Create one task per issue type
  for (const [type, issues] of Object.entries(grouped)) {
    const priority = issues[0].severity === 'warning' ? 2 : 3;

    tasks.push({
      title: `Fix ${type.replace(/_/g, ' ')}: ${issues.length} issue(s)`,
      description: issues.map(i => `- ${i.description}`).join('\n'),
      type: 'quality_followup',
      priority,
      issue_count: issues.length,
      source: 'quality_sweep'
    });
  }

  return tasks;
}

// =============================================================================
// TREND TRACKING
// =============================================================================

/**
 * Get quality score trend for the last N sweeps.
 *
 * @param {number} count - Number of entries
 * @returns {Array<{ timestamp, overall, issue_count }>}
 */
function getTrend(count) {
  count = count || 10;
  const history = loadScoreHistory();
  return history.slice(-count).map(h => ({
    timestamp: h.timestamp,
    overall: h.scores.overall,
    issue_count: h.issue_count
  }));
}

/**
 * Check if quality is trending down over N sweeps.
 *
 * @param {number} windowSize - Number of sweeps to consider
 * @returns {{ trending_down, decline_amount }}
 */
function checkTrend(windowSize) {
  windowSize = windowSize || 5;
  const trend = getTrend(windowSize);
  if (trend.length < 2) return { trending_down: false, decline_amount: 0 };

  const first = trend[0].overall;
  const last = trend[trend.length - 1].overall;
  const decline = first - last;

  return {
    trending_down: decline > 0.05, // 5% decline threshold
    decline_amount: Math.round(decline * 100) / 100
  };
}

// =============================================================================
// SCORE STORAGE
// =============================================================================

function getScoresPath() {
  return path.join(process.cwd(), SCORES_FILE);
}

function loadScoreHistory() {
  const filePath = getScoresPath();
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveScore(sweepResult) {
  const dir = path.dirname(getScoresPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const history = loadScoreHistory();
  history.push({
    timestamp: sweepResult.timestamp,
    scores: sweepResult.scores,
    issue_count: sweepResult.issue_count
  });

  // Keep last 100 entries
  const trimmed = history.slice(-100);
  const filePath = getScoresPath();
  fs.writeFileSync(filePath, JSON.stringify(trimmed, null, 2), 'utf8');
}

function logSweep(result) {
  const logPath = path.join(process.cwd(), SWEEP_LOG);
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const entry = JSON.stringify({
    ts: result.timestamp,
    overall: result.scores.overall,
    issues: result.issue_count,
    changed: (result.changed_files || []).length
  });
  fs.appendFileSync(logPath, entry + '\n');
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Core
  runSweep,
  compareWithPrevious,

  // Follow-up
  generateFollowUpTasks,

  // Trends
  getTrend,
  checkTrend,

  // Storage
  loadScoreHistory,
  saveScore
};
