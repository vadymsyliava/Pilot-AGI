/**
 * Tests for Opinionated Agent Personalities — Phase 7.5 (Pilot AGI-p92y)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/opinion-tracker.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opinion-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/opinions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/souls'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot'), { recursive: true });
  fs.writeFileSync(path.join(testDir, '.claude/pilot/agent-registry.json'), JSON.stringify({
    agents: {
      frontend: { name: 'Frontend', capabilities: ['styling'] },
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
  const modPaths = ['../opinion-tracker', '../souls', '../policy', '../session', '../memory', '../messaging'];
  for (const modPath of modPaths) {
    try { delete require.cache[require.resolve(modPath)]; } catch (e) {}
  }
  return require('../opinion-tracker');
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

console.log('\n=== Opinion Tracker Tests ===\n');

// --- recordPatternUse ---

test('recordPatternUse tracks successes', () => {
  const ot = freshModule();
  const r = ot.recordPatternUse('frontend', 'styling', 'Tailwind', 'T-001', true);
  assert.ok(r.success);
  assert.strictEqual(r.uses, 1);
  assert.strictEqual(r.successes, 1);
  assert.strictEqual(r.strength, ot.STRENGTH.NONE);
});

test('recordPatternUse strength reaches weak at threshold', () => {
  const ot = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  for (let i = 0; i < ot.STRENGTH_THRESHOLDS.weak; i++) {
    ot.recordPatternUse('frontend', 'styling', 'Tailwind', `T-${i}`, true);
  }

  const opinions = ot.getOpinions('frontend');
  const tailwind = opinions.find(o => o.pattern === 'Tailwind');
  assert.ok(tailwind);
  assert.strictEqual(tailwind.strength, ot.STRENGTH.WEAK);
});

test('recordPatternUse strength reaches strong at threshold', () => {
  const ot = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  for (let i = 0; i < ot.STRENGTH_THRESHOLDS.strong; i++) {
    ot.recordPatternUse('frontend', 'styling', 'Tailwind', `T-${i}`, true);
  }

  const opinions = ot.getOpinions('frontend');
  const tailwind = opinions.find(o => o.pattern === 'Tailwind');
  assert.strictEqual(tailwind.strength, ot.STRENGTH.STRONG);
});

test('recordPatternUse tracks failures separately', () => {
  const ot = freshModule();
  ot.recordPatternUse('frontend', 'styling', 'CSS-in-JS', 'T-001', true);
  ot.recordPatternUse('frontend', 'styling', 'CSS-in-JS', 'T-002', false);

  const opinions = ot.getOpinions('frontend');
  const cssInJs = opinions.find(o => o.pattern === 'CSS-in-JS');
  assert.strictEqual(cssInJs.uses, 2);
  assert.strictEqual(cssInJs.successes, 1);
  assert.strictEqual(cssInJs.failures, 1);
  assert.strictEqual(cssInJs.success_rate, 50);
});

test('recordPatternUse requires role, area, pattern', () => {
  const ot = freshModule();
  assert.strictEqual(ot.recordPatternUse(null, 'a', 'b', 't', true).success, false);
  assert.strictEqual(ot.recordPatternUse('r', null, 'b', 't', true).success, false);
  assert.strictEqual(ot.recordPatternUse('r', 'a', null, 't', true).success, false);
});

test('recordPatternUse writes to soul on threshold cross', () => {
  const ot = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  for (let i = 0; i < ot.STRENGTH_THRESHOLDS.weak; i++) {
    ot.recordPatternUse('frontend', 'testing', 'Vitest', `T-${i}`, true);
  }

  const soul = souls.loadSoul('frontend');
  assert.ok(soul.decision_rules.some(r => r.rule.includes('Vitest')));
});

// --- getStrength ---

test('getStrength returns correct levels', () => {
  const ot = freshModule();
  assert.strictEqual(ot.getStrength(0), ot.STRENGTH.NONE);
  assert.strictEqual(ot.getStrength(1), ot.STRENGTH.NONE);
  assert.strictEqual(ot.getStrength(2), ot.STRENGTH.WEAK);
  assert.strictEqual(ot.getStrength(5), ot.STRENGTH.MODERATE);
  assert.strictEqual(ot.getStrength(10), ot.STRENGTH.STRONG);
  assert.strictEqual(ot.getStrength(50), ot.STRENGTH.STRONG);
});

// --- expressOpinion ---

test('expressOpinion returns natural language', () => {
  const ot = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  for (let i = 0; i < 5; i++) {
    ot.recordPatternUse('frontend', 'styling', 'Tailwind', `T-${i}`, true);
  }

  const expression = ot.expressOpinion('frontend', 'styling');
  assert.ok(expression);
  assert.ok(expression.includes('prefer'));
  assert.ok(expression.includes('Tailwind'));
  assert.ok(expression.includes('styling'));
});

test('expressOpinion returns null for no opinions', () => {
  const ot = freshModule();
  assert.strictEqual(ot.expressOpinion('frontend', 'unknown_area'), null);
});

test('expressOpinion returns null for weak opinions below threshold', () => {
  const ot = freshModule();
  ot.recordPatternUse('frontend', 'styling', 'Tailwind', 'T-001', true);
  assert.strictEqual(ot.expressOpinion('frontend', 'styling'), null);
});

// --- getOpinions ---

test('getOpinions returns sorted by strength', () => {
  const ot = freshModule();
  ot.recordPatternUse('frontend', 'a', 'pattern1', 'T-001', true);
  ot.recordPatternUse('frontend', 'a', 'pattern1', 'T-002', true);
  ot.recordPatternUse('frontend', 'a', 'pattern1', 'T-003', true);
  ot.recordPatternUse('frontend', 'b', 'pattern2', 'T-004', true);

  const opinions = ot.getOpinions('frontend');
  assert.strictEqual(opinions.length, 2);
  assert.strictEqual(opinions[0].pattern, 'pattern1');
  assert.ok(opinions[0].successes > opinions[1].successes);
});

test('getOpinions returns empty for no opinions', () => {
  const ot = freshModule();
  assert.deepStrictEqual(ot.getOpinions('nonexistent'), []);
});

// --- challengeOpinion ---

test('challengeOpinion marks opinion as challenged', () => {
  const ot = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  for (let i = 0; i < 5; i++) {
    ot.recordPatternUse('frontend', 'styling', 'Tailwind', `T-${i}`, true);
  }

  const result = ot.challengeOpinion(
    'frontend', 'styling', 'Tailwind',
    'CSS Modules have better type safety', 'pm'
  );
  assert.ok(result.success);

  const opinions = ot.getOpinions('frontend');
  const tailwind = opinions.find(o => o.pattern === 'Tailwind');
  assert.ok(tailwind.challenged);
});

test('challengeOpinion reduces soul confidence', () => {
  const ot = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  for (let i = 0; i < 5; i++) {
    ot.recordPatternUse('frontend', 'styling', 'Tailwind', `T-${i}`, true);
  }

  // Get original confidence
  let soul = souls.loadSoul('frontend');
  const originalRule = soul.decision_rules.find(r => r.rule.includes('Tailwind'));
  const originalConf = originalRule ? originalRule.confidence : 1.0;

  ot.challengeOpinion('frontend', 'styling', 'Tailwind', 'counter evidence', 'pm');

  soul = souls.loadSoul('frontend');
  const updatedRule = soul.decision_rules.find(r => r.rule.includes('Tailwind'));
  assert.ok(updatedRule.confidence < originalConf);
});

test('challengeOpinion returns error for nonexistent opinion', () => {
  const ot = freshModule();
  const result = ot.challengeOpinion('frontend', 'x', 'y', 'z', 'pm');
  assert.strictEqual(result.success, false);
});

// --- resolveChallenge ---

test('resolveChallenge accepted halves successes', () => {
  const ot = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  for (let i = 0; i < 10; i++) {
    ot.recordPatternUse('frontend', 'styling', 'Tailwind', `T-${i}`, true);
  }
  ot.challengeOpinion('frontend', 'styling', 'Tailwind', 'reason', 'pm');

  const result = ot.resolveChallenge('frontend', 'styling', 'Tailwind', true);
  assert.ok(result.success);
  assert.ok(result.accepted);
  assert.strictEqual(result.new_strength, ot.STRENGTH.MODERATE); // 10 -> 5

  const opinions = ot.getOpinions('frontend');
  const tw = opinions.find(o => o.pattern === 'Tailwind');
  assert.strictEqual(tw.successes, 5);
});

test('resolveChallenge rejected keeps successes', () => {
  const ot = freshModule();
  for (let i = 0; i < 10; i++) {
    ot.recordPatternUse('frontend', 'styling', 'Tailwind', `T-${i}`, true);
  }
  ot.challengeOpinion('frontend', 'styling', 'Tailwind', 'reason', 'pm');

  const result = ot.resolveChallenge('frontend', 'styling', 'Tailwind', false);
  assert.ok(result.success);
  assert.strictEqual(result.accepted, false);

  const opinions = ot.getOpinions('frontend');
  const tw = opinions.find(o => o.pattern === 'Tailwind');
  assert.strictEqual(tw.successes, 10);
});

// --- checkConvergence ---

test('checkConvergence detects shared opinions across 3+ agents', () => {
  const ot = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');
  souls.initializeSoul('backend');
  souls.initializeSoul('testing');

  // All 3 agents form opinions on same pattern
  for (const role of ['frontend', 'backend', 'testing']) {
    for (let i = 0; i < 3; i++) {
      ot.recordPatternUse(role, 'testing', 'Vitest', `T-${role}-${i}`, true);
    }
  }

  const result = ot.checkConvergence(['frontend', 'backend', 'testing']);
  assert.ok(result.convergent_areas.length > 0);
  assert.ok(result.convergent_areas.some(a => a.pattern === 'Vitest'));
});

test('checkConvergence returns empty when no convergence', () => {
  const ot = freshModule();
  ot.recordPatternUse('frontend', 'styling', 'Tailwind', 'T-1', true);
  ot.recordPatternUse('frontend', 'styling', 'Tailwind', 'T-2', true);

  const result = ot.checkConvergence(['frontend', 'backend', 'testing']);
  assert.strictEqual(result.convergent_areas.length, 0);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
