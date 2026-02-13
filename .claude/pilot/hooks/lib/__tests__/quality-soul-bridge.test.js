/**
 * Tests for Quality Metrics to Soul Feedback — Phase 8.13 (Pilot AGI-mf4h)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/quality-soul-bridge.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsoul-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/registry'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/souls'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModules() {
  const mods = [
    '../quality-soul-bridge', '../quality-sweep',
    '../canonical-patterns', '../soul-persistence', '../souls'
  ];
  for (const mod of mods) {
    try { delete require.cache[require.resolve(mod)]; } catch (e) {}
  }
  return {
    bridge: require('../quality-soul-bridge'),
    sweep: require('../quality-sweep')
  };
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

console.log('\n=== Quality → Soul Bridge Tests ===\n');

// --- mapScoresToSkills ---

test('mapScoresToSkills returns positive adjustments for high scores', () => {
  const { bridge } = freshModules();
  const adjustments = bridge.mapScoresToSkills({
    duplicates: 0.98,
    dead_code: 0.96,
    naming: 0.99,
    patterns: 0.97,
    overall: 0.97
  });

  assert.ok(adjustments.length > 0);
  assert.ok(adjustments.every(a => a.adjustment > 0));
});

test('mapScoresToSkills returns negative adjustments for low scores', () => {
  const { bridge } = freshModules();
  const adjustments = bridge.mapScoresToSkills({
    duplicates: 0.3,
    dead_code: 0.4,
    naming: 0.2,
    patterns: 0.3,
    overall: 0.3
  });

  assert.ok(adjustments.length > 0);
  assert.ok(adjustments.every(a => a.adjustment < 0));
});

test('mapScoresToSkills returns no adjustments for neutral scores', () => {
  const { bridge } = freshModules();
  const adjustments = bridge.mapScoresToSkills({
    duplicates: 0.75,
    dead_code: 0.75,
    naming: 0.75,
    patterns: 0.75,
    overall: 0.75
  });

  assert.ok(adjustments.every(a => a.adjustment === 0));
});

test('mapScoresToSkills handles null input', () => {
  const { bridge } = freshModules();
  assert.deepStrictEqual(bridge.mapScoresToSkills(null), []);
});

// --- scoreToAdjustment ---

test('scoreToAdjustment returns correct values at boundaries', () => {
  const { bridge } = freshModules();
  assert.strictEqual(bridge.scoreToAdjustment(1.0), 0.1);
  assert.strictEqual(bridge.scoreToAdjustment(0.95), 0.1);
  assert.strictEqual(bridge.scoreToAdjustment(0.85), 0.05);
  assert.strictEqual(bridge.scoreToAdjustment(0.70), 0);
  assert.strictEqual(bridge.scoreToAdjustment(0.50), -0.05);
  assert.strictEqual(bridge.scoreToAdjustment(0.3), -0.1);
});

// --- applyToSoul ---

test('applyToSoul updates soul traits from quality scores', () => {
  const { bridge } = freshModules();

  // Create a soul file in markdown format
  const soulPath = path.join(testDir, '.claude/pilot/souls/developer.md');
  fs.writeFileSync(soulPath, `---
role: developer
version: 1
code_reuse: 0.5
code_cleanliness: 0.5
---

## Expertise
- JavaScript
`);

  const result = bridge.applyToSoul('developer', {
    duplicates: 0.98,
    dead_code: 0.30,
    naming: 0.75,
    patterns: 0.90,
    overall: 0.73
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.soul_updated, true);
  assert.ok(result.adjustments.length > 0);
});

test('applyToSoul records quality lesson in soul', () => {
  const { bridge } = freshModules();

  const soulPath = path.join(testDir, '.claude/pilot/souls/developer.md');
  fs.writeFileSync(soulPath, `---
role: developer
version: 1
---
`);

  bridge.applyToSoul('developer', {
    duplicates: 0.98, dead_code: 0.98,
    naming: 0.98, patterns: 0.98, overall: 0.98
  });

  // Read back and check the soul has lessons
  const souls = require('../souls');
  const soul = souls.loadSoul('developer');
  assert.ok(soul.lessons_learned);
  assert.ok(soul.lessons_learned.length > 0);
  assert.ok(soul.lessons_learned[soul.lessons_learned.length - 1].lesson.includes('Quality sweep'));
});

test('applyToSoul returns not-updated when no soul exists', () => {
  const { bridge } = freshModules();
  // scores that would produce adjustments
  const result = bridge.applyToSoul('nonexistent_role_xyz', {
    duplicates: 0.98, dead_code: 0.98, naming: 0.98, patterns: 0.98, overall: 0.98
  });
  // With no soul file, should either fail or not update
  assert.ok(!result.soul_updated || !result.success);
});

test('applyToSoul applies adjustments and records lesson', () => {
  const { bridge } = freshModules();

  const soulPath = path.join(testDir, '.claude/pilot/souls/developer.md');
  fs.writeFileSync(soulPath, `---
role: developer
version: 1
---
`);

  const result = bridge.applyToSoul('developer', {
    duplicates: 0.99, dead_code: 0.99,
    naming: 0.99, patterns: 0.99, overall: 0.99
  });

  assert.strictEqual(result.success, true);
  assert.ok(result.adjustments.length > 0);
  // All scores > 0.95 → positive adjustments
  assert.ok(result.adjustments.every(a => a.adjustment > 0));
});

// --- learnFromSweep ---

test('learnFromSweep records pattern observations', () => {
  const { bridge } = freshModules();

  const result = bridge.learnFromSweep({
    scores: { overall: 0.95 },
    issues: [
      { type: 'duplicate_function', description: 'test' }
    ]
  });

  assert.ok(result.patterns_observed > 0);
});

test('learnFromSweep handles missing modules gracefully', () => {
  const { bridge } = freshModules();
  const result = bridge.learnFromSweep({ scores: { overall: 0.5 }, issues: [] });
  assert.strictEqual(typeof result.patterns_observed, 'number');
});

// --- buildContext ---

test('buildContext returns null for fresh project', () => {
  const { bridge } = freshModules();
  const ctx = bridge.buildContext();
  assert.strictEqual(ctx, null);
});

test('buildContext returns quality context with history', () => {
  const { bridge, sweep } = freshModules();

  sweep.saveScore({
    timestamp: '2026-02-13T00:00:00Z',
    scores: { duplicates: 0.9, dead_code: 0.8, naming: 0.95, patterns: 0.7, overall: 0.84 },
    issue_count: 3
  });

  const ctx = bridge.buildContext();
  assert.ok(ctx);
  assert.strictEqual(ctx.latest_score, 0.84);
  assert.strictEqual(ctx.latest_issues, 3);
  assert.ok(ctx.attention_areas); // patterns < 0.85
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
