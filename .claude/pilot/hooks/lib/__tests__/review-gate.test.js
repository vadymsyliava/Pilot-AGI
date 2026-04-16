/**
 * Tests for Auto Peer Review Gate — Phase 8.3 (Pilot AGI-s6n3)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/review-gate.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revgate-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/review-gates'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/reviews'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/souls'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot'), { recursive: true });
  fs.writeFileSync(path.join(testDir, '.claude/pilot/agent-registry.json'), JSON.stringify({
    agents: {
      frontend: { name: 'Frontend', capabilities: ['styling', 'testing'] },
      backend: { name: 'Backend', capabilities: ['api_design', 'database'] }
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
  const modPaths = [
    '../review-gate', '../peer-review', '../souls',
    '../policy', '../session', '../memory', '../messaging'
  ];
  for (const modPath of modPaths) {
    try { delete require.cache[require.resolve(modPath)]; } catch (e) {}
  }
  return require('../review-gate');
}

function freshSouls() {
  try { delete require.cache[require.resolve('../souls')]; } catch (e) {}
  return require('../souls');
}

const SMALL_DIFF = `diff --git a/src/utils.js b/src/utils.js
--- a/src/utils.js
+++ b/src/utils.js
@@ -1,3 +1,5 @@
 function add(a, b) {
+  // simple addition
   return a + b;
 }
+module.exports = { add };`;

const LARGE_DIFF = Array(60).fill(`+// line of new code added here`).join('\n');

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

console.log('\n=== Review Gate Tests ===\n');

// --- checkReviewGate ---

test('checkReviewGate passes when policy does not require peer review', () => {
  const rg = freshModule();
  const r = rg.checkReviewGate('T-001', { policy: { enforcement: {} } });
  assert.strictEqual(r.passed, true);
  assert.ok(r.reason.includes('not required'));
});

test('checkReviewGate fails when review not done and policy requires it', () => {
  const rg = freshModule();
  const r = rg.checkReviewGate('T-001', {
    policy: { enforcement: { require_peer_review: true } }
  });
  assert.strictEqual(r.passed, false);
  assert.ok(r.reason.includes('not completed'));
});

test('checkReviewGate passes when gate status is approved', () => {
  const rg = freshModule();

  // Write approved gate state
  const gatePath = path.join(testDir, rg.REVIEW_GATES_DIR, 'T-001.json');
  fs.mkdirSync(path.dirname(gatePath), { recursive: true });
  fs.writeFileSync(gatePath, JSON.stringify({
    task_id: 'T-001',
    status: 'approved',
    review_id: 'R-001',
    reviewed_at: new Date().toISOString()
  }));

  const r = rg.checkReviewGate('T-001', {
    policy: { enforcement: { require_peer_review: true } }
  });
  assert.strictEqual(r.passed, true);
  assert.strictEqual(r.review_id, 'R-001');
});

test('checkReviewGate fails when gate status is rejected', () => {
  const rg = freshModule();

  const gatePath = path.join(testDir, rg.REVIEW_GATES_DIR, 'T-001.json');
  fs.mkdirSync(path.dirname(gatePath), { recursive: true });
  fs.writeFileSync(gatePath, JSON.stringify({
    task_id: 'T-001',
    status: 'rejected',
    rejection_reason: 'missing tests'
  }));

  const r = rg.checkReviewGate('T-001', {
    policy: { enforcement: { require_peer_review: true } }
  });
  assert.strictEqual(r.passed, false);
  assert.ok(r.reason.includes('missing tests'));
});

test('checkReviewGate handles null taskId', () => {
  const rg = freshModule();
  const r = rg.checkReviewGate(null);
  assert.strictEqual(r.passed, false);
});

// --- autoReview ---

test('autoReview executes review and records gate state', () => {
  const rg = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');
  souls.initializeSoul('backend');

  const r = rg.autoReview('T-001', 'frontend', SMALL_DIFF);
  assert.strictEqual(r.reviewed, true);
  assert.ok(typeof r.approved === 'boolean');

  // Gate state should be recorded
  const gate = rg.getGateStatus('T-001');
  assert.ok(gate);
  assert.strictEqual(gate.task_id, 'T-001');
  assert.ok(['approved', 'rejected'].includes(gate.status));
});

test('autoReview identifies lightweight diffs', () => {
  const rg = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');
  souls.initializeSoul('backend');

  const r = rg.autoReview('T-002', 'frontend', SMALL_DIFF);
  if (r.reviewed) {
    assert.strictEqual(r.lightweight, true);
  }
});

test('autoReview handles missing args', () => {
  const rg = freshModule();
  const r = rg.autoReview(null, null, null);
  assert.strictEqual(r.reviewed, false);
});

// --- getGateStatus ---

test('getGateStatus returns null when no gate exists', () => {
  const rg = freshModule();
  assert.strictEqual(rg.getGateStatus('T-999'), null);
});

test('getGateStatus returns gate data when exists', () => {
  const rg = freshModule();
  const gatePath = path.join(testDir, rg.REVIEW_GATES_DIR, 'T-001.json');
  fs.mkdirSync(path.dirname(gatePath), { recursive: true });
  fs.writeFileSync(gatePath, JSON.stringify({ task_id: 'T-001', status: 'approved' }));

  const gate = rg.getGateStatus('T-001');
  assert.ok(gate);
  assert.strictEqual(gate.status, 'approved');
});

test('getGateStatus handles null taskId', () => {
  const rg = freshModule();
  assert.strictEqual(rg.getGateStatus(null), null);
});

// --- clearGate ---

test('clearGate removes gate file', () => {
  const rg = freshModule();
  const gatePath = path.join(testDir, rg.REVIEW_GATES_DIR, 'T-001.json');
  fs.mkdirSync(path.dirname(gatePath), { recursive: true });
  fs.writeFileSync(gatePath, JSON.stringify({ task_id: 'T-001', status: 'approved' }));

  assert.ok(rg.getGateStatus('T-001'));
  assert.strictEqual(rg.clearGate('T-001'), true);
  assert.strictEqual(rg.getGateStatus('T-001'), null);
});

test('clearGate handles non-existent gate', () => {
  const rg = freshModule();
  assert.strictEqual(rg.clearGate('T-999'), true);
});

test('clearGate handles null taskId', () => {
  const rg = freshModule();
  assert.strictEqual(rg.clearGate(null), false);
});

// --- Integration ---

test('full flow: check fails → autoReview → check passes', () => {
  const rg = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');
  souls.initializeSoul('backend');

  const policy = { enforcement: { require_peer_review: true } };

  // Gate should fail initially
  const check1 = rg.checkReviewGate('T-001', { policy });
  assert.strictEqual(check1.passed, false);

  // Run auto-review
  const review = rg.autoReview('T-001', 'frontend', SMALL_DIFF);
  assert.strictEqual(review.reviewed, true);

  // If review approved, gate should pass now
  if (review.approved) {
    const check2 = rg.checkReviewGate('T-001', { policy });
    assert.strictEqual(check2.passed, true);
  }
});

test('clearGate then check fails again', () => {
  const rg = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');
  souls.initializeSoul('backend');

  const policy = { enforcement: { require_peer_review: true } };

  // Auto-review
  rg.autoReview('T-001', 'frontend', SMALL_DIFF);

  // Clear gate
  rg.clearGate('T-001');

  // Should fail again
  const check = rg.checkReviewGate('T-001', { policy });
  assert.strictEqual(check.passed, false);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
