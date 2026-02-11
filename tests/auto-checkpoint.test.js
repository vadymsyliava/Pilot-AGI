#!/usr/bin/env node

/**
 * Verification tests for Autonomous Context Window Management (Phase 3.5)
 *
 * Tests:
 *   1. context-gatherer: programmatic context inference
 *   2. pm-pressure-monitor: cross-agent pressure scanning
 *   3. session-start auto-resume: checkpoint detection
 *   4. stdin-injector compact_request: action type handling
 *
 * Run: node tests/auto-checkpoint.test.js
 */

const fs = require('fs');
const path = require('path');
const checkpoint = require('../.claude/pilot/hooks/lib/checkpoint');

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

// =============================================================================
// 1. CONTEXT GATHERER TESTS
// =============================================================================

console.log('=== Context Gatherer Tests ===\n');

const contextGatherer = require('../.claude/pilot/hooks/lib/context-gatherer');

test('gatherCheckpointContext returns valid structure', () => {
  const data = contextGatherer.gatherCheckpointContext('S-test-nonexistent');
  assert(data !== null, 'should return object');
  assert(data.task_id === null || typeof data.task_id === 'string', 'task_id should be null or string');
  assert(Array.isArray(data.files_modified), 'files_modified should be array');
  assert(Array.isArray(data.key_decisions), 'key_decisions should be array');
  assert(Array.isArray(data.completed_steps), 'completed_steps should be array');
  assert(typeof data.current_context === 'string', 'current_context should be string');
  assert(typeof data.tool_call_count === 'number', 'tool_call_count should be number');
  assert(typeof data.output_bytes === 'number', 'output_bytes should be number');
});

test('getModifiedFiles returns array', () => {
  const files = contextGatherer.getModifiedFiles();
  assert(Array.isArray(files), 'should return array');
  // Should be capped at 20
  assert(files.length <= 20, 'should cap at 20 files');
});

test('getRecentCommitMessages returns array of strings', () => {
  const msgs = contextGatherer.getRecentCommitMessages(3);
  assert(Array.isArray(msgs), 'should return array');
  for (const m of msgs) {
    assert(typeof m === 'string', 'each message should be string');
    assert(m.length <= 200, 'message should be capped at 200 chars');
  }
});

test('buildContextSummary produces readable text', () => {
  const data = {
    task_id: 'Pilot AGI-test',
    task_title: 'Test Task',
    plan_step: 3,
    total_steps: 7,
    files_modified: ['file1.js', 'file2.js'],
    tool_call_count: 42,
    output_bytes: 50000
  };
  const summary = contextGatherer.buildContextSummary(data);
  assert(typeof summary === 'string', 'should be string');
  assert(summary.includes('Pilot AGI-test'), 'should mention task ID');
  assert(summary.includes('step 3 of 7'), 'should mention progress');
  assert(summary.includes('2 file(s)'), 'should mention file count');
});

test('getTaskFromSession returns null or task for unknown session', () => {
  const result = contextGatherer.getTaskFromSession('S-nonexistent-0000');
  // May find a task via bd fallback if any tasks are in_progress
  assert(result === null || (typeof result === 'object' && result.task_id), 'should return null or valid task object');
});

test('getPlanProgress returns null when no capsule exists', () => {
  const result = contextGatherer.getPlanProgress('Pilot AGI-nonexistent');
  // May return null or actual data depending on if runs/ has content
  assert(result === null || typeof result === 'object', 'should return null or object');
});

// =============================================================================
// 2. PM PRESSURE MONITOR TESTS
// =============================================================================

console.log('\n=== PM Pressure Monitor Tests ===\n');

const pmMonitor = require('../.claude/pilot/hooks/lib/pm-pressure-monitor');

test('checkAllAgentPressure returns valid structure', () => {
  const result = pmMonitor.checkAllAgentPressure(process.cwd());
  assert(typeof result === 'object', 'should return object');
  assert(Array.isArray(result.alerts), 'alerts should be array');
  assert(typeof result.healthy === 'number', 'healthy should be number');
});

