/**
 * Tests for Agent Soul Module — Phase 7.1 (Pilot AGI-tfro)
 *
 * Tests:
 * - initializeSoul creates default soul with correct traits
 * - loadSoul parses SOUL.md format
 * - writeSoul serializes and bumps version
 * - recordLesson appends and enforces MAX_LESSONS
 * - addDecisionRule with dedup and confidence boost
 * - consolidateSoul trims within 4KB budget
 * - calibrateSoul (PM editor) merges updates
 * - resetSoul soft (keeps lessons) and hard (full wipe)
 * - listSouls returns all role summaries
 * - loadSoulContext returns compact injection data
 * - updateSection merges content correctly
 * - parseSoul/serializeSoul roundtrip
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/souls.test.js
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
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'souls-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/souls'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });

  // Write minimal agent-registry.json
  fs.mkdirSync(path.join(testDir, '.claude/pilot'), { recursive: true });
  fs.writeFileSync(path.join(testDir, '.claude/pilot/agent-registry.json'), JSON.stringify({
    agents: {
      frontend: {
        name: 'Frontend Agent',
        description: 'React/Next.js specialist',
        capabilities: ['component_creation', 'styling', 'accessibility']
      },
      backend: {
        name: 'Backend Agent',
        description: 'Node.js API specialist',
        capabilities: ['api_design', 'database_operations']
      }
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
  const modPaths = ['../souls', '../policy', '../session', '../memory', '../messaging'];
  for (const modPath of modPaths) {
    try {
      const resolved = require.resolve(modPath);
      delete require.cache[resolved];
    } catch (e) { /* not loaded */ }
  }
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

console.log('\n=== Agent Soul Module Tests ===\n');

// --- initializeSoul ---

test('initializeSoul creates default soul with correct traits', () => {
  const souls = freshModule();
  const soul = souls.initializeSoul('frontend');

  assert.strictEqual(soul.meta.role, 'frontend');
  assert.strictEqual(soul.meta.version, '1');
  assert.strictEqual(soul.traits.risk_tolerance, 'moderate');
  assert.strictEqual(soul.traits.verbosity, 'concise');
  assert.strictEqual(soul.traits.testing_preference, 'component_tests');
  assert.ok(soul.expertise.includes('component creation'));
  assert.ok(soul.expertise.includes('styling'));
  assert.ok(soul.preferences.some(p => p.includes('React/Next.js')));
});

test('initializeSoul does not overwrite existing soul', () => {
  const souls = freshModule();
  souls.initializeSoul('frontend');
  souls.recordLesson('frontend', 'test lesson');
  const soul = souls.initializeSoul('frontend');
  assert.strictEqual(soul.lessons_learned.length, 1);
});

test('initializeSoul creates soul for unknown role with defaults', () => {
  const souls = freshModule();
  const soul = souls.initializeSoul('infra');
  assert.strictEqual(soul.meta.role, 'infra');
  assert.strictEqual(soul.traits.risk_tolerance, 'conservative');
});

// --- loadSoul / parseSoul ---

test('loadSoul returns null for nonexistent role', () => {
  const souls = freshModule();
  assert.strictEqual(souls.loadSoul('nonexistent'), null);
});

test('parseSoul roundtrips correctly', () => {
  const souls = freshModule();
  const original = {
    meta: { role: 'test', created: '2026-01-01', version: '3' },
    traits: { risk_tolerance: 'bold', verbosity: 'detailed' },
    expertise: ['node.js', 'testing'],
    preferences: ['prefer vitest'],
    lessons_learned: [
      { date: '2026-01-15', task_id: 'T-001', lesson: 'Always check null' }
    ],
    decision_rules: [
      { area: 'testing', rule: 'Use vitest over jest', confidence: 0.9 }
    ]
  };

  const serialized = souls.serializeSoul(original);
  const parsed = souls.parseSoul(serialized);

  assert.strictEqual(parsed.meta.role, 'test');
  assert.strictEqual(parsed.traits.risk_tolerance, 'bold');
  assert.deepStrictEqual(parsed.expertise, ['node.js', 'testing']);
  assert.deepStrictEqual(parsed.preferences, ['prefer vitest']);
  assert.strictEqual(parsed.lessons_learned.length, 1);
  assert.strictEqual(parsed.lessons_learned[0].task_id, 'T-001');
  assert.strictEqual(parsed.lessons_learned[0].lesson, 'Always check null');
  assert.strictEqual(parsed.decision_rules.length, 1);
  assert.strictEqual(parsed.decision_rules[0].area, 'testing');
  assert.strictEqual(parsed.decision_rules[0].confidence, 0.9);
});

// --- writeSoul / version bumping ---

test('writeSoul bumps version on update', () => {
  const souls = freshModule();
  souls.initializeSoul('frontend');
  const soul = souls.loadSoul('frontend');
  assert.strictEqual(parseInt(soul.meta.version), 1);

  // Update via writeSoul (no keepVersion)
  souls.recordLesson('frontend', 'learned something');
  const updated = souls.loadSoul('frontend');
  assert.strictEqual(parseInt(updated.meta.version), 2);
});

