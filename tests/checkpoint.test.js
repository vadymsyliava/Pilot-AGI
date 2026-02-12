#!/usr/bin/env node

/**
 * Verification tests for Context Checkpoint & Recovery (Phase 2.2.1)
 * Run: node tests/checkpoint.test.js
 */

const checkpoint = require('../.claude/pilot/hooks/lib/checkpoint');
const pressure = require('../.claude/pilot/hooks/lib/pressure');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS: ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL: ' + name + ' - ' + e.message);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

// Test session ID for isolation
const TEST_SESSION = 'S-test-checkpoint-' + Date.now().toString(36);

// =============================================================================
// CHECKPOINT TESTS
// =============================================================================

console.log('=== Context Checkpoint Tests ===\n');

// 1. loadCheckpoint returns null for nonexistent session
test('loadCheckpoint returns null for unknown session', () => {
  const result = checkpoint.loadCheckpoint('S-nonexistent-0000');
  assert(result === null, 'should return null');
});

test('loadCheckpoint returns null for null sessionId', () => {
  const result = checkpoint.loadCheckpoint(null);
  assert(result === null, 'should return null');
});

// 2. saveCheckpoint creates checkpoint
test('saveCheckpoint creates checkpoint v1', () => {
  const result = checkpoint.saveCheckpoint(TEST_SESSION, {
    task_id: 'Pilot AGI-test',
    task_title: 'Test Task',
    plan_step: 3,
    total_steps: 9,
    completed_steps: [
      { step: 1, description: 'Setup', result: 'done' },
      { step: 2, description: 'Implementation', result: 'done' }
    ],
    key_decisions: ['Use atomic writes', 'Store per-session'],
    files_modified: ['lib/checkpoint.js', 'lib/pressure.js'],
    current_context: 'Working on step 3: PostToolUse hook',
    important_findings: ['PostToolUse hook reads stdin JSON'],
    tool_call_count: 42,
    output_bytes: 50000
  });

  assert(result.success === true, 'should succeed');
  assert(result.version === 1, 'first version should be 1');
  assert(typeof result.path === 'string', 'should return path');
});

// 3. loadCheckpoint reads back saved data
test('loadCheckpoint reads back saved data', () => {
  const cp = checkpoint.loadCheckpoint(TEST_SESSION);
  assert(cp !== null, 'should not be null');
  assert(cp.version === 1, 'version should be 1');
  assert(cp.session_id === TEST_SESSION, 'session_id should match');
  assert(cp.task_id === 'Pilot AGI-test', 'task_id should match');
  assert(cp.plan_step === 3, 'plan_step should be 3');
  assert(cp.total_steps === 9, 'total_steps should be 9');
  assert(cp.completed_steps.length === 2, 'should have 2 completed steps');
  assert(cp.key_decisions.length === 2, 'should have 2 decisions');
  assert(cp.files_modified.length === 2, 'should have 2 files');
  assert(cp.current_context.includes('step 3'), 'context should include step 3');
  assert(cp.important_findings.length === 1, 'should have 1 finding');
  assert(cp.tool_call_count === 42, 'tool calls should be 42');
  assert(cp.output_bytes === 50000, 'output bytes should be 50000');
});

// 4. saveCheckpoint increments version and archives
test('saveCheckpoint increments version on re-save', () => {
  const result = checkpoint.saveCheckpoint(TEST_SESSION, {
    task_id: 'Pilot AGI-test',
    plan_step: 5,
    total_steps: 9,
    completed_steps: [
      { step: 1, description: 'Setup', result: 'done' },
      { step: 2, description: 'Implementation', result: 'done' },
      { step: 3, description: 'Hook', result: 'done' },
      { step: 4, description: 'Registration', result: 'done' }
    ],
    current_context: 'Working on step 5'
  });

  assert(result.success === true, 'should succeed');
  assert(result.version === 2, 'second version should be 2');
});

// 5. History is maintained
test('listCheckpointHistory returns archived versions', () => {
  const history = checkpoint.listCheckpointHistory(TEST_SESSION);
  assert(history.length === 1, 'should have 1 archived version');
  assert(history[0].version === 1, 'archived version should be 1');
  assert(history[0].plan_step === 3, 'archived plan_step should be 3');
});

// 6. saveCheckpoint with missing sessionId
test('saveCheckpoint fails without sessionId', () => {
  const result = checkpoint.saveCheckpoint(null, { task_id: 'test' });
  assert(result.success === false, 'should fail');
  assert(result.error === 'sessionId is required', 'should have error message');
});

// 7. saveCheckpoint with empty data
test('saveCheckpoint handles empty data gracefully', () => {
  const emptySession = TEST_SESSION + '-empty';
  const result = checkpoint.saveCheckpoint(emptySession, {});
  assert(result.success === true, 'should succeed with empty data');

  const cp = checkpoint.loadCheckpoint(emptySession);
  assert(cp.task_id === null, 'task_id should be null');
  assert(cp.completed_steps.length === 0, 'completed_steps should be empty');

  // Cleanup
  checkpoint.deleteCheckpoint(emptySession);
});

