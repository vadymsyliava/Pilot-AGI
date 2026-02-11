#!/usr/bin/env node

/**
 * Integration Test: Autonomous Context Window Management (Phase 3.5, Step 6)
 *
 * End-to-end test covering the full autonomous flow:
 *   checkpoint → restore → PM monitoring → PM self-checkpoint
 *
 * Run: node tests/integration/autonomy-e2e.test.js
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

const checkpoint = require('../../.claude/pilot/hooks/lib/checkpoint');
const contextGatherer = require('../../.claude/pilot/hooks/lib/context-gatherer');
const pmMonitor = require('../../.claude/pilot/hooks/lib/pm-pressure-monitor');
const pressure = require('../../.claude/pilot/hooks/lib/pressure');
const injector = require('../../.claude/pilot/hooks/lib/stdin-injector');

const AGENT_SESSION = 'S-e2e-agent-' + Date.now().toString(36);
const PM_SESSION = 'S-e2e-pm-' + Date.now().toString(36);

// =============================================================================
// SCENARIO 1: Agent auto-checkpoint → resume cycle
// =============================================================================

console.log('=== E2E: Agent Checkpoint → Resume Cycle ===\n');

test('1a. Agent gathers context and saves checkpoint', () => {
  const data = contextGatherer.gatherCheckpointContext(AGENT_SESSION);
  data.task_id = 'Pilot AGI-e2e-test';
  data.task_title = 'E2E Integration Test';
  data.plan_step = 4;
  data.total_steps = 8;
  data.completed_steps = [
    { step: 1, description: 'Setup', result: 'done' },
    { step: 2, description: 'Write code', result: 'done' },
    { step: 3, description: 'Test', result: 'done' },
    { step: 4, description: 'Refactor', result: 'in-progress' }
  ];
  data.key_decisions = ['Used pattern X', 'Skipped Y'];
  data.current_context = 'Refactoring module Z';

  const result = checkpoint.saveCheckpoint(AGENT_SESSION, data);
  assert(result.success === true, 'checkpoint save should succeed');
  assert(result.version === 1, 'should be version 1');
});

test('1b. Checkpoint can be loaded by session ID', () => {
  const loaded = checkpoint.loadCheckpoint(AGENT_SESSION);
  assert(loaded !== null, 'should find checkpoint');
  assert(loaded.task_id === 'Pilot AGI-e2e-test', 'task_id should match');
  assert(loaded.plan_step === 4, 'plan_step should be 4');
});

test('1c. Restoration prompt contains full recovery context', () => {
  const loaded = checkpoint.loadCheckpoint(AGENT_SESSION);
  const prompt = checkpoint.buildRestorationPrompt(loaded);

  assert(prompt.includes('Checkpoint Recovery'), 'has recovery header');
  assert(prompt.includes('Pilot AGI-e2e-test'), 'has task ID');
  assert(prompt.includes('E2E Integration Test'), 'has task title');
  assert(prompt.includes('Step 4 of 8'), 'has progress');
  assert(prompt.includes('Setup'), 'has completed step 1');
  assert(prompt.includes('Used pattern X'), 'has key decision');
  assert(prompt.includes('Refactoring module Z'), 'has current context');
  assert(prompt.includes('Resume work'), 'has resume instruction');
});

test('1d. Second checkpoint increments version', () => {
  const data = contextGatherer.gatherCheckpointContext(AGENT_SESSION);
  data.task_id = 'Pilot AGI-e2e-test';
  data.plan_step = 5;
  data.total_steps = 8;
  data.current_context = 'Now on step 5';

  const result = checkpoint.saveCheckpoint(AGENT_SESSION, data);
  assert(result.version === 2, 'version should be 2');

  const loaded = checkpoint.loadCheckpoint(AGENT_SESSION);
  assert(loaded.plan_step === 5, 'should load latest (step 5)');
});

test('1e. Checkpoint history preserved', () => {
  const history = checkpoint.listCheckpointHistory(AGENT_SESSION);
  assert(history.length >= 1, 'should have archived v1');
  assert(history[0].version === 1, 'first archived should be v1');
});

// =============================================================================
// SCENARIO 2: PM pressure monitoring
// =============================================================================

console.log('\n=== E2E: PM Pressure Monitoring ===\n');

test('2a. PM can scan all agent pressures', () => {
  const result = pmMonitor.checkAllAgentPressure(process.cwd());
  assert(typeof result === 'object', 'should return object');
  assert(Array.isArray(result.alerts), 'should have alerts array');
  assert(typeof result.healthy === 'number', 'should have healthy count');
});

test('2b. PM nudge threshold is 70%', () => {
  assert(pmMonitor.PM_NUDGE_THRESHOLD === 70, 'threshold should be 70');
});

// =============================================================================
// SCENARIO 3: PM self-checkpoint
// =============================================================================

console.log('\n=== E2E: PM Self-Checkpoint ===\n');

test('3a. PM gathers its own orchestrator state', () => {
  const data = pmMonitor.buildPmCheckpointData(process.cwd());
  assert(data.task_id === 'PM-orchestrator', 'task_id should be PM-orchestrator');
  assert(data.key_decisions.length >= 2, 'should have at least 2 state entries');
});

test('3b. PM saves and loads its own checkpoint', () => {
  const result = pmMonitor.savePmCheckpoint(process.cwd(), PM_SESSION);
  assert(result.success === true, 'PM checkpoint save should succeed');

  const loaded = checkpoint.loadCheckpoint(PM_SESSION);
  assert(loaded !== null, 'should load PM checkpoint');
  assert(loaded.task_id === 'PM-orchestrator', 'task_id should match');
});

test('3c. PM restoration prompt is valid', () => {
  const loaded = checkpoint.loadCheckpoint(PM_SESSION);
  const prompt = checkpoint.buildRestorationPrompt(loaded);
  assert(prompt.includes('PM-orchestrator'), 'should include PM task ID');
  assert(prompt.includes('Key Decisions'), 'should include decisions section');
});

// =============================================================================
// SCENARIO 4: Compact request handling
// =============================================================================

console.log('\n=== E2E: Compact Request Handling ===\n');

test('4a. compact_request action produces valid prompt', () => {
  const prompt = injector.actionToPrompt({
    type: 'compact_request',
    data: {
      session_id: AGENT_SESSION,
      pressure_pct: 65
    }
  });
  assert(typeof prompt === 'string', 'should produce a prompt string');
  assert(prompt.includes(AGENT_SESSION), 'should reference session');
  assert(prompt.includes('65'), 'should include pressure percentage');
  assert(prompt.toLowerCase().includes('compact'), 'should mention compact');
});

// =============================================================================
// SCENARIO 5: Full cycle — checkpoint → delete → verify gone
// =============================================================================

console.log('\n=== E2E: Full Lifecycle ===\n');

test('5a. Agent checkpoint lifecycle: save → load → delete → verify', () => {
  const testSession = 'S-e2e-lifecycle-' + Date.now().toString(36);

  // Save
  const saveResult = checkpoint.saveCheckpoint(testSession, {
    task_id: 'Pilot AGI-lifecycle',
    current_context: 'lifecycle test'
  });
  assert(saveResult.success === true, 'save should succeed');

  // Load
  const loaded = checkpoint.loadCheckpoint(testSession);
  assert(loaded !== null, 'should load');
  assert(loaded.task_id === 'Pilot AGI-lifecycle', 'data should match');

  // Delete
  checkpoint.deleteCheckpoint(testSession);

  // Verify gone
  const gone = checkpoint.loadCheckpoint(testSession);
  assert(gone === null, 'should be deleted');
});

test('5b. Context gatherer produces consistent data structure', () => {
  const data = contextGatherer.gatherCheckpointContext('S-nonexistent');
  // Even with no session file, should return valid structure
  assert(typeof data.task_id === 'string' || data.task_id === null, 'task_id valid');
  assert(Array.isArray(data.files_modified), 'files_modified is array');
  assert(Array.isArray(data.key_decisions), 'key_decisions is array');
  assert(typeof data.tool_call_count === 'number', 'tool_call_count is number');
  assert(typeof data.output_bytes === 'number', 'output_bytes is number');
});

// =============================================================================
// CLEANUP
// =============================================================================

try {
  checkpoint.deleteCheckpoint(AGENT_SESSION);
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
