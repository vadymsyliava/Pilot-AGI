/**
 * Tests for agent-context.js — Shared Working Context
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/agent-context.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Test helpers
let testDir;
const origCwd = process.cwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ac-test-'));

  // Create required directory structure
  fs.mkdirSync(path.join(testDir, '.claude/pilot/memory/channels'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/memory/agents'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/agent-board'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/messages'), { recursive: true });

  // Create memory index
  fs.writeFileSync(path.join(testDir, '.claude/pilot/memory/index.json'), JSON.stringify({
    version: 1,
    channels: {}
  }));

  // Create agent registry
  fs.writeFileSync(path.join(testDir, '.claude/pilot/agent-registry.json'), JSON.stringify({
    version: '1.1',
    agents: {
      frontend: {
        name: 'Frontend Agent',
        capabilities: ['component_creation', 'styling'],
        file_patterns: ['**/*.tsx', '**/components/**/*'],
        excluded_patterns: ['**/api/**/*']
      },
      backend: {
        name: 'Backend Agent',
        capabilities: ['api_design', 'database_operations'],
        file_patterns: ['**/api/**/*', '**/server/**/*'],
        excluded_patterns: []
      }
    }
  }));

  // Mock process.cwd
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

  // Create lockfile for isSessionAlive
  const lockDir = path.join(testDir, '.claude/pilot/state/locks');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, `${sessionId}.lock`), JSON.stringify({
    session_id: sessionId,
    pid: process.pid,
    parent_pid: process.pid,
    created_at: new Date().toISOString()
  }));
}

// Clear require cache to get fresh modules with mocked cwd
function freshRequire(mod) {
  Object.keys(require.cache).forEach(key => {
    if (key.includes('.claude/pilot')) delete require.cache[key];
  });
  return require(mod);
}

// ============================================================================
// TESTS
// ============================================================================

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

console.log('\n=== agent-context.js tests ===\n');

// --- publishProgress + getWorkingContext ---
console.log('Status Publishing:');
setup();
try {
  const ac = freshRequire('../agent-context');

  test('publishProgress creates context entry', () => {
    createMockSession('S-test-1111', 'frontend', 'frontend-1', 'TASK-001');
    ac.publishProgress('S-test-1111', {
      taskId: 'TASK-001',
      taskTitle: 'Build login page',
      step: 2,
      totalSteps: 5,
      filesModified: ['src/Login.tsx'],
      status: 'working'
    });
    const ctx = ac.getWorkingContext();
    assert(ctx['S-test-1111'], 'Should have entry for session');
    assert.strictEqual(ctx['S-test-1111'].task_id, 'TASK-001');
    assert.strictEqual(ctx['S-test-1111'].status, 'working');
  });

  test('getStatusBoard returns summary', () => {
    const board = ac.getStatusBoard();
    assert.strictEqual(board.total, 1);
    assert.strictEqual(board.working, 1);
    assert.strictEqual(board.idle, 0);
  });

  test('removeAgent cleans up entry', () => {
    ac.removeAgent('S-test-1111');
    const ctx = ac.getWorkingContext();
    assert(!ctx['S-test-1111'], 'Entry should be removed');
  });
} finally {
  teardown();
}

// --- getAgentContext ---
console.log('\nAgent Context:');
setup();
try {
  const ac = freshRequire('../agent-context');

  test('getAgentContext returns null for unknown session', () => {
    const ctx = ac.getAgentContext('S-nonexistent');
    assert.strictEqual(ctx, null);
  });

  test('getAgentContext returns status with decisions/discoveries', () => {
    createMockSession('S-test-2222', 'backend', 'backend-1', 'TASK-002');
    ac.publishProgress('S-test-2222', {
      taskId: 'TASK-002',
      status: 'working'
    });
    const ctx = ac.getAgentContext('S-test-2222');
    assert(ctx, 'Should return context');
    assert.strictEqual(ctx.session_id, 'S-test-2222');
    assert(Array.isArray(ctx.recent_decisions));
    assert(Array.isArray(ctx.recent_discoveries));
  });
} finally {
  teardown();
}

// --- getAgentsOnFiles ---
console.log('\nFile Conflict Detection:');
setup();
try {
  const ac = freshRequire('../agent-context');

  test('getAgentsOnFiles detects overlapping files', () => {
    createMockSession('S-test-3333', 'frontend', 'frontend-1', 'T-1');
    ac.publishProgress('S-test-3333', {
      taskId: 'T-1',
      filesModified: ['src/App.tsx', 'src/Login.tsx'],
      status: 'working'
    });

    const overlap = ac.getAgentsOnFiles(['src/Login.tsx']);
    assert.strictEqual(overlap.length, 1);
    assert.deepStrictEqual(overlap[0].overlapping_files, ['src/Login.tsx']);
  });

  test('getAgentsOnFiles excludes specified session', () => {
    const overlap = ac.getAgentsOnFiles(['src/Login.tsx'], 'S-test-3333');
    assert.strictEqual(overlap.length, 0);
  });
} finally {
  teardown();
}

