/**
 * Tests for Process Spawner v2 — Phase 4.2 (Pilot AGI-02g)
 *
 * Tests:
 * - spawn-context.js: context capsule building, prompt generation, resume detection
 * - process-spawner.js: spawn args, worktree integration, context file, error handling
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/process-spawner.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// ============================================================================
// TEST INFRASTRUCTURE
// ============================================================================

let testDir;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawner-v2-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/orchestrator'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/approved-plans'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/spawn-context'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/locks'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/messages'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/memory/agents'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/memory/channels'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/logs'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/config'), { recursive: true });
  fs.mkdirSync(path.join(testDir, 'work/plans'), { recursive: true });

  fs.writeFileSync(path.join(testDir, '.claude/pilot/policy.yaml'), `
session:
  max_concurrent_sessions: 6
worktree:
  enabled: false
orchestrator:
  cost_tracking:
    enabled: false
`);
  fs.writeFileSync(path.join(testDir, '.claude/pilot/messages/bus.jsonl'), '');

  // Set cwd for modules that use process.cwd()
  originalCwd = process.cwd();
  process.chdir(testDir);
}

function cleanup() {
  process.chdir(originalCwd);
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (e) { /* ok */ }
}

let originalCwd;

function freshRequire(modPath) {
  const keysToDelete = Object.keys(require.cache).filter(k =>
    k.includes('spawn-context') ||
    k.includes('process-spawner') ||
    k.includes('checkpoint') ||
    k.includes('memory') ||
    k.includes('pm-research') ||
    k.includes('agent-context') ||
    k.includes('recovery') ||
    k.includes('worktree') ||
    k.includes('agent-logger') ||
    k.includes('orchestrator') ||
    k.includes('policy') ||
    k.includes('session') ||
    k.includes('messaging') ||
    k.includes('pm-daemon')
  );
  keysToDelete.forEach(k => delete require.cache[k]);
  return require(modPath);
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  setup();
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`    ${e.message}`);
    if (e.stack) {
      const frames = e.stack.split('\n').slice(1, 3);
      frames.forEach(f => console.log(`    ${f.trim()}`));
    }
  } finally {
    cleanup();
  }
}

// ============================================================================
// SPAWN-CONTEXT TESTS
// ============================================================================

console.log('\nspawn-context.js');

test('buildContextCapsule returns basic task info', () => {
  const { buildContextCapsule } = freshRequire('../spawn-context');
  const task = { id: 'bd-42', title: 'Test task', description: 'A test', labels: ['frontend'] };

  const capsule = buildContextCapsule(task, { projectRoot: testDir });

  assert.strictEqual(capsule.task.id, 'bd-42');
  assert.strictEqual(capsule.task.title, 'Test task');
  assert.strictEqual(capsule.task.description, 'A test');
  assert.deepStrictEqual(capsule.task.labels, ['frontend']);
  assert.strictEqual(capsule.resume, null);
  assert.strictEqual(capsule.agent_type, null);
});

test('buildContextCapsule sets agent_type from options', () => {
  const { buildContextCapsule } = freshRequire('../spawn-context');
  const task = { id: 'bd-42', title: 'Test' };

  const capsule = buildContextCapsule(task, { projectRoot: testDir, agentType: 'backend' });

  assert.strictEqual(capsule.agent_type, 'backend');
});

test('buildContextCapsule loads approved plan', () => {
  // Write an approval file
  fs.writeFileSync(
    path.join(testDir, '.claude/pilot/state/approved-plans/bd-42.json'),
    JSON.stringify({ approved_at: '2026-01-01T00:00:00Z', steps: 3 })
  );

  const { buildContextCapsule } = freshRequire('../spawn-context');
  const task = { id: 'bd-42', title: 'Test' };

  const capsule = buildContextCapsule(task, { projectRoot: testDir });

  assert.ok(capsule.plan);
  assert.strictEqual(capsule.plan.steps, 3);
  assert.strictEqual(capsule.plan.approved_at, '2026-01-01T00:00:00Z');
});

