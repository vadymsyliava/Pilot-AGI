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

console.log('\n=== Peer Review Tests ===\n');

// --- selectReviewer ---

test('selectReviewer picks backend for api_design changes', () => {
  const pr = freshModule();
  const result = pr.selectReviewer('frontend', ['api_design'], ['backend', 'testing', 'review']);
  assert.strictEqual(result.reviewer, 'backend');
  assert.ok(result.score > 0);
});

test('selectReviewer picks frontend for styling changes', () => {
  const pr = freshModule();
  const result = pr.selectReviewer('backend', ['styling'], ['frontend', 'testing', 'review']);
  assert.strictEqual(result.reviewer, 'frontend');
});

test('selectReviewer excludes author from selection', () => {
  const pr = freshModule();
  const result = pr.selectReviewer('frontend', ['styling'], ['frontend', 'review']);
  assert.notStrictEqual(result.reviewer, 'frontend');
});

test('selectReviewer falls back to review agent', () => {
  const pr = freshModule();
  const result = pr.selectReviewer('frontend', ['obscure_skill'], ['backend', 'review']);
  assert.strictEqual(result.reviewer, 'review');
});

test('selectReviewer returns null with no available reviewers', () => {
  const pr = freshModule();
  const result = pr.selectReviewer('frontend', ['styling'], []);
  assert.strictEqual(result.reviewer, null);
});

test('selectReviewer returns null with insufficient input', () => {
  const pr = freshModule();
  assert.strictEqual(pr.selectReviewer(null, ['a'], ['b']).reviewer, null);
  assert.strictEqual(pr.selectReviewer('a', null, ['b']).reviewer, null);
  assert.strictEqual(pr.selectReviewer('a', [], ['b']).reviewer, null);
});

// --- requestReview ---

test('requestReview creates a review request', () => {
  const pr = freshModule();
  const result = pr.requestReview('T-001', 'frontend', {
    files_changed: ['src/api.js'],
    lines_added: 100,
    lines_removed: 20,
    areas: ['api_design']
  });
  assert.ok(result.success);
  assert.ok(result.reviewer);
  assert.strictEqual(result.lightweight, false); // 120 lines > threshold
});

test('requestReview uses lightweight mode for small changes', () => {
  const pr = freshModule();
  const result = pr.requestReview('T-002', 'frontend', {
    files_changed: ['src/utils.js'],
    lines_added: 10,
    lines_removed: 5,
    areas: ['styling']
  });
  assert.ok(result.success);
  assert.strictEqual(result.lightweight, true);
});

test('requestReview accepts explicit reviewer', () => {
  const pr = freshModule();
  const result = pr.requestReview('T-003', 'frontend', {
    files_changed: ['src/api.js'],
    areas: ['api_design']
  }, { reviewer: 'security' });
  assert.ok(result.success);
  assert.strictEqual(result.reviewer, 'security');
});

test('requestReview requires params', () => {
  const pr = freshModule();
  assert.strictEqual(pr.requestReview(null, 'f', {}).success, false);
  assert.strictEqual(pr.requestReview('T', null, {}).success, false);
  assert.strictEqual(pr.requestReview('T', 'f', null).success, false);
});

test('requestReview builds full checklist for large changes', () => {
  const pr = freshModule();
  pr.requestReview('T-004', 'frontend', {
    files_changed: ['src/big.js'],
    lines_added: 200,
    areas: ['api_design']
  });
  const review = pr.loadReview('T-004');
  assert.ok(review.checklist.length >= 8); // Full checklist has 10 items
});

test('requestReview builds lightweight checklist for small changes', () => {
  const pr = freshModule();
  pr.requestReview('T-005', 'frontend', {
    files_changed: ['src/fix.js'],
    lines_added: 5,
    areas: ['styling']
  });
  const review = pr.loadReview('T-005');
  assert.strictEqual(review.checklist.length, 3);
});

// --- submitReview ---

