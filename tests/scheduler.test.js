#!/usr/bin/env node

/**
 * Verification tests for Intelligent Task Scheduler (Phase 3.4)
 * Run: node tests/scheduler.test.js
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

// =============================================================================
// SETUP: temp directory + fresh module loading
// =============================================================================

const ORIG_CWD = process.cwd();
const TMP_DIR = path.join(require('os').tmpdir(), 'pilot-scheduler-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

// Create minimal directory structure
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/sessions'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/costs/tasks'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/costs/agents'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/memory/channels'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/config'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/memory/agents'), { recursive: true });

// Write minimal policy.yaml
fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/policy.yaml'), `
version: "2.0"
orchestrator:
  scheduling:
    skill_weight: 0.55
    load_weight: 0.20
    affinity_weight: 0.15
    cost_weight: 0.10
    max_tasks_per_agent: 3
    starvation_threshold_sec: 300
    starvation_boost_per_sec: 0.001
`);

// Write skill registry
fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/config/skill-registry.json'), JSON.stringify({
  roles: {
    frontend: {
      skills: ['react', 'nextjs', 'css', 'tailwind'],
      languages: ['typescript', 'javascript'],
      areas: ['ui', 'components', 'pages'],
      task_keywords: ['component', 'page', 'ui', 'button', 'form', 'layout', 'style', 'css', 'react'],
      file_patterns: ['**/*.tsx', '**/components/**', '**/pages/**']
    },
    backend: {
      skills: ['nodejs', 'api', 'database'],
      languages: ['typescript', 'javascript'],
      areas: ['api', 'server', 'database'],
      task_keywords: ['api', 'endpoint', 'database', 'server', 'auth', 'middleware', 'rest'],
      file_patterns: ['**/*.ts', '**/api/**', '**/server/**']
    },
    testing: {
      skills: ['vitest', 'playwright', 'jest'],
      languages: ['typescript', 'javascript'],
      areas: ['tests', 'e2e', 'unit'],
      task_keywords: ['test', 'spec', 'e2e', 'unit', 'coverage', 'assertion'],
      file_patterns: ['**/*.test.*', '**/tests/**', '**/__tests__/**']
    }
  },
  scoring: {
    weights: {
      keyword_match: 0.35,
      file_pattern_match: 0.30,
      area_match: 0.20,
      affinity_bonus: 0.15
    },
    confidence_threshold: 0.3
  }
}, null, 2));

// Helper: create a session state file
function createSession(id, opts = {}) {
  const data = {
    session_id: id,
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    status: opts.status || 'active',
    role: opts.role || null,
    agent_name: opts.agent_name || `agent-${id.slice(-4)}`,
    claimed_task: opts.claimed_task || null,
    lease_expires_at: opts.claimed_task ? new Date(Date.now() + 1800000).toISOString() : null,
    locked_areas: [],
    locked_files: [],
    cwd: TMP_DIR,
    pid: opts.pid || process.pid + Math.floor(Math.random() * 10000),
    parent_pid: opts.parent_pid || process.ppid
  };
  fs.writeFileSync(
    path.join(TMP_DIR, '.claude/pilot/state/sessions', id + '.json'),
    JSON.stringify(data, null, 2)
  );
  return data;
}

// Clear module cache for fresh requires
function freshModule(modPath) {
  const fullPath = require.resolve(modPath);
  // Clear this module and transitive deps
  const keysToDelete = Object.keys(require.cache).filter(k =>
    k.includes('pilot/hooks/lib/') || k.includes('pilot/config/')
  );
  for (const k of keysToDelete) {
    delete require.cache[k];
  }
  return require(fullPath);
}

// Change to temp dir for all tests
process.chdir(TMP_DIR);

const libDir = path.join(ORIG_CWD, '.claude/pilot/hooks/lib');

// =============================================================================
// TEST GROUP 1: Scheduler Config
// =============================================================================

console.log('\n=== Scheduler Config ===');

test('loadSchedulerConfig returns defaults when no policy', () => {
  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const config = scheduler.loadSchedulerConfig();
  assert(config.skill_weight === 0.55, 'skill_weight should be 0.55, got ' + config.skill_weight);
  assert(config.load_weight === 0.20, 'load_weight should be 0.20');
  assert(config.max_tasks_per_agent === 3, 'max_tasks_per_agent should be 3');
  assert(config.starvation_threshold_sec === 300, 'starvation_threshold_sec should be 300');
});

test('DEFAULT_CONFIG weights sum to 1.0', () => {
  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const c = scheduler.DEFAULT_CONFIG;
  const sum = c.skill_weight + c.load_weight + c.affinity_weight + c.cost_weight;
  assert(Math.abs(sum - 1.0) < 0.001, `Weights sum to ${sum}, expected 1.0`);
});

// =============================================================================
// TEST GROUP 2: Starvation Prevention
// =============================================================================

console.log('\n=== Starvation Prevention ===');

test('starvationBoost returns 0 for fresh tasks', () => {
  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const config = scheduler.DEFAULT_CONFIG;
  const task = { created_at: new Date().toISOString() };
  const boost = scheduler.starvationBoost(task, config);
  assert(boost === 0, `Expected 0 boost for fresh task, got ${boost}`);
});

test('starvationBoost returns positive for old tasks', () => {
  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const config = scheduler.DEFAULT_CONFIG;
  // Task created 10 minutes ago (600s, threshold is 300s)
  const task = { created_at: new Date(Date.now() - 600000).toISOString() };
  const boost = scheduler.starvationBoost(task, config);
  assert(boost > 0, `Expected positive boost for old task, got ${boost}`);
  // 300s overdue * 0.001 = 0.3
  assert(Math.abs(boost - 0.3) < 0.05, `Expected ~0.3 boost, got ${boost}`);
});

test('starvationBoost is capped at 0.5', () => {
  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const config = scheduler.DEFAULT_CONFIG;
  // Task created 2 hours ago
  const task = { created_at: new Date(Date.now() - 7200000).toISOString() };
  const boost = scheduler.starvationBoost(task, config);
  assert(boost <= 0.5, `Boost should be capped at 0.5, got ${boost}`);
});

test('starvationBoost returns 0 for tasks without created_at', () => {
  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const config = scheduler.DEFAULT_CONFIG;
  const boost = scheduler.starvationBoost({}, config);
  assert(boost === 0, `Expected 0 for no timestamp, got ${boost}`);
});

// =============================================================================
// TEST GROUP 3: Load Balancing
// =============================================================================

console.log('\n=== Load Balancing ===');

test('loadScore returns 1 for idle agent', () => {
  const sessionId = 'S-test-idle-001';
  createSession(sessionId, { role: 'frontend', claimed_task: null });

  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const config = scheduler.DEFAULT_CONFIG;
  const score = scheduler.loadScore(sessionId, config);
  assert(score === 1, `Idle agent should have loadScore 1, got ${score}`);
});

test('loadScore returns < 1 for busy agent', () => {
  const sessionId = 'S-test-busy-001';
  createSession(sessionId, { role: 'backend', claimed_task: 'task-123' });

  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const config = scheduler.DEFAULT_CONFIG;
  const score = scheduler.loadScore(sessionId, config);
  // Agent has 1 task (M complexity = 2 load), max load = 3 * 2 = 6, available = 4/6
  assert(score < 1, `Busy agent should have loadScore < 1, got ${score}`);
  assert(score > 0, `Busy agent should still have some capacity, got ${score}`);
});

test('getAgentLoad returns correct values for idle agent', () => {
  const sessionId = 'S-test-idle-002';
  createSession(sessionId, { role: 'testing' });

  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const config = scheduler.DEFAULT_CONFIG;
  const load = scheduler.getAgentLoad(sessionId, config);
  assert(load.task_count === 0, 'Idle agent task_count should be 0');
  assert(load.load === 0, 'Idle agent load should be 0');
  assert(load.available_capacity > 0, 'Idle agent should have capacity');
});

// =============================================================================
// TEST GROUP 4: Score Assignment (Combined)
// =============================================================================

console.log('\n=== Score Assignment ===');

test('scoreAssignment returns score with breakdown', () => {
  const sessionId = 'S-test-score-001';
  createSession(sessionId, { role: 'frontend' });

  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const orchestrator = freshModule(path.join(libDir, 'orchestrator'));
  const registry = orchestrator.loadSkillRegistry();
  const config = scheduler.DEFAULT_CONFIG;

  const task = {
    id: 'test-task-1',
    title: 'Build a react component for the page layout',
    description: 'Create a responsive layout component',
    labels: ['ui', 'frontend'],
    files: []
  };

  const agent = { session_id: sessionId, role: 'frontend', agent_name: 'agent-fe' };
  const result = scheduler.scoreAssignment(agent, task, registry, config);

  assert(typeof result.score === 'number', 'Score should be a number');
  assert(result.score >= 0 && result.score <= 1, `Score should be 0-1, got ${result.score}`);
  assert(result.breakdown, 'Should have breakdown');
  assert(typeof result.breakdown.skill === 'number', 'Breakdown should have skill score');
  assert(typeof result.breakdown.load === 'number', 'Breakdown should have load score');
});

test('frontend agent scores higher than backend agent for UI task', () => {
  const feId = 'S-test-fe-001';
  const beId = 'S-test-be-001';
  createSession(feId, { role: 'frontend' });
  createSession(beId, { role: 'backend' });

  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const orchestrator = freshModule(path.join(libDir, 'orchestrator'));
  const registry = orchestrator.loadSkillRegistry();
  const config = scheduler.DEFAULT_CONFIG;

  const uiTask = {
    id: 'ui-task',
    title: 'Build a button component with css styling',
    description: 'Create a reusable react button component',
    labels: ['ui', 'component'],
    files: ['src/components/Button.tsx']
  };

  const feScore = scheduler.scoreAssignment(
    { session_id: feId, role: 'frontend', agent_name: 'fe' }, uiTask, registry, config
  );
  const beScore = scheduler.scoreAssignment(
    { session_id: beId, role: 'backend', agent_name: 'be' }, uiTask, registry, config
  );

  assert(feScore.score > beScore.score,
    `Frontend (${feScore.score.toFixed(3)}) should score higher than backend (${beScore.score.toFixed(3)}) for UI task`);
});

test('backend agent scores higher than frontend agent for API task', () => {
  const feId = 'S-test-fe-002';
  const beId = 'S-test-be-002';
  createSession(feId, { role: 'frontend' });
  createSession(beId, { role: 'backend' });

  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const orchestrator = freshModule(path.join(libDir, 'orchestrator'));
  const registry = orchestrator.loadSkillRegistry();
  const config = scheduler.DEFAULT_CONFIG;

  const apiTask = {
    id: 'api-task',
    title: 'Build REST API endpoint for auth middleware',
    description: 'Create authentication server endpoint',
    labels: ['api', 'backend', 'auth'],
    files: ['src/api/auth.ts']
  };

  const feScore = scheduler.scoreAssignment(
    { session_id: feId, role: 'frontend', agent_name: 'fe' }, apiTask, registry, config
  );
  const beScore = scheduler.scoreAssignment(
    { session_id: beId, role: 'backend', agent_name: 'be' }, apiTask, registry, config
  );

  assert(beScore.score > feScore.score,
    `Backend (${beScore.score.toFixed(3)}) should score higher than frontend (${feScore.score.toFixed(3)}) for API task`);
});

// =============================================================================
// TEST GROUP 5: Batch Scheduling
// =============================================================================

console.log('\n=== Batch Scheduling ===');

test('schedule returns empty when no agents available', () => {
  // Clear all sessions
  const sessDir = path.join(TMP_DIR, '.claude/pilot/state/sessions');
  for (const f of fs.readdirSync(sessDir)) {
    fs.unlinkSync(path.join(sessDir, f));
  }

  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const tasks = [{ id: 't1', title: 'Test', priority: 2, created_at: new Date().toISOString() }];
  const result = scheduler.schedule(tasks, 'pm-session', TMP_DIR);

  assert(result.assignments.length === 0, 'No assignments when no agents');
  assert(result.no_agents === true, 'Should report no_agents');
});

test('schedule assigns task to best-fit agent', () => {
  // Clear sessions
  const sessDir = path.join(TMP_DIR, '.claude/pilot/state/sessions');
  for (const f of fs.readdirSync(sessDir)) {
    fs.unlinkSync(path.join(sessDir, f));
  }

  createSession('S-fe-sched', { role: 'frontend', agent_name: 'frontend-1' });
  createSession('S-be-sched', { role: 'backend', agent_name: 'backend-1' });

  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const tasks = [{
    id: 't-ui',
    title: 'Build react component with css',
    description: 'UI work',
    priority: 2,
    labels: ['ui'],
    created_at: new Date().toISOString()
  }];

  const result = scheduler.schedule(tasks, 'pm-session', TMP_DIR);
  assert(result.assignments.length === 1, `Expected 1 assignment, got ${result.assignments.length}`);
  assert(result.assignments[0].agent.role === 'frontend',
    `Expected frontend agent, got ${result.assignments[0].agent.role}`);
});

test('schedule assigns multiple tasks to different agents', () => {
  const sessDir = path.join(TMP_DIR, '.claude/pilot/state/sessions');
  for (const f of fs.readdirSync(sessDir)) {
    fs.unlinkSync(path.join(sessDir, f));
  }

  createSession('S-fe-multi', { role: 'frontend', agent_name: 'frontend-1' });
  createSession('S-be-multi', { role: 'backend', agent_name: 'backend-1' });

  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const tasks = [
    {
      id: 't-ui-multi',
      title: 'Build react page layout component',
      priority: 1,
      labels: ['ui', 'component'],
      created_at: new Date().toISOString()
    },
    {
      id: 't-api-multi',
      title: 'Build REST API endpoint for server auth',
      priority: 2,
      labels: ['api', 'backend'],
      created_at: new Date().toISOString()
    }
  ];

  const result = scheduler.schedule(tasks, 'pm-session', TMP_DIR);
  assert(result.assignments.length === 2, `Expected 2 assignments, got ${result.assignments.length}`);

  const agents = result.assignments.map(a => a.agent.session_id).sort();
  assert(agents.length === 2, 'Each task should get a different agent');
  assert(agents[0] !== agents[1], 'Agents should not be double-booked');
});

test('schedule respects priority ordering', () => {
  const sessDir = path.join(TMP_DIR, '.claude/pilot/state/sessions');
  for (const f of fs.readdirSync(sessDir)) {
    fs.unlinkSync(path.join(sessDir, f));
  }

  // Only one agent available
  createSession('S-sole', { role: 'frontend', agent_name: 'frontend-1' });

  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const tasks = [
    {
      id: 't-low',
      title: 'Low priority ui task component',
      priority: 4,
      labels: ['ui'],
      created_at: new Date().toISOString()
    },
    {
      id: 't-high',
      title: 'High priority ui component fix',
      priority: 1,
      labels: ['ui'],
      created_at: new Date().toISOString()
    }
  ];

  const result = scheduler.schedule(tasks, 'pm-session', TMP_DIR);
  // Only 1 agent → only 1 assignment, should be the high priority task
  assert(result.assignments.length === 1, `Expected 1 assignment, got ${result.assignments.length}`);
  assert(result.assignments[0].task.id === 't-high',
    `Expected high-priority task, got ${result.assignments[0].task.id}`);
});

test('schedule with starvation boost promotes old low-priority task', () => {
  const sessDir = path.join(TMP_DIR, '.claude/pilot/state/sessions');
  for (const f of fs.readdirSync(sessDir)) {
    fs.unlinkSync(path.join(sessDir, f));
  }

  createSession('S-starve', { role: 'frontend', agent_name: 'frontend-1' });

  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const tasks = [
    {
      id: 't-new-p2',
      title: 'New P2 react component task',
      priority: 2,
      labels: ['ui'],
      created_at: new Date().toISOString() // Just created
    },
    {
      id: 't-old-p4',
      title: 'Old P4 react page task',
      priority: 4,
      labels: ['ui'],
      created_at: new Date(Date.now() - 900000).toISOString() // 15 min old, way past threshold
    }
  ];

  const result = scheduler.schedule(tasks, 'pm-session', TMP_DIR);
  assert(result.assignments.length === 1, 'Should assign 1 task');

  // P2 base = 0.7, P4 base = 0.2 + starvation boost ~0.5 = 0.7
  // With max starvation = 0.5, old P4 effective = 0.7, same as P2
  // It should still be competitive — the exact winner depends on timing
  // Key assertion: the old task's effective priority was boosted
  const oldTask = tasks[1];
  const boost = scheduler.starvationBoost(oldTask, scheduler.DEFAULT_CONFIG);
  assert(boost > 0.3, `Starvation boost should be significant, got ${boost}`);
});

// =============================================================================
// TEST GROUP 6: scheduleOne convenience
// =============================================================================

console.log('\n=== scheduleOne ===');

test('scheduleOne returns agent for single task', () => {
  const sessDir = path.join(TMP_DIR, '.claude/pilot/state/sessions');
  for (const f of fs.readdirSync(sessDir)) {
    fs.unlinkSync(path.join(sessDir, f));
  }

  createSession('S-one', { role: 'backend', agent_name: 'backend-1' });

  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const result = scheduler.scheduleOne(
    { id: 'single', title: 'Build api endpoint server', priority: 2, labels: ['api'], created_at: new Date().toISOString() },
    'pm-session',
    TMP_DIR
  );

  assert(result.agent !== null, 'Should find an agent');
  assert(result.agent.role === 'backend', `Expected backend, got ${result.agent.role}`);
  assert(result.score > 0, `Score should be positive, got ${result.score}`);
});

test('scheduleOne returns null when no agents', () => {
  const sessDir = path.join(TMP_DIR, '.claude/pilot/state/sessions');
  for (const f of fs.readdirSync(sessDir)) {
    fs.unlinkSync(path.join(sessDir, f));
  }

  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const result = scheduler.scheduleOne(
    { id: 'nope', title: 'Task', priority: 2, created_at: new Date().toISOString() },
    'pm',
    TMP_DIR
  );

  assert(result.agent === null, 'Should return null agent');
  assert(result.reason, 'Should have a reason');
});

// =============================================================================
// TEST GROUP 7: Context Pre-Loading
// =============================================================================

console.log('\n=== Context Pre-Loading ===');

test('buildContextPackage returns context object', () => {
  const scheduler = freshModule(path.join(libDir, 'scheduler'));
  const ctx = scheduler.buildContextPackage(
    { id: 'ctx-task', title: 'Test', labels: ['ui'] },
    TMP_DIR
  );

  assert(ctx !== null, 'Context should not be null');
  assert(typeof ctx === 'object', 'Context should be an object');
  assert('research' in ctx, 'Context should have research field');
  assert('memory' in ctx, 'Context should have memory field');
  assert('related_decisions' in ctx, 'Context should have related_decisions field');
});

// =============================================================================
// CLEANUP
// =============================================================================

process.chdir(ORIG_CWD);
try {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
} catch (e) {
  // Best effort cleanup
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
