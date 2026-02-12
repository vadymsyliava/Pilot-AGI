/**
 * Tests for Agent Self-Activation Loop (Phase 3.6)
 * Covers: autonomous config, state machine, poller, pressure check,
 * idle/wake, plan approval timeout, concurrent claim prevention
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Create isolated test directory
const TEST_DIR = path.join(os.tmpdir(), `agent-loop-test-${Date.now()}`);
const ORIGINAL_CWD = process.cwd();

function setup() {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/messages/cursors'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/messages/archive'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/messages/nudge'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/memory/channels'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/memory/agents'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/state/locks'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/state/agent-loops'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/state/agent-actions'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, 'runs/sessions.jsonl'), '');

  // Create minimal policy.yaml
  fs.writeFileSync(path.join(TEST_DIR, '.claude/pilot/policy.yaml'), `
version: "1.0"
session:
  max_concurrent_sessions: 6
  heartbeat_interval_sec: 60
`);

  // Create memory index
  fs.writeFileSync(path.join(TEST_DIR, '.claude/pilot/memory/index.json'), JSON.stringify({
    version: 1,
    channels: {}
  }));

  // Create agent registry
  fs.writeFileSync(path.join(TEST_DIR, '.claude/pilot/agent-registry.json'), JSON.stringify({
    version: '1.1',
    agents: {
      frontend: { name: 'Frontend Agent', capabilities: ['react', 'css'] },
      backend: { name: 'Backend Agent', capabilities: ['api-design', 'nodejs'] },
      pm: { name: 'PM Agent', capabilities: ['task-assignment'] }
    }
  }, null, 2));

  // Create autonomous config with self-activation
  fs.writeFileSync(path.join(TEST_DIR, '.claude/pilot/state/autonomous.json'), JSON.stringify({
    running: false,
    config: { maxTasks: 10 },
    selfActivation: {
      version: '1.0',
      defaults: {
        enabled: false,
        auto_claim: true,
        auto_plan: true,
        auto_exec: true,
        idle_poll_interval_ms: 30000,
        active_poll_interval_ms: 5000,
        wake_on_delegation: true,
        checkpoint_at_pressure_pct: 60,
        plan_approval_timeout_ms: 300000,
        max_consecutive_exec_steps: 50
      },
      roles: {
        frontend: { enabled: true },
        backend: { enabled: true },
        pm: { enabled: false }
      }
    }
  }, null, 2));

  process.chdir(TEST_DIR);
}

function teardown() {
  process.chdir(ORIGINAL_CWD);
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (e) {}
}

// Clear require cache for fresh modules
function freshModule(moduleName) {
  const mods = [
    'agent-loop.js', 'agent-poller.js', 'agent-actions.js',
    'messaging.js', 'session.js', 'policy.js', 'worktree.js',
    'memory.js', 'agent-context.js', 'pressure.js', 'checkpoint.js'
  ];
  for (const mod of mods) {
    const modPath = path.join(ORIGINAL_CWD, '.claude/pilot/hooks/lib', mod);
    delete require.cache[modPath];
  }
  return require(path.join(ORIGINAL_CWD, '.claude/pilot/hooks/lib', moduleName));
}

function freshAgentLoop() { return freshModule('agent-loop.js'); }
function freshAgentPoller() { return freshModule('agent-poller.js'); }
function freshAgentActions() { return freshModule('agent-actions.js'); }
function freshMessaging() { return freshModule('messaging.js'); }
function freshSession() { return freshModule('session.js'); }

// Register a test session with role
function registerSession(sessionId, role) {
  const session = freshSession();
  session.registerSession(sessionId, { role });
  return session;
}

// ============================================================================
// TEST RUNNER
// ============================================================================

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function test(name, fn) {
  teardown();
  setup();

  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

// ============================================================================
// TESTS
// ============================================================================

console.log('\n=== Agent Self-Activation Tests ===\n');

// --- Autonomous Config ---

console.log('Autonomous Config:');

test('loadAutonomousConfig returns defaults when no role', () => {
  const { loadAutonomousConfig } = freshAgentLoop();
  const config = loadAutonomousConfig(null);
  assertEqual(config.enabled, false, 'should default to disabled');
  assertEqual(config.auto_claim, true, 'auto_claim default');
});

test('loadAutonomousConfig merges role overrides', () => {
  const { loadAutonomousConfig } = freshAgentLoop();
  const config = loadAutonomousConfig('frontend');
  assertEqual(config.enabled, true, 'frontend should be enabled');
  assertEqual(config.auto_claim, true, 'inherits default auto_claim');
});

test('isAutonomousEnabled returns false for pm', () => {
  const { isAutonomousEnabled } = freshAgentLoop();
  assertEqual(isAutonomousEnabled('pm'), false, 'pm should be disabled');
});

test('isAutonomousEnabled returns true for backend', () => {
  const { isAutonomousEnabled } = freshAgentLoop();
  assertEqual(isAutonomousEnabled('backend'), true, 'backend should be enabled');
});

test('isAutonomousEnabled returns false for unknown role', () => {
  const { isAutonomousEnabled } = freshAgentLoop();
  assertEqual(isAutonomousEnabled('unknown'), false, 'unknown role defaults to disabled');
});

// --- Agent Actions Queue ---

console.log('\nAgent Actions:');

test('enqueueAgentAction creates action entry', () => {
  const actions = freshAgentActions();
  const entry = actions.enqueueAgentAction('S-test', {
    type: 'invoke_plan',
    data: { task_id: 'TEST-1' }
  });

  assert(entry.id.startsWith('AA-'), 'action ID format');
  assertEqual(entry.type, 'invoke_plan', 'action type');
  assertEqual(entry.status, 'pending', 'action status');
});

test('dequeueAgentAction returns pending action', () => {
  const actions = freshAgentActions();
  actions.enqueueAgentAction('S-test', { type: 'invoke_plan', data: {} });
  actions.enqueueAgentAction('S-test', { type: 'invoke_exec', data: {} });

  const first = actions.dequeueAgentAction('S-test');
  assertEqual(first.type, 'invoke_plan', 'first dequeued type');
  assertEqual(first.status, 'processing', 'status after dequeue');

  const second = actions.dequeueAgentAction('S-test');
  assertEqual(second.type, 'invoke_exec', 'second dequeued type');
});

test('hasPendingActions detects pending', () => {
  const actions = freshAgentActions();
  assertEqual(actions.hasPendingActions('S-test'), false, 'initially empty');

  actions.enqueueAgentAction('S-test', { type: 'invoke_plan', data: {} });
  assertEqual(actions.hasPendingActions('S-test'), true, 'after enqueue');
});

test('completeAction removes from queue', () => {
  const actions = freshAgentActions();
  const entry = actions.enqueueAgentAction('S-test', { type: 'invoke_plan', data: {} });

  actions.completeAction('S-test', entry.id);
  assertEqual(actions.hasPendingActions('S-test'), false, 'should be empty after complete');
});

test('actionToPrompt generates plan prompt', () => {
  const actions = freshAgentActions();
  const prompt = actions.actionToPrompt({
    type: 'invoke_plan',
    data: { task_id: 'TEST-1', task_title: 'My Task' }
  });
  assert(prompt.includes('TEST-1'), 'prompt should contain task ID');
  assert(prompt.includes('/pilot-plan'), 'prompt should reference skill');
});

test('actionToPrompt generates exec prompt', () => {
  const actions = freshAgentActions();
  const prompt = actions.actionToPrompt({
    type: 'invoke_exec',
    data: { task_id: 'TEST-1', step: 3, total_steps: 5 }
  });
  assert(prompt.includes('step 3'), 'prompt should contain step');
  assert(prompt.includes('of 5'), 'prompt should contain total');
});

test('clearQueue removes all actions', () => {
  const actions = freshAgentActions();
  actions.enqueueAgentAction('S-test', { type: 'invoke_plan', data: {} });
  actions.enqueueAgentAction('S-test', { type: 'invoke_exec', data: {} });

  actions.clearQueue('S-test');
  assertEqual(actions.hasPendingActions('S-test'), false, 'should be empty after clear');
});

// --- Agent Poller ---

console.log('\nAgent Poller:');

test('AgentPoller initializes with correct defaults', () => {
  const { AgentPoller, DEFAULT_ACTIVE_POLL_MS, DEFAULT_IDLE_POLL_MS } = freshAgentPoller();
  const poller = new AgentPoller('S-test', { role: 'frontend' });

  const status = poller.getStatus();
  assertEqual(status.running, false, 'not running initially');
  assertEqual(status.idle, true, 'idle initially');
  assertEqual(status.role, 'frontend', 'role set');
  assertEqual(status.poll_interval_ms, DEFAULT_IDLE_POLL_MS, 'idle poll interval');
});

test('AgentPoller setActive changes poll interval', () => {
  const { AgentPoller, DEFAULT_ACTIVE_POLL_MS } = freshAgentPoller();
  const poller = new AgentPoller('S-test', { role: 'frontend' });

  poller.setActive();
  const status = poller.getStatus();
  assertEqual(status.idle, false, 'should not be idle');
  assertEqual(status.poll_interval_ms, DEFAULT_ACTIVE_POLL_MS, 'active poll interval');
});

test('AgentPoller fires onTask handler for task_delegate messages', () => {
  // Set up messaging
  freshMessaging();
  const messaging = require(path.join(ORIGINAL_CWD, '.claude/pilot/hooks/lib/messaging.js'));
  messaging.initializeCursor('S-agent');

  // Write cursor at start to read from beginning
  messaging.writeCursor('S-agent', {
    session_id: 'S-agent',
    byte_offset: 0,
    last_seq: -1,
    processed_ids: []
  });

  // Send a delegation message
  messaging.sendMessage({
    type: 'task_delegate',
    from: 'S-pm',
    to: 'S-agent',
    topic: 'task.delegate',
    priority: 'normal',
    payload: { action: 'delegate_task', data: { bd_task_id: 'TEST-1', title: 'Test Task' } }
  });

  // Create poller and register handler
  const { AgentPoller } = freshAgentPoller();
  const poller = new AgentPoller('S-agent', { role: 'frontend' });

  let received = null;
  poller.onTask((taskData) => { received = taskData; });

  // Manually trigger bus check
  poller._checkBus();

  assert(received !== null, 'handler should have been called');
  assertEqual(received.bd_task_id, 'TEST-1', 'should receive task ID');
});

// --- Agent Loop State Machine ---

console.log('\nAgent Loop State Machine:');

test('AgentLoop starts in IDLE state', () => {
  registerSession('S-loop-test', 'frontend');
  const { AgentLoop, STATES } = freshAgentLoop();
  const loop = new AgentLoop('S-loop-test', {
    role: 'frontend',
    agentName: 'frontend-1',
    config: { enabled: true, auto_claim: true, auto_plan: false, auto_exec: false,
              idle_poll_interval_ms: 60000, active_poll_interval_ms: 60000,
              checkpoint_at_pressure_pct: 60, plan_approval_timeout_ms: 300000,
              max_consecutive_exec_steps: 50 }
  });

  const result = loop.start();
  assertEqual(result.success, true, 'should start');
  assertEqual(loop.state, STATES.IDLE, 'initial state');
  loop.stop();
});

test('AgentLoop refuses to start when disabled', () => {
  const { AgentLoop } = freshAgentLoop();
  const loop = new AgentLoop('S-test', {
    role: 'pm',
    config: { enabled: false }
  });

  const result = loop.start();
  assertEqual(result.success, false, 'should fail');
  assert(result.error.includes('disabled'), 'error message');
});

test('AgentLoop claimTask transitions IDLE → CLAIMING', () => {
  registerSession('S-claim-test', 'frontend');
  const { AgentLoop, STATES } = freshAgentLoop();
  const loop = new AgentLoop('S-claim-test', {
    role: 'frontend',
    agentName: 'frontend-1',
    config: { enabled: true, auto_claim: true, auto_plan: false, auto_exec: false,
              idle_poll_interval_ms: 60000, active_poll_interval_ms: 60000,
              checkpoint_at_pressure_pct: 60, plan_approval_timeout_ms: 300000,
              max_consecutive_exec_steps: 50 }
  });
  loop.start();

  const result = loop.claimTask('TEST-1', 'Test Task');
  assert(result.success, 'claim should succeed');
  assertEqual(loop.currentTaskId, 'TEST-1', 'task ID stored');
  // State should be IDLE since auto_plan is false
  assertEqual(loop.state, STATES.IDLE, 'back to idle without auto_plan');
  loop.stop();
});

test('AgentLoop claimTask with auto_plan transitions to WAITING_APPROVAL', () => {
  registerSession('S-autoplan-test', 'frontend');
  const { AgentLoop, STATES } = freshAgentLoop();
  const loop = new AgentLoop('S-autoplan-test', {
    role: 'frontend',
    agentName: 'frontend-1',
    config: { enabled: true, auto_claim: true, auto_plan: true, auto_exec: false,
              idle_poll_interval_ms: 60000, active_poll_interval_ms: 60000,
              checkpoint_at_pressure_pct: 60, plan_approval_timeout_ms: 300000,
              max_consecutive_exec_steps: 50 }
  });
  loop.start();

  const result = loop.claimTask('TEST-2', 'Auto Plan Task');
  assert(result.success, 'claim should succeed');
  assertEqual(loop.state, STATES.WAITING_APPROVAL, 'should be waiting for approval');
  assert(loop.planRequestId !== null, 'plan request ID should be set');
  loop.stop();
});

test('AgentLoop rejects claim when not idle', () => {
  registerSession('S-busy-test', 'frontend');
  const { AgentLoop, STATES } = freshAgentLoop();
  const loop = new AgentLoop('S-busy-test', {
    role: 'frontend',
    agentName: 'frontend-1',
    config: { enabled: true, auto_claim: true, auto_plan: false, auto_exec: false,
              idle_poll_interval_ms: 60000, active_poll_interval_ms: 60000,
              checkpoint_at_pressure_pct: 60, plan_approval_timeout_ms: 300000,
              max_consecutive_exec_steps: 50 }
  });
  loop.start();
  loop.claimTask('TEST-1', 'First Task');

  // Force state to EXECUTING
  loop.state = STATES.EXECUTING;
  const result = loop.claimTask('TEST-2', 'Second Task');
  assertEqual(result.success, false, 'should reject');
  assert(result.error.includes('Cannot claim'), 'error message');
  loop.stop();
});

test('AgentLoop executeStep increments step counter', () => {
  registerSession('S-exec-test', 'frontend');
  const { AgentLoop, STATES } = freshAgentLoop();
  const loop = new AgentLoop('S-exec-test', {
    role: 'frontend',
    agentName: 'frontend-1',
    config: { enabled: true, auto_claim: true, auto_plan: false, auto_exec: true,
              idle_poll_interval_ms: 60000, active_poll_interval_ms: 60000,
              checkpoint_at_pressure_pct: 90, plan_approval_timeout_ms: 300000,
              max_consecutive_exec_steps: 50 }
  });
  loop.start();
  loop.currentTaskId = 'TEST-1';
  loop.state = STATES.EXECUTING;

  const r1 = loop.executeStep();
  assert(r1.success, 'step 1 should succeed');
  assertEqual(r1.step, 1, 'step counter');

  const r2 = loop.executeStep();
  assertEqual(r2.step, 2, 'step counter incremented');
  loop.stop();
});

test('AgentLoop completeTask returns to IDLE', () => {
  registerSession('S-complete-test', 'frontend');
  const { AgentLoop, STATES } = freshAgentLoop();
  const loop = new AgentLoop('S-complete-test', {
    role: 'frontend',
    agentName: 'frontend-1',
    config: { enabled: true, auto_claim: true, auto_plan: false, auto_exec: false,
              idle_poll_interval_ms: 60000, active_poll_interval_ms: 60000,
              checkpoint_at_pressure_pct: 60, plan_approval_timeout_ms: 300000,
              max_consecutive_exec_steps: 50 }
  });
  loop.start();
  loop.claimTask('TEST-1', 'Complete Test');
  loop.state = STATES.EXECUTING;
  loop.execStep = 3;

  const result = loop.completeTask();
  assert(result.success, 'complete should succeed');
  assertEqual(result.completed_task, 'TEST-1', 'completed task ID');
  assertEqual(loop.state, STATES.IDLE, 'should be idle after completion');
  assertEqual(loop.currentTaskId, null, 'task cleared');
  assertEqual(loop.execStep, 0, 'step reset');
  loop.stop();
});

test('AgentLoop handleError escalates after MAX_ERRORS', () => {
  registerSession('S-error-test', 'frontend');
  const { AgentLoop, MAX_ERRORS } = freshAgentLoop();
  const loop = new AgentLoop('S-error-test', {
    role: 'frontend',
    agentName: 'frontend-1',
    config: { enabled: true, auto_claim: true, auto_plan: false, auto_exec: false,
              idle_poll_interval_ms: 60000, active_poll_interval_ms: 60000,
              checkpoint_at_pressure_pct: 60, plan_approval_timeout_ms: 300000,
              max_consecutive_exec_steps: 50 }
  });
  loop.start();
  loop.currentTaskId = 'TEST-1';

  // Generate MAX_ERRORS consecutive errors
  for (let i = 0; i < MAX_ERRORS; i++) {
    loop.handleError(`Error ${i + 1}`);
  }

  assertEqual(loop._running, false, 'should have stopped');
  assertEqual(loop.errors.length, MAX_ERRORS, 'errors recorded');
});

// --- Loop State Persistence ---

console.log('\nState Persistence:');

test('saveLoopState and loadLoopState roundtrip', () => {
  const { saveLoopState, loadLoopState, STATES } = freshAgentLoop();
  const state = {
    session_id: 'S-persist',
    state: STATES.EXECUTING,
    currentTaskId: 'TEST-1',
    currentTaskTitle: 'Persist Test',
    execStep: 3,
    totalSteps: 5,
    updated_at: new Date().toISOString()
  };

  saveLoopState('S-persist', state);
  const loaded = loadLoopState('S-persist');

  assert(loaded !== null, 'should load');
  assertEqual(loaded.state, STATES.EXECUTING, 'state preserved');
  assertEqual(loaded.currentTaskId, 'TEST-1', 'task preserved');
  assertEqual(loaded.execStep, 3, 'step preserved');
});

test('AgentLoop restores state from crash', () => {
  registerSession('S-crash-test', 'frontend');
  const { saveLoopState, AgentLoop, STATES } = freshAgentLoop();

  // Simulate a crashed session with saved state
  saveLoopState('S-crash-test', {
    session_id: 'S-crash-test',
    state: STATES.EXECUTING,
    currentTaskId: 'CRASH-1',
    currentTaskTitle: 'Crash Recovery',
    execStep: 2,
    totalSteps: 5,
    consecutiveErrors: 0,
    updated_at: new Date().toISOString()
  });

  const loop = new AgentLoop('S-crash-test', {
    role: 'frontend',
    agentName: 'frontend-1',
    config: { enabled: true, auto_claim: true, auto_plan: false, auto_exec: false,
              idle_poll_interval_ms: 60000, active_poll_interval_ms: 60000,
              checkpoint_at_pressure_pct: 60, plan_approval_timeout_ms: 300000,
              max_consecutive_exec_steps: 50 }
  });
  loop.start();

  assertEqual(loop.state, STATES.EXECUTING, 'restored state');
  assertEqual(loop.currentTaskId, 'CRASH-1', 'restored task');
  assertEqual(loop.execStep, 2, 'restored step');
  loop.stop();
});

// --- Concurrent Claim Prevention ---

console.log('\nConcurrent Claims:');

test('Two agents cannot claim same task', () => {
  registerSession('S-agent-a', 'frontend');
  registerSession('S-agent-b', 'backend');
  const { AgentLoop, STATES } = freshAgentLoop();

  const loopA = new AgentLoop('S-agent-a', {
    role: 'frontend',
    agentName: 'frontend-1',
    config: { enabled: true, auto_claim: true, auto_plan: false, auto_exec: false,
              idle_poll_interval_ms: 60000, active_poll_interval_ms: 60000,
              checkpoint_at_pressure_pct: 60, plan_approval_timeout_ms: 300000,
              max_consecutive_exec_steps: 50 }
  });
  loopA.start();

  const loopB = new AgentLoop('S-agent-b', {
    role: 'backend',
    agentName: 'backend-1',
    config: { enabled: true, auto_claim: true, auto_plan: false, auto_exec: false,
              idle_poll_interval_ms: 60000, active_poll_interval_ms: 60000,
              checkpoint_at_pressure_pct: 60, plan_approval_timeout_ms: 300000,
              max_consecutive_exec_steps: 50 }
  });
  loopB.start();

  const resultA = loopA.claimTask('SHARED-1', 'Shared Task');
  assert(resultA.success, 'first claim should succeed');

  const resultB = loopB.claimTask('SHARED-1', 'Shared Task');
  assertEqual(resultB.success, false, 'second claim should fail');
  assert(resultB.error.includes('already claimed'), 'error mentions already claimed');

  loopA.stop();
  loopB.stop();
});

// --- getStatus ---

console.log('\nStatus:');

test('getStatus returns comprehensive info', () => {
  registerSession('S-status-test', 'frontend');
  const { AgentLoop } = freshAgentLoop();
  const loop = new AgentLoop('S-status-test', {
    role: 'frontend',
    agentName: 'frontend-1',
    config: { enabled: true, auto_claim: true, auto_plan: false, auto_exec: false,
              idle_poll_interval_ms: 60000, active_poll_interval_ms: 60000,
              checkpoint_at_pressure_pct: 60, plan_approval_timeout_ms: 300000,
              max_consecutive_exec_steps: 50 }
  });
  loop.start();

  const status = loop.getStatus();
  assertEqual(status.running, true, 'running');
  assertEqual(status.state, 'idle', 'state');
  assertEqual(status.role, 'frontend', 'role');
  assertEqual(status.agent_name, 'frontend-1', 'agent_name');
  assert(status.poller !== null, 'poller status included');
  loop.stop();
});

// ============================================================================
// SUMMARY
// ============================================================================

teardown();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`);
    console.log(`    ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
