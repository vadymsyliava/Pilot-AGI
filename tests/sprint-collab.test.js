/**
 * Tests for Phase 7.8: Collaborative Sprint Planning
 *
 * Tests sprint-collab.js — soul loading, bidding, mediation,
 * effort estimation, sprint plan creation, retrospective.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

let tmpDir;
let origCwd;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-collab-test-'));
  origCwd = process.cwd();
  process.chdir(tmpDir);

  // Create agent registry
  const registryDir = path.join(tmpDir, '.claude', 'pilot');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(path.join(registryDir, 'agent-registry.json'), JSON.stringify({
    agents: {
      frontend: { name: 'Frontend', capabilities: ['component_creation', 'styling'] },
      backend: { name: 'Backend', capabilities: ['api_design', 'database_operations'] },
      testing: { name: 'Testing', capabilities: ['unit_testing', 'integration_testing'] },
      pm: { name: 'PM', capabilities: ['task_assignment', 'work_review'] }
    }
  }));

  // Create souls
  const soulsDir = path.join(tmpDir, '.claude', 'pilot', 'souls');
  fs.mkdirSync(soulsDir, { recursive: true });
  fs.writeFileSync(path.join(soulsDir, 'frontend.md'), [
    '---', 'role: frontend', 'created: 2026-02-13', 'updated: 2026-02-13',
    'version: 1', '---', '', '## Expertise', '- component creation', '- styling',
    '- React', '', '## Lessons Learned',
    '- [2026-02-12] (task-1) Use CSS modules for isolation', ''
  ].join('\n'));
  fs.writeFileSync(path.join(soulsDir, 'backend.md'), [
    '---', 'role: backend', 'created: 2026-02-13', 'updated: 2026-02-13',
    'version: 1', '---', '', '## Expertise', '- api design', '- database',
    '- Node.js', '', '## Lessons Learned',
    '- [2026-02-12] (task-2) Always validate input at API boundary', ''
  ].join('\n'));
  fs.writeFileSync(path.join(soulsDir, 'testing.md'), [
    '---', 'role: testing', 'created: 2026-02-13', 'updated: 2026-02-13',
    'version: 1', '---', '', '## Expertise', '- unit testing', '- integration testing', ''
  ].join('\n'));

  // Create state dirs
  fs.mkdirSync(path.join(tmpDir, '.claude', 'pilot', 'state', 'sprint-plans'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.claude', 'pilot', 'state', 'assessments'), { recursive: true });
}

function cleanup() {
  process.chdir(origCwd);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ok */ }
}

// Sample tasks
const TASKS = [
  { id: 'task-api', title: 'Build user API', domains: ['api_design', 'database'], estimated_hours: 4 },
  { id: 'task-ui', title: 'Build login form', domains: ['component_creation', 'styling'], estimated_hours: 3 },
  { id: 'task-test', title: 'Write API tests', domains: ['unit_testing', 'api_design'], estimated_hours: 2 }
];

let sc;

