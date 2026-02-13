/**
 * Tests for Phase 5.11: PR Automation & Remote Push
 *
 * Tests pr-automation.js — policy loading, commit validation,
 * PR body generation, prerequisite checks, and task completion flow.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Fresh module helper
function freshModule(modPath) {
  const fullPath = require.resolve(modPath);
  delete require.cache[fullPath];
  return require(modPath);
}

// Test temp directory
let tmpDir;
let origCwd;

function setupTmpDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-auto-test-'));
  origCwd = process.cwd();
}

function cleanupTmpDir() {
  process.chdir(origCwd);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ok */ }
}

function writePolicy(dir, githubSection) {
  const policyDir = path.join(dir, '.claude', 'pilot');
  fs.mkdirSync(policyDir, { recursive: true });
  let yaml = 'version: "2.0"\n\n';
  if (githubSection) {
    yaml += 'github:\n';
    for (const [k, v] of Object.entries(githubSection)) {
      if (typeof v === 'object' && !Array.isArray(v)) {
        yaml += '  ' + k + ':\n';
        for (const [k2, v2] of Object.entries(v)) {
          yaml += '    ' + k2 + ': ' + JSON.stringify(v2) + '\n';
        }
      } else if (Array.isArray(v)) {
        yaml += '  ' + k + ':\n';
        for (const item of v) {
          yaml += '    - "' + item + '"\n';
        }
      } else {
        yaml += '  ' + k + ': ' + JSON.stringify(v) + '\n';
      }
    }
  }
  fs.writeFileSync(path.join(policyDir, 'policy.yaml'), yaml);
}

function initGitRepo(dir) {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
}

// =============================================================================
// TESTS
// =============================================================================

