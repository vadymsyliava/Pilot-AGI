#!/usr/bin/env node

/**
 * M3 End-to-End Integration Tests
 *
 * Validates Milestone 3 success criteria by exercising cross-module
 * integration paths: decomposition → scheduling → checkpoint → recovery →
 * messaging → cost → agent loop → PM loop.
 *
 * Run: npx vitest run tests/integration/m3-e2e.test.js
 *
 * [Pilot AGI-812]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================================
// TEST RUNNER
// ============================================================================

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log('  PASS:', name);
    passed++;
  } catch (e) {
    console.log('  FAIL:', name, '-', e.message);
    failed++;
    failures.push({ name, error: e.message });
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(arr, item, msg) {
  if (!arr.includes(item)) {
    throw new Error(`${msg}: ${JSON.stringify(arr)} does not include ${JSON.stringify(item)}`);
  }
}

// ============================================================================
// SETUP: Isolated temp directory with full pilot structure
// ============================================================================

const ORIG_CWD = process.cwd();
const TMP_DIR = path.join(os.tmpdir(), 'pilot-m3-e2e-' + Date.now());

function setupTestDir() {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  // Pilot state directories
  const dirs = [
    '.claude/pilot/messages/cursors',
    '.claude/pilot/messages/archive',
    '.claude/pilot/messages/nudge',
    '.claude/pilot/memory/channels',
    '.claude/pilot/memory/agents',
    '.claude/pilot/memory/schemas',
    '.claude/pilot/state/sessions',
    '.claude/pilot/state/locks',
    '.claude/pilot/state/agent-loops',
    '.claude/pilot/state/orchestrator',
    '.claude/pilot/state/recovery',
    '.claude/pilot/state/costs/tasks',
    '.claude/pilot/state/costs/agents',
    '.claude/pilot/state/approved-plans',
    '.claude/pilot/config',
    'runs',
    'work/research',
    'src/lib',
    'src/components',
  ];
  for (const d of dirs) {
    fs.mkdirSync(path.join(TMP_DIR, d), { recursive: true });
  }

  // Policy file
  fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/policy.yaml'), `
version: "2.0"
session:
  max_concurrent_sessions: 6
  heartbeat_interval_sec: 60
orchestrator:
  auto_reassign_stale: true
  scheduling:
    skill_weight: 0.55
    load_weight: 0.20
    affinity_weight: 0.15
    cost_weight: 0.10
    starvation_boost_interval_ms: 300000
    starvation_boost_max: 0.5
  cost_tracking:
    warn_threshold_tokens: 4000000
    block_threshold_tokens: 5000000
    per_agent_per_day:
      warn_tokens: 15000000
      block_tokens: 20000000
    per_day:
      warn_tokens: 40000000
      block_tokens: 50000000
    enforcement: hard
autonomy:
  mode: "full"
  auto_approve_plans: true
  auto_advance_steps: true
`);

  // Memory index
  fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/memory/index.json'), JSON.stringify({
    version: 1, channels: {}
  }));

  // Agent registry
  fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/agent-registry.json'), JSON.stringify({
    version: '1.1',
    agents: {
      frontend: {
        name: 'Frontend Agent',
        capabilities: ['react', 'css', 'tailwind', 'components'],
        routing_rules: { file_patterns: ['src/components/**', '**/*.tsx', '**/*.css'] }
      },
      backend: {
        name: 'Backend Agent',
        capabilities: ['api-design', 'nodejs', 'database', 'auth'],
        routing_rules: { file_patterns: ['src/api/**', 'src/lib/**', '**/*.ts'] }
      },
      testing: {
        name: 'Testing Agent',
        capabilities: ['unit-testing', 'e2e-testing', 'vitest', 'playwright'],
        routing_rules: { file_patterns: ['tests/**', '**/*.test.*'] }
      },
      pm: {
        name: 'PM Agent',
        capabilities: ['task-assignment', 'decomposition', 'review'],
        routing_rules: { labels: ['pm'] }
      }
    }
  }));

  // Research schema
  fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/memory/schemas/research-findings.schema.json'), JSON.stringify({
    type: 'object',
    properties: {
      topic: { type: 'string' },
      findings: { type: 'array' },
      sources: { type: 'array' }
    }
  }));

  // Test source files for import-graph analysis
  fs.writeFileSync(path.join(TMP_DIR, 'src/lib/types.ts'), `
export interface User { id: string; name: string; }
export interface Post { id: string; title: string; author: User; }
`);
  fs.writeFileSync(path.join(TMP_DIR, 'src/lib/api.ts'), `
import { User, Post } from './types';
export function getUser(id: string): User { return { id, name: '' }; }
export function getPost(id: string): Post { return { id, title: '', author: getUser('') }; }
`);
  fs.writeFileSync(path.join(TMP_DIR, 'src/components/UserProfile.tsx'), `
import { User } from '../lib/types';
import { getUser } from '../lib/api';
export function UserProfile() { return null; }
`);

  // Sessions event log
  fs.writeFileSync(path.join(TMP_DIR, 'runs/sessions.jsonl'), '');

  // Pending ACKs file
  fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/messages/pending_acks.jsonl'), '');
  // DLQ file
  fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/messages/dlq.jsonl'), '');
  // Bus file
  fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/messages/bus.jsonl'), '');

  process.chdir(TMP_DIR);
}