test('buildContextCapsule loads plan content from work/plans/', () => {
  fs.writeFileSync(
    path.join(testDir, '.claude/pilot/state/approved-plans/bd-42.json'),
    JSON.stringify({ approved_at: '2026-01-01T00:00:00Z', steps: 2 })
  );
  fs.writeFileSync(
    path.join(testDir, 'work/plans/bd-42.md'),
    '# Plan\n\n## Step 1\nDo thing A\n\n## Step 2\nDo thing B'
  );

  const { buildContextCapsule } = freshRequire('../spawn-context');
  const task = { id: 'bd-42', title: 'Test' };

  const capsule = buildContextCapsule(task, { projectRoot: testDir });

  assert.ok(capsule.plan);
  assert.ok(capsule.plan.content);
  assert.ok(capsule.plan.content.includes('Step 1'));
  assert.ok(capsule.plan.content.includes('Step 2'));
});

test('buildContextCapsule builds resume context from checkpoint', () => {
  // Create a checkpoint for a previous session
  const prevSession = 'S-prev-1234';
  const checkpointDir = path.join(testDir, '.claude/pilot/memory/agents', prevSession);
  fs.mkdirSync(checkpointDir, { recursive: true });
  fs.writeFileSync(
    path.join(checkpointDir, 'checkpoint.json'),
    JSON.stringify({
      version: 2,
      session_id: prevSession,
      saved_at: '2026-01-01T12:00:00Z',
      task_id: 'bd-42',
      task_title: 'Test task',
      plan_step: 3,
      total_steps: 5,
      completed_steps: [
        { step: 1, description: 'Setup', result: 'done' },
        { step: 2, description: 'Implement', result: 'done' },
        { step: 3, description: 'Test', result: 'partial' }
      ],
      key_decisions: ['Used vitest over jest'],
      files_modified: ['src/foo.js'],
      current_context: 'Working on tests',
      important_findings: ['API changed in v2']
    })
  );

  const { buildContextCapsule } = freshRequire('../spawn-context');
  const task = { id: 'bd-42', title: 'Test task' };

  const capsule = buildContextCapsule(task, {
    projectRoot: testDir,
    previousSessionId: prevSession
  });

  assert.ok(capsule.resume);
  assert.strictEqual(capsule.resume.from_session, prevSession);
  assert.ok(capsule.resume.checkpoint);
  assert.strictEqual(capsule.resume.checkpoint.plan_step, 3);
  assert.ok(capsule.resume.restoration_prompt);
  assert.ok(capsule.resume.restoration_prompt.includes('Step 3'));
});

test('buildSpawnPrompt includes task info for fresh spawn', () => {
  const { buildContextCapsule, buildSpawnPrompt } = freshRequire('../spawn-context');
  const task = { id: 'bd-42', title: 'Build auth', description: 'Add JWT auth' };

  const capsule = buildContextCapsule(task, { projectRoot: testDir });
  const prompt = buildSpawnPrompt(capsule);

  assert.ok(prompt.includes('bd-42'));
  assert.ok(prompt.includes('Build auth'));
  assert.ok(prompt.includes('Add JWT auth'));
  assert.ok(prompt.includes('canonical loop'));
  assert.ok(!prompt.includes('RESUMING'));
});

test('buildSpawnPrompt includes resume context for respawn', () => {
  const prevSession = 'S-prev-5678';
  const checkpointDir = path.join(testDir, '.claude/pilot/memory/agents', prevSession);
  fs.mkdirSync(checkpointDir, { recursive: true });
  fs.writeFileSync(
    path.join(checkpointDir, 'checkpoint.json'),
    JSON.stringify({
      version: 1,
      session_id: prevSession,
      saved_at: '2026-01-01T12:00:00Z',
      task_id: 'bd-42',
      task_title: 'Build auth',
      plan_step: 2,
      total_steps: 4,
      completed_steps: [{ step: 1, description: 'Setup' }],
      key_decisions: [],
      files_modified: [],
      current_context: '',
      important_findings: []
    })
  );

  const { buildContextCapsule, buildSpawnPrompt } = freshRequire('../spawn-context');
  const task = { id: 'bd-42', title: 'Build auth' };

  const capsule = buildContextCapsule(task, {
    projectRoot: testDir,
    previousSessionId: prevSession
  });
  const prompt = buildSpawnPrompt(capsule);

  assert.ok(prompt.includes('RESUMING FROM CHECKPOINT'));
  assert.ok(prompt.includes('RESUME spawn'));
  assert.ok(!prompt.includes('canonical loop'));
});