// --- recordLesson ---

test('recordLesson appends lesson with timestamp', () => {
  const souls = freshModule();
  souls.initializeSoul('backend');
  souls.recordLesson('backend', 'Always validate input', 'T-100');

  const soul = souls.loadSoul('backend');
  assert.strictEqual(soul.lessons_learned.length, 1);
  assert.strictEqual(soul.lessons_learned[0].lesson, 'Always validate input');
  assert.strictEqual(soul.lessons_learned[0].task_id, 'T-100');
  assert.ok(soul.lessons_learned[0].date);
});

test('recordLesson enforces MAX_LESSONS limit', () => {
  const souls = freshModule();
  souls.initializeSoul('frontend');

  // Add MAX_LESSONS + 5 lessons
  for (let i = 0; i < souls.MAX_LESSONS + 5; i++) {
    souls.recordLesson('frontend', `Lesson ${i}`);
  }

  const soul = souls.loadSoul('frontend');
  assert.strictEqual(soul.lessons_learned.length, souls.MAX_LESSONS);
  // Should keep the latest ones
  assert.ok(soul.lessons_learned[soul.lessons_learned.length - 1].lesson.includes(`Lesson ${souls.MAX_LESSONS + 4}`));
});

test('recordLesson auto-initializes soul if missing', () => {
  const souls = freshModule();
  // Don't call initializeSoul first
  souls.recordLesson('frontend', 'auto-init test');
  const soul = souls.loadSoul('frontend');
  assert.ok(soul);
  assert.strictEqual(soul.lessons_learned.length, 1);
});

// --- addDecisionRule ---

test('addDecisionRule adds new rule', () => {
  const souls = freshModule();
  souls.initializeSoul('frontend');
  souls.addDecisionRule('frontend', 'styling', 'Use Tailwind over CSS modules', 0.8);

  const soul = souls.loadSoul('frontend');
  assert.strictEqual(soul.decision_rules.length, 1);
  assert.strictEqual(soul.decision_rules[0].area, 'styling');
  assert.strictEqual(soul.decision_rules[0].confidence, 0.8);
});

test('addDecisionRule deduplicates and boosts confidence', () => {
  const souls = freshModule();
  souls.initializeSoul('frontend');
  souls.addDecisionRule('frontend', 'styling', 'Use Tailwind', 0.7);
  souls.addDecisionRule('frontend', 'styling', 'Use Tailwind', 0.7);

  const soul = souls.loadSoul('frontend');
  assert.strictEqual(soul.decision_rules.length, 1);
  assert.ok(soul.decision_rules[0].confidence > 0.7);
});

test('addDecisionRule enforces MAX_DECISION_RULES', () => {
  const souls = freshModule();
  souls.initializeSoul('frontend');

  for (let i = 0; i < souls.MAX_DECISION_RULES + 5; i++) {
    souls.addDecisionRule('frontend', `area-${i}`, `Rule ${i}`, 0.5 + (i * 0.01));
  }

  const soul = souls.loadSoul('frontend');
  assert.strictEqual(soul.decision_rules.length, souls.MAX_DECISION_RULES);
});

// --- consolidateSoul ---

test('consolidateSoul trims lessons and rules', () => {
  const souls = freshModule();
  souls.initializeSoul('frontend');

  // Fill up lessons
  for (let i = 0; i < souls.MAX_LESSONS; i++) {
    souls.recordLesson('frontend', `Lesson ${i}`);
  }
  // Fill up rules
  for (let i = 0; i < souls.MAX_DECISION_RULES; i++) {
    souls.addDecisionRule('frontend', `area-${i}`, `Rule ${i}`, 0.8);
  }

  souls.consolidateSoul('frontend');
  const soul = souls.loadSoul('frontend');
  assert.ok(soul.lessons_learned.length <= souls.MAX_LESSONS / 2);
  assert.ok(soul.decision_rules.length <= Math.ceil(souls.MAX_DECISION_RULES / 2));
});

test('consolidateSoul returns error for nonexistent soul', () => {
  const souls = freshModule();
  const result = souls.consolidateSoul('nonexistent');
  assert.strictEqual(result.success, false);
});

// --- calibrateSoul (PM editor) ---

test('calibrateSoul updates traits', () => {
  const souls = freshModule();
  souls.initializeSoul('frontend');
  souls.calibrateSoul('frontend', {
    traits: { risk_tolerance: 'bold' }
  });

  const soul = souls.loadSoul('frontend');
  assert.strictEqual(soul.traits.risk_tolerance, 'bold');
  // Other traits preserved
  assert.strictEqual(soul.traits.verbosity, 'concise');
});

test('calibrateSoul adds expertise and preferences', () => {
  const souls = freshModule();
  souls.initializeSoul('backend');
  souls.calibrateSoul('backend', {
    expertise: ['GraphQL', 'Redis'],
    preferences: ['Prefer PostgreSQL over MySQL']
  });

  const soul = souls.loadSoul('backend');
  assert.ok(soul.expertise.includes('GraphQL'));
  assert.ok(soul.expertise.includes('Redis'));
  assert.ok(soul.preferences.some(p => p.includes('PostgreSQL')));
});

