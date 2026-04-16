/**
 * Tests for Phase 5.5: Self-Improving Task Decomposition
 *
 * Covers:
 * - Decomposition outcome tracking (prediction + outcome recording)
 * - Accuracy calculation
 * - Pattern library CRUD
 * - Pattern matching by keywords
 * - Adaptive sizing
 * - Feedback loop integration
 * - Historical accuracy trends
 *
 * Run: node --test tests/decomposition-outcomes.test.js
 */

const fs = require('fs');
const path = require('path');
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Fresh module loading to avoid cross-test contamination
function freshModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

// State directories used in tests
const OUTCOMES_DIR = '.claude/pilot/state/decomposition-outcomes';
const PATTERNS_DIR = '.claude/pilot/state/decomposition-patterns';

function cleanState() {
  const outcomesDir = path.join(process.cwd(), OUTCOMES_DIR);
  const patternsDir = path.join(process.cwd(), PATTERNS_DIR);

  for (const dir of [outcomesDir, patternsDir]) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* skip */ }
      }
    }
  }
}

// ============================================================================
// DECOMPOSITION OUTCOMES
// ============================================================================

describe('decomposition-outcomes', () => {
  let outcomes;

  beforeEach(() => {
    cleanState();
    outcomes = freshModule('../.claude/pilot/hooks/lib/decomposition-outcomes');
  });

  afterEach(() => {
    cleanState();
  });

  describe('recordPrediction', () => {
    test('records a prediction to state file', () => {
      outcomes.recordPrediction('TASK-001', {
        subtask_count: 5,
        subtask_ids: ['st-001', 'st-002', 'st-003', 'st-004', 'st-005'],
        complexity_per_subtask: { 'st-001': 'S', 'st-002': 'M', 'st-003': 'L' },
        task_type: 'feature',
        domain: 'infrastructure'
      });

      const state = outcomes.getOutcome('TASK-001');
      assert.ok(state, 'State should not be null');
      assert.equal(state.prediction.subtask_count, 5);
      assert.equal(state.prediction.subtask_ids.length, 5);
      assert.equal(state.prediction.task_type, 'feature');
      assert.equal(state.prediction.complexity_per_subtask['st-001'], 'S');
    });

    test('ignores null inputs', () => {
      outcomes.recordPrediction(null, { subtask_count: 3 });
      outcomes.recordPrediction('TASK-001', null);
      // Should not throw
    });

    test('preserves existing outcomes when updating prediction', () => {
      outcomes.recordPrediction('TASK-001', { subtask_count: 3, subtask_ids: ['st-001'] });
      outcomes.recordOutcome('TASK-001', 'st-001', { actual_complexity: 'M' });
      outcomes.recordPrediction('TASK-001', { subtask_count: 4, subtask_ids: ['st-001', 'st-002'] });

      const state = outcomes.getOutcome('TASK-001');
      assert.equal(state.prediction.subtask_count, 4);
      assert.ok(state.outcomes['st-001'], 'Existing outcome should be preserved');
    });
  });

  describe('recordOutcome', () => {
    test('records a subtask outcome', () => {
      outcomes.recordPrediction('TASK-001', {
        subtask_count: 2,
        subtask_ids: ['st-001', 'st-002']
      });

      outcomes.recordOutcome('TASK-001', 'st-001', {
        actual_complexity: 'M',
        duration_ms: 60000,
        commit_count: 3,
        respawn_count: 1,
        stuck: false,
        reworked: false
      });

      const state = outcomes.getOutcome('TASK-001');
      assert.ok(state.outcomes['st-001']);
      assert.equal(state.outcomes['st-001'].actual_complexity, 'M');
      assert.equal(state.outcomes['st-001'].duration_ms, 60000);
      assert.equal(state.outcomes['st-001'].commit_count, 3);
    });

    test('records stuck and reworked flags', () => {
      outcomes.recordOutcome('TASK-001', 'st-001', {
        stuck: true,
        reworked: true
      });

      const state = outcomes.getOutcome('TASK-001');
      assert.equal(state.outcomes['st-001'].stuck, true);
      assert.equal(state.outcomes['st-001'].reworked, true);
    });
  });

  describe('recordSubtaskChanges', () => {
    test('records added and removed subtasks', () => {
      outcomes.recordPrediction('TASK-001', { subtask_count: 3, subtask_ids: ['st-001', 'st-002', 'st-003'] });
      outcomes.recordSubtaskChanges('TASK-001', ['st-004'], ['st-003']);

      const state = outcomes.getOutcome('TASK-001');
      assert.deepEqual(state.subtask_changes.added, ['st-004']);
      assert.deepEqual(state.subtask_changes.removed, ['st-003']);
    });
  });

  describe('getAccuracy', () => {
    test('returns null if no prediction exists', () => {
      const acc = outcomes.getAccuracy('NONEXISTENT');
      assert.equal(acc, null);
    });

    test('calculates perfect accuracy when prediction matches outcome', () => {
      outcomes.recordPrediction('TASK-001', {
        subtask_count: 2,
        subtask_ids: ['st-001', 'st-002'],
        complexity_per_subtask: { 'st-001': 'S', 'st-002': 'M' }
      });
      outcomes.recordOutcome('TASK-001', 'st-001', { actual_complexity: 'S' });
      outcomes.recordOutcome('TASK-001', 'st-002', { actual_complexity: 'M' });

      const acc = outcomes.getAccuracy('TASK-001');
      assert.equal(acc.count_accuracy, 1);
      assert.equal(acc.complexity_accuracy, 1);
      assert.equal(acc.overall_accuracy, 1);
    });

    test('calculates degraded count accuracy when over-estimated', () => {
      outcomes.recordPrediction('TASK-001', {
        subtask_count: 8,
        subtask_ids: ['st-001', 'st-002', 'st-003', 'st-004', 'st-005', 'st-006', 'st-007', 'st-008'],
        complexity_per_subtask: {}
      });
      for (let i = 1; i <= 5; i++) {
        outcomes.recordOutcome('TASK-001', `st-00${i}`, { actual_complexity: 'M' });
      }

      const acc = outcomes.getAccuracy('TASK-001');
      // predicted=8, actual=5, diff=3, accuracy = 1 - 3/8 = 0.625 → rounds to 0.63
      assert.equal(acc.count_accuracy, 0.63);
      assert.equal(acc.predicted_count, 8);
      assert.equal(acc.actual_count, 5);
    });

    test('calculates degraded complexity accuracy when predictions wrong', () => {
      outcomes.recordPrediction('TASK-001', {
        subtask_count: 3,
        subtask_ids: ['st-001', 'st-002', 'st-003'],
        complexity_per_subtask: { 'st-001': 'S', 'st-002': 'S', 'st-003': 'S' }
      });
      outcomes.recordOutcome('TASK-001', 'st-001', { actual_complexity: 'S' }); // match
      outcomes.recordOutcome('TASK-001', 'st-002', { actual_complexity: 'L' }); // miss
      outcomes.recordOutcome('TASK-001', 'st-003', { actual_complexity: 'M' }); // miss

      const acc = outcomes.getAccuracy('TASK-001');
      // 1 match out of 3 = 0.33
      assert.equal(acc.complexity_accuracy, 0.33);
    });

    test('counts stuck and rework', () => {
      outcomes.recordPrediction('TASK-001', {
        subtask_count: 3,
        subtask_ids: ['st-001', 'st-002', 'st-003']
      });
      outcomes.recordOutcome('TASK-001', 'st-001', { stuck: true });
      outcomes.recordOutcome('TASK-001', 'st-002', { reworked: true });
      outcomes.recordOutcome('TASK-001', 'st-003', { stuck: true, reworked: true });

      const acc = outcomes.getAccuracy('TASK-001');
      assert.equal(acc.stuck_count, 2);
      assert.equal(acc.rework_count, 2);
    });
  });

  describe('isDecompositionComplete', () => {
    test('returns false when no prediction exists', () => {
      assert.equal(outcomes.isDecompositionComplete('NONEXISTENT'), false);
    });

    test('returns false when not all subtasks have outcomes', () => {
      outcomes.recordPrediction('TASK-001', {
        subtask_count: 3,
        subtask_ids: ['st-001', 'st-002', 'st-003']
      });
      outcomes.recordOutcome('TASK-001', 'st-001', { actual_complexity: 'S' });

      assert.equal(outcomes.isDecompositionComplete('TASK-001'), false);
    });

    test('returns true when all predicted subtasks have outcomes', () => {
      outcomes.recordPrediction('TASK-001', {
        subtask_count: 2,
        subtask_ids: ['st-001', 'st-002']
      });
      outcomes.recordOutcome('TASK-001', 'st-001', { actual_complexity: 'S' });
      outcomes.recordOutcome('TASK-001', 'st-002', { actual_complexity: 'M' });

      assert.equal(outcomes.isDecompositionComplete('TASK-001'), true);
    });
  });

  describe('getHistoricalAccuracy', () => {
    test('returns empty result when no outcomes exist', () => {
      const hist = outcomes.getHistoricalAccuracy();
      assert.equal(hist.count, 0);
      assert.equal(hist.avg_overall_accuracy, 0);
    });

    test('aggregates multiple task accuracies', () => {
      // Task 1: perfect
      outcomes.recordPrediction('TASK-A', {
        subtask_count: 2,
        subtask_ids: ['st-001', 'st-002'],
        complexity_per_subtask: { 'st-001': 'S', 'st-002': 'M' },
        task_type: 'feature'
      });
      outcomes.recordOutcome('TASK-A', 'st-001', { actual_complexity: 'S' });
      outcomes.recordOutcome('TASK-A', 'st-002', { actual_complexity: 'M' });

      // Task 2: imperfect
      outcomes.recordPrediction('TASK-B', {
        subtask_count: 4,
        subtask_ids: ['st-001', 'st-002', 'st-003', 'st-004'],
        complexity_per_subtask: {},
        task_type: 'bugfix'
      });
      outcomes.recordOutcome('TASK-B', 'st-001', { actual_complexity: 'M' });
      outcomes.recordOutcome('TASK-B', 'st-002', { actual_complexity: 'M' });

      const hist = outcomes.getHistoricalAccuracy();
      assert.equal(hist.count, 2);
      assert.ok(hist.by_type.feature, 'Should have feature type');
      assert.ok(hist.by_type.bugfix, 'Should have bugfix type');
    });

    test('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        outcomes.recordPrediction(`TASK-${i}`, {
          subtask_count: 1,
          subtask_ids: ['st-001'],
          task_type: 'feature'
        });
        outcomes.recordOutcome(`TASK-${i}`, 'st-001', { actual_complexity: 'S' });
      }

      const hist = outcomes.getHistoricalAccuracy(2);
      assert.ok(hist.count <= 2, 'Should respect limit');
    });
  });

  describe('adaptive sizing', () => {
    test('returns default sizing with no data', () => {
      const sizing = outcomes.getAdaptiveSizing('feature');
      assert.equal(sizing.multiplier, 1.0);
      assert.equal(sizing.confidence, 0);
      assert.equal(sizing.sample_size, 0);
    });

    test('returns default sizing with < 3 samples', () => {
      outcomes.updateAdaptiveSizing('feature', 5, 5);
      outcomes.updateAdaptiveSizing('feature', 5, 5);

      const sizing = outcomes.getAdaptiveSizing('feature');
      assert.equal(sizing.multiplier, 1.0); // Not enough data
      assert.equal(sizing.confidence, 0);
      assert.equal(sizing.sample_size, 2);
    });

    test('calculates multiplier after 3+ samples', () => {
      outcomes.updateAdaptiveSizing('feature', 8, 5);
      outcomes.updateAdaptiveSizing('feature', 8, 5);
      outcomes.updateAdaptiveSizing('feature', 8, 5);

      const sizing = outcomes.getAdaptiveSizing('feature');
      assert.ok(sizing.multiplier < 1.0, 'Multiplier should be < 1 for over-estimation');
      assert.ok(sizing.confidence > 0, 'Confidence should grow');
      assert.equal(sizing.sample_size, 3);
    });

    test('clamps multiplier to 0.5-2.0 range', () => {
      for (let i = 0; i < 5; i++) {
        outcomes.updateAdaptiveSizing('test', 100, 1);
      }
      const sizing = outcomes.getAdaptiveSizing('test');
      assert.ok(sizing.multiplier >= 0.5, 'Multiplier should be >= 0.5');
      assert.ok(sizing.multiplier <= 2.0, 'Multiplier should be <= 2.0');
    });

    test('tracks types independently', () => {
      for (let i = 0; i < 3; i++) {
        outcomes.updateAdaptiveSizing('feature', 5, 3);
        outcomes.updateAdaptiveSizing('bugfix', 5, 7);
      }

      const featureSizing = outcomes.getAdaptiveSizing('feature');
      const bugfixSizing = outcomes.getAdaptiveSizing('bugfix');

      assert.ok(featureSizing.multiplier < 1.0, 'Feature should have <1 multiplier');
      assert.ok(bugfixSizing.multiplier > 1.0, 'Bugfix should have >1 multiplier');
    });
  });
});

