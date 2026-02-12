/**
 * Tests for Phase 3.9 collaboration features in messaging.js
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/collaboration.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let testDir;
const origCwd = process.cwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'collab-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/messages/cursors'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/messages/archive'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/messages/nudge'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/memory/channels'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/memory/agents'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/locks'), { recursive: true });

  // Memory index
  fs.writeFileSync(path.join(testDir, '.claude/pilot/memory/index.json'), JSON.stringify({
    version: 1, channels: {}
  }));

  // Agent registry
  fs.writeFileSync(path.join(testDir, '.claude/pilot/agent-registry.json'), JSON.stringify({
    version: '1.1',
    agents: {
      frontend: {
        name: 'Frontend Agent',
        capabilities: ['component_creation', 'styling'],
        file_patterns: ['**/*.tsx'],
        excluded_patterns: []
      },
      backend: {
        name: 'Backend Agent',
        capabilities: ['api_design', 'database_operations'],
        file_patterns: ['**/api/**/*'],
        excluded_patterns: []
      }
    }
  }));

  process.cwd = () => testDir;
}

function teardown() {
  process.cwd = origCwd;
  fs.rmSync(testDir, { recursive: true, force: true });
}

function createMockSession(sessionId, role, agentName, task) {
  const sessDir = path.join(testDir, '.claude/pilot/state/sessions');
  fs.writeFileSync(path.join(sessDir, `${sessionId}.json`), JSON.stringify({
    session_id: sessionId,
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    status: 'active',
    role,
    agent_name: agentName,
    claimed_task: task,
    pid: process.pid,
    parent_pid: process.pid
  }));
  const lockDir = path.join(testDir, '.claude/pilot/state/locks');
  fs.writeFileSync(path.join(lockDir, `${sessionId}.lock`), JSON.stringify({
    session_id: sessionId,
    pid: process.pid,
    parent_pid: process.pid,
    created_at: new Date().toISOString()
  }));
}

function freshRequire(mod) {
  Object.keys(require.cache).forEach(key => {
    if (key.includes('.claude/pilot')) delete require.cache[key];
  });
  return require(mod);
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`    ${e.message}`);
  }
}

console.log('\n=== collaboration.test.js — Phase 3.9 messaging features ===\n');

// --- sendBlockOnTask + notifyTaskComplete ---
console.log('Block-on-Task Protocol:');
setup();
try {
  const m = freshRequire('../messaging');

  // Initialize cursor BEFORE messages are sent so reader sees them
  m.initializeCursor('S-reader');

  test('sendBlockOnTask sends blocking broadcast', () => {
    const result = m.sendBlockOnTask('S-frontend-1', 'TASK-API-001', 'Need API endpoint first');
    assert.strictEqual(result.success, true);
    assert(result.id, 'Should return message ID');
  });

  test('notifyTaskComplete broadcasts completion', () => {
    const result = m.notifyTaskComplete('S-backend-1', 'TASK-API-001', { endpoints: ['/api/users'] });
    assert.strictEqual(result.success, true);
  });

  test('blocked agent receives both block and completion messages', () => {
    const { messages } = m.readMessages('S-reader', { includeExpired: true });
    const blockMsg = messages.find(msg => msg.topic === 'task.blocked_on');
    const completeMsg = messages.find(msg => msg.topic === 'task.completed');
    assert(blockMsg, 'Should see block_on_task message');
    assert(completeMsg, 'Should see task.completed message');
    assert.strictEqual(completeMsg.payload.data.task_id, 'TASK-API-001');
  });
} finally {
  teardown();
}

// --- sendToRole + sendToAgent + queryAgent ---
console.log('\nDirect Agent Communication:');
setup();
try {
  const m = freshRequire('../messaging');

  // Initialize cursor for backend reader BEFORE messages
  m.initializeCursor('S-backend-1');

  test('sendToRole addresses by role', () => {
    const result = m.sendToRole('S-frontend-1', 'backend', 'api.contract', { endpoint: '/users' });
    assert.strictEqual(result.success, true);
  });

  test('sendToAgent addresses by name', () => {
    const result = m.sendToAgent('S-frontend-1', 'backend-1', 'api.question', { q: 'What format?' });
    assert.strictEqual(result.success, true);
  });

  test('queryAgent sends query with ack', () => {
    const result = m.queryAgent('S-frontend-1', 'backend', 'What is the user schema?');
    assert.strictEqual(result.success, true);
  });

  test('respondToQuery sends correlated response', () => {
    const result = m.respondToQuery('S-backend-1', 'M-query-123', 'S-frontend-1', { schema: { id: 'string' } });
    assert.strictEqual(result.success, true);
  });

  test('role-addressed messages readable by role reader', () => {
    const { messages } = m.readMessages('S-backend-1', { role: 'backend', includeExpired: true });
    const roleMessages = messages.filter(msg => msg.to_role === 'backend');
    assert(roleMessages.length >= 1, 'Backend should receive role-addressed messages');
  });
} finally {
  teardown();
}

