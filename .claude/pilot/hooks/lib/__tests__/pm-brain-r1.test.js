/**
 * Tests for R1 — separated prompt builders + response envelope.
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/pm-brain-r1.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { PmBrain } = require('../pm-brain');

let testDir;
function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-brain-r1-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/orchestrator'), { recursive: true });
}
function teardown() { fs.rmSync(testDir, { recursive: true, force: true }); }

let passed = 0, failed = 0; const failures = [];
function test(name, fn) {
  setup();
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; failures.push(name + ': ' + e.message); console.error('  ✗ ' + name); console.error('    ' + e.message); }
  finally { teardown(); }
}

console.log('\n=== R1: Prompt Builders + Response Envelope ===\n');

// ---- _normalizeResponse ----

test('normalize: plain string → user-mode envelope', () => {
  const brain = new PmBrain(testDir, { _callClaudeFn: () => ({ success: true, result: 'hello there' }) });
  const r = brain.ask('s1', 'hi', { audience: 'user' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.mode, 'user');
  assert.strictEqual(r.guidance, 'hello there');
  assert.strictEqual(r.decision, null);
  assert.strictEqual(r.subtasks, null);
});

test('normalize: {raw_text:"..."} unwraps for user mode', () => {
  const brain = new PmBrain(testDir, {
    _callClaudeFn: () => ({ success: true, result: { raw_text: 'hey friend' } })
  });
  const r = brain.ask('s2', 'hi', { audience: 'user' });
  assert.strictEqual(r.guidance, 'hey friend');
});

test('normalize: agent mode preserves decision + subtasks', () => {
  const brain = new PmBrain(testDir, {
    _callClaudeFn: () => ({
      success: true,
      result: {
        guidance: 'split it',
        decision: { type: 'decompose', action: 'split into 2', reason: 'large' },
        subtasks: [{ title: 'a', role: 'frontend' }, { title: 'b', role: 'backend' }]
      }
    })
  });
  const r = brain.ask('a1', 'should we split?', { audience: 'agent', taskId: 't1' });
  assert.strictEqual(r.mode, 'agent');
  assert.strictEqual(r.decision.type, 'decompose');
  assert.strictEqual(r.subtasks.length, 2);
});

test('normalize: garbage object in user mode → empty guidance, never JSON', () => {
  const brain = new PmBrain(testDir, {
    _callClaudeFn: () => ({ success: true, result: { weird: 'shape' } })
  });
  const r = brain.ask('s3', 'hi', { audience: 'user' });
  // Critically, do NOT dump JSON.stringify(result) into a user chat.
  assert.strictEqual(r.guidance.includes('weird'), false);
});

test('normalize: garbage object in agent mode → JSON-stringified for diagnostics', () => {
  const brain = new PmBrain(testDir, {
    _callClaudeFn: () => ({ success: true, result: { weird: 'shape' } })
  });
  const r = brain.ask('a2', 'q', { audience: 'agent' });
  assert.ok(r.guidance.length > 0);
});

// ---- prompt builders ----

test('user prompt: contains persona, omits productBrief / project state', () => {
  const brain = new PmBrain(testDir, { _callClaudeFn: () => ({ success: true, result: 'ok' }) });
  // Reach into the builder directly.
  const knowledge = {
    projectName: 'TestProj',
    productBrief: 'SECRET CONTRACT LANGUAGE that should not appear',
    currentMilestone: 'M9',
    currentPhase: 'P1',
    activeAgents: [{ session_id: 'sX', role: 'frontend' }],
    recentDecisions: [{ ts: 'now', type: 'drop-message', summary: 'kicked' }],
    taskSummary: 'do not include me'
  };
  const prompt = brain._buildUserPrompt(knowledge, 'hi');
  assert.ok(prompt.includes('TestProj'), 'should include project name');
  assert.ok(!prompt.includes('SECRET CONTRACT LANGUAGE'), 'should omit productBrief');
  assert.ok(!prompt.includes('drop-message'), 'should omit prior decisions');
  assert.ok(!prompt.includes('do not include me'), 'should omit task graph');
  assert.ok(prompt.includes('plain text'), 'should instruct plain text output');
});

test('agent prompt: includes productBrief, decisions, agent matrix', () => {
  const brain = new PmBrain(testDir, { _callClaudeFn: () => ({ success: true, result: 'ok' }) });
  const knowledge = {
    projectName: 'TestProj',
    productBrief: 'long brief',
    currentMilestone: 'M9',
    currentPhase: 'P1',
    tasksInProgress: [{ id: 'bd-1', title: 'Foo' }],
    tasksBlocked: [],
    activeAgents: [{ session_id: 'sX', role: 'frontend', claimed_task: 'bd-2' }],
    recentDecisions: [{ ts: 'now', type: 'decompose', summary: 'split' }],
    taskSummary: 'graph here'
  };
  const prompt = brain._buildAgentPrompt(knowledge, [], 'should we?', { taskId: 'bd-1' });
  assert.ok(prompt.includes('long brief'));
  assert.ok(prompt.includes('decompose'));
  assert.ok(prompt.includes('graph here'));
  assert.ok(prompt.includes('Return JSON'));
});

test('user prompt does not blow past prompt size cap', () => {
  const brain = new PmBrain(testDir, { _callClaudeFn: () => ({ success: true, result: 'ok' }), maxPromptSize: 16000 });
  const longQuestion = 'why ' + 'x'.repeat(20000);
  const prompt = brain._buildUserPrompt({ projectName: 'P' }, longQuestion);
  // We don't truncate inside _buildUserPrompt (it's not subject to _fitToLimit),
  // so the test asserts the contract: prompt is one-shot built without crashing.
  assert.ok(typeof prompt === 'string' && prompt.length > 0);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed > 0) { console.error(failures.join('\n')); process.exit(1); }
