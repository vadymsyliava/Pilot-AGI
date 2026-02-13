/**
 * Tests for User Correction Capture — Phase 7.3 (Pilot AGI-h4yi)
 *
 * Tests:
 * - detectPromptCorrection catches "always use X"
 * - detectPromptCorrection catches "don't use X"
 * - detectPromptCorrection catches "use X instead of Y"
 * - detectPromptCorrection catches "prefer X over Y"
 * - detectPromptCorrection catches "switch to X"
 * - detectPromptCorrection ignores questions
 * - detectPromptCorrection ignores short prompts
 * - detectPromptCorrection ignores commands
 * - classifyCorrection identifies style preferences
 * - classifyCorrection identifies technical preferences
 * - classifyCorrection identifies project conventions
 * - extractRule extracts "always use" patterns
 * - extractRule extracts "instead of" patterns
 * - extractRule extracts "prefer over" patterns
 * - extractRule extracts "don't" patterns
 * - applyCorrection writes rule to soul
 * - applyCorrection deduplicates on reinforcement
 * - applyConfidenceDecay reduces old rule confidence
 * - applyConfidenceDecay removes below-threshold rules
 * - getCorrectionStats returns counts by type
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/correction-capture.test.js
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

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'correction-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/souls'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/corrections'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });

  fs.mkdirSync(path.join(testDir, '.claude/pilot'), { recursive: true });
  fs.writeFileSync(path.join(testDir, '.claude/pilot/agent-registry.json'), JSON.stringify({
    agents: {
      frontend: { name: 'Frontend', description: 'React dev', capabilities: ['styling'] },
      backend: { name: 'Backend', description: 'Node.js dev', capabilities: ['api_design'] }
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
  const modPaths = ['../correction-capture', '../souls', '../policy', '../session', '../memory', '../messaging'];
  for (const modPath of modPaths) {
    try {
      const resolved = require.resolve(modPath);
      delete require.cache[resolved];
    } catch (e) { /* not loaded */ }
  }
  return require('../correction-capture');
}

function freshSouls() {
  try { delete require.cache[require.resolve('../souls')]; } catch (e) {}
  return require('../souls');
}

// ============================================================================
// TESTS
// ============================================================================

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

console.log('\n=== User Correction Capture Tests ===\n');

// --- detectPromptCorrection ---

test('detectPromptCorrection catches "always use X"', () => {
  const cc = freshModule();
  const result = cc.detectPromptCorrection('Always use Zod for validation in this project');
  assert.ok(result, 'Should detect correction');
  assert.ok(result.rule.includes('zod') || result.rule.includes('Zod'));
  assert.strictEqual(result.source, 'prompt');
});

test('detectPromptCorrection catches "don\'t use X"', () => {
  const cc = freshModule();
  const result = cc.detectPromptCorrection("Don't use console.log for debugging, use a proper logger");
  assert.ok(result, 'Should detect correction');
  assert.ok(result.rule.includes('console.log') || result.rule.includes('never'));
});

test('detectPromptCorrection catches "use X instead of Y"', () => {
  const cc = freshModule();
  const result = cc.detectPromptCorrection('No, use vitest instead of jest for testing');
  assert.ok(result, 'Should detect correction');
  assert.ok(result.rule);
});

test('detectPromptCorrection catches "prefer X over Y"', () => {
  const cc = freshModule();
  const result = cc.detectPromptCorrection('I prefer Tailwind over CSS modules for styling');
  assert.ok(result, 'Should detect correction');
  assert.ok(result.rule.includes('Tailwind') || result.rule.includes('tailwind'));
});

test('detectPromptCorrection catches "switch to X"', () => {
  const cc = freshModule();
  const result = cc.detectPromptCorrection('Actually, switch to TypeScript for this file');
  assert.ok(result, 'Should detect correction');
  assert.ok(result.rule.includes('TypeScript') || result.rule.includes('use'));
});

test('detectPromptCorrection ignores questions', () => {
  const cc = freshModule();
  const result = cc.detectPromptCorrection('What testing framework should we use?');
  assert.strictEqual(result, null);
});

test('detectPromptCorrection ignores short prompts', () => {
  const cc = freshModule();
  assert.strictEqual(cc.detectPromptCorrection('ok'), null);
  assert.strictEqual(cc.detectPromptCorrection('yes'), null);
  assert.strictEqual(cc.detectPromptCorrection(''), null);
  assert.strictEqual(cc.detectPromptCorrection(null), null);
});

test('detectPromptCorrection ignores commands', () => {
  const cc = freshModule();
  assert.strictEqual(cc.detectPromptCorrection('/pilot-plan'), null);
});

// --- classifyCorrection ---

test('classifyCorrection identifies style preferences', () => {
  const cc = freshModule();
  assert.strictEqual(cc.classifyCorrection('Always use single quotes and 2 spaces indent'), cc.CORRECTION_TYPES.STYLE_PREFERENCE);
});

test('classifyCorrection identifies technical preferences', () => {
  const cc = freshModule();
  assert.strictEqual(cc.classifyCorrection('Use vitest instead of jest'), cc.CORRECTION_TYPES.TECHNICAL_PREFERENCE);
});

test('classifyCorrection identifies project conventions', () => {
  const cc = freshModule();
  assert.strictEqual(cc.classifyCorrection('In this project we always use barrel exports'), cc.CORRECTION_TYPES.PROJECT_CONVENTION);
});