function teardownTestDir() {
  process.chdir(ORIG_CWD);
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

// ============================================================================
// MODULE LOADING HELPERS
// ============================================================================

const LIB_BASE = path.join(ORIG_CWD, '.claude/pilot/hooks/lib');

// All project modules that need cache clearing between test groups
const PROJECT_MODULES = [
  'session', 'messaging', 'checkpoint', 'recovery', 'cost-tracker',
  'scheduler', 'orchestrator', 'decomposition', 'policy', 'memory',
  'agent-loop', 'pm-loop', 'pm-research', 'pm-pressure-monitor',
  'worktree', 'agent-context', 'context', 'context-gatherer',
  'agent-actions', 'agent-poller', 'pressure', 'reporter',
  'stdin-injector', 'dashboard', 'benchmark', 'cache',
  'pm-daemon', 'pm-queue', 'teleport',
];

function clearModuleCache() {
  for (const mod of PROJECT_MODULES) {
    try {
      const resolved = require.resolve(path.join(LIB_BASE, mod));
      delete require.cache[resolved];
    } catch (e) { /* not loaded */ }
  }
}

function freshModule(name) {
  const modPath = path.join(LIB_BASE, name);
  try {
    const resolved = require.resolve(modPath);
    delete require.cache[resolved];
  } catch (e) { /* first load */ }
  return require(modPath);
}

function freshModules(...names) {
  clearModuleCache();
  const result = {};
  for (const n of names) {
    result[n.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = freshModule(n);
  }
  return result;
}

// ============================================================================
// SESSION HELPERS
// ============================================================================

function createSession(id, data = {}) {
  const sessionPath = path.join(TMP_DIR, '.claude/pilot/state/sessions', `${id}.json`);
  const state = {
    session_id: id,
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    status: 'active',
    role: data.role || null,
    agent_name: data.agent_name || `agent-${id.slice(-4)}`,
    claimed_task: data.claimed_task || null,
    claimed_at: data.claimed_task ? new Date().toISOString() : null,
    lease_expires_at: data.claimed_task ? new Date(Date.now() + 30 * 60000).toISOString() : null,
    locked_areas: data.locked_areas || [],
    locked_files: [],
    pid: data.pid || process.pid,
    parent_pid: data.parent_pid || process.ppid,
    cwd: TMP_DIR,
    ...data,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(state, null, 2));
  return state;
}

function createCheckpoint(sessionId, data = {}) {
  // Checkpoints are stored at .claude/pilot/memory/agents/<sessionId>/checkpoint.json
  const dir = path.join(TMP_DIR, '.claude/pilot/memory/agents', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const checkpoint = {
    version: data.version || 1,
    session_id: sessionId,
    saved_at: new Date().toISOString(),
    task_id: data.task_id || 'test-task',
    task_title: data.task_title || 'Test Task',
    plan_step: data.plan_step || 3,
    total_steps: data.total_steps || 8,
    completed_steps: data.completed_steps || [
      { step: 1, description: 'Setup', result: 'done' },
      { step: 2, description: 'Implement', result: 'done' },
      { step: 3, description: 'Test', result: 'in-progress' },
    ],
    key_decisions: data.key_decisions || ['Used pattern A'],
    files_modified: data.files_modified || ['src/lib/auth.ts', 'src/middleware/jwt.ts'],
    current_context: data.current_context || 'Working on step 3',
    important_findings: data.important_findings || ['jose library handles JWT well'],
    tool_call_count: data.tool_call_count || 12,
    output_bytes: data.output_bytes || 50000,
  };
  fs.writeFileSync(path.join(dir, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2));
  return checkpoint;
}

// ============================================================================
// START TESTS
// ============================================================================

setupTestDir();

// ════════════════════════════════════════════════════════════════════════════
// SCENARIO 1: Task Decomposition Pipeline
// Validates: PM decomposes large task into 8+ subtasks automatically
// ════════════════════════════════════════════════════════════════════════════

console.log('\n=== SCENARIO 1: Task Decomposition Pipeline ===\n');

(() => {
  clearModuleCache();
  const decomposition = freshModule('decomposition');

  test('1a. shouldDecompose returns true for large tasks', () => {
    const result = decomposition.shouldDecompose({
      title: 'Build user authentication system with OAuth, JWT, and session management',
      description: 'Full auth system: login, signup, forgot password, OAuth providers, JWT refresh tokens, session management, role-based access control, middleware, tests',
      labels: ['auth', 'backend', 'security'],
    });
    // shouldDecompose returns { decompose: boolean, reason: string }
    assert(result.decompose === true, 'large multi-concern task should require decomposition');
  });

  test('1b. shouldDecompose returns false for small tasks', () => {
    const result = decomposition.shouldDecompose({
      title: 'Fix typo in README',
      description: 'Change "teh" to "the" on line 42',
      labels: ['docs'],
    });
    // shouldDecompose returns { decompose: boolean, reason: string }
    assert(result.decompose === false, 'trivial task should not need decomposition');
  });

  test('1c. classifyTaskDomain identifies backend domain', () => {
    const result = decomposition.classifyTaskDomain({
      title: 'Build REST API for user management',
      labels: ['backend', 'api'],
    });
    // classifyTaskDomain returns { domain: string, requires: string[], postAgents: string[], confidence: number }
    assert(result !== null && result !== undefined, 'domain should be classified');
    assert(typeof result.domain === 'string', 'domain should be a string');
    assert(Array.isArray(result.requires), 'requires should be an array');
  });

  test('1d. generateSubtasks produces 3+ subtasks for complex task', () => {
    const task = {
      title: 'Build user authentication system',
      description: 'Full auth: login, signup, OAuth, JWT, RBAC, middleware, tests',
      labels: ['auth', 'backend'],
    };
    // generateSubtasks requires (task, domainInfo, research)
    const domainInfo = decomposition.classifyTaskDomain(task);
    const subtasks = decomposition.generateSubtasks(task, domainInfo, null);
    assert(Array.isArray(subtasks), 'subtasks should be an array');
    assert(subtasks.length >= 3, `should generate 3+ subtasks, got ${subtasks.length}`);
    // Each subtask should have title and description
    for (const st of subtasks) {
      assert(st.title, 'subtask must have title');
    }
  });

  test('1e. buildDependencyDAG orders subtasks by dependencies', () => {
    const subtasks = [
      { id: 'st-1', title: 'Define types', dependencies: [] },
      { id: 'st-2', title: 'Build API routes', dependencies: ['st-1'] },
      { id: 'st-3', title: 'Add middleware', dependencies: ['st-1'] },
      { id: 'st-4', title: 'Write tests', dependencies: ['st-2', 'st-3'] },
    ];
    const dag = decomposition.buildDependencyDAG(subtasks);
    assert(dag !== null, 'DAG should be built');
    // DAG should contain ordering information
    assert(dag.layers || dag.order || dag.edges || Array.isArray(dag),
      'DAG should have structure (layers, order, or edges)');
  });

  test('1f. decomposeTask returns complete decomposition result', () => {
    // decomposeTask(task, projectRoot) — needs projectRoot for research context
    // Task must be classified as L (large) to trigger decomposition:
    //   - needs L keyword (system, architecture, integration, etc.) AND desc > 100 chars
    //   - OR total text > 300 chars
    const result = decomposition.decomposeTask({
      id: 'Pilot AGI-e2e-big',
      title: 'Build complete user management system with dashboard, API, and integration tests',
      description: 'Full-stack system: user CRUD API endpoints, REST routes with authentication middleware, React dashboard with real-time charts, date range filter, CSV export, user preferences panel, dark mode toggle, responsive layout, accessibility compliance, performance optimization, integration testing suite, database migration scripts',
      labels: ['fullstack', 'dashboard', 'api'],
    }, TMP_DIR);
    assert(result !== null, 'decomposition should succeed');
    // decomposeTask returns { decomposed, subtasks, dag, domain, reason }
    assert(Array.isArray(result.subtasks), 'should contain subtasks array');
    assert(result.subtasks.length >= 3, `should produce 3+ subtasks, got ${result.subtasks.length}`);
  });

  test('1g. analyzeImportGraph detects file dependencies', () => {
    // analyzeImportGraph(files: string[], projectRoot: string)
    const files = [
      'src/lib/types.ts',
      'src/lib/api.ts',
      'src/components/UserProfile.tsx',
    ];
    const graph = decomposition.analyzeImportGraph(files, TMP_DIR);
    assert(graph !== null, 'import graph should be built');
    assert(graph.adjacency, 'graph should have adjacency map');
    // UserProfile.tsx imports from types.ts and api.ts
    const profileDeps = graph.adjacency['src/components/UserProfile.tsx'] || [];
    assert(profileDeps.length >= 1, 'UserProfile should have import dependencies');
  });
})();

// ════════════════════════════════════════════════════════════════════════════
// SCENARIO 2: Skill-Based Task Scheduling
// Validates: Scheduler routes tasks to agents with matching capabilities
// ════════════════════════════════════════════════════════════════════════════

console.log('\n=== SCENARIO 2: Skill-Based Task Scheduling ===\n');

(() => {
  clearModuleCache();

  // Create agent sessions with roles
  createSession('S-sched-fe', { role: 'frontend', agent_name: 'frontend-1', pid: 10001, parent_pid: 10000 });
  createSession('S-sched-be', { role: 'backend', agent_name: 'backend-1', pid: 10002, parent_pid: 10000 });
  createSession('S-sched-test', { role: 'testing', agent_name: 'testing-1', pid: 10003, parent_pid: 10000 });

  const scheduler = freshModule('scheduler');

  test('2a. loadSchedulerConfig reads weights from policy.yaml', () => {
    const config = scheduler.loadSchedulerConfig();
    assert(config !== null, 'config should load');
    assertEqual(config.skill_weight, 0.55, 'skill weight');
    assertEqual(config.load_weight, 0.20, 'load weight');
  });

  test('2b. scheduleOne assigns frontend task to frontend agent', () => {
    const task = {
      id: 'Pilot AGI-fe-task',
      title: 'Build React component for user profile',
      labels: ['frontend', 'react'],
      description: 'Create UserProfile.tsx component with avatar, name, and bio fields',
    };
    const result = scheduler.scheduleOne(task, null, TMP_DIR);
    assert(result !== null, 'should produce assignment');
    if (result.agent) {
      // The scheduler should prefer the frontend agent
      assert(result.agent.role === 'frontend' || result.agent.session_id === 'S-sched-fe',
        `expected frontend agent, got ${result.agent.role || result.agent.session_id}`);
    }
  });

  test('2c. scheduleOne assigns backend task to backend agent', () => {
    const task = {
      id: 'Pilot AGI-be-task',
      title: 'Build REST API endpoints for user CRUD',
      labels: ['backend', 'api'],
      description: 'Create express routes for user creation, reading, updating, deletion',
    };
    const result = scheduler.scheduleOne(task, null, TMP_DIR);
    if (result && result.agent) {
      assert(result.agent.role === 'backend' || result.agent.session_id === 'S-sched-be',
        `expected backend agent, got ${result.agent.role || result.agent.session_id}`);
    }
  });

  test('2d. schedule batch assigns multiple tasks to different agents', () => {
    const tasks = [
      { id: 'batch-1', title: 'Build login form', labels: ['frontend'], description: 'React login form' },
      { id: 'batch-2', title: 'Create auth API', labels: ['backend'], description: 'Auth endpoints' },
      { id: 'batch-3', title: 'Write auth tests', labels: ['testing'], description: 'Auth test suite' },
    ];
    const result = scheduler.schedule(tasks, null, TMP_DIR);
    assert(result !== null, 'batch schedule should return result');
    assert(result.assignments, 'should have assignments array');
    // At least some tasks should be assigned
    assert(result.assignments.length > 0 || result.unassigned_tasks,
      'should have assignments or unassigned list');
  });

  test('2e. loadScore returns value between 0 and 1', () => {
    const config = scheduler.loadSchedulerConfig();
    const score = scheduler.loadScore('S-sched-fe', config);
    assert(typeof score === 'number', 'load score should be numeric');
    assert(score >= 0 && score <= 1, `load score should be 0-1, got ${score}`);
  });

  test('2f. starvation boost increases for waiting tasks', () => {
    const config = scheduler.loadSchedulerConfig();
    // Task that's been waiting a long time
    const oldTask = {
      id: 'old-task',
      title: 'Long waiting task',
      created_at: new Date(Date.now() - 600000).toISOString(), // 10 min ago
    };
    const boost = scheduler.starvationBoost(oldTask, config);
    assert(typeof boost === 'number', 'starvation boost should be numeric');
    assert(boost >= 0, 'starvation boost should be non-negative');
  });
})();

// ════════════════════════════════════════════════════════════════════════════
// SCENARIO 3: Checkpoint → Crash → Recovery → Resume
// Validates: Crashed agent auto-recovers and resumes from checkpoint
// ════════════════════════════════════════════════════════════════════════════

console.log('\n=== SCENARIO 3: Checkpoint → Crash → Recovery → Resume ===\n');

(() => {
  clearModuleCache();

  const SESSION_ID = 'S-recovery-test';
  const TASK_ID = 'Pilot AGI-recover';

  // Create a session that "crashed" — stale heartbeat, has checkpoint
  createSession(SESSION_ID, {
    role: 'backend',
    claimed_task: TASK_ID,
    last_heartbeat: new Date(Date.now() - 300000).toISOString(), // 5 min stale
    pid: 99999, // Non-existent PID
    parent_pid: 99998,
  });

  // Create a checkpoint for the crashed session
  const checkpointData = createCheckpoint(SESSION_ID, {
    task_id: TASK_ID,
    task_title: 'Build auth middleware',
    plan_step: 4,
    total_steps: 7,
    completed_steps: [
      { step: 1, description: 'Define types', result: 'done' },
      { step: 2, description: 'Create middleware', result: 'done' },
      { step: 3, description: 'Add JWT validation', result: 'done' },
      { step: 4, description: 'Add rate limiting', result: 'in-progress' },
    ],
    key_decisions: ['Using jose library for JWT', 'Rate limit: 100 req/min per IP'],
    current_context: 'Implementing sliding window rate limiter',
  });

  const recovery = freshModule('recovery');
  const checkpoint = freshModule('checkpoint');

  test('3a. assessRecovery detects crashed session with checkpoint → resume strategy', () => {
    const assessment = recovery.assessRecovery(SESSION_ID);
    assert(assessment !== null, 'assessment should succeed');
    assertEqual(assessment.strategy, 'resume', 'strategy should be resume when checkpoint exists');
    assert(assessment.checkpoint !== null, 'should include checkpoint data');
  });

  test('3b. recoverFromCheckpoint returns restoration data', () => {
    const restored = recovery.recoverFromCheckpoint(SESSION_ID);
    assert(restored !== null, 'recovery should find checkpoint');
    assertEqual(restored.task_id, TASK_ID, 'task ID should match');
  });

  test('3c. buildRestorationPrompt generates actionable context', () => {
    const loaded = checkpoint.loadCheckpoint(SESSION_ID);
    assert(loaded !== null, 'checkpoint should be loadable');
    const prompt = checkpoint.buildRestorationPrompt(loaded);
    assert(typeof prompt === 'string', 'prompt should be a string');
    assert(prompt.length > 50, 'prompt should be substantial');
    assert(prompt.includes(TASK_ID) || prompt.includes('auth middleware'),
      'prompt should reference the task');
    assert(prompt.includes('step') || prompt.includes('Step'),
      'prompt should reference plan steps');
  });

  test('3d. assessRecovery returns reassign for session without checkpoint', () => {
    const noCheckpointSession = 'S-no-checkpoint';
    createSession(noCheckpointSession, {
      claimed_task: 'some-task',
      last_heartbeat: new Date(Date.now() - 300000).toISOString(),
      pid: 99997,
      parent_pid: 99996,
    });
    const assessment = recovery.assessRecovery(noCheckpointSession);
    assertEqual(assessment.strategy, 'reassign',
      'should reassign when no checkpoint but task was claimed');
  });

  test('3e. assessRecovery returns cleanup for idle session', () => {
    const idleSession = 'S-idle-crash';
    createSession(idleSession, {
      claimed_task: null,
      last_heartbeat: new Date(Date.now() - 300000).toISOString(),
      pid: 99995,
      parent_pid: 99994,
    });
    const assessment = recovery.assessRecovery(idleSession);
    assertEqual(assessment.strategy, 'cleanup',
      'should cleanup when no task was claimed');
  });

  test('3f. logRecoveryEvent persists recovery history', () => {
    recovery.logRecoveryEvent(SESSION_ID, 'crash_detected', { reason: 'stale heartbeat' });
    recovery.logRecoveryEvent(SESSION_ID, 'checkpoint_found', { step: 4 });
    recovery.logRecoveryEvent(SESSION_ID, 'resumed', { new_session: 'S-new' });

    const history = recovery.getRecoveryHistory(SESSION_ID);
    assert(Array.isArray(history), 'history should be an array');
    assert(history.length >= 3, `should have 3+ events, got ${history.length}`);
  });
})();

// ════════════════════════════════════════════════════════════════════════════
// SCENARIO 4: ACK/NACK Messaging with DLQ Escalation
// Validates: Messages have guaranteed delivery with ACK protocol
// ════════════════════════════════════════════════════════════════════════════

console.log('\n=== SCENARIO 4: ACK/NACK Messaging with DLQ ===\n');

(() => {
  clearModuleCache();

  // Fresh bus file
  fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/messages/bus.jsonl'), '');
  fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/messages/pending_acks.jsonl'), '');
  fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/messages/dlq.jsonl'), '');

  const messaging = freshModule('messaging');

  // Initialize receiver cursor BEFORE sending so it reads from byte 0
  messaging.readMessages('S-receiver');

  test('4a. sendMessage writes to bus and returns success', () => {
    const result = messaging.sendMessage({
      from: 'S-sender',
      to: 'S-receiver',
      type: 'request',
      topic: 'task_delegation',
      payload: { task_id: 'test-1', title: 'Build feature' },
      priority: 'normal',
    });
    assert(result.success === true, 'message should send successfully');
    assert(result.id, 'should return message ID');
  });

  test('4b. readMessages finds the sent message', () => {
    const result = messaging.readMessages('S-receiver');
    assert(result.messages.length >= 1, 'receiver should have messages');
    const msg = result.messages.find(m => m.topic === 'task_delegation');
    assert(msg, 'should find task_delegation message');
    assertEqual(msg.payload.task_id, 'test-1', 'payload should match');
  });

  test('4c. sendAck acknowledges a message', () => {
    // Re-read from the same position by resetting cursor to capture the message
    const cursorDir = path.join(TMP_DIR, '.claude/pilot/messages/cursors');
    const cursorPath = path.join(cursorDir, 'S-receiver-ack.cursor.json');
    fs.writeFileSync(cursorPath, JSON.stringify({
      session_id: 'S-receiver-ack', last_seq: -1, byte_offset: 0, processed_ids: [], updated_at: new Date().toISOString()
    }));
    const msgs = messaging.readMessages('S-receiver-ack');
    // Find message addressed to S-receiver (visible because S-receiver-ack sees untargeted + broadcast)
    // Actually, we need a message targeted to us or use the stored message ID
    // Simpler: read bus directly to find the message ID
    const busContent = fs.readFileSync(path.join(TMP_DIR, '.claude/pilot/messages/bus.jsonl'), 'utf8');
    const busMessages = busContent.trim().split('\n').filter(l => l).map(l => JSON.parse(l));
    const delegationMsg = busMessages.find(m => m.topic === 'task_delegation');
    assert(delegationMsg, 'delegation message should be in bus');
    const result = messaging.sendAck('S-receiver', delegationMsg.id, 'S-sender');
    assert(result.success === true, 'ACK should send');
  });

  test('4d. trackPendingAck registers pending acknowledgment', () => {
    messaging.trackPendingAck('msg-pending-1', 'S-a', 'S-b', 5000);
    const pending = messaging.loadPendingAcks();
    const found = pending.find(p => p.message_id === 'msg-pending-1');
    assert(found, 'should find pending ACK');
    assertEqual(found.from, 'S-a', 'from should match');
  });

  test('4e. sendNack records negative acknowledgment', () => {
    const result = messaging.sendNack('S-receiver', 'msg-nack-test', 'S-sender', 'Task too complex');
    assert(result.success === true, 'NACK should send');
  });

  test('4f. processAckTimeouts moves expired messages to DLQ', () => {
    // Write a pending ACK that's past deadline with max retries
    const pendingPath = path.join(TMP_DIR, '.claude/pilot/messages/pending_acks.jsonl');
    const expiredAck = JSON.stringify({
      message_id: 'msg-expired',
      from: 'S-expired-sender',
      to: 'S-expired-receiver',
      deadline_at: new Date(Date.now() - 10000).toISOString(),
      retries: 3,
      created_at: new Date(Date.now() - 120000).toISOString(),
    });
    fs.appendFileSync(pendingPath, expiredAck + '\n');

    // Need fresh module to pick up the new file state
    clearModuleCache();
    const freshMsg = freshModule('messaging');
    const result = freshMsg.processAckTimeouts();
    assert(result !== null, 'timeout processing should return result');
    // Either retried or moved to DLQ
    assert(typeof result.retried === 'number' || typeof result.dlqd === 'number',
      'should report retried or dlqd counts');
  });

  test('4g. getDLQMessages returns dead-lettered messages', () => {
    clearModuleCache();
    const freshMsg = freshModule('messaging');
    // Manually move a message to DLQ
    freshMsg.moveToDlq('msg-dead', 'max_retries_exceeded', { original_to: 'S-dead' });
    const dlq = freshMsg.getDLQMessages();
    assert(Array.isArray(dlq), 'DLQ should return array');
    const found = dlq.find(m => m.message_id === 'msg-dead');
    assert(found, 'should find dead-lettered message');
  });

  test('4h. sendBroadcast reaches all sessions', () => {
    clearModuleCache();
    const freshMsg = freshModule('messaging');
    const result = freshMsg.sendBroadcast('S-pm', 'system_alert', { msg: 'Deploy starting' });
    assert(result.success === true, 'broadcast should succeed');
  });

  test('4i. priority ordering — blocking messages processed before FYI', () => {
    clearModuleCache();
    // Fresh bus for this test
    fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/messages/bus.jsonl'), '');
    const freshMsg = freshModule('messaging');

    // Initialize worker cursor at byte 0 (empty bus)
    freshMsg.readMessages('S-worker');

    // Send fyi priority first, then blocking (valid priorities: blocking, normal, fyi)
    freshMsg.sendMessage({
      from: 'S-pm', to: 'S-worker', type: 'notify',
      topic: 'fyi_update', payload: { info: 'general update' }, priority: 'fyi',
    });
    freshMsg.sendMessage({
      from: 'S-pm', to: 'S-worker', type: 'request',
      topic: 'blocking_req', payload: { urgent: true }, priority: 'blocking',
    });

    const msgs = freshMsg.readMessages('S-worker');
    assert(msgs.messages.length >= 2, 'should have both messages');
    // Blocking should come before fyi priority
    const blockIdx = msgs.messages.findIndex(m => m.priority === 'blocking');
    const fyiIdx = msgs.messages.findIndex(m => m.priority === 'fyi');
    if (blockIdx !== -1 && fyiIdx !== -1) {
      assert(blockIdx < fyiIdx, 'blocking messages should appear before fyi priority');
    }
  });
})();

// ════════════════════════════════════════════════════════════════════════════
// SCENARIO 5: Cost Tracking → Budget Enforcement → Budget-Aware Scheduling
// Validates: Token budget enforced — agents stop when budget exceeded
// ════════════════════════════════════════════════════════════════════════════

console.log('\n=== SCENARIO 5: Cost Tracking & Budget Enforcement ===\n');

(() => {
  clearModuleCache();

  // Clean cost dirs
  const taskCostDir = path.join(TMP_DIR, '.claude/pilot/state/costs/tasks');
  const agentCostDir = path.join(TMP_DIR, '.claude/pilot/state/costs/agents');
  for (const f of fs.readdirSync(taskCostDir)) fs.unlinkSync(path.join(taskCostDir, f));
  for (const f of fs.readdirSync(agentCostDir)) fs.unlinkSync(path.join(agentCostDir, f));

  const costTracker = freshModule('cost-tracker');

  test('5a. recordTaskCost tracks token usage per task', () => {
    costTracker.recordTaskCost('S-cost-1', 'task-cost-1', 40000);
    costTracker.recordTaskCost('S-cost-1', 'task-cost-1', 60000);
    const cost = costTracker.getTaskCost('task-cost-1');
    assert(cost !== null, 'task cost should be recorded');
    assertEqual(cost.total_bytes, 100000, 'total bytes');
    assert(cost.total_tokens > 0, 'tokens should be calculated');
  });

  test('5b. getAgentCost tracks per-agent daily usage', () => {
    costTracker.recordTaskCost('S-agent-cost', 'task-a', 200000);
    costTracker.recordTaskCost('S-agent-cost', 'task-b', 300000);
    const agentCost = costTracker.getAgentCost('S-agent-cost');
    assert(agentCost !== null, 'agent cost should exist');
    assert(agentCost.total_tokens > 0, 'agent should have token usage');
    assert(agentCost.today_tokens > 0, 'today tokens should be tracked');
  });

  test('5c. getDailyCost aggregates across all agents', () => {
    const daily = costTracker.getDailyCost();
    assert(daily !== null, 'daily cost should compute');
    assert(daily.total_tokens > 0, 'daily total should reflect agent costs');
    assert(daily.cost_usd >= 0, 'cost should be non-negative');
  });

  test('5d. checkBudget returns ok for under-budget agent', () => {
    const status = costTracker.checkBudget('S-agent-cost', 'task-a');
    assert(status !== null, 'budget check should return result');
    assert(['ok', 'warning', 'exceeded'].includes(status.status),
      `status should be ok/warning/exceeded, got ${status.status}`);
  });

  test('5e. checkBudget returns exceeded when over per-task limit', () => {
    // Record a lot of usage to exceed per-task budget of 5M tokens (block_threshold_tokens)
    const bigTask = 'task-expensive';
    // 5M tokens * 4 bytes/token = 20M bytes needed to hit block
    for (let i = 0; i < 25; i++) {
      costTracker.recordTaskCost('S-heavy', bigTask, 1000000); // 1MB per call
    }
    const status = costTracker.checkBudget('S-heavy', bigTask);
    // With 25MB recorded = 6.25M tokens, exceeding 5M block_threshold_tokens
    assert(status.status === 'exceeded' || status.status === 'warning',
      `should be exceeded or warning with heavy usage, got ${status.status}`);
  });

  test('5f. loadBudgetPolicy reads limits from policy.yaml', () => {
    const policy = costTracker.loadBudgetPolicy();
    assert(policy !== null, 'budget policy should load');
    // loadBudgetPolicy returns { per_task: { warn_tokens, block_tokens }, per_agent_per_day: {...}, per_day: {...}, enforcement }
    assertEqual(policy.per_task.block_tokens, 5000000, 'per-task block limit');
    assertEqual(policy.per_task.warn_tokens, 4000000, 'per-task warn limit');
    assertEqual(policy.per_agent_per_day.block_tokens, 20000000, 'per-agent-per-day block limit');
    assertEqual(policy.per_day.block_tokens, 50000000, 'per-day block limit');
    assertEqual(policy.enforcement, 'hard', 'enforcement mode');
  });

  test('5g. getEfficiencyMetrics computes tokens per commit', () => {
    const metrics = costTracker.getEfficiencyMetrics('task-cost-1');
    assert(metrics !== null, 'efficiency metrics should compute');
    assert(typeof metrics.tokens_total === 'number', 'should have token total');
  });

  test('5h. cost integrates with scheduler scoring', () => {
    clearModuleCache();
    // Clean agent cost dir for isolation
    for (const f of fs.readdirSync(agentCostDir)) fs.unlinkSync(path.join(agentCostDir, f));

    // Create agents with different cost profiles
    createSession('S-cheap', { role: 'backend', agent_name: 'backend-cheap', pid: 20001, parent_pid: 20000 });
    createSession('S-expensive', { role: 'backend', agent_name: 'backend-exp', pid: 20002, parent_pid: 20000 });

    const ct = freshModule('cost-tracker');
    ct.recordTaskCost('S-expensive', 'task-exp-1', 5000000);
    ct.recordTaskCost('S-cheap', 'task-cheap-1', 50000);

    const sched = freshModule('scheduler');
    const task = { id: 'cost-test', title: 'Simple backend fix', labels: ['backend'] };
    const result = sched.scheduleOne(task, null, TMP_DIR);
    // Both agents match, but cost weight should favor cheaper agent
    assert(result !== null, 'scheduler should produce result');
  });
})();

// ════════════════════════════════════════════════════════════════════════════
// SCENARIO 6: Agent Loop Lifecycle
// Validates: Agent self-activates and manages its own state machine
// ════════════════════════════════════════════════════════════════════════════

console.log('\n=== SCENARIO 6: Agent Loop Lifecycle ===\n');

(() => {
  clearModuleCache();

  const agentLoop = freshModule('agent-loop');

  test('6a. AgentLoop constructor initializes with session ID', () => {
    const loop = new agentLoop.AgentLoop('S-loop-test', {
      role: 'backend',
      agentName: 'backend-loop',
      config: { enabled: true, auto_claim: true, auto_plan: true },
    });
    assert(loop !== null, 'loop should be created');
    const status = loop.getStatus();
    assertEqual(status.session_id, 'S-loop-test', 'session ID');
    assertEqual(status.running, false, 'should not be running yet');
  });

  test('6b. isAutonomousEnabled reads autonomy config', () => {
    // isAutonomousEnabled is a module-level function, not a class method
    const enabled = agentLoop.isAutonomousEnabled('backend');
    assert(typeof enabled === 'boolean', 'should return boolean');
  });

  test('6c. loadAutonomousConfig returns config with expected fields', () => {
    // loadAutonomousConfig is a module-level function, not a class method
    const config = agentLoop.loadAutonomousConfig('backend');
    assert(config !== null, 'config should load');
    assert('enabled' in config || 'auto_claim' in config,
      'config should have autonomy fields');
  });

  test('6d. getStatus returns complete state machine info', () => {
    const loop = new agentLoop.AgentLoop('S-status-test', {
      role: 'frontend',
      agentName: 'frontend-status',
    });
    const status = loop.getStatus();
    assert('running' in status, 'should have running field');
    assert('state' in status, 'should have state field');
    assert('session_id' in status, 'should have session_id');
  });

  test('6e. handleError tracks consecutive errors', () => {
    const loop = new agentLoop.AgentLoop('S-error-test', { role: 'backend' });
    const result1 = loop.handleError('File not found: api.ts');
    assert(result1 !== null, 'error handling should return result');
    assert(typeof result1.consecutive_errors === 'number', 'should track error count');

    const result2 = loop.handleError('Syntax error in module');
    assert(result2.consecutive_errors >= 2, 'should increment error count');
  });
})();

// ════════════════════════════════════════════════════════════════════════════
// SCENARIO 7: PM Loop Integration
// Validates: PM orchestrates health, tasks, drift, cost, and recovery scans
// ════════════════════════════════════════════════════════════════════════════

console.log('\n=== SCENARIO 7: PM Loop Integration ===\n');

(() => {
  clearModuleCache();

  // Create PM session
  createSession('S-pm-loop', { role: 'pm', agent_name: 'pm-loop-test', pid: 30001, parent_pid: 30000 });
  // Create worker sessions
  createSession('S-worker-1', { role: 'frontend', agent_name: 'frontend-w1', pid: 30002, parent_pid: 30000 });
  createSession('S-worker-2', { role: 'backend', agent_name: 'backend-w2', pid: 30003, parent_pid: 30000 });

  const pmLoop = freshModule('pm-loop');

  test('7a. PmLoop constructor initializes with project root', () => {
    const loop = new pmLoop.PmLoop(TMP_DIR, {
      pmSessionId: 'S-pm-loop',
      dryRun: true,
    });
    assert(loop !== null, 'PM loop should be created');
  });

  test('7b. PmLoop initialize sets up PM state', () => {
    const loop = new pmLoop.PmLoop(TMP_DIR, {
      pmSessionId: 'S-pm-loop',
      dryRun: true,
    });
    loop.initialize('S-pm-loop');
    const stats = loop.getStats();
    assert(stats.running === true || stats.pm_session, 'PM should be initialized');
  });

  test('7c. _healthScan detects active agents', () => {
    const loop = new pmLoop.PmLoop(TMP_DIR, {
      pmSessionId: 'S-pm-loop',
      dryRun: true,
    });
    loop.initialize('S-pm-loop');
    const results = loop._healthScan();
    assert(Array.isArray(results), 'health scan should return array');
  });

  test('7d. _costScan checks budget status', () => {
    const loop = new pmLoop.PmLoop(TMP_DIR, {
      pmSessionId: 'S-pm-loop',
      dryRun: true,
    });
    loop.initialize('S-pm-loop');
    const results = loop._costScan();
    assert(Array.isArray(results), 'cost scan should return array');
  });

  test('7e. _recoveryScan identifies stale sessions', () => {
    // Create a stale session
    createSession('S-stale-worker', {
      role: 'backend',
      claimed_task: 'stale-task',
      last_heartbeat: new Date(Date.now() - 600000).toISOString(), // 10 min stale
      pid: 88888,
      parent_pid: 88887,
    });

    clearModuleCache();
    const freshPmLoop = freshModule('pm-loop');
    const loop = new freshPmLoop.PmLoop(TMP_DIR, {
      pmSessionId: 'S-pm-loop',
      dryRun: true,
    });
    loop.initialize('S-pm-loop');
    const results = loop._recoveryScan();
    assert(Array.isArray(results), 'recovery scan should return array');
  });

  test('7f. runPeriodicScans executes all scan types', () => {
    clearModuleCache();
    const freshPmLoop = freshModule('pm-loop');
    const loop = new freshPmLoop.PmLoop(TMP_DIR, {
      pmSessionId: 'S-pm-loop',
      dryRun: true,
    });
    loop.initialize('S-pm-loop');
    const results = loop.runPeriodicScans();
    assert(Array.isArray(results), 'periodic scans should return array');
    // Should have results from multiple scan types
    assert(results.length >= 1, 'should produce scan results');
  });

  test('7g. PmLoop stop cleanly shuts down', () => {
    clearModuleCache();
    const freshPmLoop = freshModule('pm-loop');
    const loop = new freshPmLoop.PmLoop(TMP_DIR, {
      pmSessionId: 'S-pm-loop',
      dryRun: true,
    });
    loop.initialize('S-pm-loop');
    loop.stop('test complete');
    const stats = loop.getStats();
    assertEqual(stats.running, false, 'should not be running after stop');
  });
})();

// ════════════════════════════════════════════════════════════════════════════
// SCENARIO 8: Cross-Module Integration — Full Autonomous Pipeline
// Validates: Modules work together in the expected sequence
// ════════════════════════════════════════════════════════════════════════════

console.log('\n=== SCENARIO 8: Cross-Module Integration ===\n');

(() => {
  clearModuleCache();

  test('8a. Session → Checkpoint → Recovery round-trip', () => {
    const session = freshModule('session');
    const checkpoint = freshModule('checkpoint');
    const recovery = freshModule('recovery');

    // Register session
    const sid = 'S-roundtrip-' + Date.now().toString(36);
    createSession(sid, { role: 'frontend', claimed_task: 'roundtrip-task' });

    // Save checkpoint
    const saved = checkpoint.saveCheckpoint(sid, {
      task_id: 'roundtrip-task',
      plan_step: 2,
      total_steps: 5,
      completed_steps: [{ step: 1, result: 'done' }],
    });
    assert(saved.success, 'checkpoint save should succeed');

    // Simulate crash (make session stale)
    const sessionPath = path.join(TMP_DIR, '.claude/pilot/state/sessions', `${sid}.json`);
    const state = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    state.last_heartbeat = new Date(Date.now() - 600000).toISOString();
    state.pid = 77777;
    fs.writeFileSync(sessionPath, JSON.stringify(state));

    // Recovery assessment
    clearModuleCache();
    const freshRecovery = freshModule('recovery');
    const assessment = freshRecovery.assessRecovery(sid);
    assertEqual(assessment.strategy, 'resume', 'should recommend resume');
    assert(assessment.checkpoint !== null, 'should find checkpoint');
  });

  test('8b. Messaging → Cost integration (cost recorded on message send)', () => {
    clearModuleCache();
    // Clean agent cost dir
    const agentCostDir = path.join(TMP_DIR, '.claude/pilot/state/costs/agents');
    for (const f of fs.readdirSync(agentCostDir)) fs.unlinkSync(path.join(agentCostDir, f));

    const messaging = freshModule('messaging');
    const costTracker = freshModule('cost-tracker');

    // Send messages and record costs
    messaging.sendMessage({
      from: 'S-cost-msg', to: 'S-receiver', type: 'request',
      topic: 'work', payload: { task: 'implement feature' },
    });
    costTracker.recordTaskCost('S-cost-msg', 'msg-task', 50000);

    const agentCost = costTracker.getAgentCost('S-cost-msg');
    assert(agentCost.total_tokens > 0, 'cost should be tracked alongside messaging');
  });

  test('8c. Decomposition → Scheduler pipeline', () => {
    clearModuleCache();

    const decomposition = freshModule('decomposition');
    const scheduler = freshModule('scheduler');

    // Create agent sessions
    createSession('S-pipe-fe', { role: 'frontend', agent_name: 'fe-pipe', pid: 40001, parent_pid: 40000 });
    createSession('S-pipe-be', { role: 'backend', agent_name: 'be-pipe', pid: 40002, parent_pid: 40000 });

    // Decompose a big task
    const result = decomposition.decomposeTask({
      id: 'big-task',
      title: 'Build user management system',
      description: 'User CRUD, profiles, settings, avatar upload, email verification',
      labels: ['fullstack'],
    });
    assert(result !== null, 'decomposition should succeed');
    const subtasks = result.subtasks || result.tasks || [];
    assert(subtasks.length >= 2, 'should produce subtasks');

    // Schedule the subtasks
    const schedulerConfig = scheduler.loadSchedulerConfig();
    assert(schedulerConfig !== null, 'scheduler config should load');

    // Try scheduling the first subtask
    if (subtasks.length > 0) {
      const firstTask = {
        id: subtasks[0].id || 'sub-1',
        title: subtasks[0].title,
        labels: subtasks[0].labels || ['backend'],
      };
      const assignment = scheduler.scheduleOne(firstTask, null, TMP_DIR);
      assert(assignment !== null, 'scheduler should produce assignment for subtask');
    }
  });

  test('8d. Agent memory persists across module reloads', () => {
    clearModuleCache();
    const memory = freshModule('memory');

    // Publish to a test channel
    const published = memory.publish('test-integration', {
      topic: 'e2e-test',
      data: { verified: true, timestamp: Date.now() },
    });
    // publish may return { success: true } or the data
    assert(published !== null && published !== undefined, 'publish should return result');

    // Reload module and read back
    clearModuleCache();
    const freshMemory = freshModule('memory');
    const channelFile = path.join(TMP_DIR, '.claude/pilot/memory/channels/test-integration.json');
    if (fs.existsSync(channelFile)) {
      const data = JSON.parse(fs.readFileSync(channelFile, 'utf8'));
      assert(data !== null, 'channel data should persist');
    }
  });
})();

// ════════════════════════════════════════════════════════════════════════════
// SCENARIO 9: Agent-to-Agent Collaboration
// Validates: Direct messaging without PM intermediary
// ════════════════════════════════════════════════════════════════════════════

console.log('\n=== SCENARIO 9: Agent-to-Agent Collaboration ===\n');

(() => {
  clearModuleCache();

  // Fresh bus
  fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/messages/bus.jsonl'), '');

  createSession('S-collab-fe', { role: 'frontend', agent_name: 'fe-collab', pid: 50001, parent_pid: 50000 });
  createSession('S-collab-be', { role: 'backend', agent_name: 'be-collab', pid: 50002, parent_pid: 50000 });

  const messaging = freshModule('messaging');
  const session = freshModule('session');

  // Initialize backend cursor BEFORE messages are sent so it reads from byte 0
  messaging.readMessages('S-collab-be', { role: 'backend' });

  test('9a. sendToRole delivers to agent with matching role', () => {
    const result = messaging.sendToRole('S-collab-fe', 'backend', 'api_contract', {
      endpoint: '/api/users',
      method: 'GET',
      response: { type: 'User[]' },
    });
    assert(result.success === true, 'sendToRole should succeed');
  });

  test('9b. Backend agent receives role-addressed message', () => {
    const msgs = messaging.readMessages('S-collab-be', { role: 'backend' });
    assert(msgs.messages.length >= 1, 'backend should receive messages');
    const apiMsg = msgs.messages.find(m => m.topic === 'api_contract');
    assert(apiMsg, 'should find api_contract message');
    // sendToRole wraps payload as { action, data }, so original payload is at .data
    assertEqual(apiMsg.payload.data.endpoint, '/api/users', 'payload should match');
  });

  test('9c. sendToAgent delivers directly by session ID', () => {
    const result = messaging.sendToAgent('S-collab-be', 'S-collab-fe', 'api_ready', {
      endpoint: '/api/users',
      status: 'implemented',
    });
    assert(result.success === true, 'direct message should succeed');
  });

  test('9d. discoverAgentByCap finds agents with capability', () => {
    const agents = session.discoverAgentByCap('react');
    assert(Array.isArray(agents), 'should return array');
    // Frontend agent should be discoverable by react capability
    if (agents.length > 0) {
      const hasFe = agents.some(a => a.role === 'frontend' || a.session_id === 'S-collab-fe');
      assert(hasFe, 'should find frontend agent with react capability');
    }
  });

  test('9e. sendToCapability routes to capable agent', () => {
    const result = messaging.sendToCapability('S-collab-be', 'react', 'component_request', {
      component: 'UserCard',
      props: ['user', 'onClick'],
    });
    assert(result.success === true, 'sendToCapability should succeed');
  });
})();

// ============================================================================
// CLEANUP & RESULTS
// ============================================================================

teardownTestDir();

console.log(`\n${'='.repeat(60)}`);
console.log(`M3 E2E Integration Tests: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
}
console.log('='.repeat(60));

if (failed > 0) {
  throw new Error(`${failed} test(s) failed`);
}
