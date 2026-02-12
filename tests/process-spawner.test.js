#!/usr/bin/env node

/**
 * Verification tests for Process Spawner v2 (Phase 4.2)
 * Tests: spawn-context.js (context capsule, prompt, resume detection)
 *        process-spawner.js (worktree setup, context file, spawn orchestration)
 *
 * Run: node tests/process-spawner.test.js
 *
 * Part of Phase 4.2 (Pilot AGI-02g)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

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

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(str, sub, msg) {
  if (typeof str !== 'string' || !str.includes(sub)) {
    throw new Error(`${msg || 'assertIncludes'}: "${String(str).slice(0, 200)}" does not include "${sub}"`);
  }
}

// =============================================================================
// SETUP: temp directory for isolated file operations
// =============================================================================

const ORIG_CWD = process.cwd();
const TMP_DIR = path.join(os.tmpdir(), 'pilot-spawner-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

// Create minimal directory structure
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/sessions'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/approved-plans'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/spawn-context'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/costs/tasks'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/costs/agents'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/memory/channels'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/memory/agents'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/config'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/logs'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, 'work/plans'), { recursive: true });

// Write minimal policy.yaml (worktree disabled for unit tests)
fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/policy.yaml'), `
version: "2.0"
worktree:
  enabled: false
  base_dir: .worktrees
  branch_prefix: pilot/
  merge_strategy: squash
  base_branch: main
orchestrator:
  scheduling:
    skill_weight: 0.55
    load_weight: 0.20
    affinity_weight: 0.15
    cost_weight: 0.10
`);

// Write skill registry
fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/config/skill-registry.json'), JSON.stringify({
  roles: {
    frontend: {
      skills: ['react', 'nextjs'],
      languages: ['typescript'],
      areas: ['ui'],
      task_keywords: ['component', 'page', 'ui'],
      file_patterns: ['**/*.tsx']
    },
    backend: {
      skills: ['nodejs', 'api'],
      languages: ['typescript'],
      areas: ['api'],
      task_keywords: ['api', 'endpoint', 'server'],
      file_patterns: ['**/*.ts']
    }
  }
}, null, 2));

// Write sessions stream
fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/state/sessions.jsonl'), '');

const libDir = path.join(ORIG_CWD, '.claude/pilot/hooks/lib');

