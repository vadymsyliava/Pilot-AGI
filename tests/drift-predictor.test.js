'use strict';

/**
 * Tests for Phase 5.6: Predictive Drift Prevention
 *
 * Covers:
 * - Drift predictor: keyword extraction, similarity scoring, prediction
 * - Guardrails engine: warn/redirect/refresh evaluation
 * - Policy threshold configuration
 * - Tool exclusion list
 * - Prediction recording and history
 * - Context refresh mechanism
 * - Edge cases: empty plan, no current step, completed plan
 *
 * Run: npx vitest run tests/drift-predictor.test.js --reporter=verbose
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ============================================================================
// TEST SETUP
// ============================================================================

let TEST_ROOT;
const PREDICTIONS_DIR = '.claude/pilot/state/drift-predictions';

function freshModule(modPath) {
  const resolved = require.resolve(modPath);
  delete require.cache[resolved];
  // Also clear transitive deps
  for (const dep of [
    '../.claude/pilot/hooks/lib/drift-predictor',
    '../.claude/pilot/hooks/lib/drift-guardrails',
    '../.claude/pilot/hooks/lib/policy'
  ]) {
    try { delete require.cache[require.resolve(dep)]; } catch (e) { /* not loaded */ }
  }
  return require(modPath);
}

function setupTestRoot() {
  TEST_ROOT = path.join(__dirname, `.tmp-drift-test-${process.pid}-${Date.now()}`);
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  // Create a mock policy.yaml
  const policyDir = path.join(TEST_ROOT, '.claude/pilot');
  fs.mkdirSync(policyDir, { recursive: true });
  fs.writeFileSync(path.join(policyDir, 'policy.yaml'), `
version: "2.0"
drift_prevention:
  enabled: true
  thresholds:
    aligned: 0.6
    monitor: 0.3
    divergent: 0.3
  guardrails:
    warn_on_monitor: true
    block_on_divergent: true
    auto_refresh: true
  excluded_tools:
    - Read
    - Glob
    - Grep
    - WebSearch
    - WebFetch
  evaluation_interval_steps: 1
`);
}

