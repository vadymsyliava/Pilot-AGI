/**
 * Tests for Peer Review Protocol — Phase 7.7 (Pilot AGI-xpc3)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/peer-review.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peerrev-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/reviews'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/souls'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot'), { recursive: true });
  fs.writeFileSync(path.join(testDir, '.claude/pilot/agent-registry.json'), JSON.stringify({
    agents: {
      frontend: { name: 'Frontend', capabilities: ['styling', 'component_creation'] },
      backend: { name: 'Backend', capabilities: ['api_design', 'database_operations'] },
      testing: { name: 'Testing', capabilities: ['unit_testing', 'e2e_testing'] },
      review: { name: 'Review', capabilities: ['code_review', 'quality_check'] },
      security: { name: 'Security', capabilities: ['security_audit', 'vulnerability_detection'] }
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
  const modPaths = ['../peer-review', '../souls', '../policy', '../session', '../memory', '../messaging'];
  for (const modPath of modPaths) {
    try { delete require.cache[require.resolve(modPath)]; } catch (e) {}
  }
  return require('../peer-review');
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

// Sample diffs for testing
const SMALL_DIFF = `diff --git a/src/utils.js b/src/utils.js
--- a/src/utils.js
+++ b/src/utils.js
@@ -1,3 +1,5 @@
+function helper() {
+  return true;
+}
 module.exports = {};`;

const LARGE_DIFF = `diff --git a/src/api/routes.js b/src/api/routes.js
--- a/src/api/routes.js
+++ b/src/api/routes.js
@@ -1,5 +1,80 @@
${Array.from({ length: 75 }, (_, i) => `+const line${i} = ${i};`).join('\n')}
 module.exports = {};`;

const API_DIFF = `diff --git a/src/api/handler.js b/src/api/handler.js
--- a/src/api/handler.js
+++ b/src/api/handler.js
@@ -1,3 +1,10 @@
+async function handleRequest(req, res) {
+  const data = await fetchData();
+  res.json(data);
+}
+module.exports = { handleRequest };`;

const STYLE_DIFF = `diff --git a/src/components/Button.tsx b/src/components/Button.tsx
--- a/src/components/Button.tsx
+++ b/src/components/Button.tsx
@@ -1,3 +1,10 @@
+import React from 'react';
+export const Button = ({ label }) => (
+  <button className="btn-primary">{label}</button>
+);`;

const TODO_DIFF = `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1,3 +1,10 @@
+function init() {
+  // TODO: implement proper error handling
+  console.log('debug: starting app');
+  return true;
+}`;

console.log('\n=== Peer Review Tests ===\n');

// --- selectReviewer ---

test('selectReviewer picks backend for api_design domains', () => {
  const pr = freshModule();
  const result = pr.selectReviewer('frontend', ['api_design']);
  assert.ok(result);
  assert.strictEqual(result.reviewer, 'backend');
  assert.ok(result.score > 0);
});

test('selectReviewer picks frontend for styling domains', () => {
  const pr = freshModule();
  const result = pr.selectReviewer('backend', ['styling']);
  assert.ok(result);
  assert.strictEqual(result.reviewer, 'frontend');
});

test('selectReviewer excludes author from selection', () => {
  const pr = freshModule();
  const result = pr.selectReviewer('frontend', ['styling']);
  assert.ok(result);
  assert.notStrictEqual(result.reviewer, 'frontend');
});

test('selectReviewer falls back to review agent for unknown domains', () => {
  const pr = freshModule();
  const result = pr.selectReviewer('frontend', ['obscure_skill']);
  assert.ok(result);
  assert.strictEqual(result.reviewer, 'review');
  assert.ok(result.reason.includes('fallback'));
});

test('selectReviewer returns null with insufficient input', () => {
  const pr = freshModule();
  assert.strictEqual(pr.selectReviewer(null, ['a']), null);
  assert.strictEqual(pr.selectReviewer('a', null), null);
  assert.strictEqual(pr.selectReviewer('a', []), null);
});

test('selectReviewer excludes PM from reviewers', () => {
  const pr = freshModule();
  // Add pm to registry
  const regPath = path.join(process.cwd(), '.claude/pilot/agent-registry.json');
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  reg.agents.pm = { name: 'PM', capabilities: ['api_design', 'styling', 'everything'] };
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));

  const result = pr.selectReviewer('frontend', ['api_design']);
  assert.ok(result);
  assert.notStrictEqual(result.reviewer, 'pm');
});

// --- countDiffLines ---

test('countDiffLines counts added and removed lines', () => {
  const pr = freshModule();
  assert.strictEqual(pr.countDiffLines(SMALL_DIFF), 3); // 3 added lines
  assert.ok(pr.countDiffLines(LARGE_DIFF) > 50);
  assert.strictEqual(pr.countDiffLines(''), 0);
  assert.strictEqual(pr.countDiffLines(null), 0);
});

// --- isLightweight ---

test('isLightweight detects small diffs', () => {
  const pr = freshModule();
  assert.strictEqual(pr.isLightweight(SMALL_DIFF), true);
  assert.strictEqual(pr.isLightweight(LARGE_DIFF), false);
});

// --- extractDomainsFromDiff ---

test('extractDomainsFromDiff finds api domain', () => {
  const pr = freshModule();
  const domains = pr.extractDomainsFromDiff(API_DIFF);
  assert.ok(domains.includes('api_design'));
});

test('extractDomainsFromDiff finds component/styling domains', () => {
  const pr = freshModule();
  const domains = pr.extractDomainsFromDiff(STYLE_DIFF);
  assert.ok(domains.includes('component_creation') || domains.includes('styling'));
});

// --- buildReviewChecklist ---

test('buildReviewChecklist detects TODO/FIXME', () => {
  const pr = freshModule();
  const checklist = pr.buildReviewChecklist(TODO_DIFF, {
    taskId: 'T-001', authorRole: 'frontend', reviewerRole: 'backend'
  });
  assert.ok(checklist.correctness.issues.length > 0);
  assert.ok(checklist.correctness.issues.some(i => i.includes('TODO')));
});

test('buildReviewChecklist detects console.log', () => {
  const pr = freshModule();
  const checklist = pr.buildReviewChecklist(TODO_DIFF, {
    taskId: 'T-001', authorRole: 'frontend', reviewerRole: 'backend'
  });
  assert.ok(checklist.correctness.issues.some(i => i.includes('console.log')));
});

test('buildReviewChecklist passes clean diff', () => {
  const pr = freshModule();
  const checklist = pr.buildReviewChecklist(SMALL_DIFF, {
    taskId: 'T-001', authorRole: 'frontend', reviewerRole: 'backend'
  });
  assert.strictEqual(checklist.correctness.score, 'pass');
});

test('buildReviewChecklist checks test coverage for large diffs', () => {
  const pr = freshModule();
  const checklist = pr.buildReviewChecklist(LARGE_DIFF, {
    taskId: 'T-001', authorRole: 'frontend', reviewerRole: 'backend'
  }, { lightweight: false });
  assert.ok(checklist.test_coverage.issues.length > 0);
});

// --- executeReview ---

test('executeReview approves clean diff', () => {
  const pr = freshModule();
  const result = pr.executeReview('T-001', SMALL_DIFF, {
    authorRole: 'frontend', reviewerRole: 'backend'
  });
  assert.strictEqual(result.approved, true);
  assert.ok(result.summary.includes('approved'));
  assert.strictEqual(result.lightweight, true);
});

test('executeReview flags TODO/console.log', () => {
  const pr = freshModule();
  const result = pr.executeReview('T-002', TODO_DIFF, {
    authorRole: 'frontend', reviewerRole: 'backend'
  });
  assert.ok(result.issues.length > 0);
});

test('executeReview requires all params', () => {
  const pr = freshModule();
  assert.strictEqual(pr.executeReview(null, SMALL_DIFF, { authorRole: 'f', reviewerRole: 'b' }).approved, false);
  assert.strictEqual(pr.executeReview('T', null, { authorRole: 'f', reviewerRole: 'b' }).approved, false);
  assert.strictEqual(pr.executeReview('T', SMALL_DIFF, {}).approved, false);
});

test('executeReview saves review state', () => {
  const pr = freshModule();
  pr.executeReview('T-003', SMALL_DIFF, {
    authorRole: 'frontend', reviewerRole: 'backend'
  });

  const reviewPath = path.join(process.cwd(), pr._REVIEWS_DIR, 'T-003.json');
  assert.ok(fs.existsSync(reviewPath));
  const saved = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  assert.strictEqual(saved.task_id, 'T-003');
  assert.strictEqual(saved.author, 'frontend');
  assert.strictEqual(saved.reviewer, 'backend');
});

// --- requestReview (PM integration) ---

test('requestReview runs full review with auto-selected reviewer', () => {
  const pr = freshModule();
  const result = pr.requestReview('T-010', 'frontend', API_DIFF, {
    taskDescription: 'Add new API endpoint'
  });
  assert.ok(result.reviewer);
  assert.ok(result.approved !== undefined);
  assert.ok(result.checklist);
});

test('requestReview auto-approves when no reviewer available', () => {
  const pr = freshModule();
  // Remove all agents except the author
  const regPath = path.join(process.cwd(), '.claude/pilot/agent-registry.json');
  fs.writeFileSync(regPath, JSON.stringify({ agents: { frontend: { capabilities: ['styling'] } } }, null, 2));

  const result = pr.requestReview('T-011', 'frontend', SMALL_DIFF);
  assert.strictEqual(result.approved, true);
  assert.strictEqual(result.skipped, true);
});

test('requestReview returns error for missing params', () => {
  const pr = freshModule();
  assert.ok(pr.requestReview(null, 'f', SMALL_DIFF).error);
  assert.ok(pr.requestReview('T', null, SMALL_DIFF).error);
  assert.ok(pr.requestReview('T', 'f', null).error);
});

// --- getReviewFeedback ---

test('getReviewFeedback returns structured feedback', () => {
  const pr = freshModule();
  pr.executeReview('T-020', TODO_DIFF, {
    authorRole: 'frontend', reviewerRole: 'backend'
  });

  const feedback = pr.getReviewFeedback('T-020');
  assert.ok(feedback);
  assert.strictEqual(feedback.task_id, 'T-020');
  assert.ok(feedback.comments.length > 0);
});

test('getReviewFeedback returns null for missing review', () => {
  const pr = freshModule();
  assert.strictEqual(pr.getReviewFeedback('T-nonexistent'), null);
});

// --- learnFromReview ---

test('learnFromReview writes lessons to author soul', () => {
  const pr = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');
  souls.initializeSoul('backend');

  pr.executeReview('T-030', TODO_DIFF, {
    authorRole: 'frontend', reviewerRole: 'backend'
  });

  const result = pr.learnFromReview('T-030');
  assert.ok(result.author_updated);

  const authorSoul = souls.loadSoul('frontend');
  assert.ok(authorSoul.lessons_learned.some(l => l.lesson.includes('T-030')));
});

test('learnFromReview adds review expertise to reviewer soul', () => {
  const pr = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');
  souls.initializeSoul('backend');

  pr.executeReview('T-031', TODO_DIFF, {
    authorRole: 'frontend', reviewerRole: 'backend'
  });

  pr.learnFromReview('T-031');

  const reviewerSoul = souls.loadSoul('backend');
  assert.ok(reviewerSoul.expertise.some(e => e.includes('review')));
});

test('learnFromReview returns false for missing review', () => {
  const pr = freshModule();
  const result = pr.learnFromReview('T-nonexistent');
  assert.strictEqual(result.author_updated, false);
  assert.strictEqual(result.reviewer_updated, false);
});

// --- getReviewHistory ---

test('getReviewHistory returns reviews by author', () => {
  const pr = freshModule();
  pr.executeReview('T-040', SMALL_DIFF, { authorRole: 'frontend', reviewerRole: 'backend' });
  pr.executeReview('T-041', SMALL_DIFF, { authorRole: 'frontend', reviewerRole: 'testing' });
  pr.executeReview('T-042', SMALL_DIFF, { authorRole: 'backend', reviewerRole: 'frontend' });

  const history = pr.getReviewHistory('frontend');
  assert.strictEqual(history.length, 2); // T-040 and T-041
});

test('getReviewHistory returns reviews as reviewer', () => {
  const pr = freshModule();
  pr.executeReview('T-050', SMALL_DIFF, { authorRole: 'frontend', reviewerRole: 'backend' });
  pr.executeReview('T-051', SMALL_DIFF, { authorRole: 'testing', reviewerRole: 'backend' });

  const history = pr.getReviewHistory('backend', { asReviewer: true });
  assert.strictEqual(history.length, 2);
});

test('getReviewHistory respects limit', () => {
  const pr = freshModule();
  for (let i = 0; i < 5; i++) {
    pr.executeReview(`T-06${i}`, SMALL_DIFF, { authorRole: 'frontend', reviewerRole: 'backend' });
  }

  const history = pr.getReviewHistory('frontend', { limit: 3 });
  assert.strictEqual(history.length, 3);
});

test('getReviewHistory returns empty for no reviews', () => {
  const pr = freshModule();
  assert.deepStrictEqual(pr.getReviewHistory('frontend'), []);
});

// --- getReviewStats ---

test('getReviewStats counts approvals and rejections', () => {
  const pr = freshModule();
  pr.executeReview('T-070', SMALL_DIFF, { authorRole: 'frontend', reviewerRole: 'backend' });
  pr.executeReview('T-071', TODO_DIFF, { authorRole: 'frontend', reviewerRole: 'backend' });

  const stats = pr.getReviewStats('frontend');
  assert.strictEqual(stats.as_author.total, 2);
});

test('getReviewStats returns zeros for no reviews', () => {
  const pr = freshModule();
  const stats = pr.getReviewStats('frontend');
  assert.strictEqual(stats.as_author.total, 0);
  assert.strictEqual(stats.as_reviewer.total, 0);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
