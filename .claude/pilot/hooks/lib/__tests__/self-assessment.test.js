/**
 * Tests for Agent Self-Assessment & Growth Tracking — Phase 7.6 (Pilot AGI-m370)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/self-assessment.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfassess-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/assessments'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/souls'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot'), { recursive: true });
  fs.writeFileSync(path.join(testDir, '.claude/pilot/agent-registry.json'), JSON.stringify({
    agents: {
      frontend: { name: 'Frontend', capabilities: ['styling', 'components'] },
      backend: { name: 'Backend', capabilities: ['api_design'] },
      testing: { name: 'Testing', capabilities: ['unit_testing'] }
    }
  }, null, 2));

  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModule() {
  const modPaths = ['../self-assessment', '../souls', '../policy', '../session', '../memory', '../messaging'];
  for (const modPath of modPaths) {
    try { delete require.cache[require.resolve(modPath)]; } catch (e) {}
  }
  return require('../self-assessment');
}

function freshSouls() {
  try { delete require.cache[require.resolve('../souls')]; } catch (e) {}
  return require('../souls');
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  setup();
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  } finally {
    teardown();
  }
}

console.log('\n=== Self-Assessment Tests ===\n');

// --- recordTaskCompletion ---

test('recordTaskCompletion tracks a successful task', () => {
  const sa = freshModule();
  const r = sa.recordTaskCompletion('frontend', 'T-001', 'styling', {
    success: true, duration_minutes: 15, errors: 0
  });
  assert.ok(r.success);
  assert.strictEqual(r.metrics.tasks_completed, 1);
  assert.strictEqual(r.metrics.successes, 1);
  assert.strictEqual(r.metrics.success_rate, 100);
});

test('recordTaskCompletion tracks a failed task', () => {
  const sa = freshModule();
  sa.recordTaskCompletion('frontend', 'T-001', 'styling', {
    success: true, duration_minutes: 10, errors: 0
  });
  const r = sa.recordTaskCompletion('frontend', 'T-002', 'styling', {
    success: false, duration_minutes: 20, errors: 2
  });
  assert.ok(r.success);
  assert.strictEqual(r.metrics.tasks_completed, 2);
  assert.strictEqual(r.metrics.successes, 1);
  assert.strictEqual(r.metrics.success_rate, 50);
  assert.strictEqual(r.metrics.total_errors, 2);
});

test('recordTaskCompletion requires all params', () => {
  const sa = freshModule();
  assert.strictEqual(sa.recordTaskCompletion(null, 'T', 'a', {}).success, false);
  assert.strictEqual(sa.recordTaskCompletion('r', null, 'a', {}).success, false);
  assert.strictEqual(sa.recordTaskCompletion('r', 'T', null, {}).success, false);
  assert.strictEqual(sa.recordTaskCompletion('r', 'T', 'a', null).success, false);
});

test('recordTaskCompletion computes avg duration', () => {
  const sa = freshModule();
  sa.recordTaskCompletion('frontend', 'T-001', 'styling', {
    success: true, duration_minutes: 10, errors: 0
  });
  sa.recordTaskCompletion('frontend', 'T-002', 'styling', {
    success: true, duration_minutes: 20, errors: 0
  });
  const r = sa.recordTaskCompletion('frontend', 'T-003', 'styling', {
    success: true, duration_minutes: 30, errors: 0
  });
  assert.strictEqual(r.metrics.avg_duration_minutes, 20);
});

test('recordTaskCompletion caps history at MAX_TASK_HISTORY', () => {
  const sa = freshModule();
  for (let i = 0; i < sa.MAX_TASK_HISTORY + 10; i++) {
    sa.recordTaskCompletion('frontend', `T-${i}`, 'styling', {
      success: true, duration_minutes: 5, errors: 0
    });
  }
  const state = sa.loadAssessment('frontend');
  assert.strictEqual(state.task_history.length, sa.MAX_TASK_HISTORY);
});

// --- getMetrics ---

test('getMetrics returns role metrics', () => {
  const sa = freshModule();
  sa.recordTaskCompletion('frontend', 'T-001', 'styling', {
    success: true, duration_minutes: 10, errors: 0
  });
  sa.recordTaskCompletion('frontend', 'T-002', 'api_design', {
    success: true, duration_minutes: 20, errors: 1
  });

  const m = sa.getMetrics('frontend');
  assert.strictEqual(m.role, 'frontend');
  assert.strictEqual(m.total_tasks, 2);
  assert.ok(m.skills.styling);
  assert.ok(m.skills.api_design);
});

test('getMetrics returns empty for new role', () => {
  const sa = freshModule();
  const m = sa.getMetrics('nonexistent');
  assert.strictEqual(m.total_tasks, 0);
  assert.deepStrictEqual(m.skills, {});
});

// --- getSkillScores ---

test('getSkillScores computes normalized scores', () => {
  const sa = freshModule();
  for (let i = 0; i < 5; i++) {
    sa.recordTaskCompletion('frontend', `T-${i}`, 'styling', {
      success: true, duration_minutes: 15, errors: 0
    });
  }

  const scores = sa.getSkillScores('frontend');
  assert.ok(scores.styling);
  assert.ok(scores.styling.total > 0);
  assert.ok(scores.styling.total <= 100);
  assert.strictEqual(scores.styling.success, 100);
  assert.strictEqual(scores.styling.tasks_completed, 5);
});

test('getSkillScores penalizes high error rate', () => {
  const sa = freshModule();
  // Good area
  for (let i = 0; i < 3; i++) {
    sa.recordTaskCompletion('frontend', `T-g${i}`, 'styling', {
      success: true, duration_minutes: 15, errors: 0
    });
  }
  // Bad area
  for (let i = 0; i < 3; i++) {
    sa.recordTaskCompletion('frontend', `T-b${i}`, 'testing', {
      success: true, duration_minutes: 15, errors: 5
    });
  }

  const scores = sa.getSkillScores('frontend');
  assert.ok(scores.styling.total > scores.testing.total);
});

test('getSkillScores returns empty for no tasks', () => {
  const sa = freshModule();
  const scores = sa.getSkillScores('frontend');
  assert.deepStrictEqual(scores, {});
});

// --- detectSkillGaps ---

test('detectSkillGaps finds low success rate', () => {
  const sa = freshModule();
  sa.recordTaskCompletion('frontend', 'T-1', 'styling', { success: true, duration_minutes: 10, errors: 0 });
  sa.recordTaskCompletion('frontend', 'T-2', 'styling', { success: false, duration_minutes: 10, errors: 1 });
  sa.recordTaskCompletion('frontend', 'T-3', 'styling', { success: false, duration_minutes: 10, errors: 1 });

  const { gaps } = sa.detectSkillGaps('frontend');
  assert.ok(gaps.length > 0);
  assert.ok(gaps.some(g => g.issue === 'low_success_rate'));
});

test('detectSkillGaps finds high error rate', () => {
  const sa = freshModule();
  sa.recordTaskCompletion('frontend', 'T-1', 'api', { success: true, duration_minutes: 10, errors: 5 });
  sa.recordTaskCompletion('frontend', 'T-2', 'api', { success: true, duration_minutes: 10, errors: 4 });

  const { gaps } = sa.detectSkillGaps('frontend');
  assert.ok(gaps.some(g => g.issue === 'high_error_rate'));
});

test('detectSkillGaps finds slow completion', () => {
  const sa = freshModule();
  sa.recordTaskCompletion('frontend', 'T-1', 'complex', { success: true, duration_minutes: 90, errors: 0 });
  sa.recordTaskCompletion('frontend', 'T-2', 'complex', { success: true, duration_minutes: 80, errors: 0 });

  const { gaps } = sa.detectSkillGaps('frontend');
  assert.ok(gaps.some(g => g.issue === 'slow_completion'));
});

test('detectSkillGaps returns empty for strong performer', () => {
  const sa = freshModule();
  for (let i = 0; i < 5; i++) {
    sa.recordTaskCompletion('frontend', `T-${i}`, 'styling', {
      success: true, duration_minutes: 15, errors: 0
    });
  }

  const { gaps } = sa.detectSkillGaps('frontend');
  assert.strictEqual(gaps.length, 0);
});

test('detectSkillGaps skips areas with < 2 tasks', () => {
  const sa = freshModule();
  sa.recordTaskCompletion('frontend', 'T-1', 'styling', {
    success: false, duration_minutes: 100, errors: 10
  });

  const { gaps } = sa.detectSkillGaps('frontend');
  assert.strictEqual(gaps.length, 0);
});

// --- syncSkillsToSoul ---

test('syncSkillsToSoul writes expertise to soul', () => {
  const sa = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  for (let i = 0; i < 5; i++) {
    sa.recordTaskCompletion('frontend', `T-${i}`, 'styling', {
      success: true, duration_minutes: 15, errors: 0
    });
  }

  const result = sa.syncSkillsToSoul('frontend');
  assert.ok(result.success);

  const soul = souls.loadSoul('frontend');
  assert.ok(soul.expertise.some(e => e.includes('styling')));
});

// --- setGrowthGoal ---

test('setGrowthGoal creates a new goal', () => {
  const sa = freshModule();
  const r = sa.setGrowthGoal('frontend', 'styling', 'Reach 90% success rate', 90);
  assert.ok(r.success);
  assert.strictEqual(r.goals.length, 1);
  assert.strictEqual(r.goals[0].area, 'styling');
  assert.strictEqual(r.goals[0].status, 'active');
});

test('setGrowthGoal updates existing goal in same area', () => {
  const sa = freshModule();
  sa.setGrowthGoal('frontend', 'styling', 'Reach 80%', 80);
  const r = sa.setGrowthGoal('frontend', 'styling', 'Reach 90%', 90);
  assert.ok(r.success);
  assert.strictEqual(r.goals.length, 1);
  assert.strictEqual(r.goals[0].target, 'Reach 90%');
});

test('setGrowthGoal enforces MAX_GOALS', () => {
  const sa = freshModule();
  for (let i = 0; i < sa.MAX_GOALS; i++) {
    sa.setGrowthGoal('frontend', `area-${i}`, 'goal', 90);
  }
  const r = sa.setGrowthGoal('frontend', 'one-more', 'goal', 90);
  assert.strictEqual(r.success, false);
});

test('setGrowthGoal requires params', () => {
  const sa = freshModule();
  assert.strictEqual(sa.setGrowthGoal(null, 'a', 't').success, false);
  assert.strictEqual(sa.setGrowthGoal('r', null, 't').success, false);
  assert.strictEqual(sa.setGrowthGoal('r', 'a', null).success, false);
});

// --- updateGoalProgress ---

test('updateGoalProgress updates active goal', () => {
  const sa = freshModule();
  sa.setGrowthGoal('frontend', 'styling', 'Reach 90%', 90);
  const r = sa.updateGoalProgress('frontend', 'styling', 50);
  assert.ok(r.success);
  assert.strictEqual(r.goal.progress, 50);
});

test('updateGoalProgress marks achieved at 100', () => {
  const sa = freshModule();
  sa.setGrowthGoal('frontend', 'styling', 'Reach 90%', 90);
  const r = sa.updateGoalProgress('frontend', 'styling', 100);
  assert.ok(r.success);
  assert.strictEqual(r.goal.status, 'achieved');
  assert.ok(r.goal.achieved_at);
});

test('updateGoalProgress returns error for missing goal', () => {
  const sa = freshModule();
  const r = sa.updateGoalProgress('frontend', 'nonexistent', 50);
  assert.strictEqual(r.success, false);
});

// --- generateRetrospective ---

test('generateRetrospective analyzes recent tasks', () => {
  const sa = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  // Record some tasks
  for (let i = 0; i < 5; i++) {
    sa.recordTaskCompletion('frontend', `T-${i}`, 'styling', {
      success: true, duration_minutes: 15, errors: 0
    });
  }
  sa.recordTaskCompletion('frontend', 'T-bad', 'testing', {
    success: false, duration_minutes: 30, errors: 3
  });

  const r = sa.generateRetrospective('frontend', 7);
  assert.ok(r.success);
  assert.strictEqual(r.retrospective.tasks_completed, 6);
  assert.ok(r.retrospective.overall_success_rate > 0);
  assert.ok(r.retrospective.area_stats.styling);
});

test('generateRetrospective identifies strengths', () => {
  const sa = freshModule();
  for (let i = 0; i < 5; i++) {
    sa.recordTaskCompletion('frontend', `T-${i}`, 'styling', {
      success: true, duration_minutes: 15, errors: 0
    });
  }

  const r = sa.generateRetrospective('frontend', 7);
  assert.ok(r.retrospective.strengths.length > 0);
  assert.ok(r.retrospective.strengths[0].includes('styling'));
});

test('generateRetrospective identifies improvements', () => {
  const sa = freshModule();
  sa.recordTaskCompletion('frontend', 'T-1', 'api', { success: false, duration_minutes: 10, errors: 2 });
  sa.recordTaskCompletion('frontend', 'T-2', 'api', { success: false, duration_minutes: 10, errors: 1 });
  sa.recordTaskCompletion('frontend', 'T-3', 'api', { success: true, duration_minutes: 10, errors: 0 });

  const r = sa.generateRetrospective('frontend', 7);
  assert.ok(r.retrospective.improvements.length > 0);
});

test('generateRetrospective returns error for no recent tasks', () => {
  const sa = freshModule();
  const r = sa.generateRetrospective('frontend', 7);
  assert.strictEqual(r.success, false);
});

test('generateRetrospective caps stored retrospectives', () => {
  const sa = freshModule();
  // Record enough tasks so retrospectives can be generated
  for (let i = 0; i < sa.MAX_RETROSPECTIVES + 3; i++) {
    sa.recordTaskCompletion('frontend', `T-${i}`, 'styling', {
      success: true, duration_minutes: 10, errors: 0
    });
    sa.generateRetrospective('frontend', 30);
  }

  const retros = sa.getRetrospectives('frontend');
  assert.ok(retros.length <= sa.MAX_RETROSPECTIVES);
});

// --- getRetrospectives ---

test('getRetrospectives returns empty for new role', () => {
  const sa = freshModule();
  assert.deepStrictEqual(sa.getRetrospectives('frontend'), []);
});

test('getRetrospectives respects limit', () => {
  const sa = freshModule();
  for (let i = 0; i < 5; i++) {
    sa.recordTaskCompletion('frontend', `T-${i}`, 'styling', {
      success: true, duration_minutes: 10, errors: 0
    });
    sa.generateRetrospective('frontend', 30);
  }

  const retros = sa.getRetrospectives('frontend', 2);
  assert.strictEqual(retros.length, 2);
});

// --- goal auto-achievement ---

test('goal auto-achieves when target_metric is met', () => {
  const sa = freshModule();
  sa.setGrowthGoal('frontend', 'styling', 'Reach 100% success', 100);

  for (let i = 0; i < 3; i++) {
    sa.recordTaskCompletion('frontend', `T-${i}`, 'styling', {
      success: true, duration_minutes: 10, errors: 0
    });
  }

  const state = sa.loadAssessment('frontend');
  const goal = state.goals.find(g => g.area === 'styling');
  assert.strictEqual(goal.status, 'achieved');
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