test('submitReview records review with comments', () => {
  const pr = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('backend');
  souls.initializeSoul('frontend');

  pr.requestReview('T-010', 'frontend', {
    files_changed: ['src/api.js'],
    lines_added: 100,
    areas: ['api_design']
  }, { reviewer: 'backend' });

  const result = pr.submitReview('T-010', 'backend', {
    checklist_results: [
      { item: 'Logic is correct and handles edge cases', checked: true },
      { item: 'No obvious bugs or regressions', checked: true }
    ],
    comments: [
      { severity: 'warning', message: 'Missing error handling on line 42', file: 'src/api.js', line: 42 },
      { severity: 'suggestion', message: 'Consider using async/await' }
    ]
  });

  assert.ok(result.success);
  assert.strictEqual(result.status, pr.REVIEW_STATUS.APPROVED);
  assert.strictEqual(result.warnings, 1);
  assert.strictEqual(result.suggestions, 1);
});

test('submitReview auto-detects changes_requested with blockers', () => {
  const pr = freshModule();
  pr.requestReview('T-011', 'frontend', {
    files_changed: ['src/api.js'],
    lines_added: 100,
    areas: ['api_design']
  }, { reviewer: 'backend' });

  const result = pr.submitReview('T-011', 'backend', {
    comments: [
      { severity: 'blocker', message: 'SQL injection vulnerability' }
    ]
  });

  assert.strictEqual(result.status, pr.REVIEW_STATUS.CHANGES_REQUESTED);
  assert.strictEqual(result.blockers, 1);
});

test('submitReview uses explicit verdict', () => {
  const pr = freshModule();
  pr.requestReview('T-012', 'frontend', {
    files_changed: ['src/api.js'],
    lines_added: 100,
    areas: ['api_design']
  }, { reviewer: 'backend' });

  const result = pr.submitReview('T-012', 'backend', {
    verdict: pr.REVIEW_STATUS.APPROVED,
    comments: []
  });

  assert.strictEqual(result.status, pr.REVIEW_STATUS.APPROVED);
});

test('submitReview rejects wrong reviewer', () => {
  const pr = freshModule();
  pr.requestReview('T-013', 'frontend', {
    files_changed: ['src/api.js'],
    lines_added: 100,
    areas: ['api_design']
  }, { reviewer: 'backend' });

  const result = pr.submitReview('T-013', 'testing', { comments: [] });
  assert.strictEqual(result.success, false);
});

test('submitReview rejects missing review', () => {
  const pr = freshModule();
  const result = pr.submitReview('T-nonexistent', 'backend', { comments: [] });
  assert.strictEqual(result.success, false);
});

test('submitReview requires params', () => {
  const pr = freshModule();
  assert.strictEqual(pr.submitReview(null, 'r', {}).success, false);
  assert.strictEqual(pr.submitReview('T', null, {}).success, false);
  assert.strictEqual(pr.submitReview('T', 'r', null).success, false);
});

// --- respondToComment ---

test('respondToComment records author response', () => {
  const pr = freshModule();
  pr.requestReview('T-020', 'frontend', {
    files_changed: ['src/api.js'],
    lines_added: 100,
    areas: ['api_design']
  }, { reviewer: 'backend' });

  pr.submitReview('T-020', 'backend', {
    comments: [
      { severity: 'warning', message: 'Missing validation' }
    ]
  });

  const result = pr.respondToComment('T-020', 0, 'Fixed in latest commit', 'fixed');
  assert.ok(result.success);
  assert.strictEqual(result.comment.response.action, 'fixed');
});

test('respondToComment rejects invalid index', () => {
  const pr = freshModule();
  pr.requestReview('T-021', 'frontend', {
    files_changed: ['src/api.js'],
    lines_added: 100,
    areas: ['api_design']
  }, { reviewer: 'backend' });

  pr.submitReview('T-021', 'backend', { comments: [] });

  const result = pr.respondToComment('T-021', 5, 'response', 'acknowledge');
  assert.strictEqual(result.success, false);
});

test('respondToComment returns error for missing review', () => {
  const pr = freshModule();
  const result = pr.respondToComment('T-nonexistent', 0, 'resp', 'ack');
  assert.strictEqual(result.success, false);
});

// --- getReviewStatus ---

