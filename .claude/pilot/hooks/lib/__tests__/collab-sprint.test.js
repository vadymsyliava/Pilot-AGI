/**
 * Tests for Collaborative Sprint Planning — Phase 7.8 (Pilot AGI-si1p)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/collab-sprint.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collabsprint-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sprints'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/assessments'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/souls'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot'), { recursive: true });
  fs.writeFileSync(path.join(testDir, '.claude/pilot/agent-registry.json'), JSON.stringify({
    agents: {
      frontend: { name: 'Frontend', capabilities: ['styling', 'component_creation'] },
      backend: { name: 'Backend', capabilities: ['api_design', 'database_operations'] },
      testing: { name: 'Testing', capabilities: ['unit_testing', 'e2e_testing'] }
    }
  }, null, 2));

  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModule() {
  const modPaths = [
    '../collab-sprint', '../souls', '../self-assessment',
    '../policy', '../session', '../memory', '../messaging'
  ];
  for (const modPath of modPaths) {
    try { delete require.cache[require.resolve(modPath)]; } catch (e) {}
  }
  return require('../collab-sprint');
}

function freshSouls() {
  try { delete require.cache[require.resolve('../souls')]; } catch (e) {}
  return require('../souls');
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  setup();
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  } finally {
    teardown();
  }
}

const SAMPLE_TASKS = [
  { id: 'T-001', description: 'Build login form', areas: ['styling', 'component_creation'] },
  { id: 'T-002', description: 'Create API endpoint', areas: ['api_design'] },
  { id: 'T-003', description: 'Write integration tests', areas: ['unit_testing'] }
];

const SAMPLE_ROLES = ['frontend', 'backend', 'testing'];

console.log('\n=== Collaborative Sprint Planning Tests ===\n');

// --- initializeSprint ---

test('initializeSprint creates sprint with tasks and agents', () => {
  const cs = freshModule();
  const r = cs.initializeSprint('sprint-1', SAMPLE_TASKS, SAMPLE_ROLES);
  assert.ok(r.success);
  assert.strictEqual(r.sprint.tasks.length, 3);
  assert.strictEqual(r.sprint.agents.length, 3);
  assert.strictEqual(r.sprint.status, cs.SPRINT_STATUS.PLANNING);
});

test('initializeSprint requires all params', () => {
  const cs = freshModule();
  assert.strictEqual(cs.initializeSprint(null, SAMPLE_TASKS, SAMPLE_ROLES).success, false);
  assert.strictEqual(cs.initializeSprint('s', [], SAMPLE_ROLES).success, false);
  assert.strictEqual(cs.initializeSprint('s', SAMPLE_TASKS, []).success, false);
});

test('initializeSprint persists to disk', () => {
  const cs = freshModule();
  cs.initializeSprint('sprint-2', SAMPLE_TASKS, SAMPLE_ROLES);
  const loaded = cs.loadSprint('sprint-2');
  assert.ok(loaded);
  assert.strictEqual(loaded.sprint_id, 'sprint-2');
});

// --- placeBid ---

test('placeBid records agent bid on task', () => {
  const cs = freshModule();
  cs.initializeSprint('sprint-3', SAMPLE_TASKS, SAMPLE_ROLES);

  const r = cs.placeBid('sprint-3', 'T-001', 'frontend', {
    confidence: 80,
    reason: 'I have styling expertise',
    estimated_hours: 3
  });
  assert.ok(r.success);
  assert.strictEqual(r.bid_count, 1);
  assert.ok(r.total_score >= 80);
});

test('placeBid prevents duplicate bids from same agent', () => {
  const cs = freshModule();
  cs.initializeSprint('sprint-4', SAMPLE_TASKS, SAMPLE_ROLES);

  cs.placeBid('sprint-4', 'T-001', 'frontend', { confidence: 80 });
  const r = cs.placeBid('sprint-4', 'T-001', 'frontend', { confidence: 90 });
  assert.strictEqual(r.success, false);
});

test('placeBid enforces MAX_BIDS_PER_TASK', () => {
  const cs = freshModule();
  const manyRoles = ['a', 'b', 'c', 'd', 'e', 'f'];
  cs.initializeSprint('sprint-5', SAMPLE_TASKS, manyRoles);

  for (let i = 0; i < cs.MAX_BIDS_PER_TASK; i++) {
    cs.placeBid('sprint-5', 'T-001', manyRoles[i], { confidence: 50 });
  }
  const r = cs.placeBid('sprint-5', 'T-001', 'f', { confidence: 50 });
  assert.strictEqual(r.success, false);
});

test('placeBid requires all params', () => {
  const cs = freshModule();
  cs.initializeSprint('sprint-6', SAMPLE_TASKS, SAMPLE_ROLES);
  assert.strictEqual(cs.placeBid(null, 'T', 'r', {}).success, false);
  assert.strictEqual(cs.placeBid('s', null, 'r', {}).success, false);
  assert.strictEqual(cs.placeBid('s', 'T', null, {}).success, false);
  assert.strictEqual(cs.placeBid('s', 'T', 'r', null).success, false);
});

test('placeBid returns error for nonexistent task', () => {
  const cs = freshModule();
  cs.initializeSprint('sprint-7', SAMPLE_TASKS, SAMPLE_ROLES);
  const r = cs.placeBid('sprint-7', 'T-999', 'frontend', { confidence: 80 });
  assert.strictEqual(r.success, false);
});

test('placeBid adds soul expertise score', () => {
  const cs = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');
  const soul = souls.loadSoul('frontend');
  soul.expertise = ['styling: strong (score: 90, 10 tasks)'];
  souls.writeSoul('frontend', soul);

  cs.initializeSprint('sprint-8', SAMPLE_TASKS, SAMPLE_ROLES);
  const r = cs.placeBid('sprint-8', 'T-001', 'frontend', { confidence: 50 });
  assert.ok(r.total_score > 50); // Should have expertise bonus
});

// --- autoBid ---

test('autoBid generates bids based on capabilities', () => {
  const cs = freshModule();
  cs.initializeSprint('sprint-9', SAMPLE_TASKS, SAMPLE_ROLES);

  const r = cs.autoBid('sprint-9', 'frontend');
  assert.ok(r.success);
  assert.ok(r.bids_placed > 0);

  const sprint = cs.loadSprint('sprint-9');
  const t1 = sprint.tasks.find(t => t.id === 'T-001');
  assert.ok(t1.bids.some(b => b.role === 'frontend'));
});

test('autoBid skips already-bid tasks', () => {
  const cs = freshModule();
  cs.initializeSprint('sprint-10', SAMPLE_TASKS, SAMPLE_ROLES);

  cs.placeBid('sprint-10', 'T-001', 'frontend', { confidence: 80 });
  const r = cs.autoBid('sprint-10', 'frontend');
  // Should not double-bid on T-001
  const sprint = cs.loadSprint('sprint-10');
  const t1 = sprint.tasks.find(t => t.id === 'T-001');
  assert.strictEqual(t1.bids.filter(b => b.role === 'frontend').length, 1);
});

// --- resolveBids ---

test('resolveBids assigns tasks to highest scoring bidders', () => {
  const cs = freshModule();
  cs.initializeSprint('sprint-11', SAMPLE_TASKS, SAMPLE_ROLES);

  cs.placeBid('sprint-11', 'T-001', 'frontend', { confidence: 90, estimated_hours: 2 });
  cs.placeBid('sprint-11', 'T-001', 'backend', { confidence: 60, estimated_hours: 4 });
  cs.placeBid('sprint-11', 'T-002', 'backend', { confidence: 85, estimated_hours: 3 });
  cs.placeBid('sprint-11', 'T-003', 'testing', { confidence: 95, estimated_hours: 2 });

  const r = cs.resolveBids('sprint-11');
  assert.ok(r.success);
  assert.ok(r.assignments.length > 0);

  const sprint = cs.loadSprint('sprint-11');
  assert.strictEqual(sprint.status, cs.SPRINT_STATUS.COMMITTED);
});

test('resolveBids balances load across agents', () => {
  const cs = freshModule();
  const tasks = [
    { id: 'T-A', description: 'Task A', areas: ['styling'] },
    { id: 'T-B', description: 'Task B', areas: ['styling'] },
    { id: 'T-C', description: 'Task C', areas: ['styling'] }
  ];
  cs.initializeSprint('sprint-12', tasks, ['frontend', 'backend']);

  // Frontend bids on all with equal confidence
  cs.placeBid('sprint-12', 'T-A', 'frontend', { confidence: 80 });
  cs.placeBid('sprint-12', 'T-B', 'frontend', { confidence: 80 });
  cs.placeBid('sprint-12', 'T-C', 'frontend', { confidence: 80 });
  // Backend also bids on all
  cs.placeBid('sprint-12', 'T-A', 'backend', { confidence: 80 });
  cs.placeBid('sprint-12', 'T-B', 'backend', { confidence: 80 });
  cs.placeBid('sprint-12', 'T-C', 'backend', { confidence: 80 });

  cs.resolveBids('sprint-12');
  const sprint = cs.loadSprint('sprint-12');

  // Should not assign all to one agent
  const frontendTasks = sprint.tasks.filter(t => t.assigned_to === 'frontend');
  const backendTasks = sprint.tasks.filter(t => t.assigned_to === 'backend');
  assert.ok(frontendTasks.length > 0);
  assert.ok(backendTasks.length > 0);
});

test('resolveBids handles sprint not found', () => {
  const cs = freshModule();
  const r = cs.resolveBids('nonexistent');
  assert.strictEqual(r.success, false);
});

// --- confirmCommitment ---

test('confirmCommitment confirms assigned task', () => {
  const cs = freshModule();
  cs.initializeSprint('sprint-13', SAMPLE_TASKS, SAMPLE_ROLES);
  cs.placeBid('sprint-13', 'T-001', 'frontend', { confidence: 80, estimated_hours: 3 });
  cs.resolveBids('sprint-13');

  const r = cs.confirmCommitment('sprint-13', 'T-001', 'frontend', {
    estimated_hours: 4, notes: 'Will need design review'
  });
  assert.ok(r.success);

  const sprint = cs.loadSprint('sprint-13');
  const task = sprint.tasks.find(t => t.id === 'T-001');
  assert.strictEqual(task.committed, true);
  assert.strictEqual(task.estimated_hours, 4);
});

test('confirmCommitment rejects wrong agent', () => {
  const cs = freshModule();
  cs.initializeSprint('sprint-14', SAMPLE_TASKS, SAMPLE_ROLES);
  cs.placeBid('sprint-14', 'T-001', 'frontend', { confidence: 80 });
  cs.resolveBids('sprint-14');

  const r = cs.confirmCommitment('sprint-14', 'T-001', 'backend', { estimated_hours: 2 });
  assert.strictEqual(r.success, false);
});

test('confirmCommitment sets sprint ACTIVE when all committed', () => {
  const cs = freshModule();
  cs.initializeSprint('sprint-15', [SAMPLE_TASKS[0]], ['frontend']);
  cs.placeBid('sprint-15', 'T-001', 'frontend', { confidence: 80 });
  cs.resolveBids('sprint-15');

  const r = cs.confirmCommitment('sprint-15', 'T-001', 'frontend', { estimated_hours: 3 });
  assert.ok(r.all_committed);

  const sprint = cs.loadSprint('sprint-15');
  assert.strictEqual(sprint.status, cs.SPRINT_STATUS.ACTIVE);
});

test('confirmCommitment requires params', () => {
  const cs = freshModule();
  assert.strictEqual(cs.confirmCommitment(null, 'T', 'r', {}).success, false);
  assert.strictEqual(cs.confirmCommitment('s', null, 'r', {}).success, false);
  assert.strictEqual(cs.confirmCommitment('s', 'T', null, {}).success, false);
});

// --- contributeRetro ---

test('contributeRetro records retrospective contribution', () => {
  const cs = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  cs.initializeSprint('sprint-16', SAMPLE_TASKS, SAMPLE_ROLES);

  const r = cs.contributeRetro('sprint-16', 'frontend', {
    went_well: ['Component patterns were clear'],
    could_improve: ['Better API type definitions'],
    learnings: ['Tailwind JIT mode is faster']
  });
  assert.ok(r.success);
  assert.strictEqual(r.contributions, 1);

  const sprint = cs.loadSprint('sprint-16');
  assert.strictEqual(sprint.retrospective.length, 1);
  assert.strictEqual(sprint.retrospective[0].role, 'frontend');
});

test('contributeRetro writes learnings to soul', () => {
  const cs = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  cs.initializeSprint('sprint-17', SAMPLE_TASKS, SAMPLE_ROLES);
  cs.contributeRetro('sprint-17', 'frontend', {
    learnings: ['Vitest is faster than Jest for this project']
  });

  const soul = souls.loadSoul('frontend');
  assert.ok(soul.lessons_learned.some(l => l.lesson.includes('sprint-17')));
});

test('contributeRetro replaces existing contribution from same agent', () => {
  const cs = freshModule();
  cs.initializeSprint('sprint-18', SAMPLE_TASKS, SAMPLE_ROLES);

  cs.contributeRetro('sprint-18', 'frontend', { went_well: ['A'] });
  cs.contributeRetro('sprint-18', 'frontend', { went_well: ['B'] });

  const sprint = cs.loadSprint('sprint-18');
  assert.strictEqual(sprint.retrospective.length, 1);
  assert.deepStrictEqual(sprint.retrospective[0].went_well, ['B']);
});

test('contributeRetro requires params', () => {
  const cs = freshModule();
  cs.initializeSprint('sprint-19', SAMPLE_TASKS, SAMPLE_ROLES);
  assert.strictEqual(cs.contributeRetro(null, 'r', {}).success, false);
  assert.strictEqual(cs.contributeRetro('s', null, {}).success, false);
  assert.strictEqual(cs.contributeRetro('s', 'r', null).success, false);
});

// --- recordActualDuration ---

test('recordActualDuration tracks actual vs estimated', () => {
  const cs = freshModule();
  cs.initializeSprint('sprint-20', SAMPLE_TASKS, SAMPLE_ROLES);
  cs.placeBid('sprint-20', 'T-001', 'frontend', { confidence: 80, estimated_hours: 4 });
  cs.resolveBids('sprint-20');

  const r = cs.recordActualDuration('sprint-20', 'T-001', 3);
  assert.ok(r.success);
  assert.strictEqual(r.estimated, 4);
  assert.strictEqual(r.actual, 3);
  assert.ok(r.accuracy > 0);
});

// --- getSprintSummary ---

test('getSprintSummary returns sprint overview', () => {
  const cs = freshModule();
  cs.initializeSprint('sprint-21', SAMPLE_TASKS, SAMPLE_ROLES);
  cs.placeBid('sprint-21', 'T-001', 'frontend', { confidence: 80 });
  cs.resolveBids('sprint-21');

  const summary = cs.getSprintSummary('sprint-21');
  assert.ok(summary);
  assert.strictEqual(summary.sprint_id, 'sprint-21');
  assert.strictEqual(summary.tasks.total, 3);
  assert.ok(summary.tasks.assigned > 0);
});

test('getSprintSummary returns null for missing sprint', () => {
  const cs = freshModule();
  assert.strictEqual(cs.getSprintSummary('nonexistent'), null);
});

test('getSprintSummary includes estimate accuracy', () => {
  const cs = freshModule();
  cs.initializeSprint('sprint-22', SAMPLE_TASKS, SAMPLE_ROLES);
  cs.placeBid('sprint-22', 'T-001', 'frontend', { confidence: 80, estimated_hours: 4 });
  cs.resolveBids('sprint-22');
  cs.recordActualDuration('sprint-22', 'T-001', 3);

  const summary = cs.getSprintSummary('sprint-22');
  assert.ok(summary.estimate_accuracy !== null);
});

// --- closeSprint ---

test('closeSprint marks sprint as closed', () => {
  const cs = freshModule();
  cs.initializeSprint('sprint-23', SAMPLE_TASKS, SAMPLE_ROLES);
  const r = cs.closeSprint('sprint-23');
  assert.ok(r.success);

  const sprint = cs.loadSprint('sprint-23');
  assert.strictEqual(sprint.status, cs.SPRINT_STATUS.CLOSED);
});

test('closeSprint returns error for missing sprint', () => {
  const cs = freshModule();
  assert.strictEqual(cs.closeSprint('nonexistent').success, false);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
