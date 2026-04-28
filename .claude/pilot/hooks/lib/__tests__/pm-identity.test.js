/**
 * Tests for PmIdentity — Sprint 3 T2 (M1.5)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/pm-identity.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { PmIdentity } = require('../pm-identity');
const { PmBrain } = require('../pm-brain');

let testDir;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmidentity-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/orchestrator'), { recursive: true });
}

function teardown() {
  fs.rmSync(testDir, { recursive: true, force: true });
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
    failures.push(`  ✗ ${name}\n    ${e.message}`);
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  } finally {
    teardown();
  }
}

console.log('\n=== PM Identity Tests ===\n');

test('fresh PmIdentity initialises empty counters', () => {
  const id = new PmIdentity(testDir);
  const snap = id.snapshot();
  assert.strictEqual(snap.version, 1);
  assert.deepStrictEqual(snap.decisionCounts, { decompose: 0, answer: 0, defer: 0, other: 0 });
  assert.deepStrictEqual(snap.decompositions, []);
  assert.deepStrictEqual(snap.recentPrompts, []);
  assert.ok(snap.createdAt);
});

test('recordDecision increments counter and persists', () => {
  const a = new PmIdentity(testDir);
  a.recordDecision('decompose');
  a.recordDecision('decompose');
  a.recordDecision('defer');
  a.recordDecision('weird-type');

  // Reload from disk.
  const b = new PmIdentity(testDir);
  assert.strictEqual(b.snapshot().decisionCounts.decompose, 2);
  assert.strictEqual(b.snapshot().decisionCounts.defer, 1);
  assert.strictEqual(b.snapshot().decisionCounts.other, 1);
});

test('recordDecomposition stores last 50 newest first', () => {
  const id = new PmIdentity(testDir);
  for (let i = 0; i < 60; i++) {
    id.recordDecomposition(`prompt #${i}`, i + 1);
  }
  const snap = id.snapshot();
  assert.strictEqual(snap.decompositions.length, 50);
  assert.strictEqual(snap.decompositions[0].prompt, 'prompt #59');
});

test('recordPrompt dedupes adjacent identical entries', () => {
  const id = new PmIdentity(testDir);
  id.recordPrompt('hi');
  id.recordPrompt('hi');
  id.recordPrompt('hello');
  id.recordPrompt('hello');
  id.recordPrompt('hi');
  assert.strictEqual(id.snapshot().recentPrompts.length, 3);
});

test('malformed pm-identity.json → fresh start', () => {
  const filePath = path.join(testDir, '.claude/pilot/state/orchestrator/pm-identity.json');
  fs.writeFileSync(filePath, '{ corrupt');
  const id = new PmIdentity(testDir);
  // Survives constructor without throwing, defaults populated.
  assert.deepStrictEqual(id.snapshot().decisionCounts, { decompose: 0, answer: 0, defer: 0, other: 0 });
});

// --- Integration with PmBrain ---

function fakeCallClaude(verdict) {
  return () => ({
    success: true,
    result: { guidance: 'g', decision: { type: verdict, reason: 'r' } }
  });
}

test('PmBrain.ask() bumps identity decision counter', () => {
  const brain = new PmBrain(testDir, { _callClaudeFn: fakeCallClaude('decompose') });
  brain.ask('agent-1', 'do the thing', { taskId: 't1' });
  brain.ask('agent-1', 'do the other thing', { taskId: 't2' });

  // Read identity from disk, since cockpit will too.
  const stored = JSON.parse(fs.readFileSync(
    path.join(testDir, '.claude/pilot/state/orchestrator/pm-identity.json'),
    'utf8'
  ));
  assert.strictEqual(stored.decisionCounts.decompose, 2);
  assert.strictEqual(stored.recentPrompts.length, 2);
});

test('persistIdentity: false opt-out skips identity creation', () => {
  const brain = new PmBrain(testDir, {
    _callClaudeFn: fakeCallClaude('answer'),
    persistIdentity: false
  });
  brain.ask('agent-1', 'q', {});
  assert.ok(!brain.identity, 'identity should not be initialised');
  // No file written.
  const filePath = path.join(testDir, '.claude/pilot/state/orchestrator/pm-identity.json');
  assert.ok(!fs.existsSync(filePath), 'pm-identity.json should not exist');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
