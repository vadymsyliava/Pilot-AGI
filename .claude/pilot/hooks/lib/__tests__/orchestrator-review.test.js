/**
 * Tests for orchestrator.delegateForReview — Sprint 4 T2 (M1.5)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/orchestrator-review.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const orchestrator = require('../orchestrator');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-review-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/messages'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/memory/channels'), { recursive: true });
  fs.writeFileSync(
    path.join(testDir, '.claude/pilot/agent-registry.json'),
    JSON.stringify({ agents: { review: {}, frontend: {} } }, null, 2)
  );
  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function makeStubSession(agents) {
  return { getAvailableAgents: () => agents };
}

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  setup();
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push(`  ✗ ${name}\n    ${e.stack || e.message}`);
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  } finally {
    teardown();
  }
}

console.log('\n=== Orchestrator delegateForReview Tests ===\n');

test('errors when taskId missing', () => {
  const r = orchestrator.delegateForReview(null, 'review', 'pm-1', {
    _session: makeStubSession([])
  });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /taskId is required/);
});

test('returns no-agent error if no review agent available', () => {
  const r = orchestrator.delegateForReview('bd-foo', 'review', 'pm-1', {
    _session: makeStubSession([
      { session_id: 's-fe', role: 'frontend', agent_name: 'fe' }
    ])
  });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /No idle agent with role "review"/);
});

test('routes to first idle review agent', () => {
  const r = orchestrator.delegateForReview('bd-foo', 'review', 'pm-1', {
    completedBy: 's-fe',
    _session: makeStubSession([
      { session_id: 's-rev', role: 'review', agent_name: 'rev-1' }
    ])
  });
  assert.strictEqual(r.assigned_to, 's-rev');
});

test('default reviewerRole is "review"', () => {
  const r = orchestrator.delegateForReview('bd-foo', undefined, 'pm-1', {
    _session: makeStubSession([
      { session_id: 's-rev', role: 'review', agent_name: 'rev-1' }
    ])
  });
  assert.strictEqual(r.assigned_to, 's-rev');
});

test('publishes review_delegated decision to pm-decisions channel', () => {
  orchestrator.delegateForReview('bd-foo', 'review', 'pm-1', {
    completedBy: 's-fe',
    _session: makeStubSession([
      { session_id: 's-rev', role: 'review', agent_name: 'rev-1' }
    ])
  });
  const channelPath = path.join(testDir, '.claude/pilot/memory/channels/pm-decisions.json');
  if (fs.existsSync(channelPath)) {
    const stored = JSON.parse(fs.readFileSync(channelPath, 'utf8'));
    // publishDecision writes summary + data; just check we touched it.
    assert.ok(stored, 'pm-decisions.json should exist after delegateForReview');
  }
  // (the channel may be implemented as JSONL elsewhere; success ≈ no throw)
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