// 8. buildRestorationPrompt
test('buildRestorationPrompt produces valid markdown', () => {
  const cp = checkpoint.loadCheckpoint(TEST_SESSION);
  const prompt = checkpoint.buildRestorationPrompt(cp);

  assert(typeof prompt === 'string', 'should return string');
  assert(prompt.includes('Context Checkpoint Recovery'), 'should include title');
  assert(prompt.includes(TEST_SESSION), 'should include session ID');
  assert(prompt.includes('Pilot AGI-test'), 'should include task ID');
  assert(prompt.includes('Step 5 of 9'), 'should include progress');
  assert(prompt.includes('Working on step 5'), 'should include current context');
});

test('buildRestorationPrompt returns null for null input', () => {
  const prompt = checkpoint.buildRestorationPrompt(null);
  assert(prompt === null, 'should return null');
});

// 9. deleteCheckpoint
test('deleteCheckpoint removes checkpoint and history', () => {
  checkpoint.deleteCheckpoint(TEST_SESSION);

  const cp = checkpoint.loadCheckpoint(TEST_SESSION);
  assert(cp === null, 'checkpoint should be deleted');

  const history = checkpoint.listCheckpointHistory(TEST_SESSION);
  assert(history.length === 0, 'history should be empty');
});

// =============================================================================
// PRESSURE TRACKER TESTS
// =============================================================================

console.log('\n=== Context Pressure Tracker Tests ===\n');

const PRESSURE_SESSION = 'S-test-pressure-' + Date.now().toString(36);

// 10. Initial pressure is zero
test('getPressure returns zero for new session', () => {
  const p = pressure.getPressure(PRESSURE_SESSION);
  assert(p.calls === 0, 'calls should be 0');
  assert(p.bytes === 0, 'bytes should be 0');
  assert(p.pct_estimate === 0, 'pct should be 0');
});

// 11. recordToolCall increments
test('recordToolCall increments counters', () => {
  pressure.recordToolCall(PRESSURE_SESSION, 1024);
  const p = pressure.getPressure(PRESSURE_SESSION);
  assert(p.calls === 1, 'calls should be 1');
  assert(p.bytes === 1024, 'bytes should be 1024');
});

test('recordToolCall accumulates', () => {
  pressure.recordToolCall(PRESSURE_SESSION, 2048);
  const p = pressure.getPressure(PRESSURE_SESSION);
  assert(p.calls === 2, 'calls should be 2');
  assert(p.bytes === 3072, 'bytes should be 3072');
});

// 12. isNearLimit
test('isNearLimit returns false when under threshold', () => {
  const near = pressure.isNearLimit(PRESSURE_SESSION, 60);
  assert(near === false, 'should not be near limit');
});

test('isNearLimit returns true when over threshold', () => {
  // Pump bytes to exceed 60% of 800KB (480KB = 491520 bytes)
  const state = pressure.loadPressure(PRESSURE_SESSION);
  state.bytes = 500000;
  // Save directly by resetting and re-recording
  pressure.resetPressure(PRESSURE_SESSION);
  pressure.recordToolCall(PRESSURE_SESSION, 500000);

  const near = pressure.isNearLimit(PRESSURE_SESSION, 60);
  assert(near === true, 'should be near limit at 500KB');
});

// 13. checkAndNudge
test('checkAndNudge returns shouldNudge at threshold', () => {
  pressure.resetPressure(PRESSURE_SESSION);
  pressure.recordToolCall(PRESSURE_SESSION, 500000); // ~61%

  const result = pressure.checkAndNudge(PRESSURE_SESSION, 60);
  assert(result.shouldNudge === true, 'should nudge at 61%');
  assert(result.pressure.pct_estimate >= 60, 'pct should be >= 60');
});

test('checkAndNudge does not re-nudge within same band', () => {
  // Small additional bytes (still in same 10% band)
  pressure.recordToolCall(PRESSURE_SESSION, 1000);

  const result = pressure.checkAndNudge(PRESSURE_SESSION, 60);
  assert(result.shouldNudge === false, 'should not re-nudge in same band');
});

test('checkAndNudge re-nudges after 10% increase', () => {
  // Push to next band (70%+)
  pressure.recordToolCall(PRESSURE_SESSION, 100000);

  const result = pressure.checkAndNudge(PRESSURE_SESSION, 60);
  assert(result.shouldNudge === true, 'should nudge at next band');
});

// 14. resetPressure
test('resetPressure clears all counters', () => {
  pressure.resetPressure(PRESSURE_SESSION);
  const p = pressure.getPressure(PRESSURE_SESSION);
  assert(p.calls === 0, 'calls should be 0');
  assert(p.bytes === 0, 'bytes should be 0');
  assert(p.pct_estimate === 0, 'pct should be 0');
});

// 15. Percentage capped at 100
test('pct_estimate capped at 100', () => {
  pressure.recordToolCall(PRESSURE_SESSION, 2000000); // Way over capacity
  const p = pressure.getPressure(PRESSURE_SESSION);
  assert(p.pct_estimate === 100, 'pct should be capped at 100');
});

// Cleanup
pressure.deletePressure(PRESSURE_SESSION);

// =============================================================================
// SUMMARY
// =============================================================================

console.log('\n=== Results ===');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}
