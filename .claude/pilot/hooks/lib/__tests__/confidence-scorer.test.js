/**
 * Tests for Confidence Scorer — Phase 5.1
 *
 * Test groups:
 *  1. scorePlan basics
 *  2. Scope factor
 *  3. Risk classifier (file patterns)
 *  4. Risk from task text
 *  5. LOW_RISK_PATTERNS boost
 *  6. Familiarity factor
 *  7. Historical factor
 *  8. Custom thresholds and weights
 *  9. recordOutcome / readOutcomes
 * 10. scoreAndRecord / loadScore
 * 11. getAccuracyMetrics
 * 12. suggestThresholdAdjustment
 * 13. Override: always_require
 * 14. Override: always_auto
 * 15. getAllPlanFiles
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/confidence-scorer.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// ============================================================================
// TEST INFRASTRUCTURE
// ============================================================================

let testDir;
let originalCwd;

function setup(policyExtra = '') {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confidence-scorer-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/approval-history'), { recursive: true });

  // Write minimal policy.yaml so loadThresholds/loadWeights don't throw
  const policyContent = `
approval:
  confidence_thresholds:
    auto: 0.85
    notify: 0.60
  confidence_weights:
    scope: 0.20
    familiarity: 0.30
    historical_success: 0.25
    risk: 0.25
${policyExtra}
`;
  fs.mkdirSync(path.join(testDir, '.claude/pilot'), { recursive: true });
  fs.writeFileSync(path.join(testDir, '.claude/pilot/policy.yaml'), policyContent);

  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModule() {
  const modPaths = [
    '../confidence-scorer',
    '../policy',
    '../session',
    '../memory',
    '../messaging'
  ];
  for (const modPath of modPaths) {
    try {
      const resolved = require.resolve(modPath);
      delete require.cache[resolved];
    } catch (e) { /* not loaded */ }
  }
  return require('../confidence-scorer');
}

// Helper: write outcomes.jsonl with given entries
function writeOutcomes(entries) {
  const histDir = path.join(testDir, '.claude/pilot/state/approval-history');
  fs.mkdirSync(histDir, { recursive: true });
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(histDir, 'outcomes.jsonl'), lines);
}