test('buildSpawnPrompt includes approved plan', () => {
  fs.writeFileSync(
    path.join(testDir, '.claude/pilot/state/approved-plans/bd-42.json'),
    JSON.stringify({ approved_at: '2026-01-01T00:00:00Z', steps: 2 })
  );
  fs.writeFileSync(
    path.join(testDir, 'work/plans/bd-42.md'),
    '# Plan\n\nStep 1: Create file\nStep 2: Write tests'
  );

  const { buildContextCapsule, buildSpawnPrompt } = freshRequire('../spawn-context');
  const task = { id: 'bd-42', title: 'Test' };

  const capsule = buildContextCapsule(task, { projectRoot: testDir });
  const prompt = buildSpawnPrompt(capsule);

  assert.ok(prompt.includes('Approved Plan'));
  assert.ok(prompt.includes('Step 1: Create file'));
  assert.ok(prompt.includes('/pilot-exec'));
});

test('detectResume finds checkpoint from ended session', () => {
  // Create an ended session that worked on our task
  fs.writeFileSync(
    path.join(testDir, '.claude/pilot/state/sessions/S-old-9999.json'),
    JSON.stringify({
      session_id: 'S-old-9999',
      status: 'ended',
      claimed_task: 'bd-42'
    })
  );

  // Create checkpoint for that session
  const checkpointDir = path.join(testDir, '.claude/pilot/memory/agents/S-old-9999');
  fs.mkdirSync(checkpointDir, { recursive: true });
  fs.writeFileSync(
    path.join(checkpointDir, 'checkpoint.json'),
    JSON.stringify({
      version: 1,
      session_id: 'S-old-9999',
      task_id: 'bd-42',
      plan_step: 3,
      total_steps: 5,
      completed_steps: [],
      key_decisions: [],
      files_modified: [],
      current_context: '',
      important_findings: []
    })
  );

  const { detectResume } = freshRequire('../spawn-context');
  const result = detectResume('bd-42', testDir);

  assert.strictEqual(result.isResume, true);
  assert.strictEqual(result.previousSessionId, 'S-old-9999');
  assert.ok(result.checkpoint);
  assert.strictEqual(result.checkpoint.plan_step, 3);
});

test('detectResume returns false when no checkpoint exists', () => {
  // Ended session but no checkpoint
  fs.writeFileSync(
    path.join(testDir, '.claude/pilot/state/sessions/S-old-1111.json'),
    JSON.stringify({
      session_id: 'S-old-1111',
      status: 'ended',
      claimed_task: 'bd-42'
    })
  );

  const { detectResume } = freshRequire('../spawn-context');
  const result = detectResume('bd-42', testDir);

  assert.strictEqual(result.isResume, false);
});

test('detectResume returns false when no matching session exists', () => {
  const { detectResume } = freshRequire('../spawn-context');
  const result = detectResume('bd-999', testDir);

  assert.strictEqual(result.isResume, false);
});

// ============================================================================
// PROCESS-SPAWNER TESTS
// ============================================================================

console.log('\nprocess-spawner.js');

test('_writeContextFile creates JSON context file', () => {
  const { _writeContextFile } = freshRequire('../process-spawner');

  const capsule = {
    task: { id: 'bd-42', title: 'Test', description: null, labels: [] },
    resume: null,
    research: null,
    plan: null,
    related_decisions: [],
    related_agents: [],
    agent_type: 'backend'
  };

  const filePath = _writeContextFile('bd-42', capsule, testDir);

  assert.ok(fs.existsSync(filePath));
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.strictEqual(data.task.id, 'bd-42');
  assert.strictEqual(data.agent_type, 'backend');
  assert.strictEqual(data.is_resume, false);
  assert.ok(data.created_at);
});