test('getReviewStatus returns review summary', () => {
  const pr = freshModule();
  pr.requestReview('T-030', 'frontend', {
    files_changed: ['src/api.js'],
    lines_added: 100,
    areas: ['api_design']
  }, { reviewer: 'backend' });

  pr.submitReview('T-030', 'backend', {
    comments: [
      { severity: 'blocker', message: 'Critical bug' },
      { severity: 'warning', message: 'Minor issue' },
      { severity: 'suggestion', message: 'Nice-to-have' }
    ]
  });

  const status = pr.getReviewStatus('T-030');
  assert.ok(status);
  assert.strictEqual(status.total_comments, 3);
  assert.strictEqual(status.blockers, 1);
  assert.strictEqual(status.warnings, 1);
  assert.strictEqual(status.unresolved_blockers, 1);
});

test('getReviewStatus returns null for missing review', () => {
  const pr = freshModule();
  assert.strictEqual(pr.getReviewStatus('T-nonexistent'), null);
});

test('getReviewStatus tracks unresolved blockers', () => {
  const pr = freshModule();
  pr.requestReview('T-031', 'frontend', {
    files_changed: ['src/api.js'],
    lines_added: 100,
    areas: ['api_design']
  }, { reviewer: 'backend' });

  pr.submitReview('T-031', 'backend', {
    comments: [
      { severity: 'blocker', message: 'Bug 1' },
      { severity: 'blocker', message: 'Bug 2' }
    ]
  });

  // Fix one blocker
  pr.respondToComment('T-031', 0, 'Fixed', 'fixed');

  const status = pr.getReviewStatus('T-031');
  assert.strictEqual(status.unresolved_blockers, 1);
});

// --- listReviews ---

test('listReviews returns all reviews', () => {
  const pr = freshModule();
  pr.requestReview('T-040', 'frontend', {
    files_changed: ['a.js'], lines_added: 100, areas: ['api_design']
  }, { reviewer: 'backend' });
  pr.requestReview('T-041', 'backend', {
    files_changed: ['b.js'], lines_added: 100, areas: ['styling']
  }, { reviewer: 'frontend' });

  const reviews = pr.listReviews();
  assert.strictEqual(reviews.length, 2);
});

test('listReviews filters by status', () => {
  const pr = freshModule();
  pr.requestReview('T-050', 'frontend', {
    files_changed: ['a.js'], lines_added: 100, areas: ['api_design']
  }, { reviewer: 'backend' });
  pr.submitReview('T-050', 'backend', { comments: [] });

  pr.requestReview('T-051', 'frontend', {
    files_changed: ['b.js'], lines_added: 100, areas: ['styling']
  }, { reviewer: 'review' });

  const approved = pr.listReviews(pr.REVIEW_STATUS.APPROVED);
  assert.strictEqual(approved.length, 1);

  const pending = pr.listReviews(pr.REVIEW_STATUS.PENDING);
  assert.strictEqual(pending.length, 1);
});

// --- Soul learning ---

test('submitReview writes lessons to both reviewer and author souls', () => {
  const pr = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');
  souls.initializeSoul('backend');

  pr.requestReview('T-060', 'frontend', {
    files_changed: ['src/api.js'],
    lines_added: 100,
    areas: ['api_design']
  }, { reviewer: 'backend' });

  pr.submitReview('T-060', 'backend', {
    comments: [
      { severity: 'blocker', message: 'Missing auth check' },
      { severity: 'warning', message: 'Consider rate limiting' }
    ]
  });

  // Reviewer should have a lesson about this review
  const reviewerSoul = souls.loadSoul('backend');
  assert.ok(reviewerSoul.lessons_learned.some(l => l.lesson.includes('T-060')));

  // Author should have a lesson about the feedback
  const authorSoul = souls.loadSoul('frontend');
  assert.ok(authorSoul.lessons_learned.some(l => l.lesson.includes('T-060')));
});

// --- Praise ---

test('submitReview tracks praise comments', () => {
  const pr = freshModule();
  pr.requestReview('T-070', 'frontend', {
    files_changed: ['src/utils.js'],
    lines_added: 100,
    areas: ['api_design']
  }, { reviewer: 'backend' });

  const result = pr.submitReview('T-070', 'backend', {
    comments: [
      { severity: 'praise', message: 'Excellent error handling pattern' }
    ]
  });

  assert.strictEqual(result.praise, 1);
  assert.strictEqual(result.status, pr.REVIEW_STATUS.APPROVED);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
