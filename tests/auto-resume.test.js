#!/usr/bin/env node

/**
 * Tests for Auto-Resume Flow (Phase 3.5, Step 2)
 *
 * Verifies that the session-start hook correctly detects and loads
 * checkpoints from prior sessions, and that the restoration prompt
 * is generated with proper context.
 *
 * Run: node tests/auto-resume.test.js
 */

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

const checkpoint = require('../.claude/pilot/hooks/lib/checkpoint');

const TEST_SESSION_A = 'S-resume-a-' + Date.now().toString(36);
const TEST_SESSION_B = 'S-resume-b-' + Date.now().toString(36);

// =============================================================================
// 1. CHECKPOINT SAVE → LOAD ROUND-TRIP (simulates post-tool-use checkpoint)
// =============================================================================

console.log('=== Auto-Resume: Checkpoint Round-Trip ===\n');

test('saveCheckpoint creates loadable checkpoint', () => {
  const data = {
    task_id: 'Pilot AGI-resume-test',
    task_title: 'Resume Test Task',
    plan_step: 3,
    total_steps: 7,
    completed_steps: [
      { step: 1, description: 'Setup files', result: 'done' },
      { step: 2, description: 'Write tests', result: 'done' },
      { step: 3, description: 'Implement feature', result: 'partial' }
    ],
    key_decisions: ['Chose approach A over B', 'Skipped optional config'],
    files_modified: ['src/feature.js', 'tests/feature.test.js'],
    current_context: 'Implementing step 3: feature function halfway done',
    important_findings: ['API requires auth header', 'Rate limit is 100/min'],
    tool_call_count: 25,
    output_bytes: 120000
  };

  const result = checkpoint.saveCheckpoint(TEST_SESSION_A, data);
  assert(result.success === true, 'save should succeed');
  assert(result.version === 1, 'first save should be version 1');
});

test('loadCheckpoint returns saved data with correct fields', () => {
  const loaded = checkpoint.loadCheckpoint(TEST_SESSION_A);
  assert(loaded !== null, 'should load checkpoint');
  assert(loaded.task_id === 'Pilot AGI-resume-test', 'task_id should match');
  assert(loaded.task_title === 'Resume Test Task', 'task_title should match');
  assert(loaded.plan_step === 3, 'plan_step should be 3');
  assert(loaded.total_steps === 7, 'total_steps should be 7');
  assert(loaded.completed_steps.length === 3, 'should have 3 completed steps');
  assert(loaded.key_decisions.length === 2, 'should have 2 key decisions');
  assert(loaded.files_modified.length === 2, 'should have 2 files modified');
  assert(loaded.version === 1, 'version should be 1');
  assert(loaded.session_id === TEST_SESSION_A, 'session_id should match');
  assert(loaded.saved_at, 'saved_at should be set');
});

// =============================================================================
// 2. RESTORATION PROMPT GENERATION
// =============================================================================

console.log('\n=== Auto-Resume: Restoration Prompt ===\n');

test('buildRestorationPrompt includes all context sections', () => {
  const loaded = checkpoint.loadCheckpoint(TEST_SESSION_A);
  const prompt = checkpoint.buildRestorationPrompt(loaded);

  assert(typeof prompt === 'string', 'should be string');
  assert(prompt.includes('Checkpoint Recovery'), 'should have recovery header');
  assert(prompt.includes('Pilot AGI-resume-test'), 'should include task ID');
  assert(prompt.includes('Resume Test Task'), 'should include task title');
  assert(prompt.includes('Step 3 of 7'), 'should include progress');
  assert(prompt.includes('Completed Steps'), 'should include completed steps section');
  assert(prompt.includes('Setup files'), 'should include step description');
  assert(prompt.includes('Key Decisions'), 'should include decisions section');
  assert(prompt.includes('Chose approach A over B'), 'should include decision text');
  assert(prompt.includes('Files Modified'), 'should include files section');
  assert(prompt.includes('src/feature.js'), 'should include modified file');
  assert(prompt.includes('Important Findings'), 'should include findings section');
  assert(prompt.includes('API requires auth header'), 'should include finding text');
  assert(prompt.includes('Current Context'), 'should include context section');
  assert(prompt.includes('halfway done'), 'should include context text');
  assert(prompt.includes('Resume work'), 'should include resume instruction');
});

