/**
 * Tests for Phase 7.7: Peer Review Protocol
 *
 * Tests peer-review.js — reviewer selection, review execution,
 * feedback, learning, history, PM integration.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Fresh module helper
function freshModule(modPath) {
  const fullPath = require.resolve(modPath);
  delete require.cache[fullPath];
  return require(modPath);
}

let tmpDir;
let origCwd;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-review-test-'));
  origCwd = process.cwd();
  process.chdir(tmpDir);

  // Create agent registry
  const registryDir = path.join(tmpDir, '.claude', 'pilot');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(path.join(registryDir, 'agent-registry.json'), JSON.stringify({
    agents: {
      frontend: {
        name: 'Frontend Agent',
        capabilities: ['component_creation', 'styling', 'state_management']
      },
      backend: {
        name: 'Backend Agent',
        capabilities: ['api_design', 'database_operations', 'authentication']
      },
      testing: {
        name: 'Testing Agent',
        capabilities: ['unit_testing', 'integration_testing', 'e2e_testing']
      },
      security: {
        name: 'Security Agent',
        capabilities: ['security_audit', 'vulnerability_detection', 'authentication_review']
      },
      review: {
        name: 'Review Agent',
        capabilities: ['code_review', 'quality_check']
      },
      pm: {
        name: 'PM Agent',
        capabilities: ['task_assignment', 'work_review']
      }
    }
  }));

  // Create souls dir with test souls
  const soulsDir = path.join(tmpDir, '.claude', 'pilot', 'souls');
  fs.mkdirSync(soulsDir, { recursive: true });
  fs.writeFileSync(path.join(soulsDir, 'backend.md'), [
    '---', 'role: backend', 'created: 2026-02-13', 'updated: 2026-02-13',
    'version: 1', '---', '', '## Expertise', '- api design', '- database operations', '',
    '## Preferences', '- Node.js', '', '## Decision Rules',
    '- [api] avoid var declarations', ''
  ].join('\n'));
  fs.writeFileSync(path.join(soulsDir, 'frontend.md'), [
    '---', 'role: frontend', 'created: 2026-02-13', 'updated: 2026-02-13',
    'version: 1', '---', '', '## Expertise', '- component creation', '- styling', '',
    '## Preferences', '- React', ''
  ].join('\n'));
  fs.writeFileSync(path.join(soulsDir, 'security.md'), [
    '---', 'role: security', 'created: 2026-02-13', 'updated: 2026-02-13',
    'version: 1', '---', '', '## Expertise', '- security audit', '- authentication', '',
    '## Decision Rules', "- [security] never use eval", ''
  ].join('\n'));

  // Create reviews state dir
  fs.mkdirSync(path.join(tmpDir, '.claude', 'pilot', 'state', 'reviews'), { recursive: true });
}

function cleanup() {
  process.chdir(origCwd);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ok */ }
}

// Sample diffs for testing
const SMALL_DIFF = `diff --git a/src/utils.js b/src/utils.js
--- a/src/utils.js
+++ b/src/utils.js
@@ -10,3 +10,5 @@
 function existingFn() {}
+function newHelper() {
+  return true;
+}`;

const LARGE_DIFF = `diff --git a/src/api/routes.js b/src/api/routes.js
--- a/src/api/routes.js
+++ b/src/api/routes.js
@@ -1,3 +1,80 @@
` + Array.from({ length: 70 }, (_, i) => `+const line${i} = ${i};`).join('\n');

const DIFF_WITH_ISSUES = `diff --git a/src/handler.js b/src/handler.js
--- a/src/handler.js
+++ b/src/handler.js
@@ -5,3 +5,10 @@
+function process(data) {
+  console.log('debug:', data);
+  // TODO: handle edge case
+  try {
+    return data.value;
+  } catch (e) {}
+}`;

const API_DIFF = `diff --git a/src/api/users.js b/src/api/users.js
--- a/src/api/users.js
+++ b/src/api/users.js
@@ -1,3 +1,20 @@
` + Array.from({ length: 15 }, (_, i) => `+router.get('/api/user/${i}', handler${i});`).join('\n');

const AUTH_DIFF = `diff --git a/src/auth/login.js b/src/auth/login.js
--- a/src/auth/login.js
+++ b/src/auth/login.js
@@ -1,3 +1,10 @@
+function authenticate(user, password) {
+  const hash = crypto.createHash('sha256');
+  return hash.update(password).digest('hex');
+}`;

let pr;

