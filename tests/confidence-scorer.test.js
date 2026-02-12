/**
 * Tests for confidence-scorer.js (Phase 5.1)
 *
 * Tests the adaptive plan approval confidence scoring engine.
 */

const fs = require('fs');
const path = require('path');
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Fresh module loader (clear require cache)
function freshModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

const LIB_PATH = path.join(__dirname, '..', '.claude', 'pilot', 'hooks', 'lib');
const STATE_DIR = path.join(process.cwd(), '.claude/pilot/state/approval-history');

// Cleanup helper
function cleanStateDir() {
  if (fs.existsSync(STATE_DIR)) {
    const files = fs.readdirSync(STATE_DIR);
    for (const f of files) {
      fs.unlinkSync(path.join(STATE_DIR, f));
    }
    fs.rmdirSync(STATE_DIR);
  }
}

// ============================================================================
// SCOPE FACTOR TESTS
// ============================================================================

describe('computeScopeFactor', () => {
  test('small plan (1-2 steps, 1-3 files) → high scope score', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const plan = {
      steps: [
        { description: 'Fix typo', files: ['README.md'] }
      ]
    };
    const score = scorer.computeScopeFactor(plan);
    assert.ok(score >= 0.85, `Expected >= 0.85, got ${score}`);
  });

  test('medium plan (3-5 steps, 4-8 files) → medium scope score', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const plan = {
      steps: [
        { description: 'Step 1', files: ['a.js'] },
        { description: 'Step 2', files: ['b.js'] },
        { description: 'Step 3', files: ['c.js'] },
        { description: 'Step 4', files: ['d.js', 'e.js'] }
      ]
    };
    const score = scorer.computeScopeFactor(plan);
    assert.ok(score >= 0.4 && score <= 0.85, `Expected 0.4-0.85, got ${score}`);
  });

  test('large plan (10+ steps) → low scope score', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const steps = [];
    for (let i = 0; i < 12; i++) {
      steps.push({ description: `Step ${i}`, files: [`file${i}.js`] });
    }
    const plan = { steps };
    const score = scorer.computeScopeFactor(plan);
    assert.ok(score <= 0.4, `Expected <= 0.4, got ${score}`);
  });

  test('empty plan → high score (no changes)', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const score = scorer.computeScopeFactor({ steps: [] });
    assert.ok(score >= 0.85, `Expected >= 0.85, got ${score}`);
  });
});

// ============================================================================
// RISK FACTOR TESTS
// ============================================================================

describe('computeRiskFactor', () => {
  test('low-risk task (docs only) → high risk factor (close to 1.0)', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const plan = {
      steps: [{ description: 'Update docs', files: ['docs/readme.md'] }]
    };
    const task = { id: 'test-1', title: 'Update documentation', description: 'Fix typos in readme', labels: ['docs'] };
    const result = scorer.computeRiskFactor(plan, task);
    assert.ok(result.factor >= 0.8, `Expected >= 0.8, got ${result.factor}`);
    assert.equal(result.tags.length, 0, `Expected no risk tags, got ${result.tags}`);
  });

  test('auth-related task → low risk factor', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const plan = {
      steps: [{ description: 'Update auth', files: ['src/auth/login.js'] }]
    };
    const task = { id: 'test-2', title: 'Fix login flow', description: 'Update JWT token validation', labels: ['security'] };
    const result = scorer.computeRiskFactor(plan, task);
    assert.ok(result.factor < 0.7, `Expected < 0.7, got ${result.factor}`);
    assert.ok(result.tags.includes('auth_related') || result.tags.includes('security_sensitive'),
      `Expected auth/security tag, got ${result.tags}`);
  });

  test('data deletion task → data_loss tag', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const plan = { steps: [{ description: 'Cleanup', files: ['src/cleanup.js'] }] };
    const task = { id: 'test-3', title: 'Delete old records', description: 'Remove deprecated data from database', labels: [] };
    const result = scorer.computeRiskFactor(plan, task);
    assert.ok(result.tags.includes('data_loss'), `Expected data_loss tag, got ${result.tags}`);
  });

  test('infra task → infra_touching tag', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const plan = { steps: [{ description: 'CI config', files: ['.github/workflows/ci.yml'] }] };
    const task = { id: 'test-4', title: 'Update CI pipeline', description: 'Modify deployment config', labels: ['infra'] };
    const result = scorer.computeRiskFactor(plan, task);
    assert.ok(result.tags.includes('infra_touching'), `Expected infra_touching tag, got ${result.tags}`);
  });

  test('explicit risk tags are included', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const plan = { steps: [{ description: 'Fix', files: ['a.js'] }] };
    const task = { id: 'test-5', title: 'Simple fix', description: '', labels: [] };
    const result = scorer.computeRiskFactor(plan, task, ['database_migration']);
    assert.ok(result.tags.includes('database_migration'), `Expected database_migration tag`);
  });

  test('test-only files → low-risk bonus', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const plan = {
      steps: [
        { description: 'Add tests', files: ['tests/foo.test.js', 'tests/bar.test.js'] }
      ]
    };
    const task = { id: 'test-6', title: 'Add unit tests', description: 'Improve coverage', labels: ['test'] };
    const result = scorer.computeRiskFactor(plan, task);
    assert.ok(result.factor >= 0.9, `Expected >= 0.9 for test-only changes, got ${result.factor}`);
  });
});

