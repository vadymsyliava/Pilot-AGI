#!/usr/bin/env node

/**
 * Verification tests for PM Orchestrator (Phase 2.4)
 * Run: node tests/orchestrator.test.js
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
// SETUP: temp directory for isolated file operations
// =============================================================================

const ORIG_CWD = process.cwd();
const TMP_DIR = path.join(require('os').tmpdir(), 'pilot-orch-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

// Create minimal directory structure the orchestrator expects
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/orchestrator'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/sessions'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/approved-plans'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/memory/channels'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/memory/schemas'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, 'runs'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, 'work/plans'), { recursive: true });

// Create minimal memory index
fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/memory/index.json'), JSON.stringify({
  version: 1,
  channels: {
    'pm-decisions': {
      description: 'PM decisions',
      publisher: 'pm',
      consumers: [],
      schema: null
    }
  }
}));

// Create minimal policy
fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/policy.yaml'), [
  'version: 1',
  'session:',
  '  max_concurrent_sessions: 6',
  '  heartbeat_interval_sec: 60',
  'orchestrator:',
  '  drift_threshold: 0.3',
  '  require_tests_pass: false',
  '  auto_reassign_stale: false',
  'worktree:',
  '  base_branch: main'
].join('\n'));

// Change to temp dir so orchestrator's process.cwd() references are isolated
process.chdir(TMP_DIR);

// Now require the orchestrator (after cwd change)
const orchestrator = require('../.claude/pilot/hooks/lib/orchestrator');

// =============================================================================
// extractFilesFromPlan TESTS (pure function)
// =============================================================================

console.log('=== extractFilesFromPlan Tests ===\n');

test('extracts files from "File: path" lines', () => {
  const plan = [
    '## Step 1',
    'File: src/components/Button.tsx',
    '',
    '## Step 2',
    'File: src/utils/helpers.ts'
  ].join('\n');
  const files = orchestrator.extractFilesFromPlan(plan);
  assert(files.includes('src/components/Button.tsx'), 'should include Button.tsx');
  assert(files.includes('src/utils/helpers.ts'), 'should include helpers.ts');
});

test('extracts files from "Files: a, b" lines', () => {
  const plan = '## Step 1\nFiles: src/a.ts, src/b.ts, src/c.ts';
  const files = orchestrator.extractFilesFromPlan(plan);
  assert(files.includes('src/a.ts'), 'should include a.ts');
  assert(files.includes('src/b.ts'), 'should include b.ts');
  assert(files.includes('src/c.ts'), 'should include c.ts');
});

test('extracts backtick-quoted file paths', () => {
  const plan = 'Modify `lib/orchestrator.js` and `lib/session.js`';
  const files = orchestrator.extractFilesFromPlan(plan);
  assert(files.includes('lib/orchestrator.js'), 'should include orchestrator.js');
  assert(files.includes('lib/session.js'), 'should include session.js');
});

test('extracts files from "create file" patterns', () => {
  const plan = 'Create file tests/orchestrator.test.js';
  const files = orchestrator.extractFilesFromPlan(plan);
  assert(files.includes('tests/orchestrator.test.js'), 'should include test file');
});

test('returns empty array for plan with no files', () => {
  const plan = 'Just a description with no file references.';
  const files = orchestrator.extractFilesFromPlan(plan);
  assert(Array.isArray(files), 'should return array');
  assert(files.length === 0, 'should be empty');
});

test('deduplicates file paths', () => {
  const plan = 'File: src/app.ts\nFiles: src/app.ts, src/other.ts\nModify `src/app.ts`';
  const files = orchestrator.extractFilesFromPlan(plan);
  const appCount = files.filter(f => f === 'src/app.ts').length;
  assert(appCount === 1, 'should not duplicate — got ' + appCount);
});

// =============================================================================
// getRecentEvents TESTS (file-based)
// =============================================================================

console.log('\n=== getRecentEvents Tests ===\n');

test('returns empty array when no events file', () => {
  const events = orchestrator.getRecentEvents();
  assert(Array.isArray(events), 'should return array');
  assert(events.length === 0, 'should be empty');
});

test('reads events from sessions.jsonl', () => {
  const eventsPath = path.join(TMP_DIR, 'runs/sessions.jsonl');
  const lines = [
    JSON.stringify({ type: 'session_start', ts: '2026-02-10T10:00:00Z' }),
    JSON.stringify({ type: 'task_claimed', ts: '2026-02-10T10:01:00Z' }),
    JSON.stringify({ type: 'commit', ts: '2026-02-10T10:02:00Z' })
  ];
  fs.writeFileSync(eventsPath, lines.join('\n') + '\n');

  const events = orchestrator.getRecentEvents();
  assert(events.length === 3, 'should return 3 events');
  assert(events[0].type === 'session_start', 'first event type');
  assert(events[2].type === 'commit', 'last event type');
});

test('respects limit parameter', () => {
  const events = orchestrator.getRecentEvents(2);
  assert(events.length === 2, 'should return only 2 events');
  assert(events[0].type === 'task_claimed', 'should return last 2 events');
});

test('handles malformed JSON lines gracefully', () => {
  const eventsPath = path.join(TMP_DIR, 'runs/sessions.jsonl');
  const lines = [
    JSON.stringify({ type: 'valid', ts: '2026-02-10T10:00:00Z' }),
    'not json at all',
    JSON.stringify({ type: 'also_valid', ts: '2026-02-10T10:01:00Z' })
  ];
  fs.writeFileSync(eventsPath, lines.join('\n') + '\n');

  const events = orchestrator.getRecentEvents();
  assert(events.length === 2, 'should skip malformed lines, got ' + events.length);
});

// =============================================================================
// PM STATE MANAGEMENT TESTS (file-based)
// =============================================================================

console.log('\n=== PM State Tests ===\n');

test('initializePm creates state file', () => {
  const state = orchestrator.initializePm('S-pm-test-001');
  assert(state.pm_session_id === 'S-pm-test-001', 'session id should match');
  assert(state.started_at, 'should have started_at');
  assert(state.decisions_count === 0, 'decisions_count should be 0');
  assert(state.merges_approved === 0, 'merges_approved should be 0');
});

test('loadPmState reads back state', () => {
  const state = orchestrator.loadPmState();
  assert(state !== null, 'should not be null');
  assert(state.pm_session_id === 'S-pm-test-001', 'should have correct session');
});

test('updatePmState merges updates', () => {
  const updated = orchestrator.updatePmState({
    decisions_count: 5,
    merges_approved: 2
  });
  assert(updated.decisions_count === 5, 'decisions_count should be 5');
  assert(updated.merges_approved === 2, 'merges_approved should be 2');
  assert(updated.pm_session_id === 'S-pm-test-001', 'session id preserved');
  assert(updated.last_scan !== null, 'last_scan should be set');
});

test('updatePmState returns null when no state exists', () => {
  const statePath = path.join(TMP_DIR, '.claude/pilot/state/orchestrator/pm-state.json');
  fs.unlinkSync(statePath);
  const result = orchestrator.updatePmState({ foo: 'bar' });
  assert(result === null, 'should return null');
});

test('loadPmState returns null when no state exists', () => {
  const result = orchestrator.loadPmState();
  assert(result === null, 'should return null');
});

// =============================================================================
// CONSTANTS TESTS
// =============================================================================

console.log('\n=== Constants Tests ===\n');

test('PM_DECISIONS_CHANNEL is pm-decisions', () => {
  assert(orchestrator.PM_DECISIONS_CHANNEL === 'pm-decisions', 'should be pm-decisions');
});

test('DEFAULT_DRIFT_THRESHOLD is 0.3', () => {
  assert(orchestrator.DEFAULT_DRIFT_THRESHOLD === 0.3, 'should be 0.3');
});

// =============================================================================
// getPlannedFiles TESTS (file-based)
// =============================================================================

console.log('\n=== getPlannedFiles Tests ===\n');

test('reads planned files from plan-approval.json', () => {
  const approvalPath = path.join(TMP_DIR, '.claude/pilot/state/plan-approval.json');
  fs.writeFileSync(approvalPath, JSON.stringify({
    task_id: 'Pilot AGI-test-pf1',
    planned_files: ['src/a.ts', 'src/b.ts'],
    current_step: 1,
    total_steps: 3
  }));

  const files = orchestrator.getPlannedFiles('Pilot AGI-test-pf1');
  assert(files.includes('src/a.ts'), 'should include a.ts');
  assert(files.includes('src/b.ts'), 'should include b.ts');
});

test('falls back to plan file extraction', () => {
  const approvalPath = path.join(TMP_DIR, '.claude/pilot/state/plan-approval.json');
  fs.writeFileSync(approvalPath, JSON.stringify({
    task_id: 'Pilot AGI-test-pf2',
    plan_file: 'work/plans/test-plan.md',
    current_step: 1,
    total_steps: 2
  }));

  fs.writeFileSync(path.join(TMP_DIR, 'work/plans/test-plan.md'),
    '## Step 1\nFile: lib/utils.js\n## Step 2\nFile: lib/helpers.js\n'
  );

  const files = orchestrator.getPlannedFiles('Pilot AGI-test-pf2');
  assert(files.includes('lib/utils.js'), 'should include utils.js');
  assert(files.includes('lib/helpers.js'), 'should include helpers.js');
});

test('searches work/plans/ for task ID', () => {
  const approvalPath = path.join(TMP_DIR, '.claude/pilot/state/plan-approval.json');
  fs.writeFileSync(approvalPath, JSON.stringify({
    task_id: 'Pilot AGI-other',
    planned_files: ['unrelated.ts']
  }));

  fs.writeFileSync(path.join(TMP_DIR, 'work/plans/Pilot AGI-xyz-plan.md'),
    '**Task**: Pilot AGI-xyz\n\nFile: src/feature.ts\nFile: src/index.ts\n'
  );

  const files = orchestrator.getPlannedFiles('Pilot AGI-xyz');
  assert(files.includes('src/feature.ts'), 'should find feature.ts from plan scan');
  assert(files.includes('src/index.ts'), 'should find index.ts from plan scan');
});

test('returns empty array for unknown task', () => {
  const files = orchestrator.getPlannedFiles('Pilot AGI-nonexistent-999');
  assert(Array.isArray(files), 'should return array');
  assert(files.length === 0, 'should be empty');
});

// =============================================================================
// detectDrift TESTS
// =============================================================================

console.log('\n=== detectDrift Tests ===\n');

test('returns not-drifted for unknown session', () => {
  // detectDrift uses session.getAllSessionStates which scans session files.
  // An unknown session won't be found, so drifted=false with error.
  const result = orchestrator.detectDrift('S-nonexistent-000');
  assert(result.drifted === false, 'should not be drifted');
  assert(result.error, 'should have error message');
});

test('returns not-drifted for session with no claimed task', () => {
  // Create a session state file with no claimed_task in the temp dir
  const sessionPath = path.join(TMP_DIR, '.claude/pilot/state/sessions/S-noclaim-001.json');
  fs.writeFileSync(sessionPath, JSON.stringify({
    session_id: 'S-noclaim-001',
    status: 'active',
    last_heartbeat: new Date().toISOString(),
    claimed_task: null,
    locked_areas: [],
    locked_files: []
  }));

  const result = orchestrator.detectDrift('S-noclaim-001');
  assert(result.drifted === false, 'should not be drifted');
  assert(result.error && result.error.includes('No task'), 'should mention no task');
});

// =============================================================================
// publishDecision TESTS
// =============================================================================

console.log('\n=== publishDecision Tests ===\n');

test('publishDecision does not throw', () => {
  let threw = false;
  try {
    orchestrator.publishDecision('task_assigned', {
      task_id: 'Pilot AGI-test',
      assigned_to: 'S-agent-001',
      assigned_by: 'S-pm-001'
    });
  } catch (e) {
    threw = true;
  }
  assert(!threw, 'publishDecision should not throw');
});

// =============================================================================
// AGENT REGISTRY VALIDATION
// =============================================================================

console.log('\n=== Agent Registry Tests ===\n');

test('agent-registry.json has pm agent', () => {
  const registryPath = path.join(ORIG_CWD, '.claude/pilot/agent-registry.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert(registry.agents.pm, 'should have pm agent');
  assert(registry.agents.pm.name === 'PM Orchestrator Agent', 'name should match');
});

test('pm agent has correct capabilities', () => {
  const registryPath = path.join(ORIG_CWD, '.claude/pilot/agent-registry.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const pm = registry.agents.pm;
  assert(pm.capabilities.includes('task_assignment'), 'should have task_assignment');
  assert(pm.capabilities.includes('drift_detection'), 'should have drift_detection');
  assert(pm.capabilities.includes('merge_approval'), 'should have merge_approval');
  assert(pm.capabilities.includes('work_review'), 'should have work_review');
});

test('pm agent publishes pm-decisions channel', () => {
  const registryPath = path.join(ORIG_CWD, '.claude/pilot/agent-registry.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert(registry.agents.pm.memory.publishes.includes('pm-decisions'), 'should publish pm-decisions');
});

// =============================================================================
// MEMORY INDEX VALIDATION
// =============================================================================

console.log('\n=== Memory Index Tests ===\n');

test('memory index has pm-decisions channel', () => {
  const indexPath = path.join(ORIG_CWD, '.claude/pilot/memory/index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert(index.channels['pm-decisions'], 'should have pm-decisions channel');
  assert(index.channels['pm-decisions'].publisher === 'pm', 'publisher should be pm');
});

test('pm-decisions schema exists and is valid', () => {
  const schemaPath = path.join(ORIG_CWD, '.claude/pilot/memory/schemas/pm-decisions.schema.json');
  assert(fs.existsSync(schemaPath), 'schema file should exist');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert(schema.properties.decisions, 'should have decisions property');
  assert(schema.properties.decisions.items.properties.type, 'decisions should have type');
});

// =============================================================================
// SKILL FILE VALIDATION
// =============================================================================

console.log('\n=== Skill Files Tests ===\n');

test('pilot-pm skill exists', () => {
  const skillPath = path.join(ORIG_CWD, '.claude/skills/pilot-pm/SKILL.md');
  assert(fs.existsSync(skillPath), 'pilot-pm SKILL.md should exist');
  const content = fs.readFileSync(skillPath, 'utf8');
  assert(content.length > 100, 'skill should have substantial content');
  assert(content.includes('PM') || content.includes('orchestrat'), 'should mention PM/orchestrator');
});

test('pilot-pm-review skill exists', () => {
  const skillPath = path.join(ORIG_CWD, '.claude/skills/pilot-pm-review/SKILL.md');
  assert(fs.existsSync(skillPath), 'pilot-pm-review SKILL.md should exist');
  const content = fs.readFileSync(skillPath, 'utf8');
  assert(content.length > 100, 'skill should have substantial content');
  assert(content.includes('review') || content.includes('merge'), 'should mention review/merge');
});

// =============================================================================
// MODULE EXPORTS VALIDATION
// =============================================================================

console.log('\n=== Module Exports Tests ===\n');

test('orchestrator exports all required functions', () => {
  const required = [
    'getProjectOverview',
    'getRecentEvents',
    'getAgentHealth',
    'getStaleAgents',
    'detectDrift',
    'getPlannedFiles',
    'extractFilesFromPlan',
    'assignTask',
    'reassignTask',
    'blockAgent',
    'unblockAgent',
    'reviewWork',
    'approveMerge',
    'rejectMerge',
    'handleStaleAgents',
    'initializePm',
    'loadPmState',
    'updatePmState',
    'publishDecision'
  ];

  for (const fn of required) {
    assert(typeof orchestrator[fn] === 'function', fn + ' should be exported as function');
  }
});

// =============================================================================
// CLEANUP & RESULTS
// =============================================================================

process.chdir(ORIG_CWD);
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\n' + '='.repeat(40));
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
console.log('='.repeat(40));

if (failed > 0) process.exit(1);
