/**
 * Tests for Failure Post-Mortem Pipeline — Phase 7.2 (Pilot AGI-34nh)
 *
 * Tests:
 * - classifyRootCause identifies code errors
 * - classifyRootCause identifies missing context
 * - classifyRootCause identifies external blockers
 * - classifyRootCause identifies bad assumptions
 * - classifyRootCause identifies wrong approach
 * - classifyRootCause handles empty input
 * - extractLesson generates meaningful lessons per cause
 * - findSimilarLesson detects duplicates
 * - findSimilarLesson allows distinct lessons
 * - triggerPostMortem writes lesson to soul
 * - triggerPostMortem deduplicates
 * - triggerPostMortem saves record file
 * - triggerPostMortem requires role and taskId
 * - triggerPostMortem requires failure data
 * - getRelevantLessons returns task-relevant lessons
 * - getRelevantLessons returns recent when no relevance match
 * - listPostMortems lists all records
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/post-mortem.test.js
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
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postmortem-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/souls'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/post-mortems'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });

  // Write minimal agent-registry.json for souls module
  fs.mkdirSync(path.join(testDir, '.claude/pilot'), { recursive: true });
  fs.writeFileSync(path.join(testDir, '.claude/pilot/agent-registry.json'), JSON.stringify({
    agents: {
      frontend: {
        name: 'Frontend Agent',
        description: 'React specialist',
        capabilities: ['component_creation', 'styling']
      },
      backend: {
        name: 'Backend Agent',
        description: 'Node.js specialist',
        capabilities: ['api_design']
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
  const modPaths = ['../post-mortem', '../souls', '../policy', '../session', '../memory', '../messaging'];
  for (const modPath of modPaths) {
    try {
      const resolved = require.resolve(modPath);
      delete require.cache[resolved];
    } catch (e) { /* not loaded */ }
  }
  return require('../post-mortem');
}

