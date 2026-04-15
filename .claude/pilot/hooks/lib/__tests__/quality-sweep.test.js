/**
 * Tests for Post-Merge Quality Sweep — Phase 8.12 (Pilot AGI-9cdp)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/quality-sweep.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsweep-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/registry'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModule() {
  const mods = ['../quality-sweep', '../duplicate-detector', '../naming-enforcer', '../canonical-patterns', '../project-registry'];
  for (const mod of mods) {
    try { delete require.cache[require.resolve(mod)]; } catch (e) {}
  }
  return require('../quality-sweep');
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  setup();
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (e) {
    console.error(`  \u2717 ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  } finally {
    teardown();
  }
}

console.log('\n=== Quality Sweep Tests ===\n');

// --- runSweep ---

test('runSweep returns scores and issues', () => {
  const qs = freshModule();
  const result = qs.runSweep({ projectRoot: testDir });

  assert.ok(result.timestamp);
  assert.ok(result.scores);
  assert.strictEqual(typeof result.scores.overall, 'number');
  assert.ok(result.scores.overall >= 0 && result.scores.overall <= 1);
  assert.ok(Array.isArray(result.issues));
});

test('runSweep saves score to history', () => {
  const qs = freshModule();
  qs.runSweep({ projectRoot: testDir });

  const history = qs.loadScoreHistory();
  assert.strictEqual(history.length, 1);
});

test('runSweep with clean project returns perfect score', () => {
  const qs = freshModule();
  const result = qs.runSweep({ projectRoot: testDir });

  assert.strictEqual(result.scores.overall, 1);
  assert.strictEqual(result.issue_count, 0);
});

// --- compareWithPrevious ---

test('compareWithPrevious detects regression', () => {
  const qs = freshModule();

  // Save two scores — second is worse
  qs.saveScore({
    timestamp: '2026-02-12T00:00:00Z',
    scores: { duplicates: 1, dead_code: 1, naming: 1, patterns: 1, overall: 1 },
    issue_count: 0
  });
  qs.saveScore({
    timestamp: '2026-02-13T00:00:00Z',
    scores: { duplicates: 0.5, dead_code: 1, naming: 1, patterns: 1, overall: 0.85 },
    issue_count: 2
  });

  const current = {
    scores: { duplicates: 0.5, dead_code: 1, naming: 1, patterns: 1, overall: 0.85 }
  };
  const comparison = qs.compareWithPrevious(current);
  assert.strictEqual(comparison.regressed, true);
  assert.ok(comparison.changes.length > 0);
});

test('compareWithPrevious returns no change for first sweep', () => {
  const qs = freshModule();
  qs.saveScore({
    timestamp: '2026-02-13T00:00:00Z',
    scores: { overall: 1 },
    issue_count: 0
  });

  const comparison = qs.compareWithPrevious({ scores: { overall: 1 } });
  assert.strictEqual(comparison.regressed, false);
});

// --- generateFollowUpTasks ---

test('generateFollowUpTasks creates tasks from issues', () => {
  const qs = freshModule();
  const sweep = {
    issues: [
      { type: 'duplicate_function', severity: 'warning', description: 'foo duplicates bar' },
      { type: 'duplicate_function', severity: 'warning', description: 'baz duplicates qux' },
      { type: 'naming_inconsistency', severity: 'warning', description: 'user vs member' }
    ]
  };

  const tasks = qs.generateFollowUpTasks(sweep);
  assert.strictEqual(tasks.length, 2); // 2 issue types
  assert.ok(tasks[0].title.includes('duplicate function'));
  assert.strictEqual(tasks[0].issue_count, 2);
});

test('generateFollowUpTasks returns empty for no issues', () => {
  const qs = freshModule();
  const tasks = qs.generateFollowUpTasks({ issues: [] });
  assert.strictEqual(tasks.length, 0);
});

// --- getTrend ---

test('getTrend returns recent scores', () => {
  const qs = freshModule();
  for (let i = 0; i < 5; i++) {
    qs.saveScore({
      timestamp: `2026-02-${10 + i}T00:00:00Z`,
      scores: { overall: 1 - (i * 0.05) },
      issue_count: i
    });
  }

  const trend = qs.getTrend(3);
  assert.strictEqual(trend.length, 3);
  assert.ok(trend[0].overall >= trend[2].overall);
});

// --- checkTrend ---

test('checkTrend detects declining quality', () => {
  const qs = freshModule();
  qs.saveScore({ timestamp: '2026-02-10T00:00:00Z', scores: { overall: 0.95 }, issue_count: 1 });
  qs.saveScore({ timestamp: '2026-02-11T00:00:00Z', scores: { overall: 0.90 }, issue_count: 2 });
  qs.saveScore({ timestamp: '2026-02-12T00:00:00Z', scores: { overall: 0.85 }, issue_count: 3 });
  qs.saveScore({ timestamp: '2026-02-13T00:00:00Z', scores: { overall: 0.80 }, issue_count: 4 });

  const result = qs.checkTrend(4);
  assert.strictEqual(result.trending_down, true);
  assert.ok(result.decline_amount > 0.05);
});

test('checkTrend returns stable for consistent quality', () => {
  const qs = freshModule();
  qs.saveScore({ timestamp: '2026-02-10T00:00:00Z', scores: { overall: 0.95 }, issue_count: 0 });
  qs.saveScore({ timestamp: '2026-02-11T00:00:00Z', scores: { overall: 0.95 }, issue_count: 0 });
  qs.saveScore({ timestamp: '2026-02-12T00:00:00Z', scores: { overall: 0.96 }, issue_count: 0 });

  const result = qs.checkTrend(3);
  assert.strictEqual(result.trending_down, false);
});

// --- Edge cases ---

test('loadScoreHistory returns empty for fresh project', () => {
  const qs = freshModule();
  assert.deepStrictEqual(qs.loadScoreHistory(), []);
});

test('generateFollowUpTasks handles null input', () => {
  const qs = freshModule();
  assert.deepStrictEqual(qs.generateFollowUpTasks(null), []);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
