/**
 * Tests for PmAutoResponder — Sprint 4 T5 (M1.5)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/pm-auto-responder.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { PmAutoResponder } = require('../pm-auto-responder');
const { setPmMode } = require('../pm-mode');

let testDir;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-autoresp-'));
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
    failures.push(`  ✗ ${name}\n    ${e.stack || e.message}`);
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  } finally {
    teardown();
  }
}

function makeStubBrain(responses = {}) {
  return {
    calls: [],
    ask(sessionId, prompt, ctx) {
      this.calls.push({ sessionId, prompt, ctx });
      const fn = responses[prompt];
      return fn ? fn() : { success: true, guidance: `re: ${prompt}` };
    }
  };
}

console.log('\n=== PM Auto-Responder Tests ===\n');

test('tick is no-op when mode is strict_rules', () => {
  // mode defaults to strict_rules
  const brain = makeStubBrain();
  const r = new PmAutoResponder(testDir, brain);
  const result = r.tick();
  assert.strictEqual(result.mode_off, true);
  assert.strictEqual(result.processed, 0);
  assert.strictEqual(brain.calls.length, 0);
});

test('start() is a no-op when mode != free_chat', () => {
  const brain = makeStubBrain();
  const r = new PmAutoResponder(testDir, brain);
  assert.strictEqual(r.start(), false);
  assert.strictEqual(r.isRunning(), false);
});

test('tick processes pending entries when mode=free_chat', () => {
  setPmMode(testDir, 'free_chat');
  fs.writeFileSync(
    path.join(testDir, '.claude/pilot/state/orchestrator/pm-pending-chats.jsonl'),
    JSON.stringify({ id: '1', sessionId: 's1', prompt: 'hi' }) + '\n' +
    JSON.stringify({ id: '2', sessionId: 's2', prompt: 'hello' }) + '\n'
  );

  const brain = makeStubBrain();
  const r = new PmAutoResponder(testDir, brain);
  const result = r.tick();
  assert.strictEqual(result.processed, 2);
  assert.strictEqual(brain.calls.length, 2);

  // Pending drained, responses written.
  const pending = fs.readFileSync(
    path.join(testDir, '.claude/pilot/state/orchestrator/pm-pending-chats.jsonl'),
    'utf8'
  );
  assert.strictEqual(pending, '');

  const responses = fs.readFileSync(
    path.join(testDir, '.claude/pilot/state/orchestrator/pm-chat-responses.jsonl'),
    'utf8'
  ).trim().split('\n').map(JSON.parse);
  assert.strictEqual(responses.length, 2);
  assert.strictEqual(responses[0].id, '1');
  assert.match(responses[0].guidance, /re: hi/);
});

test('malformed pending lines are skipped, valid ones still processed', () => {
  setPmMode(testDir, 'free_chat');
  fs.writeFileSync(
    path.join(testDir, '.claude/pilot/state/orchestrator/pm-pending-chats.jsonl'),
    'not json\n' +
    JSON.stringify({ id: '1', sessionId: 's1', prompt: 'hi' }) + '\n' +
    '{ broken\n'
  );
  const brain = makeStubBrain();
  const r = new PmAutoResponder(testDir, brain);
  const result = r.tick();
  assert.strictEqual(result.processed, 1);
});

test('start/stop with fake timer', () => {
  setPmMode(testDir, 'free_chat');
  let firedFn = null;
  const fakeSet = (fn) => { firedFn = fn; return 'handle-1'; };
  const fakeClear = () => { firedFn = null; };
  const r = new PmAutoResponder(testDir, makeStubBrain(), {
    _setInterval: fakeSet, _clearInterval: fakeClear
  });
  assert.strictEqual(r.start(), true);
  assert.strictEqual(r.isRunning(), true);
  // Calling start again is a no-op.
  assert.strictEqual(r.start(), false);
  r.stop();
  assert.strictEqual(r.isRunning(), false);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