// --- discoverAgentByCap ---
console.log('\nService Discovery:');
setup();
try {
  const ac = freshRequire('../agent-context');

  test('discoverAgentByCap finds agents with capability', () => {
    createMockSession('S-test-4444', 'backend', 'backend-1', null);
    const agents = ac.discoverAgentByCap('api_design');
    assert.strictEqual(agents.length, 1);
    assert.strictEqual(agents[0].role, 'backend');
  });

  test('discoverAgentByCap returns empty for unknown capability', () => {
    const agents = ac.discoverAgentByCap('quantum_computing');
    assert.strictEqual(agents.length, 0);
  });
} finally {
  teardown();
}

// --- discoverAgentByFile ---
console.log('\nFile-based Discovery:');
setup();
try {
  const ac = freshRequire('../agent-context');

  test('discoverAgentByFile matches frontend patterns', () => {
    createMockSession('S-test-5555', 'frontend', 'frontend-1', null);
    const agent = ac.discoverAgentByFile('src/components/Button.tsx');
    assert(agent, 'Should find an agent');
    assert.strictEqual(agent.role, 'frontend');
  });

  test('discoverAgentByFile matches backend patterns', () => {
    createMockSession('S-test-6666', 'backend', 'backend-1', null);
    const agent = ac.discoverAgentByFile('src/api/users/route.ts');
    assert(agent, 'Should find an agent');
    assert.strictEqual(agent.role, 'backend');
  });

  test('discoverAgentByFile returns null for unmatched file', () => {
    const agent = ac.discoverAgentByFile('README.md');
    assert.strictEqual(agent, null);
  });
} finally {
  teardown();
}

// --- Context Injection ---
console.log('\nContext Injection:');
setup();
try {
  const ac = freshRequire('../agent-context');

  test('injectContext attaches context to messages with file refs', () => {
    createMockSession('S-test-7777', 'frontend', 'frontend-1', 'T-3');
    ac.publishProgress('S-test-7777', {
      taskId: 'T-3',
      filesModified: ['src/Form.tsx'],
      status: 'working'
    });

    const messages = [{
      id: 'M-test-1',
      from: 'S-other',
      topic: 'code.review',
      payload: { data: { files: ['src/Form.tsx'] } }
    }];

    const enriched = ac.injectContext('S-reader', messages);
    assert.strictEqual(enriched.length, 1);
    // Should not throw
  });

  test('injectContext handles empty messages', () => {
    const enriched = ac.injectContext('S-reader', []);
    assert.strictEqual(enriched.length, 0);
  });
} finally {
  teardown();
}

// --- Human Escalation ---
console.log('\nHuman Escalation:');
setup();
try {
  const ac = freshRequire('../agent-context');

  test('recordHumanEscalation creates entry', () => {
    const entry = ac.recordHumanEscalation({
      from: 'S-test-8888',
      reason: 'Agent unresponsive after 3 retries',
      original_message_id: 'M-test-2'
    });
    assert(entry.ts, 'Should have timestamp');
    assert.strictEqual(entry.resolved, false);
  });

  test('getPendingHumanEscalations returns unresolved', () => {
    const pending = ac.getPendingHumanEscalations();
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].reason, 'Agent unresponsive after 3 retries');
  });
} finally {
  teardown();
}

// --- getDelegatedTasks ---
console.log('\nDelegated Tasks:');
setup();
try {
  const ac = freshRequire('../agent-context');

  test('getDelegatedTasks returns empty when no bus', () => {
    const tasks = ac.getDelegatedTasks('S-test-9999');
    assert.strictEqual(tasks.length, 0);
  });

  test('getDelegatedTasks finds delegations', () => {
    const busPath = path.join(testDir, '.claude/pilot/messages/bus.jsonl');
    const msg = {
      id: 'M-del-1',
      type: 'task_delegate',
      from: 'S-pm',
      to: 'S-test-9999',
      topic: 'task.assign',
      payload: { data: { title: 'Build API' } }
    };
    fs.appendFileSync(busPath, JSON.stringify(msg) + '\n');

    const tasks = ac.getDelegatedTasks('S-test-9999', 'to');
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].from, 'S-pm');
  });
} finally {
  teardown();
}

// ============================================================================
// RESULTS
// ============================================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
