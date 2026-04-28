/**
 * Tests for PM Brain conversation persistence — Sprint 3 T1
 *
 * Pm conversation threads should survive daemon restart so PM identity
 * carries across sessions.
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/pm-brain-persistence.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { PmBrain } = require('../pm-brain');

let testDir;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmbrain-persist-'));
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

// Stub claude callable so ask() doesn't try to spawn a real subprocess.
function fakeCallClaude(_prompt, _opts) {
  return {
    success: true,
    result: { guidance: 'stub guidance', decision: { type: 'answer', reason: 'stub' } }
  };
}

console.log('\n=== PM Brain Persistence Tests ===\n');

// --- Round-trip: ask → close → reopen → thread is restored ---

test('ask() persists conversation thread to disk', () => {
  const brain = new PmBrain(testDir, { _callClaudeFn: fakeCallClaude });
  brain.ask('agent-1', 'what should I do?', { taskId: 'bd-foo' });

  const filePath = path.join(testDir, '.claude/pilot/state/orchestrator/pm-threads.json');
  assert.ok(fs.existsSync(filePath), 'pm-threads.json should be created');

  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.strictEqual(stored.version, 1);
  assert.ok(stored.conversations['agent-1']);
  assert.strictEqual(stored.conversations['agent-1'].length, 2);
  assert.strictEqual(stored.conversations['agent-1'][0].role, 'agent');
  assert.strictEqual(stored.conversations['agent-1'][1].role, 'pm');
});

test('new PmBrain on same projectRoot restores prior threads', () => {
  const a = new PmBrain(testDir, { _callClaudeFn: fakeCallClaude });
  a.ask('agent-1', 'q1', { taskId: 't1' });
  a.ask('agent-2', 'q2', { taskId: 't2' });

  // Daemon restart simulation — fresh PmBrain instance.
  const b = new PmBrain(testDir, { _callClaudeFn: fakeCallClaude });
  const t1 = b.getThread('agent-1');
  const t2 = b.getThread('agent-2');
  assert.strictEqual(t1.length, 2);
  assert.strictEqual(t2.length, 2);
  assert.strictEqual(t1[0].content, 'q1');
  assert.strictEqual(t2[0].content, 'q2');
});

test('clearThread() persists deletion', () => {
  const a = new PmBrain(testDir, { _callClaudeFn: fakeCallClaude });
  a.ask('agent-1', 'q', {});
  a.clearThread('agent-1');

  const b = new PmBrain(testDir, { _callClaudeFn: fakeCallClaude });
  assert.deepStrictEqual(b.getThread('agent-1'), []);
});

test('clearAllThreads() wipes the persisted file content', () => {
  const a = new PmBrain(testDir, { _callClaudeFn: fakeCallClaude });
  a.ask('agent-1', 'q', {});
  a.ask('agent-2', 'q', {});
  a.clearAllThreads();

  const filePath = path.join(testDir, '.claude/pilot/state/orchestrator/pm-threads.json');
  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepStrictEqual(stored.conversations, {});
});

// --- Graceful degrade: corrupted file → empty start ---

test('malformed JSON in pm-threads.json → fresh start, no throw', () => {
  const filePath = path.join(testDir, '.claude/pilot/state/orchestrator/pm-threads.json');
  fs.writeFileSync(filePath, '{ this is not valid json');
  // Should not throw.
  const brain = new PmBrain(testDir, { _callClaudeFn: fakeCallClaude });
  assert.deepStrictEqual(brain.getThread('agent-anything'), []);
});

test('missing file → fresh start, no throw', () => {
  // testDir has no pm-threads.json.
  const brain = new PmBrain(testDir, { _callClaudeFn: fakeCallClaude });
  assert.deepStrictEqual(brain.getThread('agent-anything'), []);
});

test('persistThreads: false opt-out skips load and save', () => {
  // Pre-seed a file.
  const filePath = path.join(testDir, '.claude/pilot/state/orchestrator/pm-threads.json');
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    conversations: { 'agent-1': [{ role: 'agent', content: 'old', ts: 1 }] }
  }));

  const brain = new PmBrain(testDir, {
    _callClaudeFn: fakeCallClaude,
    persistThreads: false
  });
  // Did NOT load.
  assert.deepStrictEqual(brain.getThread('agent-1'), []);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