function freshSouls() {
  try {
    const resolved = require.resolve('../souls');
    delete require.cache[resolved];
  } catch (e) {}
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

console.log('\n=== Failure Post-Mortem Pipeline Tests ===\n');

// --- classifyRootCause ---

test('classifyRootCause identifies code errors', () => {
  const pm = freshModule();
  const result = pm.classifyRootCause('TypeError: Cannot read property "x" of undefined');
  assert.strictEqual(result.cause, pm.ROOT_CAUSES.CODE_ERROR);
  assert.ok(result.confidence >= 0.7);
});

test('classifyRootCause identifies missing context', () => {
  const pm = freshModule();
  const result = pm.classifyRootCause('Error: Cannot find module "express"');
  assert.strictEqual(result.cause, pm.ROOT_CAUSES.MISSING_CONTEXT);
  assert.ok(result.confidence >= 0.7);
});

test('classifyRootCause identifies external blockers', () => {
  const pm = freshModule();
  const result = pm.classifyRootCause('Error: ECONNREFUSED 127.0.0.1:5432 - connection timeout');
  assert.strictEqual(result.cause, pm.ROOT_CAUSES.EXTERNAL_BLOCKER);
  assert.ok(result.confidence >= 0.7);
});

test('classifyRootCause identifies bad assumptions', () => {
  const pm = freshModule();
  const result = pm.classifyRootCause('AssertionError: expected "number" but got "string" - type mismatch');
  assert.strictEqual(result.cause, pm.ROOT_CAUSES.BAD_ASSUMPTION);
});

test('classifyRootCause identifies wrong approach', () => {
  const pm = freshModule();
  const result = pm.classifyRootCause('Warning: this API is deprecated. Use the new approach instead');
  assert.strictEqual(result.cause, pm.ROOT_CAUSES.WRONG_APPROACH);
});

test('classifyRootCause handles empty input', () => {
  const pm = freshModule();
  const result = pm.classifyRootCause('');
  assert.strictEqual(result.cause, pm.ROOT_CAUSES.CODE_ERROR); // default
  assert.ok(result.confidence < 0.5);
});

test('classifyRootCause handles null input', () => {
  const pm = freshModule();
  const result = pm.classifyRootCause(null);
  assert.strictEqual(result.cause, pm.ROOT_CAUSES.CODE_ERROR);
  assert.ok(result.confidence < 0.5);
});

// --- extractLesson ---

test('extractLesson generates lesson for code error', () => {
  const pm = freshModule();
  const classification = { cause: pm.ROOT_CAUSES.CODE_ERROR, evidence: 'TypeError' };
  const lesson = pm.extractLesson(classification, 'TypeError: x is not a function', {});
  assert.ok(lesson.includes('Code error'));
  assert.ok(lesson.includes('TypeError'));
});

test('extractLesson generates lesson for missing context', () => {
  const pm = freshModule();
  const classification = { cause: pm.ROOT_CAUSES.MISSING_CONTEXT, evidence: 'module not found' };
  const lesson = pm.extractLesson(classification, 'Cannot find module "foo"', {});
  assert.ok(lesson.includes('Missing context'));
});

test('extractLesson generates lesson for external blocker', () => {
  const pm = freshModule();
  const classification = { cause: pm.ROOT_CAUSES.EXTERNAL_BLOCKER, evidence: 'ECONNREFUSED' };
  const lesson = pm.extractLesson(classification, 'connection refused', {});
  assert.ok(lesson.includes('External blocker'));
  assert.ok(lesson.includes('retry'));
});

// --- findSimilarLesson ---

test('findSimilarLesson detects duplicate lessons', () => {
  const pm = freshModule();
  const existing = [
    { lesson: 'Always validate input before processing', date: '2026-01-01' }
  ];
  const similar = pm.findSimilarLesson(existing, 'Always validate input before processing data');
  assert.ok(similar);
});

test('findSimilarLesson detects word-overlap duplicates', () => {
  const pm = freshModule();
  const existing = [
    { lesson: 'Check dependencies and imports exist before using them', date: '2026-01-01' }
  ];
  const similar = pm.findSimilarLesson(existing, 'Verify dependencies and imports exist before referencing them');
  assert.ok(similar);
});

test('findSimilarLesson allows distinct lessons', () => {
  const pm = freshModule();
  const existing = [
    { lesson: 'Always validate input', date: '2026-01-01' }
  ];
  const similar = pm.findSimilarLesson(existing, 'Add retry logic for network calls');
  assert.strictEqual(similar, null);
});

test('findSimilarLesson handles empty existing', () => {
  const pm = freshModule();
  assert.strictEqual(pm.findSimilarLesson([], 'any lesson'), null);
  assert.strictEqual(pm.findSimilarLesson(null, 'any lesson'), null);
});

// --- triggerPostMortem ---

test('triggerPostMortem writes lesson to soul', () => {
  const pm = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  const result = pm.triggerPostMortem('frontend', 'T-001', {
    errors: [{ error: 'TypeError: x is not a function', ts: '2026-01-01' }],
    steps_completed: 3,
    total_steps: 5
  });

  assert.ok(result.success);
  assert.strictEqual(result.cause, pm.ROOT_CAUSES.CODE_ERROR);
  assert.ok(result.lesson);
  assert.strictEqual(result.deduplicated, false);

  // Check soul has the lesson
  const soul = souls.loadSoul('frontend');
  assert.strictEqual(soul.lessons_learned.length, 1);
  assert.ok(soul.lessons_learned[0].lesson.includes('Code error'));
});

test('triggerPostMortem deduplicates similar lessons', () => {
  const pm = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  // First post-mortem
  pm.triggerPostMortem('frontend', 'T-001', {
    errors: [{ error: 'TypeError: x is not a function' }]
  });

  // Second similar post-mortem
  const result = pm.triggerPostMortem('frontend', 'T-002', {
    errors: [{ error: 'TypeError: y is not a function' }]
  });

  assert.ok(result.deduplicated);

  // Soul should still have only 1 lesson
  const soul = souls.loadSoul('frontend');
  assert.strictEqual(soul.lessons_learned.length, 1);
});

test('triggerPostMortem saves record file', () => {
  const pm = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  pm.triggerPostMortem('frontend', 'T-001', {
    errors: [{ error: 'SyntaxError: unexpected token' }]
  });

  const record = pm.loadPostMortemRecord('T-001');
  assert.ok(record);
  assert.strictEqual(record.task_id, 'T-001');
  assert.strictEqual(record.role, 'frontend');
  assert.ok(record.classification);
  assert.ok(record.lesson);
});

test('triggerPostMortem requires role and taskId', () => {
  const pm = freshModule();
  assert.strictEqual(pm.triggerPostMortem(null, 'T-001', {}).success, false);
  assert.strictEqual(pm.triggerPostMortem('frontend', null, {}).success, false);
});

test('triggerPostMortem requires failure data', () => {
  const pm = freshModule();
  const result = pm.triggerPostMortem('frontend', 'T-001', { errors: [] });
  assert.strictEqual(result.success, false);
});

test('triggerPostMortem handles exit_reason without errors', () => {
  const pm = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  const result = pm.triggerPostMortem('frontend', 'T-003', {
    errors: [],
    exit_reason: 'max_errors'
  });

  assert.ok(result.success);
  assert.ok(result.lesson);
});

// --- getRelevantLessons ---

test('getRelevantLessons returns task-relevant lessons', () => {
  const pm = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');
  souls.recordLesson('frontend', 'Always check component props for null values');
  souls.recordLesson('frontend', 'Add retry logic for API calls');

  const lessons = pm.getRelevantLessons('frontend', 'Create a new React component with props');
  assert.ok(lessons.length > 0);
  assert.ok(lessons.some(l => l.includes('component')));
});

test('getRelevantLessons returns recent when no match', () => {
  const pm = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');
  souls.recordLesson('frontend', 'lesson about something unrelated xyz');

  const lessons = pm.getRelevantLessons('frontend', 'totally different topic abc');
  assert.ok(lessons.length > 0); // returns recent ones as fallback
});

test('getRelevantLessons returns empty for no soul', () => {
  const pm = freshModule();
  const lessons = pm.getRelevantLessons('nonexistent', 'any task');
  assert.deepStrictEqual(lessons, []);
});

// --- listPostMortems ---

test('listPostMortems lists all records', () => {
  const pm = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');
  souls.initializeSoul('backend');

  pm.triggerPostMortem('frontend', 'T-001', {
    errors: [{ error: 'TypeError' }]
  });
  pm.triggerPostMortem('backend', 'T-002', {
    errors: [{ error: 'ECONNREFUSED' }]
  });

  const list = pm.listPostMortems();
  assert.strictEqual(list.length, 2);
  assert.ok(list.some(r => r.task_id === 'T-001'));
  assert.ok(list.some(r => r.task_id === 'T-002'));
});

test('listPostMortems returns empty when no records', () => {
  const pm = freshModule();
  const list = pm.listPostMortems();
  assert.deepStrictEqual(list, []);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