test('buildRestorationPrompt handles minimal checkpoint', () => {
  const minimal = {
    session_id: TEST_SESSION_B,
    version: 1,
    saved_at: new Date().toISOString(),
    task_id: 'Pilot AGI-min',
    task_title: null,
    plan_step: null,
    total_steps: null,
    completed_steps: [],
    key_decisions: [],
    files_modified: [],
    current_context: '',
    important_findings: []
  };

  const prompt = checkpoint.buildRestorationPrompt(minimal);
  assert(typeof prompt === 'string', 'should be string');
  assert(prompt.includes('Pilot AGI-min'), 'should include task ID');
  // Should NOT include sections with no data
  assert(!prompt.includes('Completed Steps'), 'should omit empty completed steps');
  assert(!prompt.includes('Key Decisions'), 'should omit empty decisions');
  assert(!prompt.includes('Files Modified'), 'should omit empty files');
  assert(!prompt.includes('Important Findings'), 'should omit empty findings');
});

test('buildRestorationPrompt returns null for null input', () => {
  const result = checkpoint.buildRestorationPrompt(null);
  assert(result === null, 'should return null');
});

// =============================================================================
// 3. CHECKPOINT VERSIONING (simulates multiple auto-checkpoints)
// =============================================================================

console.log('\n=== Auto-Resume: Checkpoint Versioning ===\n');

test('second save increments version', () => {
  const result = checkpoint.saveCheckpoint(TEST_SESSION_A, {
    task_id: 'Pilot AGI-resume-test',
    task_title: 'Resume Test Task',
    plan_step: 5,
    total_steps: 7,
    current_context: 'Now on step 5'
  });
  assert(result.success === true, 'save should succeed');
  assert(result.version === 2, 'second save should be version 2');
});

test('loadCheckpoint returns latest version', () => {
  const loaded = checkpoint.loadCheckpoint(TEST_SESSION_A);
  assert(loaded.version === 2, 'should load version 2');
  assert(loaded.plan_step === 5, 'plan_step should be 5 from latest save');
  assert(loaded.current_context === 'Now on step 5', 'context should be from latest');
});

test('checkpoint history is preserved', () => {
  const history = checkpoint.listCheckpointHistory(TEST_SESSION_A);
  assert(Array.isArray(history), 'should return array');
  assert(history.length >= 1, 'should have at least 1 archived version');
  assert(history[0].version === 1, 'first history entry should be v1');
});

// =============================================================================
// 4. CROSS-SESSION DETECTION (simulates session-start scanning)
// =============================================================================

console.log('\n=== Auto-Resume: Cross-Session Detection ===\n');

test('loadCheckpoint returns null for unknown session', () => {
  const result = checkpoint.loadCheckpoint('S-nonexistent-00000');
  assert(result === null, 'should return null for unknown session');
});

test('loadCheckpoint returns null for empty sessionId', () => {
  const result = checkpoint.loadCheckpoint('');
  assert(result === null, 'should return null for empty string');
});

test('loadCheckpoint returns null for null sessionId', () => {
  const result = checkpoint.loadCheckpoint(null);
  assert(result === null, 'should return null for null');
});

// =============================================================================
// 5. CLEANUP
// =============================================================================

console.log('\n=== Auto-Resume: Cleanup ===\n');

test('deleteCheckpoint removes checkpoint and history', () => {
  checkpoint.deleteCheckpoint(TEST_SESSION_A);
  const loaded = checkpoint.loadCheckpoint(TEST_SESSION_A);
  assert(loaded === null, 'checkpoint should be deleted');

  const history = checkpoint.listCheckpointHistory(TEST_SESSION_A);
  assert(history.length === 0, 'history should be empty after delete');
});

test('deleteCheckpoint handles non-existent session gracefully', () => {
  // Should not throw
  checkpoint.deleteCheckpoint('S-nonexistent-cleanup');
});

// =============================================================================
// RESULTS
// =============================================================================

console.log('\n---');
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
console.log('---');

if (failed > 0) {
  process.exit(1);
}