describe('PR Automation — Phase 5.11', () => {
  let prAutomation;

  beforeEach(() => {
    setupTmpDir();
    prAutomation = freshModule('../.claude/pilot/hooks/lib/pr-automation');
  });

  afterEach(() => {
    cleanupTmpDir();
  });

  // ===========================================================================
  // Policy loading
  // ===========================================================================

  describe('loadGitHubPolicy', () => {
    it('returns defaults when no github section in policy', () => {
      writePolicy(tmpDir, null);
      const policy = prAutomation.loadGitHubPolicy(tmpDir);
      assert.equal(policy.enabled, false);
      assert.equal(policy.pr_on_complete, true);
      assert.equal(policy.auto_merge, false);
      assert.equal(policy.merge_strategy, 'squash');
      assert.deepStrictEqual(policy.labels, ['pilot-agi', 'auto-generated']);
      assert.deepStrictEqual(policy.reviewers, []);
    });

    it('returns defaults when policy file missing', () => {
      const policy = prAutomation.loadGitHubPolicy(tmpDir);
      assert.equal(policy.enabled, false);
      assert.equal(policy.base_branch, 'main');
    });

    it('reads github.enabled: true from policy', () => {
      writePolicy(tmpDir, { enabled: true, auto_merge: true, base_branch: 'develop' });
      const policy = prAutomation.loadGitHubPolicy(tmpDir);
      assert.equal(policy.enabled, true);
      assert.equal(policy.auto_merge, true);
      assert.equal(policy.base_branch, 'develop');
    });

    it('reads commit_enforcement overrides', () => {
      writePolicy(tmpDir, {
        enabled: true,
        commit_enforcement: {
          max_lines_per_commit: 200,
          require_conventional: false,
          block_on_violation: true
        }
      });
      const policy = prAutomation.loadGitHubPolicy(tmpDir);
      assert.equal(policy.commit_enforcement.max_lines_per_commit, 200);
      assert.equal(policy.commit_enforcement.require_conventional, false);
      assert.equal(policy.commit_enforcement.block_on_violation, true);
    });

    it('reads custom labels', () => {
      writePolicy(tmpDir, {
        enabled: true,
        labels: ['my-label', 'custom']
      });
      const policy = prAutomation.loadGitHubPolicy(tmpDir);
      assert.deepStrictEqual(policy.labels, ['my-label', 'custom']);
    });

    it('reads merge_strategy', () => {
      writePolicy(tmpDir, { enabled: true, merge_strategy: 'rebase' });
      const policy = prAutomation.loadGitHubPolicy(tmpDir);
      assert.equal(policy.merge_strategy, 'rebase');
    });
  });

  // ===========================================================================
  // Prerequisites
  // ===========================================================================

  describe('checkPrerequisites', () => {
    it('detects missing git remote', () => {
      initGitRepo(tmpDir);
      const result = prAutomation.checkPrerequisites(tmpDir);
      assert.equal(result.remote, false);
      assert.ok(result.errors.some(e => e.includes('No git remote')));
    });

    it('returns gh: true when gh CLI is available', () => {
      initGitRepo(tmpDir);
      const result = prAutomation.checkPrerequisites(tmpDir);
      assert.equal(typeof result.gh, 'boolean');
      assert.equal(typeof result.available, 'boolean');
      assert.ok(Array.isArray(result.errors));
    });
  });

  // ===========================================================================
  // Commit validation
  // ===========================================================================

  describe('validateCommits', () => {
    it('returns valid for empty branch', () => {
      const result = prAutomation.validateCommits('task-1', { projectRoot: tmpDir });
      assert.equal(result.valid, true);
      assert.equal(result.commits.length, 0);
    });

    it('detects non-conventional commit messages', () => {
      initGitRepo(tmpDir);
      execSync('git checkout -b pilot/task-1', { cwd: tmpDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'content');
      execSync('git add . && git commit -m "bad commit message [task-1]"', { cwd: tmpDir, stdio: 'pipe' });

      const result = prAutomation.validateCommits('task-1', {
        projectRoot: tmpDir,
        baseBranch: 'main'
      });
      assert.equal(result.valid, false);
      assert.ok(result.commits[0].violations.some(v => v.type === 'non_conventional'));
    });

    it('passes for valid conventional commits', () => {
      initGitRepo(tmpDir);
      execSync('git checkout -b pilot/task-2', { cwd: tmpDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'content');
      execSync('git add . && git commit -m "feat(core): add feature [task-2]"', { cwd: tmpDir, stdio: 'pipe' });

      const result = prAutomation.validateCommits('task-2', {
        projectRoot: tmpDir,
        baseBranch: 'main'
      });
      assert.equal(result.valid, true);
      assert.equal(result.commits.length, 1);
    });

    it('detects missing task ID reference', () => {
      initGitRepo(tmpDir);
      execSync('git checkout -b pilot/task-3', { cwd: tmpDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'content');
      execSync('git add . && git commit -m "feat: add feature"', { cwd: tmpDir, stdio: 'pipe' });

      const result = prAutomation.validateCommits('task-3', {
        projectRoot: tmpDir,
        baseBranch: 'main'
      });
      assert.equal(result.valid, false);
      assert.ok(result.commits[0].violations.some(v => v.type === 'missing_task_id'));
    });

    it('detects oversized commits', () => {
      initGitRepo(tmpDir);
      execSync('git checkout -b pilot/task-4', { cwd: tmpDir, stdio: 'pipe' });
      const bigContent = Array(600).fill('line of code\n').join('');
      fs.writeFileSync(path.join(tmpDir, 'big.txt'), bigContent);
      execSync('git add . && git commit -m "feat: big change [task-4]"', { cwd: tmpDir, stdio: 'pipe' });

      const result = prAutomation.validateCommits('task-4', {
        projectRoot: tmpDir,
        baseBranch: 'main',
        policy: { commit_enforcement: { max_lines_per_commit: 500, require_conventional: true } }
      });
      assert.ok(result.commits[0].violations.some(v => v.type === 'too_large'));
    });

    it('respects custom max_lines_per_commit', () => {
      initGitRepo(tmpDir);
      execSync('git checkout -b pilot/task-5', { cwd: tmpDir, stdio: 'pipe' });
      const content = Array(50).fill('line\n').join('');
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), content);
      execSync('git add . && git commit -m "feat: small change [task-5]"', { cwd: tmpDir, stdio: 'pipe' });

      const result = prAutomation.validateCommits('task-5', {
        projectRoot: tmpDir,
        baseBranch: 'main',
        policy: { commit_enforcement: { max_lines_per_commit: 10, require_conventional: true } }
      });
      assert.ok(result.commits[0].violations.some(v => v.type === 'too_large'));
    });
  });

  // ===========================================================================
  // PR Body generation
  // ===========================================================================

  describe('buildPRBody', () => {
    it('generates structured PR body', () => {
      initGitRepo(tmpDir);
      execSync('git checkout -b pilot/task-body', { cwd: tmpDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(tmpDir, 'feature.js'), 'module.exports = {}');
      execSync('git add . && git commit -m "feat: impl"', { cwd: tmpDir, stdio: 'pipe' });

      const body = prAutomation.buildPRBody('task-body', {
        projectRoot: tmpDir,
        baseBranch: 'main',
        sessionId: 'S-test123'
      });

      assert.ok(body.includes('## Summary'));
      assert.ok(body.includes('## Changes'));
      assert.ok(body.includes('## Task Reference'));
      assert.ok(body.includes('bd: task-body'));
      assert.ok(body.includes('Agent: S-test123'));
      assert.ok(body.includes('Auto-generated by Pilot AGI'));
    });

    it('includes plan steps when plan file exists', () => {
      initGitRepo(tmpDir);
      execSync('git checkout -b pilot/task-plan', { cwd: tmpDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(tmpDir, 'a.js'), 'x');
      execSync('git add . && git commit -m "feat: x"', { cwd: tmpDir, stdio: 'pipe' });

      const planDir = path.join(tmpDir, 'work', 'plans');
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(path.join(planDir, 'task-plan.md'), [
        '# Plan',
        '',
        '## Overview',
        '',
        'This implements the feature.',
        '',
        '## Steps',
        '',
        '### Step 1: Create module',
        '### Step 2: Add tests',
        '### Step 3: Integrate',
        ''
      ].join('\n'));

      const body = prAutomation.buildPRBody('task-plan', {
        projectRoot: tmpDir,
        baseBranch: 'main'
      });

      assert.ok(body.includes('## Plan Steps'));
      assert.ok(body.includes('Step 1: Create module'));
      assert.ok(body.includes('Step 2: Add tests'));
      assert.ok(body.includes('Step 3: Integrate'));
    });

    it('includes cost data when available', () => {
      initGitRepo(tmpDir);
      execSync('git checkout -b pilot/task-cost', { cwd: tmpDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(tmpDir, 'a.js'), 'x');
      execSync('git add . && git commit -m "feat: x"', { cwd: tmpDir, stdio: 'pipe' });

      const costDir = path.join(tmpDir, '.claude', 'pilot', 'state', 'costs', 'tasks');
      fs.mkdirSync(costDir, { recursive: true });
      fs.writeFileSync(path.join(costDir, 'task-cost.json'), JSON.stringify({
        total_tokens: 50000,
        respawn_count: 2
      }));

      const body = prAutomation.buildPRBody('task-cost', {
        projectRoot: tmpDir,
        baseBranch: 'main'
      });

      assert.ok(body.includes('## Cost'));
      assert.ok(body.includes('Tokens:'));
      assert.ok(body.includes('Respawns: 2'));
    });
  });

  // ===========================================================================
  // Sanitize task ID
  // ===========================================================================

  describe('sanitizeTaskId', () => {
    it('replaces spaces with hyphens', () => {
      assert.equal(prAutomation._sanitizeTaskId('Pilot AGI-abc'), 'Pilot-AGI-abc');
    });

    it('handles special characters', () => {
      const result = prAutomation._sanitizeTaskId('task@#$123');
      assert.ok(!result.includes('@'));
      assert.ok(!result.includes('#'));
    });
  });

  // ===========================================================================
  // CONVENTIONAL_REGEX
  // ===========================================================================

  describe('CONVENTIONAL_REGEX', () => {
    it('matches valid conventional commits', () => {
      const re = prAutomation._CONVENTIONAL_REGEX;
      assert.ok(re.test('feat: add feature'));
      assert.ok(re.test('fix(core): fix bug'));
      assert.ok(re.test('refactor!: breaking change'));
      assert.ok(re.test('docs: update readme'));
      assert.ok(re.test('test(unit): add tests'));
      assert.ok(re.test('chore: bump deps'));
    });

    it('rejects non-conventional commits', () => {
      const re = prAutomation._CONVENTIONAL_REGEX;
      assert.ok(!re.test('Add feature'));
      assert.ok(!re.test('fixed a bug'));
      assert.ok(!re.test('WIP'));
      assert.ok(!re.test(''));
    });
  });

  // ===========================================================================
  // PR Status file
  // ===========================================================================

  describe('PR status tracking', () => {
    it('getOpenPRs returns empty when no PR dir', () => {
      const result = prAutomation.getOpenPRs(tmpDir);
      assert.deepStrictEqual(result, []);
    });

    it('getOpenPRs returns open PRs', () => {
      const statusDir = path.join(tmpDir, '.claude', 'pilot', 'state', 'pr-status');
      fs.mkdirSync(statusDir, { recursive: true });
      fs.writeFileSync(path.join(statusDir, 'task-a.json'), JSON.stringify({
        task_id: 'task-a',
        pr_number: 42,
        status: 'open',
        merged: false
      }));
      fs.writeFileSync(path.join(statusDir, 'task-b.json'), JSON.stringify({
        task_id: 'task-b',
        pr_number: 43,
        status: 'merged',
        merged: true
      }));

      const result = prAutomation.getOpenPRs(tmpDir);
      assert.equal(result.length, 1);
      assert.equal(result[0].task_id, 'task-a');
      assert.equal(result[0].pr_number, 42);
    });

    it('updatePRStatus merges data into existing file', () => {
      const statusDir = path.join(tmpDir, '.claude', 'pilot', 'state', 'pr-status');
      fs.mkdirSync(statusDir, { recursive: true });
      const statusPath = path.join(statusDir, 'task-x.json');
      fs.writeFileSync(statusPath, JSON.stringify({
        task_id: 'task-x',
        pr_number: 10,
        status: 'open'
      }));

      prAutomation.updatePRStatus('task-x', { checks_passed: true }, tmpDir);

      const updated = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      assert.equal(updated.task_id, 'task-x');
      assert.equal(updated.checks_passed, true);
      assert.ok(updated.updated_at);
    });
  });

  // ===========================================================================
  // handleTaskComplete
  // ===========================================================================

  describe('handleTaskComplete', () => {
    it('returns local_merge when github disabled', () => {
      const result = prAutomation.handleTaskComplete('task-1', {
        projectRoot: tmpDir,
        policy: { enabled: false }
      });
      assert.equal(result.success, true);
      assert.equal(result.action, 'local_merge');
      assert.ok(result.reason.includes('github.enabled is false'));
    });

    it('returns local_merge when prerequisites not met', () => {
      initGitRepo(tmpDir);
      const result = prAutomation.handleTaskComplete('task-1', {
        projectRoot: tmpDir,
        policy: { enabled: true }
      });
      assert.equal(result.success, true);
      assert.equal(result.action, 'local_merge');
      assert.ok(result.reason.includes('prerequisites not met'));
    });

    it('blocks on commit violation when block_on_violation is true', () => {
      initGitRepo(tmpDir);
      execSync('git checkout -b pilot/task-block', { cwd: tmpDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(tmpDir, 'f.txt'), 'x');
      execSync('git add . && git commit -m "bad message"', { cwd: tmpDir, stdio: 'pipe' });
      // Go back to main so validateCommits can compare branches
      execSync('git checkout main', { cwd: tmpDir, stdio: 'pipe' });

      // Mock prerequisites to bypass gh/remote checks
      const origCheck = prAutomation.checkPrerequisites;
      prAutomation.checkPrerequisites = () => ({
        available: true, gh: true, remote: true, auth: true, errors: []
      });

      try {
        const result = prAutomation.handleTaskComplete('task-block', {
          projectRoot: tmpDir,
          policy: {
            enabled: true,
            auto_push: false,
            pr_on_complete: false,
            base_branch: 'main',
            commit_enforcement: {
              max_lines_per_commit: 500,
              require_conventional: true,
              block_on_violation: true
            }
          }
        });
        assert.equal(result.success, false);
        assert.equal(result.action, 'blocked');
        assert.ok(result.reason.includes('commit validation failed'));
      } finally {
        prAutomation.checkPrerequisites = origCheck;
      }
    });

    it('returns push_only when pr_on_complete is false', () => {
      initGitRepo(tmpDir);

      const origCheck = prAutomation.checkPrerequisites;
      const origPush = prAutomation.pushBranch;
      prAutomation.checkPrerequisites = () => ({
        available: true, gh: true, remote: true, auth: true, errors: []
      });
      // Mock push to succeed
      prAutomation.pushBranch = () => ({ success: true, branch: 'pilot/task-po', remote: 'origin' });

      try {
        const result = prAutomation.handleTaskComplete('task-po', {
          projectRoot: tmpDir,
          policy: {
            enabled: true,
            auto_push: true,
            pr_on_complete: false,
            base_branch: 'main',
            commit_enforcement: null
          }
        });
        assert.equal(result.success, true);
        assert.equal(result.action, 'push_only');
      } finally {
        prAutomation.checkPrerequisites = origCheck;
        prAutomation.pushBranch = origPush;
      }
    });
  });

  // ===========================================================================
  // DEFAULT_POLICY
  // ===========================================================================

  describe('DEFAULT_POLICY', () => {
    it('has expected defaults', () => {
      const dp = prAutomation.DEFAULT_POLICY;
      assert.equal(dp.enabled, false);
      assert.equal(dp.pr_on_complete, true);
      assert.equal(dp.auto_merge, false);
      assert.equal(dp.auto_push, true);
      assert.equal(dp.merge_strategy, 'squash');
      assert.equal(dp.delete_branch_after_merge, true);
      assert.equal(dp.require_checks_pass, true);
      assert.equal(dp.base_branch, 'main');
      assert.deepStrictEqual(dp.labels, ['pilot-agi', 'auto-generated']);
      assert.deepStrictEqual(dp.reviewers, []);
      assert.equal(dp.commit_enforcement.max_lines_per_commit, 500);
      assert.equal(dp.commit_enforcement.require_conventional, true);
      assert.equal(dp.commit_enforcement.block_on_violation, false);
    });
  });

  // ===========================================================================
  // Push branch (unit test with git)
  // ===========================================================================

  describe('pushBranch', () => {
    it('fails when no remote', () => {
      initGitRepo(tmpDir);
      execSync('git checkout -b pilot/task-push', { cwd: tmpDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(tmpDir, 'f.txt'), 'x');
      execSync('git add . && git commit -m "feat: x"', { cwd: tmpDir, stdio: 'pipe' });

      const result = prAutomation.pushBranch('task-push', { projectRoot: tmpDir });
      assert.equal(result.success, false);
      assert.ok(result.error);
    });
  });

  // ===========================================================================
  // getPRForTask
  // ===========================================================================

  describe('getPRForTask', () => {
    it('returns null when no cached status and no gh', () => {
      const result = prAutomation.getPRForTask('nonexistent', { projectRoot: tmpDir });
      assert.equal(result, null);
    });

    it('returns cached PR from status file', () => {
      const statusDir = path.join(tmpDir, '.claude', 'pilot', 'state', 'pr-status');
      fs.mkdirSync(statusDir, { recursive: true });
      fs.writeFileSync(path.join(statusDir, 'task-cached.json'), JSON.stringify({
        task_id: 'task-cached',
        pr_number: 99,
        pr_url: 'https://github.com/test/repo/pull/99',
        status: 'open'
      }));

      const result = prAutomation.getPRForTask('task-cached', { projectRoot: tmpDir });
      assert.equal(result.pr_number, 99);
      assert.equal(result.pr_url, 'https://github.com/test/repo/pull/99');
    });

    it('skips closed PRs from cache', () => {
      const statusDir = path.join(tmpDir, '.claude', 'pilot', 'state', 'pr-status');
      fs.mkdirSync(statusDir, { recursive: true });
      fs.writeFileSync(path.join(statusDir, 'task-closed.json'), JSON.stringify({
        task_id: 'task-closed',
        pr_number: 88,
        pr_url: 'https://github.com/test/repo/pull/88',
        status: 'closed'
      }));

      const result = prAutomation.getPRForTask('task-closed', { projectRoot: tmpDir });
      assert.equal(result, null);
    });
  });

  // ===========================================================================
  // PM Loop integration
  // ===========================================================================

  describe('PM Loop integration', () => {
    it('PmLoop has _prStatusScan method', () => {
      const pmLoopPath = require.resolve('../.claude/pilot/hooks/lib/pm-loop');
      delete require.cache[pmLoopPath];
      const depPaths = [
        '../.claude/pilot/hooks/lib/orchestrator',
        '../.claude/pilot/hooks/lib/session',
        '../.claude/pilot/hooks/lib/messaging',
        '../.claude/pilot/hooks/lib/pm-research',
        '../.claude/pilot/hooks/lib/decomposition',
        '../.claude/pilot/hooks/lib/pm-decisions',
        '../.claude/pilot/hooks/lib/overnight-mode'
      ];
      for (const dp of depPaths) {
        try {
          const resolved = require.resolve(dp);
          delete require.cache[resolved];
        } catch (e) { /* ok if not found */ }
      }

      const { PmLoop } = require(pmLoopPath);
      const loop = new PmLoop(tmpDir, { dryRun: true });
      assert.equal(typeof loop._prStatusScan, 'function');
      assert.equal(typeof loop.lastPrStatusScan, 'number');
      assert.equal(loop.lastPrStatusScan, 0);
    });

    it('PmLoop stats include last_pr_status_scan', () => {
      const pmLoopPath = require.resolve('../.claude/pilot/hooks/lib/pm-loop');
      delete require.cache[pmLoopPath];
      const { PmLoop } = require(pmLoopPath);
      const loop = new PmLoop(tmpDir, { dryRun: true });
      const stats = loop.getStats();
      assert.ok('last_pr_status_scan' in stats);
      assert.equal(stats.last_pr_status_scan, null);
    });

    it('_prStatusScan returns empty when github disabled', () => {
      writePolicy(tmpDir, null);
      const pmLoopPath = require.resolve('../.claude/pilot/hooks/lib/pm-loop');
      delete require.cache[pmLoopPath];
      const { PmLoop } = require(pmLoopPath);
      const loop = new PmLoop(tmpDir, { dryRun: true });
      const results = loop._prStatusScan();
      assert.deepStrictEqual(results, []);
    });
  });

  // ===========================================================================
  // Cleanup branch
  // ===========================================================================

  describe('cleanupBranch', () => {
    it('fails gracefully when no remote', () => {
      initGitRepo(tmpDir);
      const result = prAutomation.cleanupBranch('task-cleanup', { projectRoot: tmpDir });
      assert.equal(result.success, false);
      assert.ok(result.error);
    });
  });

  // ===========================================================================
  // Module exports
  // ===========================================================================

  describe('module exports', () => {
    it('exports all expected functions', () => {
      const exports = [
        'loadGitHubPolicy', 'checkPrerequisites', 'validateCommits',
        'buildPRBody', 'pushBranch', 'createPR', 'checkPRStatus',
        'mergePR', 'closePR', 'cleanupBranch', 'getPRForTask',
        'handleTaskComplete', 'getOpenPRs', 'updatePRStatus',
        'DEFAULT_POLICY'
      ];
      for (const name of exports) {
        assert.ok(name in prAutomation, 'Missing export: ' + name);
      }
    });
  });
});

// =============================================================================
// PR Body Builder — Phase 5.11
// =============================================================================

describe('PR Body Builder — Phase 5.11', () => {
  let builder;

  beforeEach(() => {
    setupTmpDir();
    builder = freshModule('../.claude/pilot/hooks/lib/pr-body-builder');
    // Create required directories
    fs.mkdirSync(path.join(tmpDir, '.claude/pilot/state/approved-plans'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.claude/pilot/state/costs/tasks'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'work/plans'), { recursive: true });
  });

  afterEach(() => {
    cleanupTmpDir();
  });

  describe('buildPRBody', () => {
    it('generates markdown with required sections', () => {
      const body = builder.buildPRBody('task-xyz', {
        projectRoot: tmpDir,
        sessionId: 'S-agent-1'
      });
      assert.ok(body.includes('## Summary'));
      assert.ok(body.includes('## Changes'));
      assert.ok(body.includes('## Task Reference'));
      assert.ok(body.includes('task-xyz'));
      assert.ok(body.includes('S-agent-1'));
      assert.ok(body.includes('Auto-generated by Pilot AGI'));
    });

    it('includes plan steps from approved plan JSON', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.claude/pilot/state/approved-plans/task-plan.json'),
        JSON.stringify({
          summary: 'Fix the auth bug',
          steps: ['Update handler', 'Add tests', 'Deploy']
        })
      );
      const body = builder.buildPRBody('task-plan', { projectRoot: tmpDir });
      assert.ok(body.includes('Fix the auth bug'));
      assert.ok(body.includes('## Plan Steps'));
      assert.ok(body.includes('Update handler'));
      assert.ok(body.includes('Add tests'));
      assert.ok(body.includes('Deploy'));
    });

    it('includes cost metrics when available', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.claude/pilot/state/costs/tasks/task-cost.json'),
        JSON.stringify({ total_tokens: 250000, respawn_count: 3 })
      );
      const body = builder.buildPRBody('task-cost', { projectRoot: tmpDir });
      assert.ok(body.includes('## Cost'));
      assert.ok(body.includes('250'));
      assert.ok(body.includes('Respawns: 3'));
    });

    it('respects template include_plan_steps: false', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.claude/pilot/state/approved-plans/task-tmpl.json'),
        JSON.stringify({ summary: 'Test', steps: ['Step 1'] })
      );
      const body = builder.buildPRBody('task-tmpl', {
        projectRoot: tmpDir,
        template: { include_plan_steps: false }
      });
      assert.ok(!body.includes('## Plan Steps'));
    });

    it('respects template include_cost_metrics: false', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.claude/pilot/state/costs/tasks/task-nocost.json'),
        JSON.stringify({ total_tokens: 100 })
      );
      const body = builder.buildPRBody('task-nocost', {
        projectRoot: tmpDir,
        template: { include_cost_metrics: false }
      });
      assert.ok(!body.includes('## Cost'));
    });
  });

  describe('buildPRTitle', () => {
    it('uses first commit message as title base', () => {
      const title = builder.buildPRTitle('task-1', ['feat(auth): add login [task-1]']);
      assert.ok(title.includes('feat(auth): add login'));
      assert.ok(title.includes('[task-1]'));
    });

    it('truncates long titles to under 100 chars', () => {
      const longMsg = 'feat: ' + 'a'.repeat(100);
      const title = builder.buildPRTitle('task-1', [longMsg]);
      assert.ok(title.length < 100);
      assert.ok(title.includes('...'));
    });

    it('returns default title when no commits', () => {
      assert.equal(builder.buildPRTitle('task-1'), '[task-1] Automated PR');
      assert.equal(builder.buildPRTitle('task-1', []), '[task-1] Automated PR');
    });
  });

  describe('loadPlanSteps', () => {
    it('loads from approved plan JSON', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.claude/pilot/state/approved-plans/my-task.json'),
        JSON.stringify({ summary: 'My summary', steps: ['s1', 's2'] })
      );
      const plan = builder.loadPlanSteps('my-task', tmpDir);
      assert.equal(plan.summary, 'My summary');
      assert.deepEqual(plan.steps, ['s1', 's2']);
    });

    it('returns empty when no plan exists', () => {
      const plan = builder.loadPlanSteps('nonexistent', tmpDir);
      assert.equal(plan.summary, '');
      assert.deepEqual(plan.steps, []);
    });

    it('handles plan with object steps', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.claude/pilot/state/approved-plans/obj-task.json'),
        JSON.stringify({
          summary: 'Object steps',
          steps: [{ title: 'First step' }, { description: 'Second step' }]
        })
      );
      const plan = builder.loadPlanSteps('obj-task', tmpDir);
      assert.equal(plan.steps[0], 'First step');
      assert.equal(plan.steps[1], 'Second step');
    });
  });

  describe('loadCostMetrics', () => {
    it('loads cost data from state file', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.claude/pilot/state/costs/tasks/my_task.json'),
        JSON.stringify({ total_tokens: 300000 })
      );
      const cost = builder.loadCostMetrics('my_task', tmpDir);
      assert.ok(cost);
      assert.equal(cost.total_tokens, 300000);
    });

    it('returns null when no cost file', () => {
      const cost = builder.loadCostMetrics('no-cost', tmpDir);
      assert.equal(cost, null);
    });
  });

  describe('module exports', () => {
    it('exports all expected functions', () => {
      assert.ok(typeof builder.buildPRBody === 'function');
      assert.ok(typeof builder.buildPRTitle === 'function');
      assert.ok(typeof builder.loadPlanSteps === 'function');
      assert.ok(typeof builder.getDiffStats === 'function');
      assert.ok(typeof builder.loadCostMetrics === 'function');
    });
  });
});