// ============================================================================
// DECOMPOSITION PATTERNS
// ============================================================================

describe('decomposition-patterns', () => {
  let patterns;

  beforeEach(() => {
    cleanState();
    patterns = freshModule('../.claude/pilot/hooks/lib/decomposition-patterns');
  });

  afterEach(() => {
    cleanState();
  });

  describe('classifyTaskType', () => {
    test('classifies feature tasks', () => {
      assert.equal(patterns.classifyTaskType('Implement new dashboard feature'), 'feature');
    });

    test('classifies bugfix tasks', () => {
      assert.equal(patterns.classifyTaskType('Fix login bug in auth module'), 'bugfix');
    });

    test('classifies refactor tasks', () => {
      assert.equal(patterns.classifyTaskType('Refactor database migration layer'), 'refactor');
    });

    test('classifies test tasks', () => {
      assert.equal(patterns.classifyTaskType('Write unit tests for API'), 'test');
    });

    test('classifies docs tasks', () => {
      assert.equal(patterns.classifyTaskType('Update README documentation'), 'docs');
    });

    test('classifies infra tasks', () => {
      assert.equal(patterns.classifyTaskType('Set up CI/CD pipeline and docker config'), 'infra');
    });

    test('defaults to feature for ambiguous text', () => {
      assert.equal(patterns.classifyTaskType('Do something cool'), 'feature');
    });
  });

  describe('extractKeywords', () => {
    test('extracts meaningful words', () => {
      const kw = patterns.extractKeywords('Implement the new dashboard feature for users');
      assert.ok(kw.includes('implement'), 'Should include implement');
      assert.ok(kw.includes('dashboard'), 'Should include dashboard');
      assert.ok(kw.includes('feature'), 'Should include feature');
      assert.ok(!kw.includes('the'), 'Should exclude stop word "the"');
      assert.ok(!kw.includes('for'), 'Should exclude stop word "for"');
    });

    test('deduplicates words', () => {
      const kw = patterns.extractKeywords('dashboard dashboard dashboard');
      assert.deepEqual(kw, ['dashboard']);
    });

    test('returns empty for null input', () => {
      assert.deepEqual(patterns.extractKeywords(null), []);
    });
  });

  describe('recordPattern', () => {
    test('records a successful decomposition pattern', () => {
      patterns.recordPattern('TASK-001', {
        task_title: 'Implement dashboard',
        task_description: 'Create a new admin dashboard',
        task_type: 'feature',
        subtasks: [
          { title: 'Create layout', agent: 'frontend', priority: 'high', wave: 1, depends_on: [] },
          { title: 'Add API', agent: 'backend', priority: 'medium', wave: 2, depends_on: ['st-001'] }
        ],
        domain: 'full_stack'
      }, {
        success: true,
        overall_accuracy: 0.9,
        stuck_count: 0,
        rework_count: 0
      });

      const lib = patterns.loadLibrary();
      assert.equal(lib.patterns.length, 1);
      assert.equal(lib.patterns[0].type, 'feature');
      assert.equal(lib.patterns[0].template.length, 2);
      assert.equal(lib.patterns[0].success_rate, 1.0);
    });

    test('updates existing pattern with EMA', () => {
      const decomp = {
        task_title: 'Feature X',
        task_type: 'feature',
        subtasks: [{ title: 'Step 1', agent: 'backend', priority: 'high', wave: 1 }],
        domain: 'infrastructure'
      };

      patterns.recordPattern('TASK-001', decomp, {
        success: true, overall_accuracy: 0.8
      });
      patterns.recordPattern('TASK-001', decomp, {
        success: false, overall_accuracy: 0.4
      });

      const lib = patterns.loadLibrary();
      assert.equal(lib.patterns.length, 1);
      assert.equal(lib.patterns[0].usage_count, 2);
      // EMA: 1.0 * 0.7 + 0.0 * 0.3 = 0.7
      const rate = lib.patterns[0].success_rate;
      assert.ok(Math.abs(rate - 0.7) < 0.01, `Success rate should be ~0.7, got ${rate}`);
    });
  });

  describe('findPattern', () => {
    test('returns null with empty library', () => {
      const result = patterns.findPattern('Create a new dashboard');
      assert.equal(result, null);
    });

    test('finds matching pattern by type and keywords', () => {
      patterns.recordPattern('TASK-001', {
        task_title: 'Implement admin dashboard feature',
        task_type: 'feature',
        subtasks: [
          { title: 'Layout', agent: 'frontend', priority: 'high', wave: 1 }
        ],
        domain: 'full_stack'
      }, {
        success: true, overall_accuracy: 0.9
      });

      const result = patterns.findPattern('Create a new admin dashboard feature');
      assert.ok(result !== null, 'Should find a match');
      assert.equal(result.pattern.source_task_id, 'TASK-001');
      assert.ok(result.match_score > 0, 'Match score should be positive');
    });

    test('respects minimum success rate', () => {
      patterns.recordPattern('TASK-001', {
        task_title: 'Build dashboard',
        task_type: 'feature',
        subtasks: [{ title: 'Step', agent: 'backend', priority: 'high', wave: 1 }],
        domain: 'full_stack'
      }, { success: false, overall_accuracy: 0.3 });

      const result = patterns.findPattern('Build dashboard feature', { min_success_rate: 0.7 });
      assert.equal(result, null, 'Should not match low success rate');
    });

    test('does not match across types', () => {
      patterns.recordPattern('TASK-001', {
        task_title: 'Fix auth bug',
        task_type: 'bugfix',
        subtasks: [{ title: 'Debug', agent: 'backend', priority: 'high', wave: 1 }],
        domain: 'api_only'
      }, { success: true, overall_accuracy: 0.9 });

      const result = patterns.findPattern('Implement new auth feature');
      assert.equal(result, null, 'Should not match bugfix for feature task');
    });
  });

  describe('getTopPatterns', () => {
    test('returns patterns sorted by success rate', () => {
      patterns.recordPattern('TASK-A', {
        task_title: 'Feature A', task_type: 'feature',
        subtasks: [{ title: 'A', agent: 'backend', priority: 'high', wave: 1 }]
      }, { success: true, overall_accuracy: 0.7 });

      patterns.recordPattern('TASK-B', {
        task_title: 'Feature B', task_type: 'feature',
        subtasks: [{ title: 'B', agent: 'backend', priority: 'high', wave: 1 }]
      }, { success: true, overall_accuracy: 0.9 });

      const top = patterns.getTopPatterns('feature', 5);
      assert.equal(top.length, 2);
      assert.ok(top[0].success_rate >= top[1].success_rate, 'Should be sorted by success rate');
    });

    test('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        patterns.recordPattern(`TASK-${i}`, {
          task_title: `Feature ${i}`, task_type: 'feature',
          subtasks: [{ title: `Step ${i}`, agent: 'backend', priority: 'high', wave: 1 }]
        }, { success: true, overall_accuracy: 0.8 });
      }

      const top = patterns.getTopPatterns('feature', 3);
      assert.equal(top.length, 3);
    });

    test('filters by type', () => {
      patterns.recordPattern('TASK-F', {
        task_title: 'Feature X', task_type: 'feature',
        subtasks: [{ title: 'Step', agent: 'backend', priority: 'high', wave: 1 }]
      }, { success: true, overall_accuracy: 0.8 });

      patterns.recordPattern('TASK-B', {
        task_title: 'Fix bug Y', task_type: 'bugfix',
        subtasks: [{ title: 'Debug', agent: 'backend', priority: 'high', wave: 1 }]
      }, { success: true, overall_accuracy: 0.9 });

      assert.equal(patterns.getTopPatterns('feature').length, 1);
      assert.equal(patterns.getTopPatterns('bugfix').length, 1);
      assert.equal(patterns.getTopPatterns('refactor').length, 0);
    });
  });

  describe('pruning', () => {
    test('prunes patterns exceeding max per type', () => {
      for (let i = 0; i < 5; i++) {
        patterns.recordPattern(`TASK-${i}`, {
          task_title: `Feature ${i}`, task_type: 'feature',
          subtasks: [{ title: `Step ${i}`, agent: 'backend', priority: 'high', wave: 1 }]
        }, { success: true, overall_accuracy: 0.8 }, 3);
      }

      const lib = patterns.loadLibrary();
      const featurePatterns = lib.patterns.filter(p => p.type === 'feature');
      assert.ok(featurePatterns.length <= 3, `Should have at most 3 patterns, got ${featurePatterns.length}`);
    });
  });
});