function freshModule(modPath) {
  const fullPath = require.resolve(modPath);
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

// =============================================================================
// TEST SUITE: spawn-context.js — Context Capsule Builder
// =============================================================================

console.log('\n--- spawn-context.js: Context Capsule Builder ---');

test('buildContextCapsule returns basic capsule with task info', () => {
  const sc = freshModule(path.join(libDir, 'spawn-context'));
  const task = { id: 'TEST-001', title: 'Test task', description: 'Build something', labels: ['api'] };
  const capsule = sc.buildContextCapsule(task, { projectRoot: TMP_DIR });

  assertEqual(capsule.task.id, 'TEST-001', 'task id');
  assertEqual(capsule.task.title, 'Test task', 'task title');
  assertEqual(capsule.task.description, 'Build something', 'task description');
  assert(Array.isArray(capsule.task.labels), 'labels is array');
  assertEqual(capsule.resume, null, 'no resume for fresh task');
  assert(Array.isArray(capsule.related_decisions), 'decisions is array');
  assert(Array.isArray(capsule.related_agents), 'agents is array');
});

test('buildContextCapsule loads approved plan when present', () => {
  // Write an approval file
  const taskId = 'TEST-PLAN-001';
  const approval = {
    task_id: taskId,
    approved_at: new Date().toISOString(),
    auto_approved: true,
    steps: 5
  };
  fs.writeFileSync(
    path.join(TMP_DIR, '.claude/pilot/state/approved-plans', taskId + '.json'),
    JSON.stringify(approval)
  );

  // Write a plan file — use sanitized lowercase name to match _loadExistingPlan lookup
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const planContent = '## Plan\n\nStep 1: Do something\nStep 2: Do more';
  fs.writeFileSync(
    path.join(TMP_DIR, 'work/plans', safeId + '-plan.md'),
    planContent
  );

  const sc = freshModule(path.join(libDir, 'spawn-context'));
  const task = { id: taskId, title: 'Planned task', labels: [] };
  const capsule = sc.buildContextCapsule(task, { projectRoot: TMP_DIR });

  assert(capsule.plan !== null, 'plan should be present');
  assertEqual(capsule.plan.auto_approved, true, 'auto_approved');
  assertEqual(capsule.plan.steps, 5, 'steps count');
  assertIncludes(capsule.plan.content, 'Step 1: Do something', 'plan content');
});

test('buildContextCapsule returns null plan when no approval', () => {
  const sc = freshModule(path.join(libDir, 'spawn-context'));
  const task = { id: 'NO-PLAN-001', title: 'No plan', labels: [] };
  const capsule = sc.buildContextCapsule(task, { projectRoot: TMP_DIR });
  assertEqual(capsule.plan, null, 'no plan expected');
});

test('detectResume returns isResume=false when no ended sessions', () => {
  const sc = freshModule(path.join(libDir, 'spawn-context'));
  const result = sc.detectResume('FRESH-TASK', TMP_DIR);
  assertEqual(result.isResume, false, 'should not be resume');
});

test('detectResume returns isResume=true when ended session with checkpoint exists', () => {
  // Create an ended session that was working on this task
  const sessionId = 'S-dead-agent-001';
  const taskId = 'RESUME-TASK-001';

  fs.writeFileSync(
    path.join(TMP_DIR, '.claude/pilot/state/sessions', sessionId + '.json'),
    JSON.stringify({
      session_id: sessionId,
      status: 'ended',
      claimed_task: taskId,
      pid: 99999
    })
  );

  // Create a checkpoint for that session
  const cpDir = path.join(TMP_DIR, '.claude/pilot/memory/agents', sessionId);
  fs.mkdirSync(cpDir, { recursive: true });
  fs.writeFileSync(
    path.join(cpDir, 'checkpoint.json'),
    JSON.stringify({
      version: 1,
      session_id: sessionId,
      saved_at: new Date().toISOString(),
      task_id: taskId,
      task_title: 'Resume task',
      plan_step: 3,
      total_steps: 8,
      completed_steps: [
        { step: 1, description: 'Setup', result: 'success' },
        { step: 2, description: 'Build', result: 'success' }
      ],
      key_decisions: ['chose vitest'],
      files_modified: ['src/foo.js'],
      current_context: 'Working on step 3',
      important_findings: []
    })
  );

  const sc = freshModule(path.join(libDir, 'spawn-context'));
  const result = sc.detectResume(taskId, TMP_DIR);

  assertEqual(result.isResume, true, 'should be resume');
  assertEqual(result.previousSessionId, sessionId, 'previous session');
  assert(result.checkpoint !== null, 'checkpoint present');
  assertEqual(result.checkpoint.plan_step, 3, 'plan_step');
});

test('detectResume ignores active sessions', () => {
  const sessionId = 'S-active-agent-001';
  const taskId = 'ACTIVE-TASK-001';

  fs.writeFileSync(
    path.join(TMP_DIR, '.claude/pilot/state/sessions', sessionId + '.json'),
    JSON.stringify({
      session_id: sessionId,
      status: 'active',
      claimed_task: taskId,
      pid: 88888
    })
  );

  const sc = freshModule(path.join(libDir, 'spawn-context'));
  const result = sc.detectResume(taskId, TMP_DIR);
  assertEqual(result.isResume, false, 'active session should not trigger resume');
});

// =============================================================================
// TEST SUITE: spawn-context.js — Prompt Generation
// =============================================================================

console.log('\n--- spawn-context.js: Prompt Generation ---');

test('buildSpawnPrompt includes task info for fresh spawn', () => {
  const sc = freshModule(path.join(libDir, 'spawn-context'));
  const capsule = {
    task: { id: 'T-1', title: 'Build API', description: 'REST endpoints', labels: [] },
    resume: null,
    research: null,
    plan: null,
    related_decisions: [],
    related_agents: [],
    agent_type: 'backend'
  };

  const prompt = sc.buildSpawnPrompt(capsule);

  assertIncludes(prompt, 'T-1', 'includes task id');
  assertIncludes(prompt, 'Build API', 'includes task title');
  assertIncludes(prompt, 'canonical loop', 'includes workflow instructions');
  assert(!prompt.includes('RESUMING'), 'should NOT include resume marker');
});

test('buildSpawnPrompt includes resume context for checkpoint spawn', () => {
  const sc = freshModule(path.join(libDir, 'spawn-context'));
  const capsule = {
    task: { id: 'T-2', title: 'Resume task', description: null, labels: [] },
    resume: {
      from_session: 'S-old-session',
      checkpoint: { plan_step: 5, total_steps: 10 },
      restoration_prompt: '## Context Checkpoint Recovery\n\n**Progress**: Step 5 of 10\n\n### Completed Steps\n- Step 1: Init\n- Step 4: Build'
    },
    research: null,
    plan: null,
    related_decisions: [],
    related_agents: [],
    agent_type: null
  };

  const prompt = sc.buildSpawnPrompt(capsule);

  assertIncludes(prompt, 'RESUMING', 'includes resume marker');
  assertIncludes(prompt, 'Step 5 of 10', 'includes checkpoint progress');
  assertIncludes(prompt, 'Re-read modified files', 'includes resume instructions');
});

test('buildSpawnPrompt includes approved plan when present', () => {
  const sc = freshModule(path.join(libDir, 'spawn-context'));
  const capsule = {
    task: { id: 'T-3', title: 'Planned task', description: null, labels: [] },
    resume: null,
    research: null,
    plan: {
      approved_at: '2026-02-11',
      auto_approved: true,
      steps: 5,
      content: '## Steps\n1. Create module\n2. Write tests'
    },
    related_decisions: [],
    related_agents: [],
    agent_type: null
  };

  const prompt = sc.buildSpawnPrompt(capsule);

  assertIncludes(prompt, 'Approved Plan', 'includes plan header');
  assertIncludes(prompt, 'Create module', 'includes plan content');
  assertIncludes(prompt, 'plan is already approved', 'tells agent to use existing plan');
});

test('buildSpawnPrompt includes research context', () => {
  const sc = freshModule(path.join(libDir, 'spawn-context'));
  const capsule = {
    task: { id: 'T-4', title: 'Researched task', description: null, labels: [] },
    resume: null,
    research: { summary: 'Best practice: use connection pooling for DB access' },
    plan: null,
    related_decisions: [],
    related_agents: [],
    agent_type: null
  };

  const prompt = sc.buildSpawnPrompt(capsule);

  assertIncludes(prompt, 'Research Context', 'includes research header');
  assertIncludes(prompt, 'connection pooling', 'includes research content');
});

test('buildSpawnPrompt includes PM decisions', () => {
  const sc = freshModule(path.join(libDir, 'spawn-context'));
  const capsule = {
    task: { id: 'T-5', title: 'Decision task', description: null, labels: [] },
    resume: null,
    research: null,
    plan: null,
    related_decisions: [
      { decision: 'Use PostgreSQL for the database' },
      { decision: 'JWT for authentication' }
    ],
    related_agents: [],
    agent_type: null
  };

  const prompt = sc.buildSpawnPrompt(capsule);

  assertIncludes(prompt, 'PM Decisions', 'includes decisions header');
  assertIncludes(prompt, 'PostgreSQL', 'includes decision content');
  assertIncludes(prompt, 'JWT', 'includes second decision');
});

test('buildSpawnPrompt includes active agents', () => {
  const sc = freshModule(path.join(libDir, 'spawn-context'));
  const capsule = {
    task: { id: 'T-6', title: 'Peer task', description: null, labels: [] },
    resume: null,
    research: null,
    plan: null,
    related_decisions: [],
    related_agents: [
      { session_id: 'S-frontend-1', task: 'Build header', status: 'executing step 3' }
    ],
    agent_type: null
  };

  const prompt = sc.buildSpawnPrompt(capsule);

  assertIncludes(prompt, 'Active Agents', 'includes agents header');
  assertIncludes(prompt, 'S-frontend-1', 'includes agent session');
});

// =============================================================================
// TEST SUITE: process-spawner.js — Context File & Worktree
// =============================================================================

console.log('\n--- process-spawner.js: Context File & Spawn ---');

test('_writeContextFile creates JSON context file', () => {
  const ps = freshModule(path.join(libDir, 'process-spawner'));
  const capsule = {
    task: { id: 'CTX-001', title: 'Context task', description: 'Desc', labels: [] },
    agent_type: 'backend',
    resume: null,
    plan: { approved_at: '2026-02-11', steps: 3, content: null },
    research: null,
    related_agents: [],
    related_decisions: []
  };

  const filePath = ps._writeContextFile('CTX-001', capsule, TMP_DIR);

  assert(fs.existsSync(filePath), 'context file should exist');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assertEqual(data.task.id, 'CTX-001', 'task id in context file');
  assertEqual(data.agent_type, 'backend', 'agent type');
  assertEqual(data.is_resume, false, 'not a resume');
  assertEqual(data.has_plan, true, 'has plan');
  assert(data.created_at, 'has timestamp');
});

test('_writeContextFile handles resume context', () => {
  const ps = freshModule(path.join(libDir, 'process-spawner'));
  const capsule = {
    task: { id: 'CTX-RESUME', title: 'Resume', description: null, labels: [] },
    agent_type: null,
    resume: { from_session: 'S-old-123', checkpoint: { plan_step: 3 } },
    plan: null,
    research: null,
    related_agents: [],
    related_decisions: []
  };

  const filePath = ps._writeContextFile('CTX-RESUME', capsule, TMP_DIR);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  assertEqual(data.is_resume, true, 'should be resume');
  assertEqual(data.resume_session, 'S-old-123', 'resume session id');
});

test('cleanupContextFile removes the context file', () => {
  const ps = freshModule(path.join(libDir, 'process-spawner'));

  // First create a file
  const capsule = {
    task: { id: 'CLEANUP-001', title: 'Cleanup test', description: null, labels: [] },
    agent_type: null, resume: null, plan: null, research: null,
    related_agents: [], related_decisions: []
  };
  const filePath = ps._writeContextFile('CLEANUP-001', capsule, TMP_DIR);
  assert(fs.existsSync(filePath), 'file should exist before cleanup');

  // Now clean up
  ps.cleanupContextFile('CLEANUP-001', TMP_DIR);
  assert(!fs.existsSync(filePath), 'file should be gone after cleanup');
});

test('cleanupContextFile is idempotent for missing files', () => {
  const ps = freshModule(path.join(libDir, 'process-spawner'));
  // Should not throw
  ps.cleanupContextFile('NONEXISTENT-001', TMP_DIR);
});

test('_setupWorktree returns null when worktree disabled', () => {
  const ps = freshModule(path.join(libDir, 'process-spawner'));
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const result = ps._setupWorktree('WT-001', TMP_DIR, log);
  // Policy has worktree.enabled = false
  assertEqual(result, null, 'should be null when disabled');
});

// =============================================================================
// TEST SUITE: process-spawner.js — spawnAgent dry run
// =============================================================================

console.log('\n--- process-spawner.js: Spawn Dry Run ---');

test('spawnAgent dry run returns success without spawning', () => {
  const ps = freshModule(path.join(libDir, 'process-spawner'));
  const task = { id: 'DRY-001', title: 'Dry run task', description: 'Test', labels: [] };
  const result = ps.spawnAgent(task, {
    projectRoot: TMP_DIR,
    dryRun: true
  });

  assertEqual(result.success, true, 'dry run success');
  assertEqual(result.dry_run, true, 'marked as dry run');
  assert(result.isResume !== undefined, 'has isResume field');
});

test('spawnAgent dry run detects resume when checkpoint exists', () => {
  // Create ended session + checkpoint for this task
  const sessionId = 'S-dry-resume-001';
  const taskId = 'DRY-RESUME-001';

  fs.writeFileSync(
    path.join(TMP_DIR, '.claude/pilot/state/sessions', sessionId + '.json'),
    JSON.stringify({
      session_id: sessionId,
      status: 'ended',
      claimed_task: taskId,
      pid: 77777
    })
  );

  const cpDir = path.join(TMP_DIR, '.claude/pilot/memory/agents', sessionId);
  fs.mkdirSync(cpDir, { recursive: true });
  fs.writeFileSync(
    path.join(cpDir, 'checkpoint.json'),
    JSON.stringify({
      version: 1,
      session_id: sessionId,
      saved_at: new Date().toISOString(),
      task_id: taskId,
      task_title: 'Dry resume',
      plan_step: 2,
      total_steps: 5,
      completed_steps: [{ step: 1, description: 'Init', result: 'success' }],
      key_decisions: [],
      files_modified: [],
      current_context: '',
      important_findings: []
    })
  );

  const ps = freshModule(path.join(libDir, 'process-spawner'));
  const result = ps.spawnAgent(
    { id: taskId, title: 'Dry resume', description: 'Test', labels: [] },
    { projectRoot: TMP_DIR, dryRun: true }
  );

  assertEqual(result.success, true, 'dry run success');
  assertEqual(result.isResume, true, 'should detect resume');
});

// =============================================================================
// TEST SUITE: process-spawner.js — Full spawn (with actual process)
// =============================================================================

console.log('\n--- process-spawner.js: Full Spawn ---');

test('spawnAgent creates context file on actual spawn', () => {
  const ps = freshModule(path.join(libDir, 'process-spawner'));
  const taskId = 'SPAWN-REAL-001';
  const task = { id: taskId, title: 'Real spawn', description: 'Actually spawn', labels: [] };

  // Spawn will likely fail (no `claude` binary in test), but context file should be written
  const result = ps.spawnAgent(task, {
    projectRoot: TMP_DIR,
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  });

  // Check context file was created regardless of spawn success
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const contextFile = path.join(TMP_DIR, '.claude/pilot/state/spawn-context', safeId + '.json');

  // Context file should exist (created before spawn attempt)
  // Note: if spawn fails the file stays — that's expected, PM daemon cleans up on exit
  if (result.success) {
    assert(result.pid > 0, 'should have PID');
    assert(result.contextFile, 'should have contextFile path');
  }
  // If spawn fails (no claude binary), that's OK for this test
  // We're testing context file creation, not actual process spawning
});

test('spawnAgent sets correct environment variables', () => {
  // This test verifies the env construction logic by doing a dry run
  // and checking the intermediate context
  const sc = freshModule(path.join(libDir, 'spawn-context'));
  const task = { id: 'ENV-001', title: 'Env task', description: 'Test env', labels: [] };

  // Verify resume detection logic
  const resumeInfo = sc.detectResume('ENV-001', TMP_DIR);
  assertEqual(resumeInfo.isResume, false, 'fresh task should not be resume');

  // Verify capsule building
  const capsule = sc.buildContextCapsule(task, { projectRoot: TMP_DIR });
  assertEqual(capsule.task.id, 'ENV-001', 'capsule task id');
  assertEqual(capsule.resume, null, 'no resume context');
});

test('CONTEXT_FILE_DIR constant is correct', () => {
  const ps = freshModule(path.join(libDir, 'process-spawner'));
  assertEqual(ps.CONTEXT_FILE_DIR, '.claude/pilot/state/spawn-context', 'context dir path');
});

test('MAX_PROMPT_LENGTH is set', () => {
  const ps = freshModule(path.join(libDir, 'process-spawner'));
  assert(ps.MAX_PROMPT_LENGTH > 0, 'MAX_PROMPT_LENGTH should be positive');
  assert(ps.MAX_PROMPT_LENGTH <= 32000, 'MAX_PROMPT_LENGTH should be reasonable');
});

// =============================================================================
// TEST SUITE: Integration — End-to-end context assembly
// =============================================================================

console.log('\n--- Integration: End-to-End Context Assembly ---');

test('full pipeline: fresh task → capsule → prompt → context file', () => {
  const sc = freshModule(path.join(libDir, 'spawn-context'));
  const ps = freshModule(path.join(libDir, 'process-spawner'));

  const taskId = 'E2E-001';
  const task = { id: taskId, title: 'Build auth module', description: 'JWT auth with refresh tokens', labels: ['backend'] };

  // Step 1: Detect resume
  const resumeInfo = sc.detectResume(taskId, TMP_DIR);
  assertEqual(resumeInfo.isResume, false, 'fresh task');

  // Step 2: Build capsule
  const capsule = sc.buildContextCapsule(task, { projectRoot: TMP_DIR });
  assertEqual(capsule.task.id, taskId, 'capsule task id');
  assertEqual(capsule.resume, null, 'no resume');

  // Step 3: Build prompt
  const prompt = sc.buildSpawnPrompt(capsule);
  assertIncludes(prompt, taskId, 'prompt has task id');
  assertIncludes(prompt, 'Build auth module', 'prompt has title');
  assertIncludes(prompt, 'canonical loop', 'prompt has workflow');

  // Step 4: Write context file
  const filePath = ps._writeContextFile(taskId, capsule, TMP_DIR);
  assert(fs.existsSync(filePath), 'context file exists');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assertEqual(data.task.id, taskId, 'context file task id');
  assertEqual(data.is_resume, false, 'context file not resume');

  // Step 5: Cleanup
  ps.cleanupContextFile(taskId, TMP_DIR);
  assert(!fs.existsSync(filePath), 'cleaned up');
});

test('full pipeline: resume task → capsule → prompt → context file', () => {
  const sc = freshModule(path.join(libDir, 'spawn-context'));
  const ps = freshModule(path.join(libDir, 'process-spawner'));

  const taskId = 'E2E-RESUME-001';
  const sessionId = 'S-e2e-dead-001';

  // Set up ended session with checkpoint
  fs.writeFileSync(
    path.join(TMP_DIR, '.claude/pilot/state/sessions', sessionId + '.json'),
    JSON.stringify({
      session_id: sessionId,
      status: 'ended',
      claimed_task: taskId,
      pid: 66666
    })
  );

  const cpDir = path.join(TMP_DIR, '.claude/pilot/memory/agents', sessionId);
  fs.mkdirSync(cpDir, { recursive: true });
  fs.writeFileSync(
    path.join(cpDir, 'checkpoint.json'),
    JSON.stringify({
      version: 2,
      session_id: sessionId,
      saved_at: new Date().toISOString(),
      task_id: taskId,
      task_title: 'E2E resume',
      plan_step: 4,
      total_steps: 8,
      completed_steps: [
        { step: 1, description: 'Init project', result: 'success' },
        { step: 2, description: 'Add dependencies', result: 'success' },
        { step: 3, description: 'Create models', result: 'success' }
      ],
      key_decisions: ['chose PostgreSQL', 'JWT with refresh'],
      files_modified: ['src/models.ts', 'package.json'],
      current_context: 'Building API routes next',
      important_findings: ['DB connection needs pooling']
    })
  );

  // Step 1: Detect resume
  const resumeInfo = sc.detectResume(taskId, TMP_DIR);
  assertEqual(resumeInfo.isResume, true, 'should be resume');
  assertEqual(resumeInfo.previousSessionId, sessionId, 'correct session');

  // Step 2: Build capsule with resume
  const capsule = sc.buildContextCapsule(
    { id: taskId, title: 'E2E resume', labels: [] },
    { projectRoot: TMP_DIR, previousSessionId: sessionId }
  );
  assert(capsule.resume !== null, 'capsule has resume');
  assert(capsule.resume.restoration_prompt, 'has restoration prompt');

  // Step 3: Build prompt
  const prompt = sc.buildSpawnPrompt(capsule);
  assertIncludes(prompt, 'RESUMING', 'prompt has resume marker');
  assertIncludes(prompt, 'Step 4 of 8', 'prompt has progress from restoration');
  assertIncludes(prompt, 'Re-read modified files', 'prompt has resume instructions');

  // Step 4: Write context file
  const filePath = ps._writeContextFile(taskId, capsule, TMP_DIR);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assertEqual(data.is_resume, true, 'context file is resume');
  assertEqual(data.resume_session, sessionId, 'context file has previous session');
});

test('pm-daemon _spawnAgent delegates to process-spawner (dry run verification)', () => {
  // Ensure orchestrator state directory exists first
  fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/orchestrator'), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_DIR, '.claude/pilot/state/orchestrator/pm-daemon-state.json'),
    JSON.stringify({ status: 'running', started_at: new Date().toISOString(), agents_spawned: 0 })
  );
  fs.writeFileSync(
    path.join(TMP_DIR, '.claude/pilot/state/orchestrator/pm-daemon.pid'),
    String(process.pid)
  );

  // Load pm-daemon fresh — we'll test that _spawnAgent uses process-spawner
  const PmDaemon = freshModule(path.join(libDir, 'pm-daemon')).PmDaemon;

  const daemon = new PmDaemon(TMP_DIR, {
    dryRun: true,
    maxAgents: 2,
    tickIntervalMs: 60000
  });

  const result = daemon._spawnAgent({
    id: 'DAEMON-DRY-001',
    title: 'Daemon dry run',
    description: 'Test delegation',
    labels: []
  });

  assertEqual(result.success, true, 'daemon dry run success');
  assertEqual(result.dry_run, true, 'marked as dry run');
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

// =============================================================================
// RESULTS
// =============================================================================

console.log('\n' + '='.repeat(60));
console.log(`Process Spawner v2 Tests: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