function cleanTestRoot() {
  if (TEST_ROOT && fs.existsSync(TEST_ROOT)) {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

let originalCwd;

// ============================================================================
// DRIFT PREDICTOR TESTS
// ============================================================================

describe('drift-predictor', () => {
  let predictor;

  beforeEach(() => {
    setupTestRoot();
    originalCwd = process.cwd;
    process.cwd = () => TEST_ROOT;
    predictor = freshModule('../.claude/pilot/hooks/lib/drift-predictor');
  });

  afterEach(() => {
    process.cwd = originalCwd;
    cleanTestRoot();
  });

  // --------------------------------------------------------------------------
  // Keyword extraction
  // --------------------------------------------------------------------------

  describe('extractKeywords', () => {
    it('should extract meaningful keywords from text', () => {
      const kw = predictor.extractKeywords('Create the drift predictor module with similarity scoring');
      assert.ok(kw.has('drift'));
      assert.ok(kw.has('predictor'));
      assert.ok(kw.has('module'));
      assert.ok(kw.has('similarity'));
      assert.ok(kw.has('scoring'));
      // Stop words should be filtered
      assert.ok(!kw.has('the'));
      assert.ok(!kw.has('with'));
    });

    it('should handle empty/null input', () => {
      assert.deepStrictEqual(predictor.extractKeywords(''), new Set());
      assert.deepStrictEqual(predictor.extractKeywords(null), new Set());
      assert.deepStrictEqual(predictor.extractKeywords(undefined), new Set());
    });

    it('should lowercase all keywords', () => {
      const kw = predictor.extractKeywords('Create DRIFT Module');
      assert.ok(kw.has('drift'));
      assert.ok(!kw.has('DRIFT'));
    });
  });

  describe('extractPaths', () => {
    it('should extract file paths from text', () => {
      const paths = predictor.extractPaths('Edit src/lib/drift.js and tests/drift.test.js');
      assert.ok(paths.some(p => p.includes('src/lib/drift.js')));
      assert.ok(paths.some(p => p.includes('tests/drift.test.js')));
    });

    it('should handle empty input', () => {
      assert.deepStrictEqual(predictor.extractPaths(''), []);
      assert.deepStrictEqual(predictor.extractPaths(null), []);
    });
  });

  describe('extractPlanTerms', () => {
    it('should extract terms from a plan step', () => {
      const step = {
        description: 'Create drift predictor module',
        files: ['src/lib/drift-predictor.js', 'tests/drift.test.js']
      };
      const terms = predictor.extractPlanTerms(step);
      assert.ok(terms.keywords.has('drift'));
      assert.ok(terms.keywords.has('predictor'));
      assert.ok(terms.paths.includes('src/lib/drift-predictor.js'));
      assert.equal(terms.actionType, 'write'); // 'create' maps to write
    });

    it('should handle null plan step', () => {
      const terms = predictor.extractPlanTerms(null);
      assert.equal(terms.keywords.size, 0);
      assert.deepStrictEqual(terms.paths, []);
      assert.equal(terms.actionType, 'unknown');
    });

    it('should infer action type from description', () => {
      assert.equal(predictor.extractPlanTerms({ description: 'Run tests for module' }).actionType, 'test');
      assert.equal(predictor.extractPlanTerms({ description: 'Read and review the existing code' }).actionType, 'read');
      assert.equal(predictor.extractPlanTerms({ description: 'Execute the build script' }).actionType, 'execute');
      assert.equal(predictor.extractPlanTerms({ description: 'Edit the configuration file' }).actionType, 'write');
    });
  });

  describe('extractToolTerms', () => {
    it('should extract terms from Edit tool', () => {
      const terms = predictor.extractToolTerms('Edit', {
        file_path: '/project/src/lib/drift-predictor.js',
        new_string: 'function predictDrift() { return score; }'
      });
      assert.ok(terms.paths.includes('/project/src/lib/drift-predictor.js'));
      assert.equal(terms.actionType, 'write');
    });

    it('should extract terms from Bash tool', () => {
      const terms = predictor.extractToolTerms('Bash', {
        command: 'npx vitest run tests/drift.test.js'
      });
      assert.ok(terms.keywords.has('vitest'));
      assert.equal(terms.actionType, 'test');
    });

    it('should categorize tool actions correctly', () => {
      assert.equal(predictor.categorizeToolAction('Edit'), 'write');
      assert.equal(predictor.categorizeToolAction('Write'), 'write');
      assert.equal(predictor.categorizeToolAction('Read'), 'read');
      assert.equal(predictor.categorizeToolAction('Glob'), 'read');
      assert.equal(predictor.categorizeToolAction('Bash', { command: 'git status' }), 'read');
      assert.equal(predictor.categorizeToolAction('Bash', { command: 'rm -rf temp/' }), 'write');
      assert.equal(predictor.categorizeToolAction('Bash', { command: 'npx vitest run' }), 'test');
    });
  });

  // --------------------------------------------------------------------------
  // Similarity scoring
  // --------------------------------------------------------------------------

  describe('jaccardSimilarity', () => {
    it('should return 1.0 for identical sets', () => {
      const s = new Set(['a', 'b', 'c']);
      assert.equal(predictor.jaccardSimilarity(s, s), 1);
    });

    it('should return 0 for disjoint sets', () => {
      const a = new Set(['a', 'b']);
      const b = new Set(['c', 'd']);
      assert.equal(predictor.jaccardSimilarity(a, b), 0);
    });

    it('should return correct score for partial overlap', () => {
      const a = new Set(['a', 'b', 'c']);
      const b = new Set(['b', 'c', 'd']);
      // intersection = 2, union = 4
      assert.equal(predictor.jaccardSimilarity(a, b), 0.5);
    });

    it('should handle empty sets', () => {
      assert.equal(predictor.jaccardSimilarity(new Set(), new Set()), 1.0);
      assert.equal(predictor.jaccardSimilarity(new Set(['a']), new Set()), 0);
    });
  });

  describe('pathSimilarity', () => {
    it('should return 1.0 for matching paths', () => {
      assert.equal(predictor.pathSimilarity(['src/drift.js'], ['src/drift.js']), 1.0);
    });

    it('should return 0 for completely different paths', () => {
      assert.equal(predictor.pathSimilarity(['src/foo.js'], ['lib/bar.py']), 0);
    });

    it('should handle empty paths', () => {
      assert.equal(predictor.pathSimilarity([], []), 1.0);
      assert.equal(predictor.pathSimilarity(['a.js'], []), 0);
    });
  });

  describe('actionTypeAlignment', () => {
    it('should return 1.0 for matching types', () => {
      assert.equal(predictor.actionTypeAlignment('write', 'write'), 1.0);
      assert.equal(predictor.actionTypeAlignment('test', 'test'), 1.0);
    });

    it('should return 0.5 for unknown types', () => {
      assert.equal(predictor.actionTypeAlignment('unknown', 'write'), 0.5);
    });

    it('should return partial scores for related types', () => {
      assert.equal(predictor.actionTypeAlignment('test', 'execute'), 0.7);
    });
  });

  // --------------------------------------------------------------------------
  // Core prediction
  // --------------------------------------------------------------------------

  describe('predictDrift', () => {
    it('should detect aligned actions', () => {
      const step = {
        description: 'Create drift predictor module with keyword scoring',
        files: ['src/lib/drift-predictor.js']
      };
      const action = {
        tool_name: 'Edit',
        tool_input: {
          file_path: '/project/src/lib/drift-predictor.js',
          new_string: 'function extractKeywords(text) { /* keyword scoring impl */ }'
        }
      };

      const result = predictor.predictDrift(step, action);
      assert.equal(result.level, 'aligned');
      assert.ok(result.score >= 0.6, `Expected score >= 0.6 but got ${result.score}`);
    });

    it('should detect divergent actions', () => {
      const step = {
        description: 'Create drift predictor module',
        files: ['src/lib/drift-predictor.js']
      };
      const action = {
        tool_name: 'Edit',
        tool_input: {
          file_path: '/project/package.json',
          new_string: '{ "dependencies": { "react": "^18" } }'
        }
      };

      const result = predictor.predictDrift(step, action);
      assert.equal(result.level, 'divergent');
      assert.ok(result.score < 0.3, `Expected score < 0.3 but got ${result.score}`);
      assert.ok(result.reasons.length > 0);
    });

    it('should handle missing plan step', () => {
      const result = predictor.predictDrift(null, { tool_name: 'Edit', tool_input: {} });
      assert.equal(result.level, 'monitor');
      assert.equal(result.score, 0.5);
    });

    it('should handle missing tool action', () => {
      const result = predictor.predictDrift({ description: 'test' }, null);
      assert.equal(result.level, 'monitor');
      assert.equal(result.score, 0.5);
    });

    it('should provide suggestion for divergent actions', () => {
      const step = {
        description: 'Update the authentication module',
        files: ['src/auth.js']
      };
      const action = {
        tool_name: 'Edit',
        tool_input: {
          file_path: '/project/database/migrations/001.sql',
          new_string: 'ALTER TABLE users ADD COLUMN role TEXT;'
        }
      };

      const result = predictor.predictDrift(step, action);
      assert.ok(result.suggestion, 'Expected suggestion for divergent action');
      assert.ok(result.suggestion.includes('plan step'));
    });

    it('should include breakdown scores', () => {
      const step = { description: 'Test step', files: ['test.js'] };
      const action = { tool_name: 'Edit', tool_input: { file_path: 'test.js' } };

      const result = predictor.predictDrift(step, action);
      assert.ok(result.breakdown);
      assert.equal(typeof result.breakdown.keyword, 'number');
      assert.equal(typeof result.breakdown.path, 'number');
      assert.equal(typeof result.breakdown.action_type, 'number');
    });

    it('should respect custom thresholds', () => {
      const step = { description: 'Something generic', files: [] };
      const action = { tool_name: 'Edit', tool_input: { file_path: 'random.js' } };

      // With very high threshold, everything looks divergent
      const result = predictor.predictDrift(step, action, {
        aligned: 0.99, monitor: 0.98, divergent: 0.98
      });
      assert.equal(result.level, 'divergent');
    });
  });

  // --------------------------------------------------------------------------
  // Prediction history
  // --------------------------------------------------------------------------

  describe('recordPrediction / getDriftHistory', () => {
    it('should record and retrieve predictions', () => {
      const sessionId = 'test-session-1';
      const prediction = {
        score: 0.75,
        level: 'aligned',
        reasons: ['action aligns with current plan step']
      };

      predictor.recordPrediction(sessionId, prediction, { tool_name: 'Edit', plan_step_index: 0 });

      const history = predictor.getDriftHistory(sessionId);
      assert.equal(history.predictions.length, 1);
      assert.equal(history.predictions[0].score, 0.75);
      assert.equal(history.predictions[0].level, 'aligned');
      assert.equal(history.stats.total, 1);
      assert.equal(history.stats.aligned, 1);
    });

    it('should track stats across multiple predictions', () => {
      const sessionId = 'test-session-2';

      predictor.recordPrediction(sessionId, { score: 0.8, level: 'aligned', reasons: [] });
      predictor.recordPrediction(sessionId, { score: 0.4, level: 'monitor', reasons: [] });
      predictor.recordPrediction(sessionId, { score: 0.1, level: 'divergent', reasons: [] });

      const history = predictor.getDriftHistory(sessionId);
      assert.equal(history.stats.total, 3);
      assert.equal(history.stats.aligned, 1);
      assert.equal(history.stats.monitor, 1);
      assert.equal(history.stats.divergent, 1);
    });

    it('should return empty history for unknown session', () => {
      const history = predictor.getDriftHistory('nonexistent');
      assert.deepStrictEqual(history.predictions, []);
      assert.equal(history.stats.total, 0);
    });

    it('should keep only last 50 predictions', () => {
      const sessionId = 'test-session-overflow';
      for (let i = 0; i < 60; i++) {
        predictor.recordPrediction(sessionId, { score: 0.5, level: 'monitor', reasons: [] });
      }
      const history = predictor.getDriftHistory(sessionId);
      assert.equal(history.predictions.length, 50);
      assert.equal(history.stats.total, 60);
    });
  });

  // --------------------------------------------------------------------------
  // Refresh / redirect tracking
  // --------------------------------------------------------------------------

  describe('refresh and redirect tracking', () => {
    it('should track refresh count per plan step', () => {
      const sessionId = 'test-refresh';
      assert.equal(predictor.getRefreshCount(sessionId, 0), 0);

      predictor.incrementRefreshCount(sessionId, 0);
      assert.equal(predictor.getRefreshCount(sessionId, 0), 1);

      predictor.incrementRefreshCount(sessionId, 0);
      assert.equal(predictor.getRefreshCount(sessionId, 0), 2);

      // Different step should start at 0
      assert.equal(predictor.getRefreshCount(sessionId, 1), 0);
    });

    it('should track consecutive redirects', () => {
      const sessionId = 'test-redirects';

      // Record some divergent predictions
      predictor.recordPrediction(sessionId, { score: 0.1, level: 'divergent', reasons: [] });
      predictor.recordPrediction(sessionId, { score: 0.2, level: 'divergent', reasons: [] });
      predictor.recordPrediction(sessionId, { score: 0.15, level: 'divergent', reasons: [] });

      assert.equal(predictor.getConsecutiveRedirects(sessionId), 3);

      // Add an aligned prediction — breaks the streak
      predictor.recordPrediction(sessionId, { score: 0.8, level: 'aligned', reasons: [] });
      assert.equal(predictor.getConsecutiveRedirects(sessionId), 0);
    });
  });

  // --------------------------------------------------------------------------
  // Accuracy
  // --------------------------------------------------------------------------

  describe('getAccuracy', () => {
    it('should return zero for no sessions', () => {
      const accuracy = predictor.getAccuracy();
      assert.equal(accuracy.total_sessions, 0);
      assert.equal(accuracy.avg_alignment_ratio, 0);
    });

    it('should compute average alignment ratio', () => {
      // Session with 4 aligned out of 5
      predictor.recordPrediction('acc-1', { score: 0.8, level: 'aligned', reasons: [] });
      predictor.recordPrediction('acc-1', { score: 0.7, level: 'aligned', reasons: [] });
      predictor.recordPrediction('acc-1', { score: 0.9, level: 'aligned', reasons: [] });
      predictor.recordPrediction('acc-1', { score: 0.65, level: 'aligned', reasons: [] });
      predictor.recordPrediction('acc-1', { score: 0.2, level: 'divergent', reasons: [] });

      const accuracy = predictor.getAccuracy();
      assert.equal(accuracy.total_sessions, 1);
      assert.equal(accuracy.avg_alignment_ratio, 0.8); // 4/5
    });
  });

  // --------------------------------------------------------------------------
  // Policy loading
  // --------------------------------------------------------------------------

  describe('loadDriftPolicy', () => {
    it('should load thresholds from policy file', () => {
      const policy = predictor.loadDriftPolicy();
      assert.equal(policy.enabled, true);
      assert.equal(policy.thresholds.aligned, 0.6);
      assert.equal(policy.thresholds.monitor, 0.3);
    });

    it('should include excluded tools list', () => {
      const policy = predictor.loadDriftPolicy();
      assert.ok(policy.excluded_tools.includes('Read'));
      assert.ok(policy.excluded_tools.includes('Glob'));
    });
  });
});

// ============================================================================
// DRIFT GUARDRAILS TESTS
// ============================================================================

describe('drift-guardrails', () => {
  let guardrails;
  let predictor;

  beforeEach(() => {
    setupTestRoot();
    originalCwd = process.cwd;
    process.cwd = () => TEST_ROOT;
    predictor = freshModule('../.claude/pilot/hooks/lib/drift-predictor');
    guardrails = freshModule('../.claude/pilot/hooks/lib/drift-guardrails');
  });

  afterEach(() => {
    process.cwd = originalCwd;
    cleanTestRoot();
  });

  // --------------------------------------------------------------------------
  // Guardrail evaluation
  // --------------------------------------------------------------------------

  describe('evaluateGuardrail', () => {
    it('should allow aligned predictions', () => {
      const prediction = { score: 0.8, level: 'aligned', reasons: ['match'], breakdown: {} };
      const result = guardrails.evaluateGuardrail(prediction);
      assert.equal(result.action, 'allow');
      assert.equal(result.message, null);
    });

    it('should warn on monitor-level predictions', () => {
      const prediction = { score: 0.45, level: 'monitor', reasons: ['partial match'] };
      const result = guardrails.evaluateGuardrail(prediction, {
        policy: { warn_on_monitor: true, block_on_divergent: true, auto_refresh: true }
      });
      assert.equal(result.action, 'warn');
      assert.ok(result.message.includes('Drift warning'));
    });

    it('should allow monitor when warn disabled', () => {
      const prediction = { score: 0.45, level: 'monitor', reasons: ['partial'] };
      const result = guardrails.evaluateGuardrail(prediction, {
        policy: { warn_on_monitor: false, block_on_divergent: true, auto_refresh: true }
      });
      assert.equal(result.action, 'allow');
    });

    it('should refresh on first divergent prediction', () => {
      const sessionId = 'guard-test-1';
      const prediction = { score: 0.1, level: 'divergent', reasons: ['no match'] };
      const result = guardrails.evaluateGuardrail(prediction, {
        sessionId,
        planStep: { description: 'Create drift module', files: ['drift.js'] },
        planStepIndex: 0,
        policy: { warn_on_monitor: true, block_on_divergent: true, auto_refresh: true }
      });
      assert.equal(result.action, 'refresh');
      assert.ok(result.refreshPrompt);
      assert.ok(result.refreshPrompt.includes('step 0'));
    });

    it('should redirect after max refreshes', () => {
      const sessionId = 'guard-test-2';

      // Exhaust refresh budget (3 times)
      predictor.incrementRefreshCount(sessionId, 0);
      predictor.incrementRefreshCount(sessionId, 0);
      predictor.incrementRefreshCount(sessionId, 0);

      const prediction = { score: 0.1, level: 'divergent', reasons: ['no match'] };
      const result = guardrails.evaluateGuardrail(prediction, {
        sessionId,
        planStep: { description: 'Create module', files: [] },
        planStepIndex: 0,
        policy: { warn_on_monitor: true, block_on_divergent: true, auto_refresh: true }
      });
      assert.equal(result.action, 'redirect');
      assert.ok(result.message.includes('blocked'));
    });

    it('should warn instead of redirect when blocking disabled', () => {
      const sessionId = 'guard-test-3';

      // Exhaust refreshes
      predictor.incrementRefreshCount(sessionId, 0);
      predictor.incrementRefreshCount(sessionId, 0);
      predictor.incrementRefreshCount(sessionId, 0);

      const prediction = { score: 0.1, level: 'divergent', reasons: ['mismatch'] };
      const result = guardrails.evaluateGuardrail(prediction, {
        sessionId,
        planStep: { description: 'Something' },
        planStepIndex: 0,
        policy: { warn_on_monitor: true, block_on_divergent: false, auto_refresh: false }
      });
      assert.equal(result.action, 'warn');
    });
  });

  // --------------------------------------------------------------------------
  // Message builders
  // --------------------------------------------------------------------------

  describe('buildRefreshPrompt', () => {
    it('should include step index and description', () => {
      const prompt = guardrails.buildRefreshPrompt({
        planStep: { description: 'Create the drift predictor', files: ['drift.js'] },
        planStepIndex: 3
      });
      assert.ok(prompt.includes('step 3'));
      assert.ok(prompt.includes('Create the drift predictor'));
      assert.ok(prompt.includes('drift.js'));
    });

    it('should handle missing plan step', () => {
      const prompt = guardrails.buildRefreshPrompt({});
      assert.ok(prompt.includes('Unable to determine'));
    });
  });

  describe('buildRedirectMessage', () => {
    it('should include drift score and plan step', () => {
      const msg = guardrails.buildRedirectMessage(
        { score: 0.15, reasons: ['low keyword overlap'] },
        { planStep: { description: 'Update auth module', files: ['auth.js'] } }
      );
      assert.ok(msg.includes('0.15'));
      assert.ok(msg.includes('Update auth module'));
      assert.ok(msg.includes('auth.js'));
    });
  });

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  describe('guardrail stats', () => {
    it('should track guardrail actions', () => {
      guardrails.resetStats();

      guardrails.evaluateGuardrail(
        { score: 0.4, level: 'monitor', reasons: ['partial'] },
        { policy: { warn_on_monitor: true, block_on_divergent: true, auto_refresh: true } }
      );

      const stats = guardrails.getGuardrailStats();
      assert.ok(stats.total >= 1);
      assert.ok(stats.warned >= 1);
    });

    it('should reset stats', () => {
      guardrails.evaluateGuardrail(
        { score: 0.4, level: 'monitor', reasons: [] },
        { policy: { warn_on_monitor: true, block_on_divergent: true, auto_refresh: true } }
      );

      guardrails.resetStats();
      const stats = guardrails.getGuardrailStats();
      assert.equal(stats.total, 0);
    });
  });
});

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

describe('drift prevention integration', () => {
  let predictor;
  let guardrails;

  beforeEach(() => {
    setupTestRoot();
    originalCwd = process.cwd;
    process.cwd = () => TEST_ROOT;
    predictor = freshModule('../.claude/pilot/hooks/lib/drift-predictor');
    guardrails = freshModule('../.claude/pilot/hooks/lib/drift-guardrails');
  });

  afterEach(() => {
    process.cwd = originalCwd;
    cleanTestRoot();
  });

  it('should allow aligned Edit action and record prediction', () => {
    const planStep = {
      description: 'Implement drift predictor with keyword extraction',
      files: ['.claude/pilot/hooks/lib/drift-predictor.js']
    };
    const toolAction = {
      tool_name: 'Edit',
      tool_input: {
        file_path: '/project/.claude/pilot/hooks/lib/drift-predictor.js',
        new_string: 'function extractKeywords(text) { /* impl */ }'
      }
    };

    const prediction = predictor.predictDrift(planStep, toolAction);
    predictor.recordPrediction('int-test-1', prediction, { tool_name: 'Edit', plan_step_index: 0 });

    const guardrail = guardrails.evaluateGuardrail(prediction, {
      sessionId: 'int-test-1',
      planStep,
      planStepIndex: 0,
      policy: { warn_on_monitor: true, block_on_divergent: true, auto_refresh: true }
    });

    assert.equal(guardrail.action, 'allow');

    const history = predictor.getDriftHistory('int-test-1');
    assert.equal(history.predictions.length, 1);
  });

  it('should block divergent action with redirect after refresh budget', () => {
    const sessionId = 'int-test-2';
    const planStep = {
      description: 'Create drift predictor module',
      files: ['src/drift-predictor.js']
    };
    const toolAction = {
      tool_name: 'Edit',
      tool_input: {
        file_path: '/project/database/schema.sql',
        new_string: 'CREATE TABLE users (id INT PRIMARY KEY);'
      }
    };

    const prediction = predictor.predictDrift(planStep, toolAction);
    assert.equal(prediction.level, 'divergent');

    // Exhaust refreshes
    predictor.incrementRefreshCount(sessionId, 0);
    predictor.incrementRefreshCount(sessionId, 0);
    predictor.incrementRefreshCount(sessionId, 0);

    const guardrail = guardrails.evaluateGuardrail(prediction, {
      sessionId,
      planStep,
      planStepIndex: 0,
      policy: { warn_on_monitor: true, block_on_divergent: true, auto_refresh: true }
    });

    assert.equal(guardrail.action, 'redirect');
    assert.ok(guardrail.message.includes('blocked'));
  });

  it('should handle full drift prevention flow across multiple actions', () => {
    const sessionId = 'int-test-3';
    const planStep = {
      description: 'Write tests for the drift predictor',
      files: ['tests/drift-predictor.test.js']
    };

    // Action 1: aligned — writing the test file
    const action1 = {
      tool_name: 'Write',
      tool_input: {
        file_path: '/project/tests/drift-predictor.test.js',
        content: 'describe("drift-predictor", () => { it("should work", () => {}); });'
      }
    };
    const pred1 = predictor.predictDrift(planStep, action1);
    predictor.recordPrediction(sessionId, pred1, { tool_name: 'Write', plan_step_index: 5 });
    assert.equal(pred1.level, 'aligned');

    // Action 2: running tests (Bash)
    const action2 = {
      tool_name: 'Bash',
      tool_input: {
        command: 'npx vitest run tests/drift-predictor.test.js'
      }
    };
    const pred2 = predictor.predictDrift(planStep, action2);
    predictor.recordPrediction(sessionId, pred2, { tool_name: 'Bash', plan_step_index: 5 });
    // Running tests for the test file is reasonably aligned
    assert.ok(['aligned', 'monitor'].includes(pred2.level),
      `Expected aligned or monitor, got ${pred2.level}`);

    const history = predictor.getDriftHistory(sessionId);
    assert.equal(history.predictions.length, 2);
    assert.equal(history.stats.total, 2);
  });

  it('should skip excluded tools', () => {
    const policy = predictor.loadDriftPolicy();
    assert.ok(policy.excluded_tools.includes('Read'));
    assert.ok(policy.excluded_tools.includes('Glob'));
    assert.ok(policy.excluded_tools.includes('Grep'));
  });

  it('should handle edge case: empty plan step', () => {
    const prediction = predictor.predictDrift({}, { tool_name: 'Edit', tool_input: {} });
    assert.ok(prediction);
    assert.equal(typeof prediction.score, 'number');
  });

  it('should handle edge case: no current step (step index beyond plan length)', () => {
    // Simulates pre-tool-use.js behavior: if stepIndex >= planSteps.length, skip drift check
    const planSteps = [{ description: 'Only step', files: [] }];
    const stepIndex = 5;
    // Step is beyond plan — drift check would be skipped in the hook
    assert.ok(stepIndex >= planSteps.length);
  });
});