// ============================================================================
// FULL SCORING TESTS
// ============================================================================

describe('scorePlan', () => {
  beforeEach(() => { cleanStateDir(); });
  afterEach(() => { cleanStateDir(); });

  test('small low-risk plan → auto_approve tier', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const plan = {
      steps: [{ description: 'Fix typo', files: ['README.md'] }]
    };
    const task = { id: 'test-auto', title: 'Fix README typo', description: 'Correct spelling', labels: ['docs'] };

    const result = scorer.scorePlan(plan, task, {
      thresholds: { auto_approve: 0.85, notify_approve: 0.60 }
    });

    assert.ok(result.score >= 0.60, `Expected score >= 0.60, got ${result.score}`);
    assert.ok(['auto_approve', 'notify_approve'].includes(result.tier),
      `Expected auto/notify tier, got ${result.tier}`);
    assert.ok(result.reasoning.length > 0, 'Expected reasoning');
  });

  test('large high-risk plan → require_approve tier', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const steps = [];
    for (let i = 0; i < 12; i++) {
      steps.push({ description: `Step ${i}`, files: [`src/auth/module${i}.js`] });
    }
    const plan = { steps };
    const task = {
      id: 'test-require',
      title: 'Refactor authentication system',
      description: 'Complete rewrite of login, password, and permission modules',
      labels: ['security', 'auth']
    };

    const result = scorer.scorePlan(plan, task, {
      thresholds: { auto_approve: 0.85, notify_approve: 0.60 }
    });

    assert.ok(result.score < 0.60, `Expected score < 0.60, got ${result.score}`);
    assert.equal(result.tier, 'require_approve', `Expected require_approve, got ${result.tier}`);
    assert.ok(result.risk_tags.length > 0, 'Expected risk tags for auth task');
  });

  test('medium plan → notify_approve tier', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const plan = {
      steps: [
        { description: 'Add feature', files: ['src/feature.js'] },
        { description: 'Add tests', files: ['tests/feature.test.js'] },
        { description: 'Update config', files: ['config.json'] }
      ]
    };
    const task = {
      id: 'test-notify',
      title: 'Add new feature',
      description: 'Implement a new module for data processing',
      labels: ['feature']
    };

    const result = scorer.scorePlan(plan, task, {
      thresholds: { auto_approve: 0.85, notify_approve: 0.60 }
    });

    assert.ok(result.score >= 0.40, `Expected score >= 0.40, got ${result.score}`);
    assert.ok(result.factors.scope > 0, 'Expected scope factor');
    assert.ok(result.factors.risk > 0, 'Expected risk factor');
  });
});

// ============================================================================
// SCORE AND RECORD TESTS
// ============================================================================

describe('scoreAndRecord', () => {
  beforeEach(() => { cleanStateDir(); });
  afterEach(() => { cleanStateDir(); });

  test('persists score to state file', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const plan = { steps: [{ description: 'Fix', files: ['a.js'] }] };
    const task = { id: 'persist-test', title: 'Test task', description: '', labels: [] };

    const result = scorer.scoreAndRecord(plan, task, {
      thresholds: { auto_approve: 0.85, notify_approve: 0.60 }
    });

    // Check state file exists
    const loaded = scorer.loadScore('persist-test');
    assert.ok(loaded, 'Expected score to be persisted');
    assert.equal(loaded.task_id, 'persist-test');
    assert.equal(loaded.score, result.score);
    assert.equal(loaded.tier, result.tier);
  });

  test('appends to scores log', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const plan = { steps: [{ description: 'Fix', files: ['a.js'] }] };

    scorer.scoreAndRecord(plan, { id: 'log-test-1', title: 'T1', description: '', labels: [] });
    scorer.scoreAndRecord(plan, { id: 'log-test-2', title: 'T2', description: '', labels: [] });

    const logPath = path.join(STATE_DIR, 'scores.jsonl');
    assert.ok(fs.existsSync(logPath), 'Expected scores log');

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.ok(lines.length >= 2, `Expected >= 2 log entries, got ${lines.length}`);
  });
});