test('PM_NUDGE_THRESHOLD is 70', () => {
  assert(pmMonitor.PM_NUDGE_THRESHOLD === 70, 'should be 70');
});

test('buildPmCheckpointData returns valid checkpoint data', () => {
  const data = pmMonitor.buildPmCheckpointData(process.cwd());
  assert(typeof data === 'object', 'should return object');
  assert(data.task_id === 'PM-orchestrator', 'task_id should be PM-orchestrator');
  assert(Array.isArray(data.key_decisions), 'key_decisions should be array');
  assert(Array.isArray(data.important_findings), 'important_findings should be array');
  assert(typeof data.current_context === 'string', 'current_context should be string');
});

// =============================================================================
// 2b. PM SELF-CHECKPOINT TESTS
// =============================================================================

console.log('\n=== PM Self-Checkpoint Tests ===\n');

test('savePmCheckpoint saves PM orchestrator state', () => {
  const PM_TEST_SESSION = 'S-test-pm-' + Date.now().toString(36);
  const result = pmMonitor.savePmCheckpoint(process.cwd(), PM_TEST_SESSION);
  assert(result.success === true, 'should save successfully');
  assert(typeof result.version === 'number', 'should return version number');

  // Verify the saved data
  const loaded = checkpoint.loadCheckpoint(PM_TEST_SESSION);
  assert(loaded !== null, 'should load PM checkpoint');
  assert(loaded.task_id === 'PM-orchestrator', 'task_id should be PM-orchestrator');
  assert(loaded.task_title === 'PM Orchestrator State', 'title should be PM state');

  // Cleanup
  try { checkpoint.deleteCheckpoint(PM_TEST_SESSION); } catch (e) {}
});

test('savePmCheckpoint rejects missing sessionId', () => {
  const result = pmMonitor.savePmCheckpoint(process.cwd(), '');
  assert(result.success === false, 'should fail without sessionId');
});

test('checkPmSelfPressure returns valid structure', () => {
  const result = pmMonitor.checkPmSelfPressure(process.cwd(), 'S-test-nonexistent');
  assert(typeof result === 'object', 'should return object');
  assert(typeof result.checkpointed === 'boolean', 'checkpointed should be boolean');
  assert(typeof result.pct === 'number', 'pct should be number');
});

test('checkPmSelfPressure exported correctly', () => {
  assert(typeof pmMonitor.checkPmSelfPressure === 'function', 'checkPmSelfPressure should be exported');
  assert(typeof pmMonitor.savePmCheckpoint === 'function', 'savePmCheckpoint should be exported');
});

// =============================================================================
// 2c. AUTO-RESUME (SESSION-START) TESTS
// =============================================================================

console.log('\n=== Auto-Resume Tests ===\n');

test('checkpoint.loadCheckpoint returns null for unknown session', () => {
  const result = checkpoint.loadCheckpoint('S-nonexistent-0000');
  assert(result === null, 'should return null for unknown session');
});

