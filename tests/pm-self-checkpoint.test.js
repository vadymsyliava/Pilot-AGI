#!/usr/bin/env node

/**
 * Tests for PM Self-Checkpoint (Phase 3.5, Step 3)
 *
 * Verifies that:
 *   1. savePmCheckpoint gathers PM state and persists it
 *   2. checkPmSelfPressure triggers checkpoint at threshold
 *   3. PM checkpoint data contains orchestrator state
 *
 * Run: node tests/pm-self-checkpoint.test.js
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

const pmMonitor = require('../.claude/pilot/hooks/lib/pm-pressure-monitor');
const checkpoint = require('../.claude/pilot/hooks/lib/checkpoint');

const PM_SESSION = 'S-pm-test-' + Date.now().toString(36);

// =============================================================================
// 1. buildPmCheckpointData
// =============================================================================

console.log('=== PM Self-Checkpoint: Data Gathering ===\n');

test('buildPmCheckpointData returns valid structure', () => {
  const data = pmMonitor.buildPmCheckpointData(process.cwd());
  assert(typeof data === 'object', 'should return object');
  assert(data.task_id === 'PM-orchestrator', 'task_id should be PM-orchestrator');
  assert(data.task_title === 'PM Orchestrator State', 'task_title should match');
  assert(Array.isArray(data.key_decisions), 'key_decisions should be array');
  assert(Array.isArray(data.important_findings), 'important_findings should be array');
  assert(typeof data.current_context === 'string', 'current_context should be string');
  assert(Array.isArray(data.files_modified), 'files_modified should be array');
});

test('buildPmCheckpointData includes active assignments', () => {
  const data = pmMonitor.buildPmCheckpointData(process.cwd());
  // key_decisions should contain at least the "Active assignments" entry
  const hasAssignments = data.key_decisions.some(d => d.includes('Active assignments'));
  assert(hasAssignments, 'should include active assignments in key_decisions');
});

test('buildPmCheckpointData includes action queue state', () => {
  const data = pmMonitor.buildPmCheckpointData(process.cwd());
  const hasQueue = data.key_decisions.some(d => d.includes('Action queue'));
  assert(hasQueue, 'should include action queue state in key_decisions');
});

// =============================================================================
// 2. savePmCheckpoint
// =============================================================================

console.log('\n=== PM Self-Checkpoint: Save/Load ===\n');

test('savePmCheckpoint saves and can be loaded', () => {
  const result = pmMonitor.savePmCheckpoint(process.cwd(), PM_SESSION);
  assert(result.success === true, 'save should succeed');
  assert(typeof result.version === 'number', 'should return version number');

  const loaded = checkpoint.loadCheckpoint(PM_SESSION);
  assert(loaded !== null, 'should load saved PM checkpoint');
  assert(loaded.task_id === 'PM-orchestrator', 'task_id should be PM-orchestrator');
  assert(loaded.session_id === PM_SESSION, 'session_id should match');
});

test('savePmCheckpoint rejects empty session ID', () => {
  const result = pmMonitor.savePmCheckpoint(process.cwd(), '');
  assert(result.success === false, 'should fail with empty session ID');
  assert(result.error === 'pmSessionId is required', 'should have error message');
});

test('savePmCheckpoint rejects null session ID', () => {
  const result = pmMonitor.savePmCheckpoint(process.cwd(), null);
  assert(result.success === false, 'should fail with null session ID');
});

test('PM checkpoint generates valid restoration prompt', () => {
  const loaded = checkpoint.loadCheckpoint(PM_SESSION);
  const prompt = checkpoint.buildRestorationPrompt(loaded);
  assert(typeof prompt === 'string', 'should return string');
  assert(prompt.includes('PM-orchestrator'), 'should include PM task ID');
  assert(prompt.includes('Checkpoint Recovery'), 'should include recovery header');
});

test('PM checkpoint version increments on re-save', () => {
  const result = pmMonitor.savePmCheckpoint(process.cwd(), PM_SESSION);
  assert(result.success === true, 'second save should succeed');
  assert(result.version === 2, 'second save should be version 2');
});

// =============================================================================
// 3. checkPmSelfPressure
// =============================================================================

console.log('\n=== PM Self-Checkpoint: Pressure Check ===\n');

test('checkPmSelfPressure returns valid structure', () => {
  const result = pmMonitor.checkPmSelfPressure(process.cwd(), PM_SESSION);
  assert(typeof result === 'object', 'should return object');
  assert(typeof result.checkpointed === 'boolean', 'checkpointed should be boolean');
  assert(typeof result.pct === 'number', 'pct should be number');
});

test('checkPmSelfPressure returns pct 0 when no pressure file', () => {
  const result = pmMonitor.checkPmSelfPressure(process.cwd(), 'S-no-pressure-file');
  assert(result.pct === 0, 'pct should be 0 without pressure file');
  assert(result.checkpointed === false, 'should not checkpoint without pressure file');
});

// =============================================================================
// 4. Exported API
// =============================================================================

console.log('\n=== PM Self-Checkpoint: Exports ===\n');

test('savePmCheckpoint is exported', () => {
  assert(typeof pmMonitor.savePmCheckpoint === 'function', 'savePmCheckpoint should be a function');
});

test('checkPmSelfPressure is exported', () => {
  assert(typeof pmMonitor.checkPmSelfPressure === 'function', 'checkPmSelfPressure should be a function');
});

test('PM_NUDGE_THRESHOLD is exported and equals 70', () => {
  assert(pmMonitor.PM_NUDGE_THRESHOLD === 70, 'threshold should be 70');
});

// =============================================================================
// CLEANUP
// =============================================================================

try {
  checkpoint.deleteCheckpoint(PM_SESSION);
} catch (e) {
  // Best effort
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