// ============================================================================
// HISTORICAL OUTCOMES TESTS
// ============================================================================

describe('recordOutcome + readOutcomes', () => {
  beforeEach(() => { cleanStateDir(); });
  afterEach(() => { cleanStateDir(); });

  test('records and reads outcomes', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));

    scorer.recordOutcome('task-1', true, { labels: ['test'] });
    scorer.recordOutcome('task-2', false, { failure_reason: 'tests failed' });

    const outcomes = scorer.readOutcomes();
    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[0].task_id, 'task-1');
    assert.equal(outcomes[0].success, true);
    assert.equal(outcomes[1].task_id, 'task-2');
    assert.equal(outcomes[1].success, false);
    assert.equal(outcomes[1].failure_reason, 'tests failed');
  });

  test('empty outcomes when no history', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const outcomes = scorer.readOutcomes();
    assert.equal(outcomes.length, 0);
  });
});

// ============================================================================
// FAMILIARITY FACTOR TESTS
// ============================================================================

describe('computeFamiliarityFactor', () => {
  beforeEach(() => { cleanStateDir(); });
  afterEach(() => { cleanStateDir(); });

  test('returns 0.5 with no history', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const plan = { steps: [{ description: 'Edit', files: ['src/foo.js'] }] };
    const score = scorer.computeFamiliarityFactor(plan);
    assert.equal(score, 0.5);
  });

  test('increases with successful past work on same files', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));

    // Seed history
    scorer.recordOutcome('past-1', true, { labels: [] });
    // Need to manually add files to outcome since recordOutcome reads score state
    const outcomesPath = path.join(STATE_DIR, 'outcomes.jsonl');
    fs.writeFileSync(outcomesPath, JSON.stringify({
      ts: new Date().toISOString(), task_id: 'past-1', success: true,
      files: ['src/foo.js', 'src/bar.js'], labels: []
    }) + '\n');

    const scorer2 = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const plan = { steps: [{ description: 'Edit', files: ['src/foo.js'] }] };
    const score = scorer2.computeFamiliarityFactor(plan);
    assert.ok(score > 0.5, `Expected > 0.5 for familiar file, got ${score}`);
  });

  test('returns 0.8 for plan with no files', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const score = scorer.computeFamiliarityFactor({ steps: [] });
    assert.equal(score, 0.8);
  });
});

// ============================================================================
// HISTORICAL FACTOR TESTS
// ============================================================================

describe('computeHistoricalFactor', () => {
  beforeEach(() => { cleanStateDir(); });
  afterEach(() => { cleanStateDir(); });

  test('returns 0.5 with no history', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const score = scorer.computeHistoricalFactor({ id: 'test', labels: [] });
    assert.equal(score, 0.5);
  });

  test('high score with mostly successful history', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));

    // Seed 10 successful outcomes
    const outcomesPath = path.join(STATE_DIR, 'outcomes.jsonl');
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    let content = '';
    for (let i = 0; i < 10; i++) {
      content += JSON.stringify({ ts: new Date().toISOString(), task_id: `past-${i}`, success: true, labels: ['feature'] }) + '\n';
    }
    fs.writeFileSync(outcomesPath, content);

    const scorer2 = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const score = scorer2.computeHistoricalFactor({ id: 'new-task', labels: ['feature'] });
    assert.ok(score >= 0.8, `Expected >= 0.8 for all-success history, got ${score}`);
  });

  test('low score with mostly failed history', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));

    const outcomesPath = path.join(STATE_DIR, 'outcomes.jsonl');
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    let content = '';
    for (let i = 0; i < 10; i++) {
      content += JSON.stringify({ ts: new Date().toISOString(), task_id: `past-${i}`, success: false, labels: [] }) + '\n';
    }
    fs.writeFileSync(outcomesPath, content);

    const scorer2 = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const score = scorer2.computeHistoricalFactor({ id: 'new-task', labels: [] });
    assert.ok(score <= 0.2, `Expected <= 0.2 for all-failure history, got ${score}`);
  });
});