test('_writeContextFile marks resume correctly', () => {
  const { _writeContextFile } = freshRequire('../process-spawner');

  const capsule = {
    task: { id: 'bd-42', title: 'Test', description: null, labels: [] },
    resume: { from_session: 'S-old-1234' },
    research: null,
    plan: { approved_at: '2026-01-01', steps: 3 },
    related_decisions: [],
    related_agents: [],
    agent_type: null
  };

  const filePath = _writeContextFile('bd-42', capsule, testDir);

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.strictEqual(data.is_resume, true);
  assert.strictEqual(data.resume_session, 'S-old-1234');
  assert.strictEqual(data.has_plan, true);
});

test('cleanupContextFile removes the file', () => {
  const { _writeContextFile, cleanupContextFile } = freshRequire('../process-spawner');

  const capsule = {
    task: { id: 'bd-42', title: 'Test', description: null, labels: [] },
    resume: null, research: null, plan: null,
    related_decisions: [], related_agents: [], agent_type: null
  };

  const filePath = _writeContextFile('bd-42', capsule, testDir);
  assert.ok(fs.existsSync(filePath));

  cleanupContextFile('bd-42', testDir);
  assert.ok(!fs.existsSync(filePath));
});

test('cleanupContextFile is safe when file does not exist', () => {
  const { cleanupContextFile } = freshRequire('../process-spawner');

  // Should not throw
  cleanupContextFile('bd-nonexistent', testDir);
});

test('spawnAgent in dryRun mode returns context info', () => {
  const { spawnAgent } = freshRequire('../process-spawner');

  const task = { id: 'bd-42', title: 'Test task', description: 'Do test things' };
  const result = spawnAgent(task, {
    projectRoot: testDir,
    agentType: 'backend',
    dryRun: true
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.dry_run, true);
  assert.strictEqual(result.isResume, false);
});

test('spawnAgent in dryRun detects resume', () => {
  // Create ended session with checkpoint
  fs.writeFileSync(
    path.join(testDir, '.claude/pilot/state/sessions/S-old-dry.json'),
    JSON.stringify({ session_id: 'S-old-dry', status: 'ended', claimed_task: 'bd-42' })
  );
  const checkpointDir = path.join(testDir, '.claude/pilot/memory/agents/S-old-dry');
  fs.mkdirSync(checkpointDir, { recursive: true });
  fs.writeFileSync(
    path.join(checkpointDir, 'checkpoint.json'),
    JSON.stringify({
      version: 1, session_id: 'S-old-dry', task_id: 'bd-42',
      plan_step: 2, total_steps: 4,
      completed_steps: [], key_decisions: [], files_modified: [],
      current_context: '', important_findings: []
    })
  );

  const { spawnAgent } = freshRequire('../process-spawner');
  const task = { id: 'bd-42', title: 'Test' };
  const result = spawnAgent(task, { projectRoot: testDir, dryRun: true });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.isResume, true);
});

// ============================================================================
// PM-DAEMON INTEGRATION TESTS
// ============================================================================

console.log('\npm-daemon.js integration');

test('PmDaemon constructor still works with processSpawner require', () => {
  const { PmDaemon } = freshRequire('../pm-daemon');
  const daemon = new PmDaemon(testDir, {
    skipSignalHandlers: true,
    once: true
  });

  assert.ok(daemon);
  assert.strictEqual(daemon.projectRoot, testDir);
});

test('PmDaemon getStatus includes spawned_agents tracking fields', () => {
  const { PmDaemon } = freshRequire('../pm-daemon');
  const daemon = new PmDaemon(testDir, { skipSignalHandlers: true });

  const status = daemon.getStatus();
  assert.ok(status);
  assert.ok(Array.isArray(status.spawned_agents));
});

// ============================================================================
// RESULTS
// ============================================================================

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