// =============================================================================
// Commit Enforcer — Phase 5.11
// =============================================================================

describe('Commit Enforcer — Phase 5.11', () => {
  let enforcer;

  beforeEach(() => {
    setupTmpDir();
    enforcer = freshModule('../.claude/pilot/hooks/lib/commit-enforcer');
  });

  afterEach(() => {
    cleanupTmpDir();
  });

  describe('validateCommit', () => {
    it('returns valid for empty file list', () => {
      const result = enforcer.validateCommit([]);
      assert.equal(result.valid, true);
      assert.deepEqual(result.violations, []);
    });

    it('returns valid for null input', () => {
      const result = enforcer.validateCommit(null);
      assert.equal(result.valid, true);
    });

    it('detects too many files', () => {
      const files = Array.from({ length: 15 }, (_, i) => 'src/file' + i + '.js');
      const result = enforcer.validateCommit(files, { maxFiles: 10, enforceAtomic: false });
      assert.equal(result.valid, false);
      assert.ok(result.violations.some(v => v.type === 'too_many_files'));
      assert.ok(result.suggestions.length > 0);
    });

    it('respects custom maxFiles', () => {
      const files = ['a.js', 'b.js', 'c.js'];
      const result = enforcer.validateCommit(files, { maxFiles: 2, enforceAtomic: false });
      assert.equal(result.valid, false);
    });

    it('passes with files under limit', () => {
      const files = ['src/a.js', 'src/b.js'];
      const result = enforcer.validateCommit(files, {
        maxFiles: 10,
        projectRoot: tmpDir,
        enforceAtomic: false
      });
      assert.equal(result.valid, true);
    });
  });

  describe('detectMixedConcerns', () => {
    it('detects mixed source, tests, docs, and infra', () => {
      const files = [
        'src/auth/handler.js',
        'src/api/routes.js',
        'tests/auth.test.js',
        'docs/readme.md',
        '.github/workflows/ci.yml'
      ];
      const result = enforcer.detectMixedConcerns(files);
      assert.equal(result.isMixed, true);
      assert.ok(result.areas.length >= 3);
    });

    it('does not flag single-area changes', () => {
      const files = ['src/auth/handler.js', 'src/auth/middleware.js'];
      const result = enforcer.detectMixedConcerns(files);
      assert.equal(result.isMixed, false);
    });

    it('does not flag test-only changes', () => {
      const files = ['tests/auth.test.js', 'tests/api.test.js'];
      const result = enforcer.detectMixedConcerns(files);
      assert.equal(result.isMixed, false);
    });

    it('classifies config files correctly', () => {
      const files = ['package.json', 'tsconfig.json'];
      const result = enforcer.detectMixedConcerns(files);
      assert.ok(result.areas.includes('config'));
    });
  });

  describe('suggestSplit', () => {
    it('groups files by area', () => {
      const files = [
        'src/handler.js',
        'tests/handler.test.js',
        'docs/api.md'
      ];
      const groups = enforcer.suggestSplit(files);
      assert.ok(groups.length >= 2);
      assert.ok(groups.some(g => g.name === 'tests'));
      assert.ok(groups.some(g => g.name === 'docs'));
    });

    it('returns single group for related files', () => {
      const files = ['tests/a.test.js', 'tests/b.test.js'];
      const groups = enforcer.suggestSplit(files);
      assert.equal(groups.length, 1);
      assert.equal(groups[0].name, 'tests');
      assert.equal(groups[0].files.length, 2);
    });

    it('handles empty input', () => {
      const groups = enforcer.suggestSplit([]);
      assert.equal(groups.length, 0);
    });
  });

  describe('validateMessage', () => {
    it('validates conventional commit format', () => {
      assert.equal(enforcer.validateMessage('feat: add login').valid, true);
      assert.equal(enforcer.validateMessage('feat: add login').type, 'feat');
      assert.equal(enforcer.validateMessage('fix(auth): resolve bug').scope, 'auth');
    });

    it('accepts all standard types', () => {
      const types = ['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'perf', 'ci', 'build', 'style', 'revert'];
      for (const t of types) {
        assert.equal(enforcer.validateMessage(t + ': description').valid, true, 'Failed for type: ' + t);
      }
    });

    it('rejects non-conventional messages', () => {
      assert.equal(enforcer.validateMessage('Update readme').valid, false);
      assert.ok(enforcer.validateMessage('Update readme').error);
    });

    it('rejects empty messages', () => {
      assert.equal(enforcer.validateMessage('').valid, false);
      assert.equal(enforcer.validateMessage(null).valid, false);
    });
  });

  describe('DEFAULT_LIMITS', () => {
    it('has expected defaults', () => {
      assert.equal(enforcer.DEFAULT_LIMITS.max_files_per_commit, 10);
      assert.equal(enforcer.DEFAULT_LIMITS.max_lines_per_commit, 500);
      assert.equal(enforcer.DEFAULT_LIMITS.enforce_atomic, true);
    });
  });

  describe('module exports', () => {
    it('exports all expected functions and constants', () => {
      assert.ok(typeof enforcer.validateCommit === 'function');
      assert.ok(typeof enforcer.validateMessage === 'function');
      assert.ok(typeof enforcer.detectMixedConcerns === 'function');
      assert.ok(typeof enforcer.suggestSplit === 'function');
      assert.ok(enforcer.CONVENTIONAL_REGEX instanceof RegExp);
      assert.ok(typeof enforcer.DEFAULT_LIMITS === 'object');
    });
  });
});

// =============================================================================
// CI Monitor — Phase 5.11
// =============================================================================

describe('CI Monitor — Phase 5.11', () => {
  let ci;

  beforeEach(() => {
    ci = freshModule('../.claude/pilot/hooks/lib/ci-monitor');
  });

  describe('extractFailureDetails', () => {
    it('extracts failing checks', () => {
      const checks = [
        { name: 'lint', conclusion: 'SUCCESS', url: null },
        { name: 'test', conclusion: 'FAILURE', url: 'https://ci.example.com/1' },
        { name: 'build', conclusion: 'TIMED_OUT', url: 'https://ci.example.com/2' }
      ];
      const result = ci.extractFailureDetails(checks);
      assert.equal(result.failing.length, 2);
      assert.equal(result.failing[0].name, 'test');
      assert.equal(result.failing[0].conclusion, 'FAILURE');
      assert.equal(result.failing[1].name, 'build');
      assert.ok(result.details.includes('test'));
      assert.ok(result.details.includes('build'));
    });

    it('returns empty for all passing', () => {
      const checks = [
        { name: 'lint', conclusion: 'SUCCESS' },
        { name: 'test', conclusion: 'SUCCESS' }
      ];
      const result = ci.extractFailureDetails(checks);
      assert.equal(result.failing.length, 0);
      assert.ok(result.details.includes('No failures'));
    });

    it('handles empty checks array', () => {
      const result = ci.extractFailureDetails([]);
      assert.equal(result.failing.length, 0);
    });

    it('includes URLs in details when available', () => {
      const checks = [
        { name: 'ci', conclusion: 'FAILURE', url: 'https://ci.example.com/run/1' }
      ];
      const result = ci.extractFailureDetails(checks);
      assert.ok(result.details.includes('https://ci.example.com/run/1'));
    });
  });

  describe('checkStatus', () => {
    it('returns error status when gh not available or not in repo', () => {
      const result = ci.checkStatus(999, { projectRoot: '/nonexistent' });
      assert.equal(result.status, 'error');
      assert.ok(result.error);
      assert.deepEqual(result.summary, { total: 0, passed: 0, failed: 0, pending: 0 });
    });
  });

  describe('isReadyToMerge', () => {
    it('returns not ready when cannot check status', () => {
      const result = ci.isReadyToMerge(999, { projectRoot: '/nonexistent' });
      assert.equal(result.ready, false);
      assert.ok(result.reason);
    });
  });

  describe('constants', () => {
    it('has expected timeout defaults', () => {
      assert.equal(ci.DEFAULT_TIMEOUT_MS, 30 * 60 * 1000);
      assert.equal(ci.POLL_INTERVAL_MS, 30 * 1000);
    });
  });

  describe('module exports', () => {
    it('exports all expected functions', () => {
      assert.ok(typeof ci.checkStatus === 'function');
      assert.ok(typeof ci.waitForChecks === 'function');
      assert.ok(typeof ci.extractFailureDetails === 'function');
      assert.ok(typeof ci.isReadyToMerge === 'function');
      assert.ok(typeof ci.DEFAULT_TIMEOUT_MS === 'number');
      assert.ok(typeof ci.POLL_INTERVAL_MS === 'number');
    });
  });
});

// =============================================================================
// Worktree Integration — Phase 5.11
// =============================================================================

describe('Worktree PR Integration — Phase 5.11', () => {
  it('worktree module exports mergeWorktree function', () => {
    const worktree = freshModule('../.claude/pilot/hooks/lib/worktree');
    assert.ok(typeof worktree.mergeWorktree === 'function');
  });

  it('mergeWorktree with non-existent branch returns error without crashing', () => {
    const worktree = freshModule('../.claude/pilot/hooks/lib/worktree');
    const result = worktree.mergeWorktree('nonexistent-task', 'test commit');
    assert.ok(result);
    assert.equal(result.success, false);
  });
});