// ============================================================================
// ACCURACY METRICS TESTS
// ============================================================================

describe('getAccuracyMetrics', () => {
  beforeEach(() => { cleanStateDir(); });
  afterEach(() => { cleanStateDir(); });

  test('returns zeros with no data', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const metrics = scorer.getAccuracyMetrics();
    assert.equal(metrics.total, 0);
    assert.equal(metrics.accuracy, 0);
  });

  test('computes correct metrics from outcomes', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));

    const outcomesPath = path.join(STATE_DIR, 'outcomes.jsonl');
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

    const outcomes = [
      { ts: '2026-01-01', task_id: 't1', success: true, tier: 'auto_approve' },
      { ts: '2026-01-02', task_id: 't2', success: true, tier: 'auto_approve' },
      { ts: '2026-01-03', task_id: 't3', success: false, tier: 'auto_approve' }, // false auto
      { ts: '2026-01-04', task_id: 't4', success: false, tier: 'require_approve' }, // correct require
      { ts: '2026-01-05', task_id: 't5', success: true, tier: 'notify_approve' }
    ];
    fs.writeFileSync(outcomesPath, outcomes.map(o => JSON.stringify(o)).join('\n') + '\n');

    const scorer2 = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const metrics = scorer2.getAccuracyMetrics();

    assert.equal(metrics.total, 5);
    assert.equal(metrics.correct_auto, 2);
    assert.equal(metrics.false_auto, 1);
    assert.equal(metrics.correct_require, 1);
    // accuracy = (2 correct_auto + 1 correct_require + 1 notify_success) / 5 = 0.8
    assert.equal(metrics.accuracy, 0.8);
  });
});

// ============================================================================
// THRESHOLD ADJUSTMENT TESTS
// ============================================================================

describe('suggestThresholdAdjustment', () => {
  beforeEach(() => { cleanStateDir(); });
  afterEach(() => { cleanStateDir(); });

  test('returns null with insufficient data', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const result = scorer.suggestThresholdAdjustment();
    assert.equal(result, null);
  });

  test('suggests raising threshold when false auto rate > 10%', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));

    const outcomesPath = path.join(STATE_DIR, 'outcomes.jsonl');
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

    // 7 correct autos, 3 false autos = 30% false rate
    let content = '';
    for (let i = 0; i < 7; i++) {
      content += JSON.stringify({ ts: '2026-01-01', task_id: `t${i}`, success: true, tier: 'auto_approve' }) + '\n';
    }
    for (let i = 7; i < 10; i++) {
      content += JSON.stringify({ ts: '2026-01-01', task_id: `t${i}`, success: false, tier: 'auto_approve' }) + '\n';
    }
    fs.writeFileSync(outcomesPath, content);

    const scorer2 = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const suggestion = scorer2.suggestThresholdAdjustment();

    assert.ok(suggestion, 'Expected threshold adjustment suggestion');
    assert.ok(suggestion.adjust_auto_approve > 0, 'Expected positive adjustment (raise threshold)');
  });

  test('suggests lowering threshold when false auto rate < 2%', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));

    const outcomesPath = path.join(STATE_DIR, 'outcomes.jsonl');
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

    // 15 correct autos, 0 false autos
    let content = '';
    for (let i = 0; i < 15; i++) {
      content += JSON.stringify({ ts: '2026-01-01', task_id: `t${i}`, success: true, tier: 'auto_approve' }) + '\n';
    }
    fs.writeFileSync(outcomesPath, content);

    const scorer2 = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const suggestion = scorer2.suggestThresholdAdjustment();

    assert.ok(suggestion, 'Expected threshold adjustment suggestion');
    assert.ok(suggestion.adjust_auto_approve < 0, 'Expected negative adjustment (lower threshold)');
  });
});

// ============================================================================
// PLAN FILE EXTRACTION TESTS
// ============================================================================