// ============================================================================
// TESTS
// ============================================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  // Support optional policyExtra argument passed via closure
  // Default setup with no extra policy
  if (!test._customSetup) {
    setup();
  }
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${e.message}`);
  } finally {
    teardown();
    test._customSetup = false;
  }
}

// Variant: setup with extra policy YAML
function testWithPolicy(name, policyExtra, fn) {
  setup(policyExtra);
  test._customSetup = true;
  test(name, fn);
}

console.log('\nConfidence Scorer Tests\n');

// ============================================================================
// 1. scorePlan basics
// ============================================================================

console.log('--- scorePlan basics ---');

test('scorePlan returns valid score structure', () => {
  const cs = freshModule();
  const plan = { steps: [{ description: 'update readme' }], files: ['README.md'] };
  const task = { id: 'task-1', title: 'Update readme', description: '', labels: [] };

  const result = cs.scorePlan(plan, task, {
    thresholds: cs.DEFAULT_THRESHOLDS,
    weights: cs.DEFAULT_WEIGHTS
  });

  assert.ok(typeof result.score === 'number', 'score should be a number');
  assert.ok(result.score >= 0 && result.score <= 1, 'score should be 0-1');
  assert.ok(['auto_approve', 'notify_approve', 'require_approve'].includes(result.tier), 'tier should be valid');
  assert.ok(result.factors, 'factors should exist');
  assert.ok(typeof result.factors.scope === 'number', 'factors.scope should be a number');
  assert.ok(typeof result.factors.familiarity === 'number', 'factors.familiarity should be a number');
  assert.ok(typeof result.factors.historical_success === 'number', 'factors.historical_success should be a number');
  assert.ok(typeof result.factors.risk === 'number', 'factors.risk should be a number');
  assert.ok(Array.isArray(result.risk_tags), 'risk_tags should be an array');
  assert.ok(typeof result.reasoning === 'string', 'reasoning should be a string');
});

test('scorePlan with minimal plan gives high scope score', () => {
  const cs = freshModule();
  const plan = { steps: [{ description: 'fix typo' }], files: ['README.md'] };
  const task = { id: 'task-2', title: 'Fix typo', description: 'Fix typo in readme', labels: [] };

  const result = cs.scorePlan(plan, task, {
    thresholds: cs.DEFAULT_THRESHOLDS,
    weights: cs.DEFAULT_WEIGHTS
  });

  assert.ok(result.factors.scope >= 0.7, `scope should be high for small plan, got ${result.factors.scope}`);
});

test('scorePlan tier is auto_approve when score >= 0.85', () => {
  const cs = freshModule();

  // Force high score via custom weights that heavily favor scope
  const result = cs.scorePlan(
    { steps: [{ description: 'a' }], files: ['test.md'] },
    { id: 't-1', title: 'Trivial', description: '', labels: [] },
    {
      thresholds: { auto_approve: 0.85, notify_approve: 0.60 },
      weights: { scope: 1.0, familiarity: 0, historical_success: 0, risk: 0 }
    }
  );

  assert.strictEqual(result.tier, 'auto_approve');
  assert.ok(result.score >= 0.85, `expected score >= 0.85, got ${result.score}`);
});

test('scorePlan tier is require_approve when score < 0.60', () => {
  const cs = freshModule();

  // Force low score via high-risk task and scope-heavy plan
  const result = cs.scorePlan(
    { steps: Array.from({ length: 15 }, (_, i) => ({ description: `step ${i}` })),
      files: Array.from({ length: 20 }, (_, i) => `src/auth/file${i}.js`) },
    { id: 't-r', title: 'Delete all user data and drop tables', description: 'Dangerous delete migration', labels: ['security'] },
    {
      thresholds: { auto_approve: 0.85, notify_approve: 0.60 },
      weights: cs.DEFAULT_WEIGHTS
    }
  );

  assert.strictEqual(result.tier, 'require_approve');
  assert.ok(result.score < 0.60, `expected score < 0.60, got ${result.score}`);
});

test('scorePlan reasoning string contains tier description', () => {
  const cs = freshModule();
  const result = cs.scorePlan(
    { steps: [{ description: 'a' }], files: ['test.md'] },
    { id: 't-1', title: 'Trivial', description: '', labels: [] },
    { thresholds: cs.DEFAULT_THRESHOLDS, weights: cs.DEFAULT_WEIGHTS }
  );

  assert.ok(result.reasoning.includes('Score'), 'reasoning should include Score');
  assert.ok(
    result.reasoning.includes('auto-approve') ||
    result.reasoning.includes('notify-approve') ||
    result.reasoning.includes('require human approval'),
    'reasoning should include tier label'
  );
});

// ============================================================================
// 2. Scope factor
// ============================================================================

console.log('--- Scope factor ---');

test('computeScopeFactor: 1 step, 1 file = 1.0', () => {
  const cs = freshModule();
  const factor = cs.computeScopeFactor({ steps: [{ description: 'a' }], files: ['a.js'] });
  assert.strictEqual(factor, 1.0);
});

test('computeScopeFactor: 2 steps, 3 files = 1.0', () => {
  const cs = freshModule();
  const factor = cs.computeScopeFactor({
    steps: [{ description: 'a' }, { description: 'b' }],
    files: ['a.js', 'b.js', 'c.js']
  });
  assert.strictEqual(factor, 1.0);
});

test('computeScopeFactor: 4 steps, 6 files = 0.7', () => {
  const cs = freshModule();
  const factor = cs.computeScopeFactor({
    steps: Array.from({ length: 4 }, (_, i) => ({ description: `s${i}` })),
    files: Array.from({ length: 6 }, (_, i) => `f${i}.js`)
  });
  assert.strictEqual(factor, 0.7);
});

test('computeScopeFactor: 8 steps, 12 files = 0.4', () => {
  const cs = freshModule();
  const factor = cs.computeScopeFactor({
    steps: Array.from({ length: 8 }, (_, i) => ({ description: `s${i}` })),
    files: Array.from({ length: 12 }, (_, i) => `f${i}.js`)
  });
  assert.strictEqual(factor, 0.4);
});

test('computeScopeFactor: 15 steps, 20 files = 0.2', () => {
  const cs = freshModule();
  const factor = cs.computeScopeFactor({
    steps: Array.from({ length: 15 }, (_, i) => ({ description: `s${i}` })),
    files: Array.from({ length: 20 }, (_, i) => `f${i}.js`)
  });
  assert.strictEqual(factor, 0.2);
});

test('computeScopeFactor: empty plan = high score (0 steps/files)', () => {
  const cs = freshModule();
  const factor = cs.computeScopeFactor({});
  // 0 steps => stepScore 1.0, 0 files => fileScore 1.0 → average 1.0
  assert.strictEqual(factor, 1.0);
});

test('computeScopeFactor: mixed steps/files bracket (3 steps, 10 files)', () => {
  const cs = freshModule();
  const factor = cs.computeScopeFactor({
    steps: Array.from({ length: 3 }, (_, i) => ({ description: `s${i}` })),
    files: Array.from({ length: 10 }, (_, i) => `f${i}.js`)
  });
  // 3 steps → 0.7, 10 files → 0.4 → average 0.55
  assert.strictEqual(factor, 0.55);
});

// ============================================================================
// 3. Risk classifier (file patterns)
// ============================================================================

console.log('--- Risk classifier (file patterns) ---');

test('computeRiskFactor: auth files trigger auth_related', () => {
  const cs = freshModule();
  const result = cs.computeRiskFactor(
    { files: ['src/auth/login.js'], steps: [] },
    { title: 'Update code', description: '', labels: [] }
  );
  assert.ok(result.tags.includes('auth_related'), `expected auth_related tag, got ${result.tags}`);
});

test('computeRiskFactor: deploy files trigger infra_touching', () => {
  const cs = freshModule();
  const result = cs.computeRiskFactor(
    { files: ['deploy/scripts/run.sh'], steps: [] },
    { title: 'Update code', description: '', labels: [] }
  );
  assert.ok(result.tags.includes('infra_touching'), `expected infra_touching tag, got ${result.tags}`);
});

test('computeRiskFactor: .env files trigger security_sensitive', () => {
  const cs = freshModule();
  const result = cs.computeRiskFactor(
    { files: ['.env.production'], steps: [] },
    { title: 'Update code', description: '', labels: [] }
  );
  assert.ok(result.tags.includes('security_sensitive'), `expected security_sensitive tag, got ${result.tags}`);
});

test('computeRiskFactor: migration files trigger database_migration', () => {
  const cs = freshModule();
  const result = cs.computeRiskFactor(
    { files: ['db/migration_001.sql'], steps: [] },
    { title: 'Update code', description: '', labels: [] }
  );
  assert.ok(result.tags.includes('database_migration'), `expected database_migration tag, got ${result.tags}`);
});

test('computeRiskFactor: credential files trigger security_sensitive', () => {
  const cs = freshModule();
  const result = cs.computeRiskFactor(
    { files: ['config/credentials.json'], steps: [] },
    { title: 'Update code', description: '', labels: [] }
  );
  assert.ok(result.tags.includes('security_sensitive'), `expected security_sensitive tag, got ${result.tags}`);
});

test('computeRiskFactor: no high-risk files = no risk tags from files', () => {
  const cs = freshModule();
  const result = cs.computeRiskFactor(
    { files: ['src/utils/helpers.js'], steps: [] },
    { title: 'Refactor utility', description: 'Clean up helpers', labels: [] }
  );
  assert.strictEqual(result.tags.length, 0, `expected no tags, got ${result.tags}`);
  assert.strictEqual(result.factor, 1.0, 'factor should be 1.0 with no risk');
});

test('computeRiskFactor: high risk tags reduce factor below 1.0', () => {
  const cs = freshModule();
  const result = cs.computeRiskFactor(
    { files: ['src/auth/login.js', '.env'], steps: [] },
    { title: 'Update code', description: '', labels: [] }
  );
  assert.ok(result.factor < 1.0, `factor should be < 1.0, got ${result.factor}`);
});

// ============================================================================
// 4. Risk from task text
// ============================================================================

console.log('--- Risk from task text ---');

test('computeRiskFactor: "delete user data" triggers data_loss', () => {
  const cs = freshModule();
  const result = cs.computeRiskFactor(
    { files: [], steps: [] },
    { title: 'Delete user data', description: 'Remove all user records', labels: [] }
  );
  assert.ok(result.tags.includes('data_loss'), `expected data_loss tag, got ${result.tags}`);
});

test('computeRiskFactor: "update login page" triggers auth_related and user_facing', () => {
  const cs = freshModule();
  const result = cs.computeRiskFactor(
    { files: [], steps: [] },
    { title: 'Update login page', description: 'Redesign the login form', labels: [] }
  );
  assert.ok(result.tags.includes('auth_related'), `expected auth_related, got ${result.tags}`);
  assert.ok(result.tags.includes('user_facing'), `expected user_facing, got ${result.tags}`);
});

test('computeRiskFactor: "deploy to production" triggers infra_touching', () => {
  const cs = freshModule();
  const result = cs.computeRiskFactor(
    { files: [], steps: [] },
    { title: 'Deploy to production', description: 'Run the CI pipeline', labels: [] }
  );
  assert.ok(result.tags.includes('infra_touching'), `expected infra_touching, got ${result.tags}`);
});

test('computeRiskFactor: "upgrade dependency" triggers dependency_update', () => {
  const cs = freshModule();
  const result = cs.computeRiskFactor(
    { files: [], steps: [] },
    { title: 'Upgrade dependency versions', description: 'Bump packages', labels: [] }
  );
  assert.ok(result.tags.includes('dependency_update'), `expected dependency_update, got ${result.tags}`);
});

test('computeRiskFactor: "alter table schema migration" triggers database_migration', () => {
  const cs = freshModule();
  const result = cs.computeRiskFactor(
    { files: [], steps: [] },
    { title: 'Run schema migration', description: 'alter table to add columns', labels: [] }
  );
  assert.ok(result.tags.includes('database_migration'), `expected database_migration, got ${result.tags}`);
});

test('computeRiskFactor: explicit risk_tags are included', () => {
  const cs = freshModule();
  const result = cs.computeRiskFactor(
    { files: [], steps: [] },
    { title: 'Normal task', description: '', labels: [] },
    ['data_loss', 'security_sensitive']
  );
  assert.ok(result.tags.includes('data_loss'), 'explicit data_loss should be present');
  assert.ok(result.tags.includes('security_sensitive'), 'explicit security_sensitive should be present');
});

// ============================================================================
// 5. LOW_RISK_PATTERNS boost
// ============================================================================

console.log('--- LOW_RISK_PATTERNS boost ---');

test('computeRiskFactor: all test files get low-risk bonus', () => {
  const cs = freshModule();
  const result = cs.computeRiskFactor(
    { files: ['src/__tests__/helpers.test.js', 'tests/unit/utils.spec.js'], steps: [] },
    { title: 'Add tests', description: 'Add unit tests', labels: [] }
  );
  // All files match LOW_RISK_PATTERNS → lowRiskBonus = 0.2
  // No risk tags from benign title → factor = 1.0 + 0.2 = clamped to 1.0
  assert.ok(result.factor >= 1.0, `test-only files should have factor >= 1.0, got ${result.factor}`);
});

test('computeRiskFactor: mixed test and src files get partial boost', () => {
  const cs = freshModule();
  const result = cs.computeRiskFactor(
    { files: ['src/__tests__/helpers.test.js', 'src/core/engine.js', 'tests/unit/utils.spec.js'], steps: [] },
    { title: 'Update engine', description: 'refactor', labels: [] }
  );
  // 2 of 3 files are low-risk (> half) → lowRiskBonus = 0.1
  // No risk tags → factor = 1.0 + 0.1 = clamped to 1.0
  assert.ok(result.factor >= 1.0, `majority test files should get partial bonus, got ${result.factor}`);
});

test('computeRiskFactor: docs-only files get low-risk bonus', () => {
  const cs = freshModule();
  const result = cs.computeRiskFactor(
    { files: ['docs/guide.md', 'README.md'], steps: [] },
    { title: 'Update docs', description: 'Fix typos', labels: [] }
  );
  assert.ok(result.factor >= 1.0, `docs-only files should have high factor, got ${result.factor}`);
});

test('computeRiskFactor: JSON/YAML config files get low-risk bonus', () => {
  const cs = freshModule();
  const result = cs.computeRiskFactor(
    { files: ['config.json', 'settings.yaml'], steps: [] },
    { title: 'Update config', description: 'Change settings', labels: [] }
  );
  assert.ok(result.factor >= 1.0, `config files should be low risk, got ${result.factor}`);
});

// ============================================================================
// 6. Familiarity factor
// ============================================================================

console.log('--- Familiarity factor ---');

test('computeFamiliarityFactor: no outcomes = 0.5 (neutral)', () => {
  const cs = freshModule();
  const factor = cs.computeFamiliarityFactor({ files: ['src/app.js'], steps: [] });
  assert.strictEqual(factor, 0.5);
});

test('computeFamiliarityFactor: no files in plan = 0.8', () => {
  const cs = freshModule();
  const factor = cs.computeFamiliarityFactor({ steps: [] });
  assert.strictEqual(factor, 0.8);
});

test('computeFamiliarityFactor: all files are familiar = high score', () => {
  const cs = freshModule();
  // Write outcomes where src/app.js was successfully worked on
  writeOutcomes([
    { success: true, files: ['src/app.js'], labels: [] },
    { success: true, files: ['src/app.js', 'src/utils.js'], labels: [] }
  ]);

  // Re-require to pick up new outcomes
  const cs2 = freshModule();
  const factor = cs2.computeFamiliarityFactor({ files: ['src/app.js'], steps: [] });
  // src/app.js is familiar → familiarCount/planFiles.length = 1.0 → 0.3 + 0.7*1.0 = 1.0
  assert.ok(factor >= 0.9, `all familiar files should score high, got ${factor}`);
});

test('computeFamiliarityFactor: unknown files = lower score', () => {
  const cs = freshModule();
  writeOutcomes([
    { success: true, files: ['src/app.js'], labels: [] }
  ]);

  const cs2 = freshModule();
  const factor = cs2.computeFamiliarityFactor({ files: ['src/brand_new.js'], steps: [] });
  // brand_new.js not in outcomes → familiarCount=0 → 0.3 + 0 = 0.3
  assert.ok(factor <= 0.5, `unknown files should score low, got ${factor}`);
});

test('computeFamiliarityFactor: partially familiar files = medium score', () => {
  const cs = freshModule();
  writeOutcomes([
    { success: true, files: ['src/app.js'], labels: [] }
  ]);

  const cs2 = freshModule();
  const factor = cs2.computeFamiliarityFactor({
    files: ['src/app.js', 'src/unknown.js'],
    steps: []
  });
  // 1 of 2 files familiar → 0.3 + 0.7 * 0.5 = 0.65
  assert.ok(factor > 0.5 && factor < 1.0, `partial familiarity should be medium, got ${factor}`);
});

test('computeFamiliarityFactor: only failed outcomes do not count', () => {
  const cs = freshModule();
  writeOutcomes([
    { success: false, files: ['src/app.js'], labels: [] }
  ]);

  const cs2 = freshModule();
  const factor = cs2.computeFamiliarityFactor({ files: ['src/app.js'], steps: [] });
  // Only failed outcomes → successfulFiles.size = 0 → returns 0.5
  assert.strictEqual(factor, 0.5);
});

// ============================================================================
// 7. Historical factor
// ============================================================================

console.log('--- Historical factor ---');

test('computeHistoricalFactor: no history = 0.5', () => {
  const cs = freshModule();
  const factor = cs.computeHistoricalFactor({ id: 'task-1', labels: [] });
  assert.strictEqual(factor, 0.5);
});

test('computeHistoricalFactor: all success = high rate', () => {
  const cs = freshModule();
  writeOutcomes(Array.from({ length: 10 }, () => ({ success: true, labels: [] })));

  const cs2 = freshModule();
  const factor = cs2.computeHistoricalFactor({ id: 'task-1', labels: [] });
  assert.strictEqual(factor, 1.0);
});

test('computeHistoricalFactor: all failures = 0', () => {
  const cs = freshModule();
  writeOutcomes(Array.from({ length: 10 }, () => ({ success: false, labels: [] })));

  const cs2 = freshModule();
  const factor = cs2.computeHistoricalFactor({ id: 'task-1', labels: [] });
  assert.strictEqual(factor, 0);
});

test('computeHistoricalFactor: mixed outcomes = medium', () => {
  const cs = freshModule();
  const outcomes = [];
  for (let i = 0; i < 10; i++) {
    outcomes.push({ success: i % 2 === 0, labels: [] }); // 5 success, 5 fail
  }
  writeOutcomes(outcomes);

  const cs2 = freshModule();
  const factor = cs2.computeHistoricalFactor({ id: 'task-1', labels: [] });
  assert.strictEqual(factor, 0.5);
});

test('computeHistoricalFactor: label boost when matching labels', () => {
  const cs = freshModule();
  const outcomes = [];
  for (let i = 0; i < 10; i++) {
    outcomes.push({ success: true, labels: ['bugfix'] });
  }
  writeOutcomes(outcomes);

  const cs2 = freshModule();
  const factorWithLabels = cs2.computeHistoricalFactor({ id: 'task-1', labels: ['bugfix'] });
  // 10 matching successes > 2 → labelBoost 0.1, rate 1.0, capped at 1.0
  assert.strictEqual(factorWithLabels, 1.0);

  // Compare: with non-matching labels, no boost
  const cs3 = freshModule();
  const factorNoLabels = cs3.computeHistoricalFactor({ id: 'task-1', labels: ['unrelated'] });
  // rate = 1.0, no label boost → still 1.0 (already maxed)
  assert.strictEqual(factorNoLabels, 1.0);
});

test('computeHistoricalFactor: label boost noticeable on mixed outcomes', () => {
  const cs = freshModule();
  // 7 success (5 with 'bugfix' label), 3 fail → rate = 0.7
  const outcomes = [];
  for (let i = 0; i < 5; i++) outcomes.push({ success: true, labels: ['bugfix'] });
  for (let i = 0; i < 2; i++) outcomes.push({ success: true, labels: [] });
  for (let i = 0; i < 3; i++) outcomes.push({ success: false, labels: [] });
  writeOutcomes(outcomes);

  const cs2 = freshModule();
  const factorWith = cs2.computeHistoricalFactor({ id: 'task-1', labels: ['bugfix'] });
  // rate = 0.7, matchingSuccess = 5 > 2 → labelBoost 0.1, total = 0.8
  assert.ok(Math.abs(factorWith - 0.8) < 1e-10, `expected ~0.8, got ${factorWith}`);

  const cs3 = freshModule();
  const factorWithout = cs3.computeHistoricalFactor({ id: 'task-1', labels: ['other'] });
  // rate = 0.7, no matching → labelBoost 0, total = 0.7
  assert.ok(Math.abs(factorWithout - 0.7) < 1e-10, `expected ~0.7, got ${factorWithout}`);
});

// ============================================================================
// 8. Custom thresholds and weights
// ============================================================================

console.log('--- Custom thresholds and weights ---');

test('scorePlan respects custom thresholds', () => {
  const cs = freshModule();
  const plan = { steps: [{ description: 'a' }], files: ['test.md'] };
  const task = { id: 't-1', title: 'Trivial', description: '', labels: [] };

  // With very low auto_approve threshold, everything auto-approves
  const result = cs.scorePlan(plan, task, {
    thresholds: { auto_approve: 0.10, notify_approve: 0.05 },
    weights: cs.DEFAULT_WEIGHTS
  });
  assert.strictEqual(result.tier, 'auto_approve');
});

test('scorePlan respects custom weights (scope dominant)', () => {
  const cs = freshModule();

  // Note: the module uses `weights.x || DEFAULT_WEIGHTS.x` so 0 falls back to defaults.
  // To test weight dominance, use very small values for non-dominant weights.
  const bigPlan = {
    steps: Array.from({ length: 15 }, (_, i) => ({ description: `s${i}` })),
    files: Array.from({ length: 20 }, (_, i) => `f${i}.js`)
  };
  const task = { id: 't-w', title: 'Big plan', description: '', labels: [] };

  // Scope-heavy: scope=0.90, others=small
  const result = cs.scorePlan(bigPlan, task, {
    thresholds: cs.DEFAULT_THRESHOLDS,
    weights: { scope: 0.90, familiarity: 0.04, historical_success: 0.03, risk: 0.03 }
  });

  // 15 steps → 0.2, 20 files → 0.2, scope factor = 0.2
  // Scope contribution dominates at 0.9*0.2 = 0.18
  // Total should be low → require_approve
  assert.ok(result.score < 0.60, `score should be < 0.60, got ${result.score}`);
  assert.strictEqual(result.tier, 'require_approve');
});

test('scorePlan respects custom weights (risk=1.0, others=0)', () => {
  const cs = freshModule();
  const plan = { steps: [{ description: 'a' }], files: ['src/utils.js'] };
  const task = { id: 't-r', title: 'Safe refactor', description: 'clean up utils', labels: [] };

  const result = cs.scorePlan(plan, task, {
    thresholds: cs.DEFAULT_THRESHOLDS,
    weights: { scope: 0, familiarity: 0, historical_success: 0, risk: 1.0 }
  });

  // No risk tags → risk factor = 1.0, score = 1.0 * 1.0 = 1.0
  assert.strictEqual(result.score, 1.0);
  assert.strictEqual(result.tier, 'auto_approve');
});

// ============================================================================
// 9. recordOutcome / readOutcomes
// ============================================================================

console.log('--- recordOutcome / readOutcomes ---');

test('recordOutcome writes to outcomes.jsonl', () => {
  const cs = freshModule();
  cs.recordOutcome('task-1', true, { files: ['a.js'], labels: ['bugfix'] });

  const outcomes = cs.readOutcomes();
  assert.strictEqual(outcomes.length, 1);
  assert.strictEqual(outcomes[0].task_id, 'task-1');
  assert.strictEqual(outcomes[0].success, true);
  assert.deepStrictEqual(outcomes[0].files, ['a.js']);
  assert.deepStrictEqual(outcomes[0].labels, ['bugfix']);
});

test('recordOutcome appends multiple outcomes', () => {
  const cs = freshModule();
  cs.recordOutcome('task-1', true, { files: ['a.js'] });
  cs.recordOutcome('task-2', false, { failure_reason: 'test failed' });
  cs.recordOutcome('task-3', true, { files: ['b.js'] });

  const outcomes = cs.readOutcomes();
  assert.strictEqual(outcomes.length, 3);
  assert.strictEqual(outcomes[0].task_id, 'task-1');
  assert.strictEqual(outcomes[1].task_id, 'task-2');
  assert.strictEqual(outcomes[1].success, false);
  assert.strictEqual(outcomes[1].failure_reason, 'test failed');
  assert.strictEqual(outcomes[2].task_id, 'task-3');
});

test('readOutcomes returns empty array when no file exists', () => {
  const cs = freshModule();
  const outcomes = cs.readOutcomes();
  assert.deepStrictEqual(outcomes, []);
});

test('recordOutcome includes score/tier from prior scoreAndRecord', () => {
  const cs = freshModule();
  const plan = { steps: [{ description: 'a' }], files: ['test.md'] };
  const task = { id: 'task-sr', title: 'Test', description: '', labels: [] };

  // Score first so there's a score file
  cs.scoreAndRecord(plan, task, {
    thresholds: cs.DEFAULT_THRESHOLDS,
    weights: cs.DEFAULT_WEIGHTS
  });

  // Now record outcome — it should pick up the score
  const outcome = cs.recordOutcome('task-sr', true, {});
  assert.ok(outcome.score !== null, 'outcome should include score from prior scoring');
  assert.ok(outcome.tier !== null, 'outcome should include tier from prior scoring');
});

// ============================================================================
// 10. scoreAndRecord / loadScore
// ============================================================================

console.log('--- scoreAndRecord / loadScore ---');

test('scoreAndRecord persists score to state file', () => {
  const cs = freshModule();
  const plan = { steps: [{ description: 'a' }], files: ['README.md'] };
  const task = { id: 'task-persist', title: 'Test', description: '', labels: [] };

  const result = cs.scoreAndRecord(plan, task, {
    thresholds: cs.DEFAULT_THRESHOLDS,
    weights: cs.DEFAULT_WEIGHTS
  });

  const loaded = cs.loadScore('task-persist');
  assert.ok(loaded, 'loadScore should return persisted score');
  assert.strictEqual(loaded.task_id, 'task-persist');
  assert.strictEqual(loaded.score, result.score);
  assert.strictEqual(loaded.tier, result.tier);
  assert.ok(loaded.scored_at, 'should have scored_at timestamp');
});

test('loadScore returns null for unknown task', () => {
  const cs = freshModule();
  assert.strictEqual(cs.loadScore('nonexistent'), null);
});

test('scoreAndRecord appends to scores.jsonl', () => {
  const cs = freshModule();
  const plan = { steps: [{ description: 'a' }], files: ['README.md'] };
  const task = { id: 'task-log', title: 'Test', description: '', labels: [] };

  cs.scoreAndRecord(plan, task, {
    thresholds: cs.DEFAULT_THRESHOLDS,
    weights: cs.DEFAULT_WEIGHTS
  });

  const logPath = path.join(testDir, '.claude/pilot/state/approval-history/scores.jsonl');
  assert.ok(fs.existsSync(logPath), 'scores.jsonl should exist');

  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.strictEqual(entry.task_id, 'task-log');
  assert.ok(typeof entry.score === 'number');
  assert.ok(typeof entry.tier === 'string');
});

test('scoreAndRecord includes plan_step_count and plan_file_count', () => {
  const cs = freshModule();
  const plan = {
    steps: [{ description: 'a' }, { description: 'b' }],
    files: ['x.js', 'y.js', 'z.js']
  };
  const task = { id: 'task-counts', title: 'Test', description: '', labels: [] };

  cs.scoreAndRecord(plan, task, {
    thresholds: cs.DEFAULT_THRESHOLDS,
    weights: cs.DEFAULT_WEIGHTS
  });

  const loaded = cs.loadScore('task-counts');
  assert.strictEqual(loaded.plan_step_count, 2);
  assert.strictEqual(loaded.plan_file_count, 3);
});

// ============================================================================
// 11. getAccuracyMetrics
// ============================================================================

console.log('--- getAccuracyMetrics ---');

test('getAccuracyMetrics: no outcomes = all zeros', () => {
  const cs = freshModule();
  const metrics = cs.getAccuracyMetrics();
  assert.strictEqual(metrics.total, 0);
  assert.strictEqual(metrics.correct_auto, 0);
  assert.strictEqual(metrics.false_auto, 0);
  assert.strictEqual(metrics.correct_require, 0);
  assert.strictEqual(metrics.accuracy, 0);
});

test('getAccuracyMetrics: correct_auto counts auto_approve + success', () => {
  const cs = freshModule();
  writeOutcomes([
    { tier: 'auto_approve', success: true },
    { tier: 'auto_approve', success: true },
    { tier: 'auto_approve', success: true }
  ]);

  const cs2 = freshModule();
  const metrics = cs2.getAccuracyMetrics();
  assert.strictEqual(metrics.correct_auto, 3);
  assert.strictEqual(metrics.false_auto, 0);
  assert.strictEqual(metrics.total, 3);
});

test('getAccuracyMetrics: false_auto counts auto_approve + failure', () => {
  const cs = freshModule();
  writeOutcomes([
    { tier: 'auto_approve', success: true },
    { tier: 'auto_approve', success: false },
    { tier: 'auto_approve', success: false }
  ]);

  const cs2 = freshModule();
  const metrics = cs2.getAccuracyMetrics();
  assert.strictEqual(metrics.correct_auto, 1);
  assert.strictEqual(metrics.false_auto, 2);
});

test('getAccuracyMetrics: correct_require counts require_approve + failure', () => {
  const cs = freshModule();
  writeOutcomes([
    { tier: 'require_approve', success: false },
    { tier: 'require_approve', success: true }
  ]);

  const cs2 = freshModule();
  const metrics = cs2.getAccuracyMetrics();
  assert.strictEqual(metrics.correct_require, 1);
});

test('getAccuracyMetrics: accuracy includes notify_approve successes', () => {
  const cs = freshModule();
  writeOutcomes([
    { tier: 'auto_approve', success: true },    // correct_auto
    { tier: 'notify_approve', success: true },   // counted in correctCount
    { tier: 'require_approve', success: false },  // correct_require
    { tier: 'auto_approve', success: false }      // false_auto
  ]);

  const cs2 = freshModule();
  const metrics = cs2.getAccuracyMetrics();
  assert.strictEqual(metrics.total, 4);
  assert.strictEqual(metrics.correct_auto, 1);
  assert.strictEqual(metrics.false_auto, 1);
  assert.strictEqual(metrics.correct_require, 1);
  // correctCount = 1 (correct_auto) + 1 (correct_require) + 1 (notify+success) = 3
  assert.strictEqual(metrics.accuracy, 0.75);
});

test('getAccuracyMetrics: outcomes without tier are skipped', () => {
  const cs = freshModule();
  writeOutcomes([
    { success: true },  // no tier
    { tier: 'auto_approve', success: true }
  ]);

  const cs2 = freshModule();
  const metrics = cs2.getAccuracyMetrics();
  assert.strictEqual(metrics.total, 1);
  assert.strictEqual(metrics.correct_auto, 1);
});

// ============================================================================
// 12. suggestThresholdAdjustment
// ============================================================================

console.log('--- suggestThresholdAdjustment ---');

test('suggestThresholdAdjustment: returns null with < 10 outcomes', () => {
  const cs = freshModule();
  writeOutcomes(Array.from({ length: 5 }, () => ({ tier: 'auto_approve', success: true })));

  const cs2 = freshModule();
  assert.strictEqual(cs2.suggestThresholdAdjustment(), null);
});

test('suggestThresholdAdjustment: high false auto rate suggests raising threshold', () => {
  const cs = freshModule();
  // 10 auto_approve outcomes: 5 success, 5 fail → falseRate = 50% > 10%
  const outcomes = [];
  for (let i = 0; i < 5; i++) outcomes.push({ tier: 'auto_approve', success: true });
  for (let i = 0; i < 5; i++) outcomes.push({ tier: 'auto_approve', success: false });
  writeOutcomes(outcomes);

  const cs2 = freshModule();
  const suggestion = cs2.suggestThresholdAdjustment();
  assert.ok(suggestion, 'should return a suggestion');
  assert.strictEqual(suggestion.adjust_auto_approve, 0.02);
  assert.ok(suggestion.reason.includes('Raising'), `reason should mention raising, got: ${suggestion.reason}`);
});

test('suggestThresholdAdjustment: low false rate suggests lowering threshold', () => {
  const cs = freshModule();
  // 15 auto_approve outcomes: 15 success, 0 fail → falseRate = 0% < 2%
  const outcomes = Array.from({ length: 15 }, () => ({ tier: 'auto_approve', success: true }));
  writeOutcomes(outcomes);

  const cs2 = freshModule();
  const suggestion = cs2.suggestThresholdAdjustment();
  assert.ok(suggestion, 'should return a suggestion');
  assert.strictEqual(suggestion.adjust_auto_approve, -0.01);
  assert.ok(suggestion.reason.includes('lower'), `reason should mention lowering, got: ${suggestion.reason}`);
});

test('suggestThresholdAdjustment: moderate false rate returns null', () => {
  const cs = freshModule();
  // 20 auto_approve: 19 success, 1 fail → falseRate = 5%, between 2-10%
  const outcomes = [];
  for (let i = 0; i < 19; i++) outcomes.push({ tier: 'auto_approve', success: true });
  outcomes.push({ tier: 'auto_approve', success: false });
  writeOutcomes(outcomes);

  const cs2 = freshModule();
  const suggestion = cs2.suggestThresholdAdjustment();
  assert.strictEqual(suggestion, null);
});

test('suggestThresholdAdjustment: no auto_approve outcomes returns null', () => {
  const cs = freshModule();
  const outcomes = Array.from({ length: 15 }, () => ({ tier: 'require_approve', success: false }));
  writeOutcomes(outcomes);

  const cs2 = freshModule();
  assert.strictEqual(cs2.suggestThresholdAdjustment(), null);
});

// ============================================================================
// 13. Override: always_require
// ============================================================================

console.log('--- Override: always_require ---');

testWithPolicy('loadOverrides returns always_require from policy', `
  always_require_approval:
    - security
    - migration
