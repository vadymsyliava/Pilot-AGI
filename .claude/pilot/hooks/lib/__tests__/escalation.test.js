/**
 * Tests for escalation.js — Auto-Escalation Engine (Phase 3.12)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/escalation.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Test helpers
let testDir;
const origCwd = process.cwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'esc-test-'));

  // Create required directory structure
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/escalations'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/human-escalations'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/messages'), { recursive: true });

  // Mock process.cwd
  process.cwd = () => testDir;
}

function teardown() {
  process.cwd = origCwd;
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModule() {
  // Clear require cache for our modules
  const modulesToClear = [
    'escalation.js',
    'messaging.js',
    'agent-context.js',
    'recovery.js',
    'policy.js',
    'session.js',
    'cost-tracker.js'
  ];
  for (const key of Object.keys(require.cache)) {
    for (const mod of modulesToClear) {
      if (key.includes(mod)) {
        delete require.cache[key];
      }
    }
  }
  return require('../escalation');
}

// ============================================================================
// TESTS
// ============================================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  setup();
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  } finally {
    teardown();
  }
}

console.log('\nEscalation Engine Tests');
console.log('='.repeat(60));

// ---------- Policy Loading ----------

console.log('\n  Policy Loading');

test('loadEscalationPolicy returns defaults when no policy.yaml', () => {
  const esc = freshModule();
  const policy = esc.loadEscalationPolicy();

  assert.strictEqual(policy.enabled, true);
  assert.ok(policy.paths.drift);
  assert.ok(policy.paths.test_failure);
  assert.ok(policy.paths.budget_exceeded);
  assert.ok(policy.paths.merge_conflict);
  assert.ok(policy.paths.agent_unresponsive);
  assert.strictEqual(policy.scan_interval_sec, 60);
});

test('loadEscalationPolicy reads from policy.yaml', () => {
  // Create minimal policy.yaml with escalation section
  fs.mkdirSync(path.join(testDir, '.claude/pilot'), { recursive: true });
  fs.writeFileSync(path.join(testDir, '.claude/pilot/policy.yaml'), [
    'version: "2.0"',
    'orchestrator:',
    '  escalation:',
    '    enabled: true',
    '    scan_interval_sec: 30',
    '    paths:',
    '      drift:',
    '        levels:',
    '          - warning',
    '          - human',
    '        cooldown_sec: 60',
    '        auto_deescalate: false',
    ''
  ].join('\n'));
  const esc = freshModule();
  const policy = esc.loadEscalationPolicy();

  assert.strictEqual(policy.enabled, true);
  assert.strictEqual(policy.scan_interval_sec, 30);
  assert.deepStrictEqual(policy.paths.drift.levels, ['warning', 'human']);
  assert.strictEqual(policy.paths.drift.cooldown_sec, 60);
  assert.strictEqual(policy.paths.drift.auto_deescalate, false);
  // Other paths should be defaults
  assert.ok(policy.paths.test_failure);
});

test('loadEscalationPolicy respects enabled: false', () => {
  fs.mkdirSync(path.join(testDir, '.claude/pilot'), { recursive: true });
  fs.writeFileSync(path.join(testDir, '.claude/pilot/policy.yaml'), `
version: "2.0"
orchestrator:
  escalation:
    enabled: false
`);
  const esc = freshModule();
  const policy = esc.loadEscalationPolicy();
  assert.strictEqual(policy.enabled, false);
});

// ---------- Event Key ----------

console.log('\n  Event Key');

test('buildEventKey combines type, session, and task', () => {
  const esc = freshModule();
  const key = esc.buildEventKey('drift', 'S-abc123', 'TASK-1');
  assert.strictEqual(key, 'drift:S-abc123:TASK-1');
});

test('buildEventKey works without taskId', () => {
  const esc = freshModule();
  const key = esc.buildEventKey('agent_unresponsive', 'S-abc123');
  assert.strictEqual(key, 'agent_unresponsive:S-abc123');
});

// ---------- Trigger Escalation ----------

console.log('\n  Trigger Escalation');

test('triggerEscalation creates initial state at level 0', () => {
  const esc = freshModule();
  const result = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1', { score: 0.5 });

  assert.strictEqual(result.level, 'warning');
  assert.strictEqual(result.level_index, 0);
  assert.strictEqual(result.first_time, true);
  assert.strictEqual(result.escalated, false);
  assert.ok(result.eventKey);

  // Verify state file was created
  const state = esc.getEscalationState(result.eventKey);
  assert.ok(state);
  assert.strictEqual(state.level, 'warning');
  assert.strictEqual(state.resolved, false);
});

test('triggerEscalation stays at current level during cooldown', () => {
  const esc = freshModule();

  // First trigger
  const r1 = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');
  assert.strictEqual(r1.level, 'warning');

  // Immediate re-trigger (within cooldown)
  const r2 = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');
  assert.strictEqual(r2.level, 'warning');
  assert.strictEqual(r2.escalated, false);
  assert.strictEqual(r2.first_time, false);
});

test('triggerEscalation escalates after cooldown passes', () => {
  const esc = freshModule();

  // First trigger
  const r1 = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');
  assert.strictEqual(r1.level, 'warning');

  // Manually backdate the last_escalated to simulate cooldown passing
  const state = esc.getEscalationState(r1.eventKey);
  state.last_escalated = new Date(Date.now() - 200000).toISOString(); // 200s ago
  const statePath = esc.getEscalationStatePath(r1.eventKey);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  // Re-trigger — should escalate
  const r2 = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');
  assert.strictEqual(r2.level, 'block');
  assert.strictEqual(r2.level_index, 1);
  assert.strictEqual(r2.escalated, true);
});

test('triggerEscalation caps at max level', () => {
  const esc = freshModule();

  // Agent unresponsive path: warning → reassign → human
  const r1 = esc.triggerEscalation('agent_unresponsive', 'S-agent1', 'TASK-1');
  assert.strictEqual(r1.level, 'warning');

  // Backdate and escalate twice
  for (let i = 0; i < 3; i++) {
    const state = esc.getEscalationState(r1.eventKey);
    state.last_escalated = new Date(Date.now() - 60000).toISOString();
    fs.writeFileSync(esc.getEscalationStatePath(r1.eventKey), JSON.stringify(state, null, 2));
    esc.triggerEscalation('agent_unresponsive', 'S-agent1', 'TASK-1');
  }

  const finalState = esc.getEscalationState(r1.eventKey);
  assert.strictEqual(finalState.level, 'human');
});

test('triggerEscalation returns noop when disabled', () => {
  fs.mkdirSync(path.join(testDir, '.claude/pilot'), { recursive: true });
  fs.writeFileSync(path.join(testDir, '.claude/pilot/policy.yaml'), `
version: "2.0"
orchestrator:
  escalation:
    enabled: false
`);
  const esc = freshModule();
  const result = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');
  assert.strictEqual(result.action, 'noop');
  assert.strictEqual(result.level, 'disabled');
});

test('triggerEscalation re-triggers after resolution', () => {
  const esc = freshModule();

  const r1 = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');
  assert.strictEqual(r1.level, 'warning');

  // Resolve it
  esc.resolveEscalation(r1.eventKey, 'test');

  // Re-trigger — should start fresh at level 0
  const r2 = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');
  assert.strictEqual(r2.level, 'warning');
  assert.strictEqual(r2.first_time, true);
  assert.strictEqual(r2.level_index, 0);
});

// ---------- Execute Actions ----------

console.log('\n  Execute Actions');

test('executeAction warning sends notification (dry run)', () => {
  const esc = freshModule();
  const result = esc.executeAction('warning', {
    eventType: 'drift',
    sessionId: 'S-agent1',
    taskId: 'TASK-1',
    pmSessionId: 'S-pm',
    context: {},
    dryRun: true
  });
  assert.strictEqual(result.dry_run, true);
  assert.strictEqual(result.action, 'warning');
});

test('executeAction block creates block marker (dry run)', () => {
  const esc = freshModule();
  const result = esc.executeAction('block', {
    eventType: 'drift',
    sessionId: 'S-agent1',
    taskId: 'TASK-1',
    pmSessionId: 'S-pm',
    context: {},
    dryRun: true
  });
  assert.strictEqual(result.dry_run, true);
  assert.strictEqual(result.action, 'block');
});

test('executeAction reassign returns no_task_id when taskId missing', () => {
  const esc = freshModule();
  const result = esc.executeAction('reassign', {
    eventType: 'drift',
    sessionId: 'S-agent1',
    taskId: null,
    pmSessionId: 'S-pm',
    context: {},
    dryRun: false
  });
  assert.strictEqual(result.executed, false);
  assert.strictEqual(result.reason, 'no_task_id');
});

test('executeAction human (dry run)', () => {
  const esc = freshModule();
  const result = esc.executeAction('human', {
    eventType: 'budget_exceeded',
    sessionId: 'S-agent1',
    taskId: 'TASK-1',
    pmSessionId: 'S-pm',
    context: {},
    dryRun: true
  });
  assert.strictEqual(result.dry_run, true);
  assert.strictEqual(result.action, 'human');
});

test('executeAction unknown action returns failure', () => {
  const esc = freshModule();
  const result = esc.executeAction('unknown_level', {
    eventType: 'drift',
    sessionId: 'S-agent1',
    taskId: 'TASK-1',
    pmSessionId: 'S-pm',
    context: {},
    dryRun: false
  });
  assert.strictEqual(result.executed, false);
  assert.strictEqual(result.reason, 'unknown_action');
});

// ---------- Resolution & De-escalation ----------

console.log('\n  Resolution & De-escalation');

test('resolveEscalation marks state as resolved', () => {
  const esc = freshModule();

  const r1 = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');
  const resolved = esc.resolveEscalation(r1.eventKey, 'test_agent');

  assert.strictEqual(resolved, true);

  const state = esc.getEscalationState(r1.eventKey);
  assert.strictEqual(state.resolved, true);
  assert.ok(state.resolved_at);
  assert.strictEqual(state.resolved_by, 'test_agent');
});

test('resolveEscalation returns false for nonexistent key', () => {
  const esc = freshModule();
  const resolved = esc.resolveEscalation('nonexistent:key');
  assert.strictEqual(resolved, false);
});

test('resolveEscalation returns false for already resolved', () => {
  const esc = freshModule();

  const r1 = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');
  esc.resolveEscalation(r1.eventKey, 'first');
  const second = esc.resolveEscalation(r1.eventKey, 'second');
  assert.strictEqual(second, false);
});

test('checkAutoDeescalation resolves events where condition cleared', () => {
  const esc = freshModule();

  // Trigger drift escalation
  const r1 = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1', { score: 0.5 });
  assert.strictEqual(r1.level, 'warning');

  // Condition checker says drift is gone
  const deescalated = esc.checkAutoDeescalation((eventType, sid, taskId) => {
    return false; // Issue no longer exists
  });

  assert.strictEqual(deescalated.length, 1);
  // The returned key comes from getActiveEscalations which uses sanitized filenames
  // (colons replaced with underscores), so just check it contains the right parts
  assert.ok(deescalated[0].includes('drift'));
  assert.ok(deescalated[0].includes('S-agent1'));

  // Verify state is resolved
  const state = esc.getEscalationState(r1.eventKey);
  assert.strictEqual(state.resolved, true);
  assert.strictEqual(state.resolved_by, 'auto_deescalation');
});

test('checkAutoDeescalation does not resolve non-auto-deescalate events', () => {
  const esc = freshModule();

  // Budget exceeded has auto_deescalate: false
  const r1 = esc.triggerEscalation('budget_exceeded', 'S-agent1', 'TASK-1');

  const deescalated = esc.checkAutoDeescalation((eventType, sid, taskId) => {
    return false; // Issue gone
  });

  assert.strictEqual(deescalated.length, 0);

  // Budget escalation should still be active
  const state = esc.getEscalationState(r1.eventKey);
  assert.strictEqual(state.resolved, false);
});

test('checkAutoDeescalation keeps escalation when condition still exists', () => {
  const esc = freshModule();

  const r1 = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');

  const deescalated = esc.checkAutoDeescalation((eventType, sid, taskId) => {
    return true; // Issue still exists
  });

  assert.strictEqual(deescalated.length, 0);

  const state = esc.getEscalationState(r1.eventKey);
  assert.strictEqual(state.resolved, false);
});

// ---------- Block Check ----------

console.log('\n  Block Check');

test('isAgentBlocked returns false when no block marker', () => {
  const esc = freshModule();
  const result = esc.isAgentBlocked('S-agent1');
  assert.strictEqual(result.blocked, false);
});

test('isAgentBlocked returns true when block marker exists', () => {
  const esc = freshModule();

  // Write a block marker
  const blockPath = path.join(testDir, '.claude/pilot/state/escalations', 'block_S-agent1');
  fs.writeFileSync(blockPath, JSON.stringify({
    blocked_at: new Date().toISOString(),
    reason: 'drift',
    task_id: 'TASK-1',
    message: 'Agent blocked due to drift'
  }));

  const result = esc.isAgentBlocked('S-agent1');
  assert.strictEqual(result.blocked, true);
  assert.strictEqual(result.reason, 'drift');
});

test('resolveEscalation clears block marker', () => {
  const esc = freshModule();

  // Create an escalation at block level
  const r1 = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');

  // Write block marker
  const blockPath = path.join(testDir, '.claude/pilot/state/escalations', 'block_S-agent1');
  fs.writeFileSync(blockPath, JSON.stringify({ reason: 'drift' }));
  assert.ok(fs.existsSync(blockPath));

  // Resolve the escalation
  esc.resolveEscalation(r1.eventKey, 'test');

  // Block marker should be cleared
  assert.ok(!fs.existsSync(blockPath));
});

// ---------- Active Escalations ----------

console.log('\n  Active Escalations');

test('getActiveEscalations returns unresolved events', () => {
  const esc = freshModule();

  esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');
  esc.triggerEscalation('budget_exceeded', 'S-agent2', 'TASK-2');

  const active = esc.getActiveEscalations();
  assert.strictEqual(active.length, 2);
});

test('getActiveEscalations excludes resolved events', () => {
  const esc = freshModule();

  const r1 = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');
  esc.triggerEscalation('budget_exceeded', 'S-agent2', 'TASK-2');
  esc.resolveEscalation(r1.eventKey);

  const active = esc.getActiveEscalations();
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].event_type, 'budget_exceeded');
});

// ---------- Escalation Logging ----------

console.log('\n  Escalation Logging');

test('triggerEscalation writes to audit log', () => {
  const esc = freshModule();
  esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');

  const history = esc.getEscalationHistory();
  assert.ok(history.length >= 1);
  assert.strictEqual(history[0].action, 'triggered');
});

test('escalation through multiple levels logs all transitions', () => {
  const esc = freshModule();

  const r1 = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');

  // Backdate and escalate
  const state = esc.getEscalationState(r1.eventKey);
  state.last_escalated = new Date(Date.now() - 200000).toISOString();
  fs.writeFileSync(esc.getEscalationStatePath(r1.eventKey), JSON.stringify(state, null, 2));

  esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');

  const history = esc.getEscalationHistory(r1.eventKey);
  assert.ok(history.length >= 2);
  assert.strictEqual(history[0].action, 'triggered');
  assert.strictEqual(history[1].action, 'escalated');
});

test('getEscalationHistory can filter by eventKey', () => {
  const esc = freshModule();

  esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');
  esc.triggerEscalation('budget_exceeded', 'S-agent2', 'TASK-2');

  const allHistory = esc.getEscalationHistory();
  assert.ok(allHistory.length >= 2);

  const driftHistory = esc.getEscalationHistory('drift:S-agent1:TASK-1');
  assert.strictEqual(driftHistory.length, 1);
});

// ---------- Full Path Tests ----------

console.log('\n  Full Escalation Paths');

test('drift path: warning → block → reassign → human', () => {
  const esc = freshModule();
  const eventKey = esc.buildEventKey('drift', 'S-agent1', 'TASK-1');

  // Step 1: warning
  const r1 = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');
  assert.strictEqual(r1.level, 'warning');

  // Step 2: block (after cooldown)
  let state = esc.getEscalationState(eventKey);
  state.last_escalated = new Date(Date.now() - 200000).toISOString();
  fs.writeFileSync(esc.getEscalationStatePath(eventKey), JSON.stringify(state, null, 2));
  const r2 = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');
  assert.strictEqual(r2.level, 'block');

  // Step 3: reassign
  state = esc.getEscalationState(eventKey);
  state.last_escalated = new Date(Date.now() - 200000).toISOString();
  fs.writeFileSync(esc.getEscalationStatePath(eventKey), JSON.stringify(state, null, 2));
  const r3 = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');
  assert.strictEqual(r3.level, 'reassign');

  // Step 4: human
  state = esc.getEscalationState(eventKey);
  state.last_escalated = new Date(Date.now() - 200000).toISOString();
  fs.writeFileSync(esc.getEscalationStatePath(eventKey), JSON.stringify(state, null, 2));
  const r4 = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');
  assert.strictEqual(r4.level, 'human');

  // Step 5: stays at human (max level)
  state = esc.getEscalationState(eventKey);
  state.last_escalated = new Date(Date.now() - 200000).toISOString();
  fs.writeFileSync(esc.getEscalationStatePath(eventKey), JSON.stringify(state, null, 2));
  const r5 = esc.triggerEscalation('drift', 'S-agent1', 'TASK-1');
  assert.strictEqual(r5.level, 'human');
  assert.strictEqual(r5.escalated, false);
});

test('test_failure path: warning → reassign → human (skips block)', () => {
  const esc = freshModule();
  const eventKey = esc.buildEventKey('test_failure', 'S-agent1', 'TASK-1');

  const r1 = esc.triggerEscalation('test_failure', 'S-agent1', 'TASK-1');
  assert.strictEqual(r1.level, 'warning');

  let state = esc.getEscalationState(eventKey);
  state.last_escalated = new Date(Date.now() - 100000).toISOString();
  fs.writeFileSync(esc.getEscalationStatePath(eventKey), JSON.stringify(state, null, 2));
  const r2 = esc.triggerEscalation('test_failure', 'S-agent1', 'TASK-1');
  assert.strictEqual(r2.level, 'reassign');

  state = esc.getEscalationState(eventKey);
  state.last_escalated = new Date(Date.now() - 100000).toISOString();
  fs.writeFileSync(esc.getEscalationStatePath(eventKey), JSON.stringify(state, null, 2));
  const r3 = esc.triggerEscalation('test_failure', 'S-agent1', 'TASK-1');
  assert.strictEqual(r3.level, 'human');
});

test('budget_exceeded path: warning → block → human (no reassign)', () => {
  const esc = freshModule();
  const eventKey = esc.buildEventKey('budget_exceeded', 'S-agent1', 'TASK-1');

  const r1 = esc.triggerEscalation('budget_exceeded', 'S-agent1', 'TASK-1');
  assert.strictEqual(r1.level, 'warning');

  let state = esc.getEscalationState(eventKey);
  state.last_escalated = new Date(Date.now() - 400000).toISOString();
  fs.writeFileSync(esc.getEscalationStatePath(eventKey), JSON.stringify(state, null, 2));
  const r2 = esc.triggerEscalation('budget_exceeded', 'S-agent1', 'TASK-1');
  assert.strictEqual(r2.level, 'block');

  state = esc.getEscalationState(eventKey);
  state.last_escalated = new Date(Date.now() - 400000).toISOString();
  fs.writeFileSync(esc.getEscalationStatePath(eventKey), JSON.stringify(state, null, 2));
  const r3 = esc.triggerEscalation('budget_exceeded', 'S-agent1', 'TASK-1');
  assert.strictEqual(r3.level, 'human');
});

// ---------- Constants ----------

console.log('\n  Constants & Exports');

test('LEVELS contains all expected levels', () => {
  const esc = freshModule();
  assert.strictEqual(esc.LEVELS.WARNING, 'warning');
  assert.strictEqual(esc.LEVELS.BLOCK, 'block');
  assert.strictEqual(esc.LEVELS.REASSIGN, 'reassign');
  assert.strictEqual(esc.LEVELS.HUMAN, 'human');
});

test('EVENT_TYPES contains all expected types', () => {
  const esc = freshModule();
  assert.strictEqual(esc.EVENT_TYPES.DRIFT, 'drift');
  assert.strictEqual(esc.EVENT_TYPES.TEST_FAILURE, 'test_failure');
  assert.strictEqual(esc.EVENT_TYPES.BUDGET_EXCEEDED, 'budget_exceeded');
  assert.strictEqual(esc.EVENT_TYPES.MERGE_CONFLICT, 'merge_conflict');
  assert.strictEqual(esc.EVENT_TYPES.AGENT_UNRESPONSIVE, 'agent_unresponsive');
});

test('LEVEL_ORDER has correct progression', () => {
  const esc = freshModule();
  assert.deepStrictEqual(esc.LEVEL_ORDER, ['warning', 'block', 'reassign', 'human']);
});

// ============================================================================
// RESULTS
// ============================================================================

console.log('\n' + '='.repeat(60));
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

if (failed > 0) {
  process.exit(1);
}