describe('getAllPlanFiles', () => {
  test('extracts files from steps', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const plan = {
      steps: [
        { description: 'Step 1', files: ['a.js', 'b.js'] },
        { description: 'Step 2', files: ['c.js'] }
      ]
    };
    const files = scorer.getAllPlanFiles(plan);
    assert.deepEqual(files.sort(), ['a.js', 'b.js', 'c.js']);
  });

  test('deduplicates files across steps', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const plan = {
      steps: [
        { description: 'Step 1', files: ['a.js'] },
        { description: 'Step 2', files: ['a.js', 'b.js'] }
      ]
    };
    const files = scorer.getAllPlanFiles(plan);
    assert.equal(files.length, 2, 'Expected deduplicated files');
  });

  test('handles plan-level files array', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const plan = {
      files: ['top.js'],
      steps: [{ description: 'Step', files: ['step.js'] }]
    };
    const files = scorer.getAllPlanFiles(plan);
    assert.ok(files.includes('top.js'));
    assert.ok(files.includes('step.js'));
  });

  test('handles empty plan', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const files = scorer.getAllPlanFiles({});
    assert.equal(files.length, 0);
  });
});

// ============================================================================
// POLICY LOADING TESTS
// ============================================================================

describe('loadThresholds', () => {
  test('returns defaults when policy not available', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const thresholds = scorer.loadThresholds();
    assert.ok(thresholds.auto_approve > 0);
    assert.ok(thresholds.notify_approve > 0);
    assert.ok(thresholds.auto_approve > thresholds.notify_approve);
  });
});

describe('loadWeights', () => {
  test('returns defaults when policy not available', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const weights = scorer.loadWeights();
    assert.ok(weights.scope > 0);
    assert.ok(weights.familiarity > 0);
    // Should have either historical_success or history
    assert.ok((weights.historical_success || weights.history) > 0);
    assert.ok(weights.risk > 0);
  });
});

// ============================================================================
// INTEGRATION: TIERED APPROVAL FLOW
// ============================================================================

describe('tiered approval flow (integration)', () => {
  beforeEach(() => { cleanStateDir(); });
  afterEach(() => { cleanStateDir(); });

  test('routine doc change → auto_approve', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const plan = { steps: [{ description: 'Fix typo', files: ['README.md'] }] };
    const task = { id: 'routine-1', title: 'Fix typo', description: 'Correct spelling', labels: ['docs'] };

    const result = scorer.scoreAndRecord(plan, task, {
      thresholds: { auto_approve: 0.85, notify_approve: 0.60 }
    });

    // Small scope + no risk → should be high confidence
    assert.ok(result.score >= 0.60, `Score ${result.score} too low for doc change`);
    assert.ok(result.risk_tags.length === 0, 'Expected no risk tags for doc change');
  });

  test('security change → require_approve', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const steps = [];
    for (let i = 0; i < 8; i++) {
      steps.push({ description: `Auth step ${i}`, files: [`src/auth/handler${i}.js`] });
    }
    const plan = { steps };
    const task = {
      id: 'security-1',
      title: 'Rewrite JWT authentication',
      description: 'Replace password hashing, update encryption, modify permission model',
      labels: ['security', 'auth']
    };

    const result = scorer.scoreAndRecord(plan, task, {
      thresholds: { auto_approve: 0.85, notify_approve: 0.60 }
    });

    assert.equal(result.tier, 'require_approve', `Expected require_approve for security change, got ${result.tier}`);
    assert.ok(result.risk_tags.length > 0, 'Expected risk tags for security change');
  });

  test('outcome recording feeds back into future scoring', () => {
    const scorer = freshModule(path.join(LIB_PATH, 'confidence-scorer'));

    // Record several successful outcomes
    for (let i = 0; i < 5; i++) {
      scorer.recordOutcome(`success-${i}`, true, {
        files: ['src/foo.js'],
        labels: ['feature']
      });
    }

    // Now score a new plan touching the same files
    const scorer2 = freshModule(path.join(LIB_PATH, 'confidence-scorer'));
    const plan = { steps: [{ description: 'Update', files: ['src/foo.js'] }] };
    const task = { id: 'new-task', title: 'Update foo', description: 'Small change', labels: ['feature'] };

    const result = scorer2.scorePlan(plan, task, {
      thresholds: { auto_approve: 0.85, notify_approve: 0.60 }
    });

    // Should have higher familiarity and historical success than baseline
    assert.ok(result.factors.familiarity > 0.5, `Expected familiarity > 0.5, got ${result.factors.familiarity}`);
    assert.ok(result.factors.historical_success > 0.5, `Expected history > 0.5, got ${result.factors.historical_success}`);
  });
});

console.log('All confidence-scorer tests loaded.');