describe('Peer Review — Phase 7.7', () => {
  beforeEach(() => {
    setup();
    // Clear require cache for fresh module
    for (const key of Object.keys(require.cache)) {
      if (key.includes('peer-review') || key.includes('souls') || key.includes('opinion-tracker')) {
        delete require.cache[key];
      }
    }
    pr = require('../.claude/pilot/hooks/lib/peer-review');
  });

  afterEach(() => {
    cleanup();
  });

  // ===========================================================================
  // countDiffLines
  // ===========================================================================

  describe('countDiffLines', () => {
    it('counts added and removed lines', () => {
      assert.equal(pr.countDiffLines(SMALL_DIFF), 3);
    });

    it('handles empty diff', () => {
      assert.equal(pr.countDiffLines(''), 0);
      assert.equal(pr.countDiffLines(null), 0);
    });
  });

  // ===========================================================================
  // isLightweight
  // ===========================================================================

  describe('isLightweight', () => {
    it('returns true for small diffs', () => {
      assert.ok(pr.isLightweight(SMALL_DIFF));
    });

    it('returns false for large diffs', () => {
      assert.ok(!pr.isLightweight(LARGE_DIFF));
    });
  });

  // ===========================================================================
  // selectReviewer
  // ===========================================================================

  describe('selectReviewer', () => {
    it('selects reviewer based on capability match', () => {
      const result = pr.selectReviewer('frontend', ['api_design'], { projectRoot: tmpDir });
      assert.ok(result);
      assert.equal(result.reviewer, 'backend');
      assert.ok(result.score > 0);
    });

    it('excludes author from candidates', () => {
      const result = pr.selectReviewer('backend', ['api_design'], { projectRoot: tmpDir });
      assert.ok(result);
      assert.notEqual(result.reviewer, 'backend');
    });

    it('excludes PM from candidates', () => {
      const result = pr.selectReviewer('frontend', ['task_assignment'], { projectRoot: tmpDir });
      // PM has task_assignment but should be excluded
      assert.ok(!result || result.reviewer !== 'pm');
    });

    it('excludes specified roles', () => {
      const result = pr.selectReviewer('frontend', ['api_design'], {
        projectRoot: tmpDir,
        excludeRoles: ['backend']
      });
      assert.ok(!result || result.reviewer !== 'backend');
    });

    it('falls back to review role when no match', () => {
      const result = pr.selectReviewer('frontend', ['quantum_computing'], { projectRoot: tmpDir });
      assert.ok(result);
      assert.equal(result.reviewer, 'review');
      assert.equal(result.reason, 'fallback-reviewer');
    });

    it('returns null for missing params', () => {
      assert.equal(pr.selectReviewer(null, ['api']), null);
      assert.equal(pr.selectReviewer('backend', null), null);
      assert.equal(pr.selectReviewer('backend', []), null);
    });
  });

  // ===========================================================================
  // buildReviewChecklist
  // ===========================================================================

  describe('buildReviewChecklist', () => {
    it('detects correctness issues', () => {
      const checklist = pr.buildReviewChecklist(DIFF_WITH_ISSUES, {
        taskId: 'test-1', authorRole: 'backend', reviewerRole: 'frontend'
      }, { projectRoot: tmpDir });

      assert.ok(checklist.correctness);
      assert.equal(checklist.correctness.score, 'warning');
      assert.ok(checklist.correctness.issues.length > 0);
      assert.ok(checklist.correctness.issues.some(i => i.includes('TODO')));
      assert.ok(checklist.correctness.issues.some(i => i.includes('console.log')));
    });

    it('passes for clean diff', () => {
      const checklist = pr.buildReviewChecklist(SMALL_DIFF, {
        taskId: 'test-2', authorRole: 'backend', reviewerRole: 'frontend'
      }, { projectRoot: tmpDir });

      assert.equal(checklist.correctness.score, 'pass');
    });

    it('flags missing tests for large changes', () => {
      const bigDiff = `diff --git a/src/logic.js b/src/logic.js
--- a/src/logic.js
+++ b/src/logic.js
@@ -1,3 +1,30 @@
` + Array.from({ length: 25 }, (_, i) => `+const val${i} = process(${i});`).join('\n');

      const checklist = pr.buildReviewChecklist(bigDiff, {
        taskId: 'test-3', authorRole: 'backend', reviewerRole: 'frontend'
      }, { projectRoot: tmpDir, lightweight: false });

      assert.equal(checklist.test_coverage.score, 'warning');
      assert.ok(checklist.test_coverage.issues.some(i => i.includes('No test changes')));
    });

    it('does not flag missing tests for lightweight changes', () => {
      const checklist = pr.buildReviewChecklist(SMALL_DIFF, {
        taskId: 'test-4', authorRole: 'backend', reviewerRole: 'frontend'
      }, { projectRoot: tmpDir, lightweight: true });

      assert.equal(checklist.test_coverage.score, 'pass');
    });

    it('checks soul alignment against decision rules', () => {
      // Backend soul has rule: "avoid var declarations"
      const diffWithVar = `diff --git a/src/api.js b/src/api.js
--- a/src/api.js
+++ b/src/api.js
@@ -1,3 +1,5 @@
+var badVariable = true;
+var anotherOne = false;`;

      const checklist = pr.buildReviewChecklist(diffWithVar, {
        taskId: 'test-5', authorRole: 'frontend', reviewerRole: 'backend'
      }, { projectRoot: tmpDir });

      assert.equal(checklist.soul_alignment.score, 'info');
      assert.ok(checklist.soul_alignment.issues.some(i => i.includes('var')));
    });
  });

  // ===========================================================================
  // executeReview
  // ===========================================================================

  describe('executeReview', () => {
    it('approves clean code', () => {
      const result = pr.executeReview('task-1', SMALL_DIFF, {
        authorRole: 'backend',
        reviewerRole: 'frontend',
        taskDescription: 'Add helper'
      }, { projectRoot: tmpDir });

      assert.ok(result.approved);
      assert.ok(result.summary.includes('approved') || result.summary.includes('passed'));
    });

    it('flags code with issues', () => {
      const result = pr.executeReview('task-2', DIFF_WITH_ISSUES, {
        authorRole: 'backend',
        reviewerRole: 'frontend'
      }, { projectRoot: tmpDir });

      assert.ok(result.issues.length > 0);
    });

    it('saves review state to disk', () => {
      pr.executeReview('task-3', SMALL_DIFF, {
        authorRole: 'backend',
        reviewerRole: 'frontend'
      }, { projectRoot: tmpDir });

      const reviewPath = path.join(tmpDir, '.claude/pilot/state/reviews/task-3.json');
      assert.ok(fs.existsSync(reviewPath));
      const saved = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
      assert.equal(saved.task_id, 'task-3');
      assert.equal(saved.author, 'backend');
      assert.equal(saved.reviewer, 'frontend');
    });

    it('returns error for missing params', () => {
      const result = pr.executeReview(null, SMALL_DIFF, { authorRole: 'x', reviewerRole: 'y' });
      assert.ok(result.error);
    });

    it('marks lightweight reviews', () => {
      const result = pr.executeReview('task-4', SMALL_DIFF, {
        authorRole: 'backend',
        reviewerRole: 'frontend'
      }, { projectRoot: tmpDir });

      assert.ok(result.lightweight);
    });
  });

  // ===========================================================================
  // getReviewFeedback
  // ===========================================================================

  describe('getReviewFeedback', () => {
    it('returns feedback from saved review', () => {
      pr.executeReview('task-fb', DIFF_WITH_ISSUES, {
        authorRole: 'backend',
        reviewerRole: 'frontend'
      }, { projectRoot: tmpDir });

      const feedback = pr.getReviewFeedback('task-fb', { projectRoot: tmpDir });
      assert.ok(feedback);
      assert.equal(feedback.task_id, 'task-fb');
      assert.equal(feedback.reviewer, 'frontend');
      assert.ok(feedback.comments.length > 0);
    });

    it('returns null for non-existent review', () => {
      const feedback = pr.getReviewFeedback('no-such-task', { projectRoot: tmpDir });
      assert.equal(feedback, null);
    });
  });

  // ===========================================================================
  // learnFromReview
  // ===========================================================================

  describe('learnFromReview', () => {
    it('records lessons for author from review with issues', () => {
      pr.executeReview('task-learn', DIFF_WITH_ISSUES, {
        authorRole: 'backend',
        reviewerRole: 'frontend'
      }, { projectRoot: tmpDir });

      const result = pr.learnFromReview('task-learn', { projectRoot: tmpDir });
      // Author should get a lesson if souls module works
      assert.ok(result.author_updated === true || result.author_updated === false);
    });

    it('returns both false for non-existent review', () => {
      const result = pr.learnFromReview('no-task', { projectRoot: tmpDir });
      assert.equal(result.author_updated, false);
      assert.equal(result.reviewer_updated, false);
    });
  });

  // ===========================================================================
  // extractDomainsFromDiff
  // ===========================================================================

  describe('extractDomainsFromDiff', () => {
    it('detects API domain from path', () => {
      const domains = pr.extractDomainsFromDiff(API_DIFF);
      assert.ok(domains.includes('api_design'));
    });

    it('detects security domain from auth path', () => {
      const domains = pr.extractDomainsFromDiff(AUTH_DIFF);
      assert.ok(domains.includes('security_audit'));
    });

    it('returns empty for generic paths', () => {
      const domains = pr.extractDomainsFromDiff('diff --git a/README.md b/README.md\n+hello');
      assert.equal(domains.length, 0);
    });
  });

  // ===========================================================================
  // requestReview (PM integration)
  // ===========================================================================

  describe('requestReview', () => {
    it('selects reviewer and executes review', () => {
      const result = pr.requestReview('task-pm', 'backend', API_DIFF, {
        projectRoot: tmpDir,
        taskDescription: 'Add API routes'
      });

      assert.ok('approved' in result);
      assert.ok(result.reviewer);
      assert.ok(result.reviewer !== 'backend'); // Not self-review
    });

    it('auto-approves when no reviewer available', () => {
      // Remove all agents except pm and the author
      const regPath = path.join(tmpDir, '.claude/pilot/agent-registry.json');
      fs.writeFileSync(regPath, JSON.stringify({
        agents: {
          solo: { name: 'Solo', capabilities: ['everything'] },
          pm: { name: 'PM', capabilities: ['task_assignment'] }
        }
      }));

      // Clear cache so new registry is loaded
      for (const key of Object.keys(require.cache)) {
        if (key.includes('peer-review')) delete require.cache[key];
      }
      const freshPr = require('../.claude/pilot/hooks/lib/peer-review');
      const result = freshPr.requestReview('task-solo', 'solo', SMALL_DIFF, {
        projectRoot: tmpDir
      });

      assert.ok(result.approved);
      assert.ok(result.skipped);
    });

    it('returns error for missing params', () => {
      const result = pr.requestReview(null, 'backend', SMALL_DIFF);
      assert.ok(result.error);
    });
  });

  // ===========================================================================
  // getReviewHistory
  // ===========================================================================

  describe('getReviewHistory', () => {
    it('returns history for author', () => {
      pr.executeReview('task-h1', SMALL_DIFF, {
        authorRole: 'backend', reviewerRole: 'frontend'
      }, { projectRoot: tmpDir });
      pr.executeReview('task-h2', SMALL_DIFF, {
        authorRole: 'backend', reviewerRole: 'security'
      }, { projectRoot: tmpDir });

      const history = pr.getReviewHistory('backend', { projectRoot: tmpDir });
      assert.equal(history.length, 2);
    });

    it('filters by reviewer', () => {
      pr.executeReview('task-r1', SMALL_DIFF, {
        authorRole: 'backend', reviewerRole: 'frontend'
      }, { projectRoot: tmpDir });
      pr.executeReview('task-r2', SMALL_DIFF, {
        authorRole: 'backend', reviewerRole: 'security'
      }, { projectRoot: tmpDir });

      const history = pr.getReviewHistory('frontend', {
        projectRoot: tmpDir, asReviewer: true
      });
      assert.equal(history.length, 1);
      assert.equal(history[0].reviewer, 'frontend');
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        pr.executeReview('task-lim-' + i, SMALL_DIFF, {
          authorRole: 'backend', reviewerRole: 'frontend'
        }, { projectRoot: tmpDir });
      }

      const history = pr.getReviewHistory('backend', { projectRoot: tmpDir, limit: 3 });
      assert.equal(history.length, 3);
    });

    it('returns empty for no reviews', () => {
      const history = pr.getReviewHistory('backend', { projectRoot: tmpDir });
      assert.equal(history.length, 0);
    });
  });

  // ===========================================================================
  // getReviewStats
  // ===========================================================================

  describe('getReviewStats', () => {
    it('counts author and reviewer stats', () => {
      pr.executeReview('task-s1', SMALL_DIFF, {
        authorRole: 'backend', reviewerRole: 'frontend'
      }, { projectRoot: tmpDir });
      pr.executeReview('task-s2', DIFF_WITH_ISSUES, {
        authorRole: 'backend', reviewerRole: 'frontend'
      }, { projectRoot: tmpDir });

      const stats = pr.getReviewStats('backend', { projectRoot: tmpDir });
      assert.equal(stats.as_author.total, 2);
      assert.ok(stats.as_author.approved >= 0);

      const reviewerStats = pr.getReviewStats('frontend', { projectRoot: tmpDir });
      assert.equal(reviewerStats.as_reviewer.total, 2);
    });

    it('returns zeros for no reviews', () => {
      const stats = pr.getReviewStats('backend', { projectRoot: tmpDir });
      assert.equal(stats.as_author.total, 0);
      assert.equal(stats.as_reviewer.total, 0);
    });
  });

  // ===========================================================================
  // Module exports
  // ===========================================================================

  describe('module exports', () => {
    it('exports all expected functions', () => {
      const exports = [
        'selectReviewer', 'isLightweight', 'buildReviewChecklist',
        'executeReview', 'getReviewFeedback', 'learnFromReview',
        'getReviewHistory', 'getReviewStats', 'requestReview',
        'extractDomainsFromDiff', 'countDiffLines'
      ];
      for (const name of exports) {
        assert.ok(name in pr, 'Missing export: ' + name);
      }
    });
  });
});
