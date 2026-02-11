/**
 * Tests for Agent-to-Agent Collaboration (Phase 3.9)
 * Covers: role-addressed messaging, agent queries, blocking requests,
 * PM escalation, shared working context, service discovery
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Create isolated test directory
const TEST_DIR = path.join(os.tmpdir(), `collab-test-${Date.now()}`);
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
  fs.mkdirSync(path.join(TEST_DIR, 'runs'), { recursive: true });
  // Create empty sessions.jsonl for logEvent
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

  // Create agent registry with capabilities
  fs.writeFileSync(path.join(TEST_DIR, '.claude/pilot/agent-registry.json'), JSON.stringify({
    version: '1.1',
    agents: {
      frontend: {
        name: 'Frontend Agent',
        capabilities: ['react', 'css', 'components']
      },
      backend: {
        name: 'Backend Agent',
        capabilities: ['api-design', 'database', 'nodejs']
      },
      pm: {
        name: 'PM Agent',
        capabilities: ['task-assignment', 'coordination']
      }
    }
  }, null, 2));

  process.chdir(TEST_DIR);
}

function teardown() {
  process.chdir(ORIGINAL_CWD);
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (e) {}
}

function freshMessaging() {
  const modPath = path.join(ORIGINAL_CWD, '.claude/pilot/hooks/lib/messaging.js');
  delete require.cache[modPath];
  return require(modPath);
}

function freshAgentContext() {
  // Clear all related caches including messaging (agent-context may reference it)
  const mods = [
    'agent-context.js', 'memory.js', 'session.js', 'policy.js', 'worktree.js', 'messaging.js'
  ];
  for (const mod of mods) {
    const p = path.join(ORIGINAL_CWD, '.claude/pilot/hooks/lib', mod);
    delete require.cache[p];
  }
  return require(path.join(ORIGINAL_CWD, '.claude/pilot/hooks/lib/agent-context.js'));
}

function freshSession() {
  const mods = ['session.js', 'policy.js', 'worktree.js'];
  for (const mod of mods) {
    const p = path.join(ORIGINAL_CWD, '.claude/pilot/hooks/lib', mod);
    delete require.cache[p];
  }
  return require(path.join(ORIGINAL_CWD, '.claude/pilot/hooks/lib/session.js'));
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

console.log('\n=== Agent-to-Agent Collaboration Tests ===\n');

// --- Role-Addressed Messaging ---

console.log('Role-Addressed Messaging:');

test('sendToRole sends message with to_role field', () => {
  const m = freshMessaging();
  const result = m.sendToRole('S-sender', 'backend', 'api.query', { endpoint: '/users' });
  assert(result.success, 'sendToRole should succeed');

  // Read bus directly
  const bus = fs.readFileSync(path.join(TEST_DIR, '.claude/pilot/messages/bus.jsonl'), 'utf8');
  const msg = JSON.parse(bus.trim().split('\n').pop());
  assertEqual(msg.to_role, 'backend', 'Message should have to_role=backend');
  assertEqual(msg.type, 'request', 'Default type should be request');
  assertEqual(msg.topic, 'api.query', 'Topic should match');
});

test('sendToAgent sends message with to_agent field', () => {
  const m = freshMessaging();
  const result = m.sendToAgent('S-sender', 'backend-1', 'progress.update', { step: 3 });
  assert(result.success, 'sendToAgent should succeed');

  const bus = fs.readFileSync(path.join(TEST_DIR, '.claude/pilot/messages/bus.jsonl'), 'utf8');
  const msg = JSON.parse(bus.trim().split('\n').pop());
  assertEqual(msg.to_agent, 'backend-1', 'Message should have to_agent=backend-1');
});

test('readMessages with role filter receives role-addressed messages', () => {
  const m = freshMessaging();

  // Initialize cursor for the receiver
  m.initializeCursor('S-backend-1');

  // Send a role-addressed message
  m.sendToRole('S-frontend-1', 'backend', 'api.query', { endpoint: '/users' });

  // Reader with role=backend should see it
  const { messages } = m.readMessages('S-backend-1', { role: 'backend' });
  assertEqual(messages.length, 1, 'Backend reader should see 1 role-addressed message');
  assertEqual(messages[0].to_role, 'backend', 'Message to_role should be backend');
});

test('readMessages without matching role does NOT receive role-addressed messages', () => {
  const m = freshMessaging();

  m.initializeCursor('S-frontend-1');

  // Send to backend role
  m.sendToRole('S-sender', 'backend', 'api.query', { endpoint: '/users' });

  // Frontend reader should NOT see backend-addressed messages
  const { messages } = m.readMessages('S-frontend-1', { role: 'frontend' });
  assertEqual(messages.length, 0, 'Frontend reader should not see backend messages');
});

test('readMessages with agentName filter receives name-addressed messages', () => {
  const m = freshMessaging();

  m.initializeCursor('S-backend-1');

  // Send to specific agent name
  m.sendToAgent('S-frontend-1', 'backend-1', 'direct.msg', { data: 'hello' });

  // Reader with matching agentName should see it
  const { messages } = m.readMessages('S-backend-1', { agentName: 'backend-1' });
  assertEqual(messages.length, 1, 'Named agent should receive the message');
});

// --- Query Protocol ---

console.log('\nQuery Protocol:');

test('queryAgent sends query with ACK tracking', () => {
  const m = freshMessaging();
  const result = m.queryAgent('S-frontend-1', 'backend', 'What is the API contract for /users?');
  assert(result.success, 'queryAgent should succeed');

  const bus = fs.readFileSync(path.join(TEST_DIR, '.claude/pilot/messages/bus.jsonl'), 'utf8');
  const msg = JSON.parse(bus.trim().split('\n').pop());
  assertEqual(msg.type, 'query', 'Message type should be query');
  assertEqual(msg.to_role, 'backend', 'Should target backend role');
  assert(msg.payload.data.question.includes('API contract'), 'Should contain the question');
  assert(msg.ack && msg.ack.required, 'Should require ACK');
});

test('respondToQuery sends correlation response', () => {
  const m = freshMessaging();

  // Initialize cursor BEFORE sending messages so we see everything
  m.initializeCursor('S-frontend-1');

  // Send initial query
  const queryResult = m.queryAgent('S-frontend-1', 'backend', 'What API?');
  const queryId = queryResult.id;

  // Send response
  const respResult = m.respondToQuery('S-backend-1', queryId, 'S-frontend-1', {
    contract: { method: 'GET', path: '/users', response: '200 User[]' }
  });
  assert(respResult.success, 'respondToQuery should succeed');

  // Read response — frontend should see the response addressed to them
  const { messages } = m.readMessages('S-frontend-1');
  const response = messages.find(msg => msg.correlation_id === queryId);
  assert(response, 'Should find correlation response');
  assertEqual(response.payload.action, 'query_response', 'Should be query_response');
});

// --- Blocking Requests ---

console.log('\nBlocking Requests:');

test('sendBlockingRequest creates blocking message with escalation flag', () => {
  const m = freshMessaging();
  const result = m.sendBlockingRequest('S-frontend-1', 'backend', 'Need API done before UI work', {
    deadline_ms: 5000
  });
  assert(result.success, 'sendBlockingRequest should succeed');

  const bus = fs.readFileSync(path.join(TEST_DIR, '.claude/pilot/messages/bus.jsonl'), 'utf8');
  const msg = JSON.parse(bus.trim().split('\n').pop());
  assertEqual(msg.priority, 'blocking', 'Should be blocking priority');
  assertEqual(msg.to_role, 'backend', 'Should target backend role');
  assert(msg.payload.data.escalate_to_pm, 'Should have escalate_to_pm flag');
});

test('ACK timeout escalation sends PM notification for blocking requests', () => {
  const m = freshMessaging();

  // Ensure bus file exists (processAckTimeouts writes to it on escalation)
  const busPath = path.join(TEST_DIR, '.claude/pilot/messages/bus.jsonl');
  if (!fs.existsSync(busPath)) {
    fs.writeFileSync(busPath, '');
  }

  // Directly write a pending ACK that's already at max retries with expired deadline.
  // This avoids timing issues — processAckTimeouts will see retries >= ACK_MAX_RETRIES
  // and trigger the escalation path immediately.
  const acksPath = path.join(TEST_DIR, '.claude/pilot/messages/pending_acks.jsonl');
  const entry = {
    message_id: 'M-test-123',
    from: 'S-frontend-1',
    to: null,
    to_role: 'backend',
    escalate_to_pm: true,
    deadline_at: new Date(Date.now() - 1000).toISOString(), // already expired
    retries: 3, // already at max (ACK_MAX_RETRIES = 3)
    created_at: new Date().toISOString()
  };
  fs.writeFileSync(acksPath, JSON.stringify(entry) + '\n');

  m.processAckTimeouts();

  // Check that an escalation message was sent to PM
  const bus = fs.readFileSync(busPath, 'utf8');
  const lines = bus.trim().split('\n').filter(l => l.trim());
  const escalation = lines
    .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(Boolean)
    .find(msg => msg.topic === 'escalation.blocking_timeout');

  assert(escalation, 'Should find PM escalation message');
  assertEqual(escalation.to_role, 'pm', 'Escalation should target PM');
  assertEqual(escalation.priority, 'blocking', 'Escalation should be blocking priority');
});

test('trackPendingAck stores to_role and escalate_to_pm', () => {
  const m = freshMessaging();

  m.trackPendingAck('M-test-456', 'S-sender', null, 30000, {
    to_role: 'backend',
    escalate_to_pm: true
  });

  const acks = m.loadPendingAcks();
  assertEqual(acks.length, 1, 'Should have 1 pending ACK');
  assertEqual(acks[0].to_role, 'backend', 'Should store to_role');
  assertEqual(acks[0].escalate_to_pm, true, 'Should store escalate_to_pm');
});

// --- Shared Working Context ---

console.log('\nShared Working Context:');

test('publishProgress creates working context entry', () => {
  const ctx = freshAgentContext();

  ctx.publishProgress('S-backend-1', {
    taskId: 'TASK-123',
    taskTitle: 'Build API endpoints',
    step: 2,
    totalSteps: 5,
    filesModified: ['src/api/users.ts'],
    status: 'working'
  });

  const context = ctx.getWorkingContext();
  assert(context['S-backend-1'], 'Should have entry for S-backend-1');
  assertEqual(context['S-backend-1'].task_id, 'TASK-123', 'Should have task_id');
  assertEqual(context['S-backend-1'].status, 'working', 'Should have status');
});

test('getRelatedProgress finds agents on same task', () => {
  const ctx = freshAgentContext();

  ctx.publishProgress('S-agent-1', { taskId: 'TASK-123', status: 'working' });
  ctx.publishProgress('S-agent-2', { taskId: 'TASK-456', status: 'working' });

  const related = ctx.getRelatedProgress('TASK-123');
  assertEqual(related.length, 1, 'Should find 1 related agent');
  assertEqual(related[0].session_id, 'S-agent-1', 'Should be agent-1');
});

test('getAgentsOnFiles detects file overlap', () => {
  const ctx = freshAgentContext();

  ctx.publishProgress('S-backend-1', {
    taskId: 'TASK-1',
    filesModified: ['src/api/users.ts', 'src/db/schema.ts'],
    status: 'working'
  });

  const overlap = ctx.getAgentsOnFiles(['src/api/users.ts'], 'S-other');
  assertEqual(overlap.length, 1, 'Should find 1 overlapping agent');
  assert(overlap[0].overlapping_files.includes('src/api/users.ts'), 'Should include overlapping file');
});

test('removeAgent clears agent from context', () => {
  const ctx = freshAgentContext();

  ctx.publishProgress('S-agent-1', { taskId: 'TASK-1', status: 'working' });
  let context = ctx.getWorkingContext();
  assert(context['S-agent-1'], 'Agent should exist');

  ctx.removeAgent('S-agent-1');
  context = ctx.getWorkingContext();
  assert(!context['S-agent-1'], 'Agent should be removed');
});

test('getStatusBoard returns summary', () => {
  const ctx = freshAgentContext();

  ctx.publishProgress('S-a', { taskId: 'T-1', status: 'working' });
  ctx.publishProgress('S-b', { taskId: null, status: 'idle' });

  const board = ctx.getStatusBoard();
  assertEqual(board.total, 2, 'Should have 2 agents');
  assertEqual(board.working, 1, 'Should have 1 working');
  assertEqual(board.idle, 1, 'Should have 1 idle');
});

// --- Service Discovery ---

console.log('\nService Discovery:');

test('discoverAgentByCap finds agents with matching capability', () => {
  const ctx = freshAgentContext();
  const sess = freshSession();

  // Register two sessions with roles
  sess.registerSession('S-fe-1', { role: 'frontend' });
  sess.registerSession('S-be-1', { role: 'backend' });

  // Search for react capability (frontend has it)
  const found = ctx.discoverAgentByCap('react');
  assert(found.length >= 1, 'Should find at least 1 agent with react capability');
  assert(found.some(a => a.role === 'frontend'), 'Should include frontend agent');
});

test('discoverAgentByCap returns empty for unknown capability', () => {
  const ctx = freshAgentContext();
  const found = ctx.discoverAgentByCap('quantum-computing');
  assertEqual(found.length, 0, 'Should find no agents');
});

// --- Validation ---

console.log('\nValidation:');

test('query type is valid in message validation', () => {
  const m = freshMessaging();
  const validation = m.validateMessage({
    type: 'query',
    from: 'S-sender',
    to_role: 'backend',
    priority: 'normal',
    payload: { action: 'query', data: { question: 'test' } }
  });
  assert(validation.valid, `Query should be valid: ${validation.errors.join(', ')}`);
});

test('query without recipient fails validation', () => {
  const m = freshMessaging();
  const validation = m.validateMessage({
    type: 'query',
    from: 'S-sender',
    priority: 'normal',
    payload: {}
  });
  assert(!validation.valid, 'Query without to/to_role should fail');
});

test('request with to_role passes validation', () => {
  const m = freshMessaging();
  const validation = m.validateMessage({
    type: 'request',
    from: 'S-sender',
    to_role: 'backend',
    priority: 'normal',
    payload: {}
  });
  assert(validation.valid, `Request with to_role should be valid: ${validation.errors.join(', ')}`);
});

// --- Dependency Blocking Protocol ---

console.log('\nDependency Blocking Protocol:');

test('sendBlockOnTask creates block_on_task message', () => {
  const m = freshMessaging();
  const result = m.sendBlockOnTask('S-frontend-1', 'TASK-123', 'Need API done first');
  assert(result.success, 'sendBlockOnTask should succeed');

  const bus = fs.readFileSync(path.join(TEST_DIR, '.claude/pilot/messages/bus.jsonl'), 'utf8');
  const msg = JSON.parse(bus.trim().split('\n').pop());
  assertEqual(msg.type, 'block_on_task', 'Type should be block_on_task');
  assertEqual(msg.priority, 'blocking', 'Should be blocking priority');
  assertEqual(msg.payload.data.blocked_task_id, 'TASK-123', 'Should contain blocked task ID');
});

test('notifyTaskComplete broadcasts task.completed', () => {
  const m = freshMessaging();
  const result = m.notifyTaskComplete('S-backend-1', 'TASK-123', {
    summary: 'API endpoints done',
    files_changed: ['src/api/users.ts']
  });
  assert(result.success, 'notifyTaskComplete should succeed');

  const bus = fs.readFileSync(path.join(TEST_DIR, '.claude/pilot/messages/bus.jsonl'), 'utf8');
  const msg = JSON.parse(bus.trim().split('\n').pop());
  assertEqual(msg.type, 'broadcast', 'Should be a broadcast');
  assertEqual(msg.topic, 'task.completed', 'Topic should be task.completed');
  assertEqual(msg.payload.data.task_id, 'TASK-123', 'Should contain task ID');
});

test('block_on_task type is valid in message validation', () => {
  const m = freshMessaging();
  const validation = m.validateMessage({
    type: 'block_on_task',
    from: 'S-sender',
    to: '*',
    priority: 'blocking',
    payload: { action: 'block_on_task', data: { blocked_task_id: 'T-1' } }
  });
  assert(validation.valid, `block_on_task should be valid: ${(validation.errors || []).join(', ')}`);
});

// --- Escalation Chain ---

console.log('\nEscalation Chain:');

test('sendWithEscalation sends request with escalation metadata', () => {
  const m = freshMessaging();
  const result = m.sendWithEscalation('S-fe-1', 'S-be-1', 'api.contract', { need: 'user endpoint' });
  assert(result.success, 'sendWithEscalation should succeed');
  assert(Array.isArray(result.escalation_chain), 'Should return escalation chain');

  const bus = fs.readFileSync(path.join(TEST_DIR, '.claude/pilot/messages/bus.jsonl'), 'utf8');
  const msg = JSON.parse(bus.trim().split('\n').pop());
  assertEqual(msg.priority, 'blocking', 'Should be blocking priority');
  assert(msg.ack && msg.ack.escalation_chain, 'Should have escalation chain in ack');
  assertEqual(msg.ack.current_level, 0, 'Should be at level 0');
});

test('DEFAULT_ESCALATION_CHAIN has 3 levels', () => {
  const m = freshMessaging();
  assertEqual(m.DEFAULT_ESCALATION_CHAIN.length, 3, 'Chain should have 3 levels');
  assertEqual(m.DEFAULT_ESCALATION_CHAIN[0].level, 'peer', 'Level 0 should be peer');
  assertEqual(m.DEFAULT_ESCALATION_CHAIN[1].level, 'pm', 'Level 1 should be pm');
  assertEqual(m.DEFAULT_ESCALATION_CHAIN[2].level, 'human', 'Level 2 should be human');
});

// --- Delegated Tasks ---

console.log('\nDelegated Tasks:');

test('getDelegatedTasks finds delegation messages on bus', () => {
  const m = freshMessaging();
  const ctx = freshAgentContext();

  m.delegateTask('S-pm-1', 'S-fe-1', { title: 'Build login page', description: 'Create login form' });

  const fromPm = ctx.getDelegatedTasks('S-pm-1', 'from');
  assert(fromPm.length >= 1, 'PM should have 1 delegated task');

  const toFe = ctx.getDelegatedTasks('S-fe-1', 'to');
  assert(toFe.length >= 1, 'Frontend should receive 1 delegated task');
});

// --- Context Injection ---

console.log('\nContext Injection:');

test('getAgentContext includes decisions and discoveries', () => {
  const ctx = freshAgentContext();
  ctx.publishProgress('S-be-1', { taskId: 'T-1', status: 'working' });

  const agentCtx = ctx.getAgentContext('S-be-1');
  assert(agentCtx, 'Should return agent context');
  assertEqual(agentCtx.task_id, 'T-1', 'Should have task_id');
  assert(Array.isArray(agentCtx.recent_decisions), 'Should have decisions array');
  assert(Array.isArray(agentCtx.recent_discoveries), 'Should have discoveries array');
});

test('getRelatedContext finds related tasks on overlapping files', () => {
  const ctx = freshAgentContext();

  ctx.publishProgress('S-be-1', {
    taskId: 'T-1',
    filesModified: ['src/api/users.ts'],
    status: 'working'
  });

  const related = ctx.getRelatedContext({
    files: ['src/api/users.ts'],
    from: 'S-fe-1',
    topic: 'api.query'
  });

  assert(related, 'Should return related context');
  assert(Array.isArray(related.peer_decisions), 'Should have peer_decisions');
  assert(Array.isArray(related.related_tasks), 'Should have related_tasks');
  assert(related.related_tasks.length >= 1, 'Should find related task on overlapping file');
});

test('injectContext enriches messages with _context', () => {
  const ctx = freshAgentContext();

  ctx.publishProgress('S-be-1', {
    taskId: 'T-1',
    filesModified: ['src/api/users.ts'],
    status: 'working'
  });

  const messages = [{
    id: 'M-1',
    from: 'S-fe-1',
    topic: 'api.query',
    payload: { data: { files: ['src/api/users.ts'] } }
  }];

  const enriched = ctx.injectContext('S-be-1', messages);
  assertEqual(enriched.length, 1, 'Should have 1 message');
  assert(enriched[0]._context, 'Message should have _context');
  assert(enriched[0]._context.related_tasks.length >= 1, 'Should have related tasks');
});

// --- Service Discovery by File ---

console.log('\nService Discovery by File:');

test('discoverAgentByFile matches file patterns from registry', () => {
  const ctx = freshAgentContext();
  const sess = freshSession();

  fs.writeFileSync(path.join(TEST_DIR, '.claude/pilot/agent-registry.json'), JSON.stringify({
    version: '1.1',
    agents: {
      frontend: {
        name: 'Frontend Agent',
        capabilities: ['react'],
        file_patterns: ['**/*.tsx', '**/components/**/*'],
        excluded_patterns: ['**/*.test.*']
      },
      backend: {
        name: 'Backend Agent',
        capabilities: ['api-design'],
        file_patterns: ['**/api/**/*', '**/server/**/*'],
        excluded_patterns: []
      }
    }
  }, null, 2));

  sess.registerSession('S-fe-1', { role: 'frontend' });

  const result = ctx.discoverAgentByFile('src/components/Button.tsx');
  assert(result, 'Should find a matching agent');
  assertEqual(result.role, 'frontend', 'Should match frontend agent');
});

// --- Human Escalation ---

console.log('\nHuman Escalation:');

test('recordHumanEscalation writes to JSONL file', () => {
  const ctx = freshAgentContext();

  const entry = ctx.recordHumanEscalation({
    from: 'S-pm-1',
    reason: 'All automated levels failed',
    original_message_id: 'M-test-1'
  });

  assert(entry.ts, 'Should have timestamp');
  assertEqual(entry.resolved, false, 'Should be unresolved');

  const pending = ctx.getPendingHumanEscalations();
  assertEqual(pending.length, 1, 'Should have 1 pending escalation');
});

// ============================================================================
// RESULTS
// ============================================================================

teardown();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

if (failures.length > 0) {
  console.log('Failures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}: ${f.error}`);
  }
}

if (failed > 0 && require.main === module) {
  process.exit(1);
}