// ============================================================================
// FEEDBACK LOOP INTEGRATION
// ============================================================================

describe('feedback loop integration', () => {
  beforeEach(() => {
    cleanState();
    // Clear require cache for relevant modules
    for (const key of Object.keys(require.cache)) {
      if (key.includes('decomposition-outcomes') ||
          key.includes('decomposition-patterns') ||
          key.includes('decomposition.js')) {
        delete require.cache[key];
      }
    }
  });

  afterEach(() => {
    cleanState();
  });

  test('loadFeedbackLoopPolicy returns defaults', () => {
    const decomposition = require('../.claude/pilot/hooks/lib/decomposition');
    const policy = decomposition.loadFeedbackLoopPolicy();
    assert.equal(policy.enabled, true);
    assert.equal(policy.min_confidence, 0.7);
    assert.equal(policy.pattern_match_threshold, 0.5);
    assert.equal(policy.max_patterns_per_type, 50);
  });

  test('decomposeTask returns pattern_used field', () => {
    const decomposition = require('../.claude/pilot/hooks/lib/decomposition');
    const result = decomposition.decomposeTask(
      { id: 'TEST-001', title: 'Simple task', description: 'Not complex', labels: [] },
      process.cwd()
    );
    // Whether decomposed or not, should have pattern_used field
    assert.ok('pattern_used' in result, 'Result should include pattern_used field');
  });

  test('finalizeDecomposition does not crash with no data', () => {
    const decomposition = require('../.claude/pilot/hooks/lib/decomposition');
    // Should handle gracefully when no outcome data exists
    decomposition.finalizeDecomposition('NONEXISTENT-TASK');
    // No assertion needed — just verifying it doesn't throw
  });

  test('finalizeDecomposition records pattern for high-accuracy decomposition', () => {
    const outcomes = require('../.claude/pilot/hooks/lib/decomposition-outcomes');
    const decompPatterns = require('../.claude/pilot/hooks/lib/decomposition-patterns');
    const decomposition = require('../.claude/pilot/hooks/lib/decomposition');

    // Set up a completed decomposition with perfect accuracy
    outcomes.recordPrediction('FINAL-001', {
      subtask_count: 2,
      subtask_ids: ['st-001', 'st-002'],
      complexity_per_subtask: { 'st-001': 'S', 'st-002': 'M' },
      task_type: 'feature',
      domain: 'infrastructure'
    });
    outcomes.recordOutcome('FINAL-001', 'st-001', { actual_complexity: 'S' });
    outcomes.recordOutcome('FINAL-001', 'st-002', { actual_complexity: 'M' });

    decomposition.finalizeDecomposition('FINAL-001');

    // Pattern should be recorded (accuracy = 1.0 > 0.6 threshold)
    const lib = decompPatterns.loadLibrary();
    assert.ok(lib.patterns.length >= 1, 'Should have recorded a pattern');
  });

  test('finalizeDecomposition skips pattern for low-accuracy decomposition', () => {
    const outcomes = require('../.claude/pilot/hooks/lib/decomposition-outcomes');
    const decompPatterns = require('../.claude/pilot/hooks/lib/decomposition-patterns');
    const decomposition = require('../.claude/pilot/hooks/lib/decomposition');

    // Set up decomposition with terrible accuracy
    outcomes.recordPrediction('LOW-ACC', {
      subtask_count: 10,
      subtask_ids: ['st-001'],
      complexity_per_subtask: { 'st-001': 'L' },
      task_type: 'bugfix',
      domain: 'api_only'
    });
    outcomes.recordOutcome('LOW-ACC', 'st-001', { actual_complexity: 'S' });

    const libBefore = decompPatterns.loadLibrary();
    const countBefore = libBefore.patterns.length;

    decomposition.finalizeDecomposition('LOW-ACC');

    const libAfter = decompPatterns.loadLibrary();
    assert.equal(libAfter.patterns.length, countBefore, 'Should not record low-accuracy pattern');
  });
});