test('calibrateSoul auto-initializes if missing', () => {
  const souls = freshModule();
  souls.calibrateSoul('frontend', { traits: { verbosity: 'detailed' } });
  const soul = souls.loadSoul('frontend');
  assert.ok(soul);
  assert.strictEqual(soul.traits.verbosity, 'detailed');
});

// --- resetSoul ---

test('resetSoul soft reset keeps lessons and rules', () => {
  const souls = freshModule();
  souls.initializeSoul('frontend');
  souls.recordLesson('frontend', 'Important lesson');
  souls.addDecisionRule('frontend', 'testing', 'Always test', 0.9);

  const soul = souls.resetSoul('frontend');
  assert.strictEqual(soul.traits.risk_tolerance, 'moderate'); // restored default
  assert.strictEqual(soul.lessons_learned.length, 1); // kept
  assert.strictEqual(soul.decision_rules.length, 1); // kept
});

test('resetSoul hard wipes everything', () => {
  const souls = freshModule();
  souls.initializeSoul('frontend');
  souls.recordLesson('frontend', 'lesson to wipe');
  souls.addDecisionRule('frontend', 'x', 'rule to wipe', 0.9);

  const soul = souls.resetSoul('frontend', { hard: true });
  assert.strictEqual(soul.lessons_learned.length, 0);
  assert.strictEqual(soul.decision_rules.length, 0);
  assert.strictEqual(soul.meta.role, 'frontend');
});

// --- listSouls ---

test('listSouls returns all role summaries', () => {
  const souls = freshModule();
  souls.initializeSoul('frontend');
  souls.initializeSoul('backend');
  souls.recordLesson('frontend', 'a lesson');

  const list = souls.listSouls();
  assert.strictEqual(list.length, 2);
  const fe = list.find(s => s.role === 'frontend');
  assert.ok(fe);
  assert.strictEqual(fe.lessons, 1);
  assert.ok(fe.size > 0);
});

// --- loadSoulContext ---

test('loadSoulContext returns compact data for injection', () => {
  const souls = freshModule();
  souls.initializeSoul('frontend');
  souls.recordLesson('frontend', 'lesson 1');
  souls.addDecisionRule('frontend', 'styling', 'Use Tailwind', 0.8);

  const ctx = souls.loadSoulContext('frontend');
  assert.strictEqual(ctx.role, 'frontend');
  assert.ok(ctx.traits);
  assert.ok(ctx.expertise);
  assert.ok(ctx.recent_lessons);
  assert.ok(ctx.active_rules);
  assert.ok(ctx.active_rules.some(r => r.includes('Tailwind')));
});

test('loadSoulContext returns null for nonexistent soul', () => {
  const souls = freshModule();
  assert.strictEqual(souls.loadSoulContext('nonexistent'), null);
});

test('loadSoulContext filters low-confidence rules', () => {
  const souls = freshModule();
  souls.initializeSoul('frontend');
  souls.addDecisionRule('frontend', 'a', 'high confidence rule', 0.9);
  souls.addDecisionRule('frontend', 'b', 'low confidence rule', 0.3);

  const ctx = souls.loadSoulContext('frontend');
  assert.ok(ctx.active_rules.some(r => r.includes('high confidence')));
  assert.ok(!ctx.active_rules.some(r => r.includes('low confidence')));
});

// --- updateSection ---

test('updateSection merges expertise items', () => {
  const souls = freshModule();
  souls.initializeSoul('frontend');
  souls.updateSection('frontend', 'expertise', ['GraphQL', 'WebSockets']);

  const soul = souls.loadSoul('frontend');
  assert.ok(soul.expertise.includes('GraphQL'));
  assert.ok(soul.expertise.includes('WebSockets'));
  // Original items still there
  assert.ok(soul.expertise.includes('component creation'));
});

test('updateSection returns error for nonexistent soul', () => {
  const souls = freshModule();
  const result = souls.updateSection('nonexistent', 'traits', {});
  assert.strictEqual(result.success, false);
});

test('updateSection returns error for invalid section', () => {
  const souls = freshModule();
  souls.initializeSoul('frontend');
  const result = souls.updateSection('frontend', 'invalid_section', []);
  assert.strictEqual(result.success, false);
});

// --- getSoulSize ---

test('getSoulSize returns 0 for nonexistent soul', () => {
  const souls = freshModule();
  assert.strictEqual(souls.getSoulSize('nonexistent'), 0);
});

test('getSoulSize returns positive value for existing soul', () => {
  const souls = freshModule();
  souls.initializeSoul('frontend');
  assert.ok(souls.getSoulSize('frontend') > 0);
});

// --- soulExists ---

test('soulExists returns false for nonexistent soul', () => {
  const souls = freshModule();
  assert.strictEqual(souls.soulExists('nonexistent'), false);
});

test('soulExists returns true after initialization', () => {
  const souls = freshModule();
  souls.initializeSoul('frontend');
  assert.strictEqual(souls.soulExists('frontend'), true);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
