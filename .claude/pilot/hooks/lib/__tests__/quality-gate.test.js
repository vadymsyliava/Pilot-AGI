/**
 * Tests for Quality Regression Prevention — Phase 8.15 (Pilot AGI-w7ej)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/quality-gate.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/registry'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModule() {
  const mods = ['../quality-gate', '../quality-sweep'];
  for (const mod of mods) {
    try { delete require.cache[require.resolve(mod)]; } catch (e) {}
  }
  return require('../quality-gate');
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

console.log('\n=== Quality Regression Prevention Tests ===\n');

// --- checkGate ---

test('checkGate allows scores above threshold', () => {
  const qg = freshModule();
  const result = qg.checkGate({ overall: 0.85 });
  assert.strictEqual(result.allowed, true);
});

test('checkGate blocks scores below threshold', () => {
  const qg = freshModule();
  const result = qg.checkGate({ overall: 0.50 });
  assert.strictEqual(result.allowed, false);
  assert.ok(result.reason.includes('below threshold'));
});

test('checkGate uses area-specific thresholds', () => {
  const qg = freshModule();
  qg.setThreshold('core', 0.90);

  // 0.85 passes default but fails core
  const result = qg.checkGate({ overall: 0.85 }, { area: 'core' });
  assert.strictEqual(result.allowed, false);
});

test('checkGate allows null scores', () => {
  const qg = freshModule();
  assert.strictEqual(qg.checkGate(null).allowed, true);
});

// --- grace periods ---

test('grantGracePeriod creates grace period', () => {
  const qg = freshModule();
  const r = qg.grantGracePeriod('TASK-123', 7);
  assert.strictEqual(r.success, true);
  assert.ok(r.expires_at);
});

test('checkGate relaxes threshold during grace period', () => {
  const qg = freshModule();
  qg.grantGracePeriod('TASK-123', 7);

  // Default threshold is 0.70, relaxed = 0.70 * 0.85 = 0.595
  // Score 0.60 should pass during grace
  const result = qg.checkGate({ overall: 0.60 }, { taskId: 'TASK-123' });
  assert.strictEqual(result.allowed, true);
  assert.ok(result.warnings);
  assert.ok(result.warnings[0].includes('Grace period'));
});

test('checkGate blocks even during grace if too low', () => {
  const qg = freshModule();
  qg.grantGracePeriod('TASK-123', 7);

  // Relaxed threshold = 0.70 * 0.85 = 0.595
  // Score 0.40 should still fail
  const result = qg.checkGate({ overall: 0.40 }, { taskId: 'TASK-123' });
  assert.strictEqual(result.allowed, false);
});

test('revokeGracePeriod removes grace', () => {
  const qg = freshModule();
  qg.grantGracePeriod('TASK-123', 7);
  const r = qg.revokeGracePeriod('TASK-123');
  assert.strictEqual(r.success, true);

  // Now normal threshold applies
  const result = qg.checkGate({ overall: 0.60 }, { taskId: 'TASK-123' });
  assert.strictEqual(result.allowed, false);
});

test('revokeGracePeriod returns error for unknown task', () => {
  const qg = freshModule();
  const r = qg.revokeGracePeriod('unknown');
  assert.strictEqual(r.success, false);
});

// --- thresholds ---

test('setThreshold updates area threshold', () => {
  const qg = freshModule();
  qg.setThreshold('core', 0.95);
  qg.setThreshold('experimental', 0.50);

  const thresholds = qg.listThresholds();
  assert.strictEqual(thresholds.areas.core, 0.95);
  assert.strictEqual(thresholds.areas.experimental, 0.50);
});

test('setThreshold updates default threshold', () => {
  const qg = freshModule();
  qg.setThreshold('default', 0.80);

  const thresholds = qg.listThresholds();
  assert.strictEqual(thresholds.default, 0.80);
});

test('setThreshold rejects invalid values', () => {
  const qg = freshModule();
  assert.strictEqual(qg.setThreshold('core', 1.5).success, false);
  assert.strictEqual(qg.setThreshold('core', -0.1).success, false);
});

// --- checkRegression ---

test('checkRegression allows minor score drops', () => {
  const qg = freshModule();
  const result = qg.checkRegression(
    { overall: 0.90, duplicates: 0.95 },
    { overall: 0.88, duplicates: 0.93 }
  );
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.regressions.length, 0);
});

test('checkRegression blocks large score drops', () => {
  const qg = freshModule();
  const result = qg.checkRegression(
    { overall: 0.90, duplicates: 0.95 },
    { overall: 0.75, duplicates: 0.60 }
  );
  assert.strictEqual(result.allowed, false);
  assert.ok(result.regressions.length > 0);
  assert.ok(result.regressions.some(r => r.metric === 'overall'));
});

test('checkRegression uses custom max regression', () => {
  const qg = freshModule();
  const result = qg.checkRegression(
    { overall: 0.90 },
    { overall: 0.88 },
    { maxRegression: 0.01 }
  );
  assert.strictEqual(result.allowed, false); // 0.02 > 0.01
});

test('checkRegression handles null input', () => {
  const qg = freshModule();
  assert.strictEqual(qg.checkRegression(null, null).allowed, true);
});

// --- config ---

test('loadConfig returns defaults for fresh project', () => {
  const qg = freshModule();
  const config = qg.loadConfig();
  assert.strictEqual(config.default_threshold, 0.70);
});

test('saveConfig and loadConfig round-trip', () => {
  const qg = freshModule();
  const config = { default_threshold: 0.80, area_thresholds: { core: 0.95 } };
  qg.saveConfig(config);

  const loaded = qg.loadConfig();
  assert.strictEqual(loaded.default_threshold, 0.80);
  assert.strictEqual(loaded.area_thresholds.core, 0.95);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