// ============================================================================
// PM LOOP INTEGRATION
// ============================================================================

describe('pm-loop decomposition learning scan', () => {
  test('PmLoop has _decompositionLearningScan method', () => {
    for (const key of Object.keys(require.cache)) {
      if (key.includes('pm-loop')) {
        delete require.cache[key];
      }
    }

    const { PmLoop } = require('../.claude/pilot/hooks/lib/pm-loop');
    const loop = new PmLoop(process.cwd(), { dryRun: true });
    assert.equal(typeof loop._decompositionLearningScan, 'function');
  });

  test('PmLoop has decompLearningScan interval option', () => {
    for (const key of Object.keys(require.cache)) {
      if (key.includes('pm-loop')) {
        delete require.cache[key];
      }
    }

    const { PmLoop } = require('../.claude/pilot/hooks/lib/pm-loop');
    const loop = new PmLoop(process.cwd(), {
      decompLearningScanIntervalMs: 10000,
      dryRun: true
    });
    assert.equal(loop.opts.decompLearningScanIntervalMs, 10000);
  });

  test('_decompositionLearningScan returns empty array when no outcomes', () => {
    cleanState();
    for (const key of Object.keys(require.cache)) {
      if (key.includes('pm-loop') || key.includes('decomposition')) {
        delete require.cache[key];
      }
    }

    const { PmLoop } = require('../.claude/pilot/hooks/lib/pm-loop');
    const loop = new PmLoop(process.cwd(), { dryRun: true });
    loop.pmSessionId = 'test-pm';
    loop.running = true;

    const results = loop._decompositionLearningScan();
    assert.ok(Array.isArray(results), 'Should return array');
    assert.equal(results.length, 0, 'Should be empty with no outcomes');
  });
});