`, () => {
  const cs = freshModule();
  const overrides = cs.loadOverrides();
  assert.ok(Array.isArray(overrides.always_require), 'always_require should be array');
  assert.ok(overrides.always_require.includes('security'), 'should include security');
  assert.ok(overrides.always_require.includes('migration'), 'should include migration');
});

testWithPolicy('loadOverrides returns empty arrays when no policy', '', () => {
  const cs = freshModule();
  const overrides = cs.loadOverrides();
  assert.ok(Array.isArray(overrides.always_require));
  assert.ok(Array.isArray(overrides.always_auto));
  assert.strictEqual(overrides.always_require.length, 0);
  assert.strictEqual(overrides.always_auto.length, 0);
});

// ============================================================================
// 14. Override: always_auto
// ============================================================================

console.log('--- Override: always_auto ---');

testWithPolicy('loadOverrides returns always_auto from policy', `
  always_auto_approve:
    - docs
    - test
`, () => {
  const cs = freshModule();
  const overrides = cs.loadOverrides();
  assert.ok(Array.isArray(overrides.always_auto), 'always_auto should be array');
  assert.ok(overrides.always_auto.includes('docs'), 'should include docs');
  assert.ok(overrides.always_auto.includes('test'), 'should include test');
});

// ============================================================================
// 15. getAllPlanFiles
// ============================================================================

console.log('--- getAllPlanFiles ---');

test('getAllPlanFiles extracts from plan.files', () => {
  const cs = freshModule();
  const files = cs.getAllPlanFiles({ files: ['a.js', 'b.js'], steps: [] });
  assert.deepStrictEqual(files.sort(), ['a.js', 'b.js']);
});

test('getAllPlanFiles extracts from step.files', () => {
  const cs = freshModule();
  const files = cs.getAllPlanFiles({
    steps: [
      { files: ['c.js'] },
      { files: ['d.js', 'e.js'] }
    ]
  });
  assert.deepStrictEqual(files.sort(), ['c.js', 'd.js', 'e.js']);
});

test('getAllPlanFiles deduplicates across plan.files and step.files', () => {
  const cs = freshModule();
  const files = cs.getAllPlanFiles({
    files: ['a.js', 'b.js'],
    steps: [
      { files: ['b.js', 'c.js'] },
      { files: ['a.js', 'd.js'] }
    ]
  });
  assert.strictEqual(files.length, 4);
  assert.deepStrictEqual(files.sort(), ['a.js', 'b.js', 'c.js', 'd.js']);
});

test('getAllPlanFiles returns empty array for empty plan', () => {
  const cs = freshModule();
  assert.deepStrictEqual(cs.getAllPlanFiles({}), []);
});

test('getAllPlanFiles handles steps without files property', () => {
  const cs = freshModule();
  const files = cs.getAllPlanFiles({
    steps: [
      { description: 'no files here' },
      { files: ['a.js'] }
    ]
  });
  assert.deepStrictEqual(files, ['a.js']);
});

// ============================================================================
// Additional edge cases
// ============================================================================

console.log('--- Additional edge cases ---');

test('loadThresholds returns defaults from policy', () => {
  const cs = freshModule();
  const thresholds = cs.loadThresholds();
  assert.strictEqual(thresholds.auto_approve, 0.85);
  assert.strictEqual(thresholds.notify_approve, 0.60);
});

test('loadWeights returns defaults from policy', () => {
  const cs = freshModule();
  const weights = cs.loadWeights();
  assert.strictEqual(weights.scope, 0.20);
  assert.strictEqual(weights.familiarity, 0.30);
  assert.strictEqual(weights.historical_success, 0.25);
  assert.strictEqual(weights.risk, 0.25);
});

test('DEFAULT_THRESHOLDS constants are correct', () => {
  const cs = freshModule();
  assert.strictEqual(cs.DEFAULT_THRESHOLDS.auto_approve, 0.85);
  assert.strictEqual(cs.DEFAULT_THRESHOLDS.notify_approve, 0.60);
});

test('DEFAULT_WEIGHTS constants sum to 1.0', () => {
  const cs = freshModule();
  const w = cs.DEFAULT_WEIGHTS;
  const sum = w.scope + w.familiarity + w.historical_success + w.risk;
  assert.strictEqual(sum, 1.0);
});

test('RISK_TAGS has expected keys', () => {
  const cs = freshModule();
  const expectedKeys = ['data_loss', 'security_sensitive', 'user_facing', 'infra_touching', 'auth_related', 'database_migration', 'dependency_update'];
  for (const key of expectedKeys) {
    assert.ok(key in cs.RISK_TAGS, `RISK_TAGS should have ${key}`);
    assert.ok(typeof cs.RISK_TAGS[key] === 'number', `RISK_TAGS.${key} should be a number`);
  }
});

test('HISTORY_DIR constant is correct', () => {
  const cs = freshModule();
  assert.strictEqual(cs.HISTORY_DIR, '.claude/pilot/state/approval-history');
});

test('scorePlan score is clamped between 0 and 1', () => {
  const cs = freshModule();

  // Try to get a very low score
  const result = cs.scorePlan(
    { steps: Array.from({ length: 20 }, (_, i) => ({ description: `s${i}` })),
      files: Array.from({ length: 25 }, (_, i) => `auth/secret/credential${i}.env`) },
    { id: 't-low', title: 'Delete all user data and drop database tables',
      description: 'Destroy everything in production deploy', labels: ['security'] },
    { thresholds: cs.DEFAULT_THRESHOLDS, weights: cs.DEFAULT_WEIGHTS }
  );

  assert.ok(result.score >= 0, `score should be >= 0, got ${result.score}`);
  assert.ok(result.score <= 1, `score should be <= 1, got ${result.score}`);
});

test('loadRiskPatterns returns null when no patterns in policy', () => {
  const cs = freshModule();
  const patterns = cs.loadRiskPatterns();
  // Our default test policy has no risk_patterns section
  assert.strictEqual(patterns, null);
});

testWithPolicy('loadRiskPatterns returns patterns from policy', `
  risk_patterns:
    data_loss:
      - database
      - backup
    security_sensitive:
      - vault
`, () => {
  const cs = freshModule();
  const patterns = cs.loadRiskPatterns();
  assert.ok(patterns, 'should return patterns');
  assert.ok(Array.isArray(patterns.data_loss), 'data_loss should be array');
  assert.ok(patterns.data_loss.includes('database'));
  assert.ok(patterns.data_loss.includes('backup'));
  assert.ok(patterns.security_sensitive.includes('vault'));
});

test('scorePlan with notify_approve tier (between thresholds)', () => {
  const cs = freshModule();

  // Medium-sized plan with some risk
  const result = cs.scorePlan(
    { steps: Array.from({ length: 5 }, (_, i) => ({ description: `s${i}` })),
      files: Array.from({ length: 6 }, (_, i) => `src/module${i}.js`) },
    { id: 't-n', title: 'Refactor module layout', description: 'restructure code', labels: [] },
    { thresholds: cs.DEFAULT_THRESHOLDS, weights: cs.DEFAULT_WEIGHTS }
  );

  // With medium scope and no history/familiarity, likely notify or require
  assert.ok(
    result.tier === 'notify_approve' || result.tier === 'require_approve',
    `medium plan should be notify or require, got ${result.tier} (score: ${result.score})`
  );
});

// ============================================================================
// RESULTS
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