describe('Sprint Collaboration — Phase 7.8', () => {
  beforeEach(() => {
    setup();
    for (const key of Object.keys(require.cache)) {
      if (key.includes('sprint-collab') || key.includes('souls') || key.includes('self-assessment')) {
        delete require.cache[key];
      }
    }
    sc = require('../.claude/pilot/hooks/lib/sprint-collab');
  });

  afterEach(() => {
    cleanup();
  });

  // ===========================================================================
  // loadAllSouls
  // ===========================================================================

  describe('loadAllSouls', () => {
    it('loads all available souls', () => {
      const souls = sc.loadAllSouls({ projectRoot: tmpDir });
      assert.ok('frontend' in souls);
      assert.ok('backend' in souls);
      assert.ok('testing' in souls);
    });

    it('returns empty when no souls exist', () => {
      fs.rmSync(path.join(tmpDir, '.claude', 'pilot', 'souls'), { recursive: true });
      // Re-require to pick up change
      for (const key of Object.keys(require.cache)) {
        if (key.includes('souls')) delete require.cache[key];
      }
      const freshSc = require('../.claude/pilot/hooks/lib/sprint-collab');
      const souls = freshSc.loadAllSouls({ projectRoot: tmpDir });
      assert.equal(Object.keys(souls).length, 0);
    });
  });

  // ===========================================================================
  // generateBid
  // ===========================================================================

  describe('generateBid', () => {
    it('generates bid with expertise match', () => {
      const bid = sc.generateBid('backend', TASKS[0], { projectRoot: tmpDir });
      assert.ok(!bid.error);
      assert.equal(bid.role, 'backend');
      assert.ok(bid.expertise_match > 0);
      assert.ok(bid.confidence > 0);
    });

    it('generates lower match for unrelated task', () => {
      const bid = sc.generateBid('frontend', TASKS[0], { projectRoot: tmpDir });
      assert.ok(!bid.error);
      assert.equal(bid.expertise_match, 0);
    });

    it('includes reasoning', () => {
      const bid = sc.generateBid('backend', TASKS[0], { projectRoot: tmpDir });
      assert.ok(bid.reasoning.length > 0);
    });

    it('returns error for missing params', () => {
      const bid = sc.generateBid(null, TASKS[0]);
      assert.ok(bid.error);
    });

    it('adjusts estimate based on expertise', () => {
      const expertBid = sc.generateBid('backend', TASKS[0], { projectRoot: tmpDir });
      const noviceBid = sc.generateBid('frontend', TASKS[0], { projectRoot: tmpDir });
      // Expert should estimate same or less time
      assert.ok(expertBid.estimated_hours <= noviceBid.estimated_hours);
    });
  });

  // ===========================================================================
  // collectBids
  // ===========================================================================

  describe('collectBids', () => {
    it('collects bids from all agents for all tasks', () => {
      const bids = sc.collectBids(TASKS, { projectRoot: tmpDir });
      assert.ok('task-api' in bids);
      assert.ok('task-ui' in bids);
      assert.ok('task-test' in bids);
    });

    it('excludes PM by default', () => {
      const bids = sc.collectBids(TASKS, { projectRoot: tmpDir });
      for (const taskBids of Object.values(bids)) {
        for (const bid of taskBids) {
          assert.notEqual(bid.role, 'pm');
        }
      }
    });

    it('sorts bids by confidence', () => {
      const bids = sc.collectBids(TASKS, { projectRoot: tmpDir });
      for (const taskBids of Object.values(bids)) {
        for (let i = 1; i < taskBids.length; i++) {
          assert.ok(taskBids[i - 1].confidence >= taskBids[i].confidence);
        }
      }
    });
  });

  // ===========================================================================
  // mediateBids
  // ===========================================================================

  describe('mediateBids', () => {
    it('assigns tasks to best-fit agents', () => {
      const bids = sc.collectBids(TASKS, { projectRoot: tmpDir });
      const assignments = sc.mediateBids(bids);
      assert.ok(assignments.length >= TASKS.length);
      // API task should go to backend
      const apiAssignment = assignments.find(a => a.task_id === 'task-api');
      assert.equal(apiAssignment.assigned_to, 'backend');
    });

    it('respects max tasks per agent', () => {
      const bids = sc.collectBids(TASKS, { projectRoot: tmpDir });
      const assignments = sc.mediateBids(bids, { maxTasksPerAgent: 1 });
      const agentCounts = {};
      for (const a of assignments) {
        if (a.assigned_to) {
          agentCounts[a.assigned_to] = (agentCounts[a.assigned_to] || 0) + 1;
        }
      }
      for (const count of Object.values(agentCounts)) {
        assert.ok(count <= 1);
      }
    });

    it('marks unassignable tasks', () => {
      // Create scenario with many tasks and few agents
      const manyTasks = Array.from({ length: 10 }, (_, i) => ({
        id: 'task-' + i, domains: ['unknown_domain'], estimated_hours: 2
      }));
      const bids = sc.collectBids(manyTasks, { projectRoot: tmpDir });
      const assignments = sc.mediateBids(bids, { maxTasksPerAgent: 1 });
      const unassigned = assignments.filter(a => !a.assigned_to);
      assert.ok(unassigned.length > 0);
    });
  });

  // ===========================================================================
  // estimateEffort
  // ===========================================================================

  describe('estimateEffort', () => {
    it('returns base estimate with no history', () => {
      const est = sc.estimateEffort('backend', { id: 'task-1', estimated_hours: 4 }, { projectRoot: tmpDir });
      assert.ok(est.hours > 0);
      assert.ok(['low', 'medium', 'high'].includes(est.confidence));
    });

    it('uses task default when no assessment available', () => {
      const est = sc.estimateEffort('backend', { id: 'task-1', estimated_hours: 6 }, { projectRoot: tmpDir });
      // Should use base estimate since no history
      assert.ok(est.hours > 0);
      assert.ok(est.basis.includes('no history') || est.basis.includes('fallback'));
    });

    it('defaults to 4 hours when no estimate given', () => {
      const est = sc.estimateEffort('backend', { id: 'task-1' }, { projectRoot: tmpDir });
      assert.ok(est.hours > 0);
    });
  });

  // ===========================================================================
  // createSprintPlan
  // ===========================================================================

  describe('createSprintPlan', () => {
    it('creates a complete sprint plan', () => {
      const plan = sc.createSprintPlan('sprint-1', TASKS, { projectRoot: tmpDir });
      assert.ok(!plan.error);
      assert.equal(plan.sprint_id, 'sprint-1');
      assert.equal(plan.total_tasks, 3);
      assert.ok(plan.assignments.length >= 3);
      assert.ok(plan.participating_agents.length > 0);
    });

    it('saves plan to disk', () => {
      sc.createSprintPlan('sprint-2', TASKS, { projectRoot: tmpDir });
      const planPath = path.join(tmpDir, '.claude/pilot/state/sprint-plans/sprint-2.json');
      assert.ok(fs.existsSync(planPath));
    });

    it('includes effort estimates for assigned tasks', () => {
      const plan = sc.createSprintPlan('sprint-3', TASKS, { projectRoot: tmpDir });
      const assigned = plan.assignments.filter(a => a.assigned_to);
      for (const a of assigned) {
        assert.ok(a.effort_estimate);
        assert.ok(a.effort_estimate.hours > 0);
      }
    });

    it('includes bid summaries', () => {
      const plan = sc.createSprintPlan('sprint-4', TASKS, { projectRoot: tmpDir });
      assert.ok(plan.bids_summary);
      assert.ok(plan.bids_summary['task-api']);
    });

    it('returns error for missing params', () => {
      const plan = sc.createSprintPlan(null, TASKS);
      assert.ok(plan.error);
    });

    it('returns error for empty tasks', () => {
      const plan = sc.createSprintPlan('sprint-x', []);
      assert.ok(plan.error);
    });
  });

  // ===========================================================================
  // collectRetroInput
  // ===========================================================================

  describe('collectRetroInput', () => {
    it('collects input with lessons from soul', () => {
      const input = sc.collectRetroInput('backend', 'sprint-1', { projectRoot: tmpDir });
      assert.equal(input.role, 'backend');
      assert.equal(input.sprint_id, 'sprint-1');
      assert.ok(input.learnings.length > 0); // From soul lessons
    });

    it('returns empty arrays for agent without data', () => {
      const input = sc.collectRetroInput('testing', 'sprint-1', { projectRoot: tmpDir });
      assert.equal(input.role, 'testing');
      assert.ok(Array.isArray(input.strengths));
    });
  });

  // ===========================================================================
  // aggregateRetro
  // ===========================================================================

  describe('aggregateRetro', () => {
    it('aggregates inputs from all agents', () => {
      const result = sc.aggregateRetro('sprint-1', { projectRoot: tmpDir });
      assert.equal(result.sprint_id, 'sprint-1');
      assert.ok(result.inputs.length > 0);
      // Should include frontend, backend, testing (not PM)
      const roles = result.inputs.map(i => i.role);
      assert.ok(roles.includes('frontend'));
      assert.ok(roles.includes('backend'));
      assert.ok(!roles.includes('pm'));
    });

    it('includes common themes', () => {
      const result = sc.aggregateRetro('sprint-1', { projectRoot: tmpDir });
      assert.ok(Array.isArray(result.common_themes));
    });
  });

  // ===========================================================================
  // Plan history
  // ===========================================================================

  describe('plan history', () => {
    it('loads saved sprint plan', () => {
      sc.createSprintPlan('sprint-load', TASKS, { projectRoot: tmpDir });
      const loaded = sc.loadSprintPlan('sprint-load', { projectRoot: tmpDir });
      assert.ok(loaded);
      assert.equal(loaded.sprint_id, 'sprint-load');
    });

    it('returns null for non-existent plan', () => {
      const loaded = sc.loadSprintPlan('no-such', { projectRoot: tmpDir });
      assert.equal(loaded, null);
    });

    it('lists all sprint plans', () => {
      sc.createSprintPlan('sprint-a', TASKS, { projectRoot: tmpDir });
      sc.createSprintPlan('sprint-b', TASKS, { projectRoot: tmpDir });
      const list = sc.listSprintPlans({ projectRoot: tmpDir });
      assert.ok(list.includes('sprint-a'));
      assert.ok(list.includes('sprint-b'));
    });
  });

  // ===========================================================================
  // Module exports
  // ===========================================================================

  describe('module exports', () => {
    it('exports all expected functions', () => {
      const exports = [
        'loadAllSouls', 'generateBid', 'collectBids', 'mediateBids',
        'estimateEffort', 'createSprintPlan', 'collectRetroInput',
        'aggregateRetro', 'loadSprintPlan', 'listSprintPlans'
      ];
      for (const name of exports) {
        assert.ok(name in sc, 'Missing export: ' + name);
      }
    });
  });
});