test('classifyCorrection defaults to factual for unmatched', () => {
  const cc = freshModule();
  assert.strictEqual(cc.classifyCorrection('The API returns a 200 not 201'), cc.CORRECTION_TYPES.FACTUAL_CORRECTION);
});

// --- extractRule ---

test('extractRule extracts "always use" patterns', () => {
  const cc = freshModule();
  const rule = cc.extractRule('Always use Zod for validation');
  assert.ok(rule);
  assert.ok(rule.includes('always') && (rule.includes('Zod') || rule.includes('zod')));
});

test('extractRule extracts "instead of" patterns', () => {
  const cc = freshModule();
  const rule = cc.extractRule('Use pnpm instead of npm');
  assert.ok(rule);
  assert.ok(rule.includes('pnpm'));
  assert.ok(rule.includes('npm'));
});

test('extractRule extracts "prefer over" patterns', () => {
  const cc = freshModule();
  const rule = cc.extractRule('Prefer functional components over class components');
  assert.ok(rule);
  assert.ok(rule.includes('functional'));
});

test('extractRule extracts "don\'t" patterns', () => {
  const cc = freshModule();
  const rule = cc.extractRule("Don't use var for declarations");
  assert.ok(rule);
  assert.ok(rule.includes('never') || rule.includes('var'));
});

test('extractRule returns null for unextractable', () => {
  const cc = freshModule();
  assert.strictEqual(cc.extractRule('hi'), null);
});

// --- applyCorrection ---

test('applyCorrection writes rule to soul', () => {
  const cc = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  const correction = {
    type: cc.CORRECTION_TYPES.TECHNICAL_PREFERENCE,
    rule: 'always use Zod for validation',
    source: 'prompt'
  };

  const result = cc.applyCorrection('frontend', correction);
  assert.ok(result.success);

  const soul = souls.loadSoul('frontend');
  assert.ok(soul.decision_rules.length > 0);
  assert.ok(soul.decision_rules.some(r => r.rule.includes('Zod') || r.rule.includes('zod')));
});

test('applyCorrection deduplicates on reinforcement', () => {
  const cc = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  const correction = {
    type: cc.CORRECTION_TYPES.TECHNICAL_PREFERENCE,
    rule: 'always use Zod',
    source: 'prompt'
  };

  cc.applyCorrection('frontend', correction);
  cc.applyCorrection('frontend', correction);

  const soul = souls.loadSoul('frontend');
  // Should have 1 rule with boosted confidence, not 2
  const zodRules = soul.decision_rules.filter(r => r.rule.includes('Zod'));
  assert.strictEqual(zodRules.length, 1);
  assert.ok(zodRules[0].confidence > 0.8); // boosted
});

test('applyCorrection returns error without role', () => {
  const cc = freshModule();
  const result = cc.applyCorrection(null, { rule: 'test' });
  assert.strictEqual(result.success, false);
});

// --- applyConfidenceDecay ---

test('applyConfidenceDecay reduces old rule confidence', () => {
  const cc = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');
  souls.addDecisionRule('frontend', 'style', 'use tabs', 0.8);

  // Fake an old correction log entry (90 days ago)
  const logDir = path.join(process.cwd(), '.claude/pilot/state/corrections');
  fs.mkdirSync(logDir, { recursive: true });
  const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(
    path.join(logDir, 'frontend.jsonl'),
    JSON.stringify({ rule: 'use tabs', detected_at: oldDate }) + '\n'
  );

  const result = cc.applyConfidenceDecay('frontend');
  assert.ok(result.decayed > 0 || result.removed > 0);
});

test('applyConfidenceDecay handles no rules gracefully', () => {
  const cc = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  const result = cc.applyConfidenceDecay('frontend');
  assert.strictEqual(result.decayed, 0);
  assert.strictEqual(result.removed, 0);
});

// --- getCorrectionStats ---

test('getCorrectionStats returns counts by type', () => {
  const cc = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  cc.applyCorrection('frontend', {
    type: cc.CORRECTION_TYPES.STYLE_PREFERENCE,
    rule: 'use single quotes',
    source: 'prompt'
  });
  cc.applyCorrection('frontend', {
    type: cc.CORRECTION_TYPES.TECHNICAL_PREFERENCE,
    rule: 'use vitest',
    source: 'prompt'
  });

  const stats = cc.getCorrectionStats('frontend');
  assert.strictEqual(stats.total, 2);
  assert.ok(stats.by_type[cc.CORRECTION_TYPES.STYLE_PREFERENCE] >= 1);
  assert.ok(stats.by_type[cc.CORRECTION_TYPES.TECHNICAL_PREFERENCE] >= 1);
});

test('getCorrectionStats returns empty for no corrections', () => {
  const cc = freshModule();
  const stats = cc.getCorrectionStats('nonexistent');
  assert.strictEqual(stats.total, 0);
});

// --- correctionTypeToArea ---

test('correctionTypeToArea maps types correctly', () => {
  const cc = freshModule();
  assert.strictEqual(cc.correctionTypeToArea(cc.CORRECTION_TYPES.STYLE_PREFERENCE), 'style');
  assert.strictEqual(cc.correctionTypeToArea(cc.CORRECTION_TYPES.TECHNICAL_PREFERENCE), 'technology');
  assert.strictEqual(cc.correctionTypeToArea(cc.CORRECTION_TYPES.PROJECT_CONVENTION), 'convention');
  assert.strictEqual(cc.correctionTypeToArea(cc.CORRECTION_TYPES.FACTUAL_CORRECTION), 'general');
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