test('checkpoint save then load round-trip preserves restoration fields', () => {
  const RESUME_SESSION = 'S-test-resume-' + Date.now().toString(36);
  const saveData = {
    task_id: 'Pilot AGI-resume-test',
    task_title: 'Resume Flow Test',
    plan_step: 3,
    total_steps: 5,
    completed_steps: [
      { step: 1, description: 'Init', result: 'done' },
      { step: 2, description: 'Build', result: 'done' }
    ],
    files_modified: ['src/a.js', 'src/b.js'],
    current_context: 'Testing auto-resume restoration',
    key_decisions: ['Use checkpoint v2 format'],
    important_findings: ['Found edge case in pressure calc']
  };

  checkpoint.saveCheckpoint(RESUME_SESSION, saveData);
  const loaded = checkpoint.loadCheckpoint(RESUME_SESSION);

  assert(loaded !== null, 'should load');
  assert(loaded.task_id === 'Pilot AGI-resume-test', 'task_id preserved');
  assert(loaded.plan_step === 3, 'plan_step preserved');
  assert(loaded.total_steps === 5, 'total_steps preserved');
  assert(loaded.completed_steps.length === 2, 'completed_steps preserved');
  assert(loaded.files_modified.length === 2, 'files_modified preserved');
  assert(loaded.key_decisions.length === 1, 'key_decisions preserved');

  // Verify buildRestorationPrompt includes all context
  const prompt = checkpoint.buildRestorationPrompt(loaded);
  assert(prompt.includes('Pilot AGI-resume-test'), 'prompt includes task ID');
  assert(prompt.includes('Resume Flow Test'), 'prompt includes title');
  assert(prompt.includes('Step 3'), 'prompt includes plan step');
  assert(prompt.includes('src/a.js'), 'prompt includes files');

  try { checkpoint.deleteCheckpoint(RESUME_SESSION); } catch (e) {}
});

// =============================================================================
// 3. STDIN-INJECTOR COMPACT REQUEST TEST
// =============================================================================

console.log('\n=== Stdin Injector compact_request Tests ===\n');

const injector = require('../.claude/pilot/hooks/lib/stdin-injector');

test('actionToPrompt handles compact_request', () => {
  const prompt = injector.actionToPrompt({
    type: 'compact_request',
    data: {
      session_id: 'S-test-123',
      pressure_pct: 65
    }
  });
  assert(typeof prompt === 'string', 'should return string');
  assert(prompt.includes('S-test-123'), 'should include session ID');
  assert(prompt.includes('65'), 'should include pressure percentage');
  assert(prompt.includes('compact'), 'should mention compact');
});

// =============================================================================
// 4. CHECKPOINT SAVE/LOAD ROUND-TRIP WITH AUTO-GATHERED DATA
// =============================================================================

console.log('\n=== Auto-Checkpoint Round-Trip Tests ===\n');

const TEST_SESSION = 'S-test-autocp-' + Date.now().toString(36);

test('auto-gathered data can be saved and loaded', () => {
  const data = contextGatherer.gatherCheckpointContext(TEST_SESSION);
  // Override with known values for testing
  data.task_id = 'Pilot AGI-test';
  data.task_title = 'Auto-Checkpoint Test';
  data.current_context = 'Testing auto-checkpoint round-trip';

  const result = checkpoint.saveCheckpoint(TEST_SESSION, data);
  assert(result.success === true, 'save should succeed');
  assert(result.version === 1, 'first version should be 1');

  const loaded = checkpoint.loadCheckpoint(TEST_SESSION);
  assert(loaded !== null, 'should load saved checkpoint');
  assert(loaded.task_id === 'Pilot AGI-test', 'task_id should match');
  assert(loaded.task_title === 'Auto-Checkpoint Test', 'task_title should match');
  assert(loaded.current_context === 'Testing auto-checkpoint round-trip', 'context should match');
  assert(loaded.version === 1, 'version should be 1');
});

test('buildRestorationPrompt works with auto-gathered checkpoint', () => {
  const loaded = checkpoint.loadCheckpoint(TEST_SESSION);
  assert(loaded !== null, 'checkpoint should exist');

  const prompt = checkpoint.buildRestorationPrompt(loaded);
  assert(typeof prompt === 'string', 'should return string');
  assert(prompt.includes('Pilot AGI-test'), 'should include task ID');
  assert(prompt.includes('Auto-Checkpoint Test'), 'should include task title');
  assert(prompt.includes('Checkpoint Recovery'), 'should include header');
});

// Cleanup test checkpoint
try {
  checkpoint.deleteCheckpoint(TEST_SESSION);
} catch (e) {
  // Best effort cleanup
}

// =============================================================================
// RESULTS
// =============================================================================

console.log('\n---');
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
console.log('---');

if (failed > 0) {
  process.exit(1);
}