// --- sendWithEscalation ---
console.log('\nEscalation Chain:');
setup();
try {
  const m = freshRequire('../messaging');

  test('sendWithEscalation sends with chain metadata', () => {
    const result = m.sendWithEscalation(
      'S-frontend-1',
      'S-backend-1',
      'api.urgent_request',
      { need: 'endpoint now' },
      [
        { level: 'peer', timeout_ms: 5000, retries: 1 },
        { level: 'pm', timeout_ms: 10000, retries: 1 },
        { level: 'human', timeout_ms: 0, retries: 0 }
      ]
    );
    assert.strictEqual(result.success, true);
    assert(result.escalation_chain, 'Should return escalation chain');
    assert.strictEqual(result.escalation_chain.length, 3);
  });

  test('DEFAULT_ESCALATION_CHAIN has 3 levels', () => {
    assert(m.DEFAULT_ESCALATION_CHAIN, 'Should export DEFAULT_ESCALATION_CHAIN');
    assert.strictEqual(m.DEFAULT_ESCALATION_CHAIN.length, 3);
    assert.strictEqual(m.DEFAULT_ESCALATION_CHAIN[0].level, 'peer');
    assert.strictEqual(m.DEFAULT_ESCALATION_CHAIN[2].level, 'human');
  });
} finally {
  teardown();
}

// --- sendToCapability ---
console.log('\nCapability-based Routing:');
setup();
try {
  const m = freshRequire('../messaging');

  test('sendToCapability fails when no agent has capability', () => {
    const result = m.sendToCapability('S-test', 'quantum_computing', 'test', {});
    assert.strictEqual(result.success, false);
    assert(result.error.includes('No active agent'), 'Should report no agent found');
  });

  test('sendToCapability routes to matching agent', () => {
    createMockSession('S-be-1', 'backend', 'backend-1', null);
    const result = m.sendToCapability('S-fe-1', 'api_design', 'api.request', { endpoint: '/users' });
    assert.strictEqual(result.success, true);
    assert(result.matched_agent, 'Should return matched agent info');
    assert.strictEqual(result.matched_agent.role, 'backend');
  });
} finally {
  teardown();
}

// --- delegateTaskWithBd ---
console.log('\nTask Delegation:');
setup();
try {
  const m = freshRequire('../messaging');

  // Initialize cursor for reader BEFORE delegation
  m.initializeCursor('S-reader');

  test('delegateTaskWithBd sends delegation message', () => {
    const result = m.delegateTaskWithBd('S-pm', 'frontend', {
      title: 'Build user profile page',
      description: 'Create responsive profile page with avatar upload'
    });
    assert.strictEqual(result.success, true);
    assert(result.message_id, 'Should return message ID');
    // bd_task_id may be null if bd is not available in test env
  });

  test('delegation message appears on bus', () => {
    const { messages } = m.readMessages('S-reader', { role: 'frontend', includeExpired: true });
    const delegation = messages.find(msg => msg.type === 'task_delegate');
    assert(delegation, 'Should see delegation message');
    assert.strictEqual(delegation.payload.data.title, 'Build user profile page');
  });
} finally {
  teardown();
}

// --- Integration: Two agents communicate ---
console.log('\nIntegration — Two-Agent Communication:');
setup();
try {
  const m = freshRequire('../messaging');

  createMockSession('S-fe', 'frontend', 'frontend-1', 'T-ui');
  createMockSession('S-be', 'backend', 'backend-1', 'T-api');

  // Initialize cursors BEFORE messages
  m.initializeCursor('S-fe');
  m.initializeCursor('S-be');

  test('frontend queries backend and backend responds', () => {
    // Frontend asks backend about API contract
    const query = m.queryAgent('S-fe', 'backend', 'What is the user endpoint schema?', {
      context: { component: 'UserProfile.tsx' }
    });
    assert.strictEqual(query.success, true);

    // Backend reads and finds the query
    const { messages: beMessages, cursor } = m.readMessages('S-be', {
      role: 'backend',
      includeExpired: true
    });
    const incoming = beMessages.find(msg => msg.type === 'query');
    assert(incoming, 'Backend should receive query');

    // Backend responds
    const response = m.respondToQuery('S-be', incoming.id, 'S-fe', {
      schema: { id: 'string', name: 'string', email: 'string' }
    });
    assert.strictEqual(response.success, true);

    // Frontend reads response
    const { messages: feMessages } = m.readMessages('S-fe', { includeExpired: true });
    const reply = feMessages.find(msg =>
      msg.type === 'response' && msg.correlation_id === incoming.id
    );
    assert(reply, 'Frontend should receive response');
    assert(reply.payload.data.schema, 'Response should contain schema');
  });
} finally {
  teardown();
}

// ============================================================================
// RESULTS
// ============================================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
