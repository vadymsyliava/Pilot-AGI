/**
 * Tests for Auto-Refactor on Detection — Phase 8.10 (Pilot AGI-953a)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/auto-refactor.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoref-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/refactor-plans'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModule() {
  const modPath = '../auto-refactor';
  try { delete require.cache[require.resolve(modPath)]; } catch (e) {}
  return require(modPath);
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  setup();
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (e) {
    console.error(`  \u2717 ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  } finally {
    teardown();
  }
}

console.log('\n=== Auto-Refactor Tests ===\n');

// --- generatePlan: duplicate ---

test('generatePlan creates duplicate consolidation plan', () => {
  const ar = freshModule();
  const detection = {
    duplicates: [{
      function_name: 'add',
      matches: [{ name: 'add', file_path: 'src/utils.js', line: 5, confidence: 0.95, type: 'exact_body' }]
    }],
    reexports: [],
    wrappers: []
  };

  const plan = ar.generatePlan(detection, { type: 'duplicate', filePath: 'src/other.js' });
  assert.ok(plan.plan_id);
  assert.strictEqual(plan.type, 'duplicate');
  assert.strictEqual(plan.risk_level, 'low');
  assert.ok(plan.steps.length >= 2); // consolidate + update imports
  assert.strictEqual(plan.steps[0].action, 'consolidate_function');
});

test('generatePlan includes wrapper removal steps', () => {
  const ar = freshModule();
  const detection = {
    duplicates: [],
    reexports: [],
    wrappers: [{ wrapper_name: 'fetchUser', calls: 'getUser', line: 10, file_path: 'api.ts' }]
  };

  const plan = ar.generatePlan(detection, { type: 'duplicate', filePath: 'api.ts' });
  const wrapperStep = plan.steps.find(s => s.action === 'remove_wrapper');
  assert.ok(wrapperStep);
  assert.strictEqual(wrapperStep.wrapper_name, 'fetchUser');
});

test('generatePlan includes reexport removal steps', () => {
  const ar = freshModule();
  const detection = {
    duplicates: [],
    reexports: [{ names: ['Button'], source: './Button', line: 1, file_path: 'index.ts' }],
    wrappers: []
  };

  const plan = ar.generatePlan(detection, { type: 'duplicate', filePath: 'index.ts' });
  const reexportStep = plan.steps.find(s => s.action === 'remove_reexport');
  assert.ok(reexportStep);
});

// --- generatePlan: dead_code ---

test('generatePlan creates dead code removal plan', () => {
  const ar = freshModule();
  const detection = {
    unused_exports: [{ name: 'oldFunc', line: 5, type: 'function' }],
    backward_compat: [{ type: 'legacy_comment', line: 10, description: '// deprecated' }],
    todos: [{ stale: true, line: 15, text: 'fix this', type: 'TODO' }]
  };

  const plan = ar.generatePlan(detection, { type: 'dead_code', filePath: 'src/old.js' });
  assert.strictEqual(plan.type, 'dead_code');
  assert.ok(plan.steps.some(s => s.action === 'remove_export'));
  assert.ok(plan.steps.some(s => s.action === 'remove_compat'));
  assert.ok(plan.steps.some(s => s.action === 'resolve_todos'));
});

test('generatePlan raises risk for many unused exports', () => {
  const ar = freshModule();
  const detection = {
    unused_exports: [
      { name: 'a', line: 1 },
      { name: 'b', line: 2 },
      { name: 'c', line: 3 },
      { name: 'd', line: 4 }
    ],
    backward_compat: [],
    todos: []
  };

  const plan = ar.generatePlan(detection, { type: 'dead_code', filePath: 'src/old.js' });
  assert.strictEqual(plan.risk_level, 'medium');
  assert.strictEqual(plan.auto_approvable, false);
});

// --- generatePlan: naming ---

test('generatePlan creates naming fix plan', () => {
  const ar = freshModule();
  const detection = {
    inconsistencies: [{
      current_name: 'MemberList',
      canonical_name: 'UserList',
      domain: 'components',
      file_path: 'src/components/MemberList.tsx',
      affects_layers: ['pages', 'apis']
    }]
  };

  const plan = ar.generatePlan(detection, { type: 'naming', filePath: 'src/components/MemberList.tsx' });
  assert.strictEqual(plan.type, 'naming');
  assert.strictEqual(plan.risk_level, 'medium');
  assert.ok(plan.steps.some(s => s.action === 'rename_across_layers'));
});

// --- generatePlan: errors ---

test('generatePlan returns error for missing type', () => {
  const ar = freshModule();
  const result = ar.generatePlan({}, {});
  assert.ok(result.error);
});

test('generatePlan returns error for unknown type', () => {
  const ar = freshModule();
  const result = ar.generatePlan({}, { type: 'unknown' });
  assert.ok(result.error);
});

// --- plan execution ---

test('approvePlan marks plan as approved', () => {
  const ar = freshModule();
  const plan = ar.generatePlan(
    { duplicates: [], reexports: [], wrappers: [] },
    { type: 'duplicate', filePath: 'test.js' }
  );

  const result = ar.approvePlan(plan.plan_id, 'human');
  assert.strictEqual(result.success, true);

  const loaded = ar.loadPlan(plan.plan_id);
  assert.strictEqual(loaded.status, 'approved');
  assert.strictEqual(loaded.approved_by, 'human');
});

test('completeStep marks step and detects all done', () => {
  const ar = freshModule();
  const detection = {
    unused_exports: [{ name: 'x', line: 1, type: 'function' }],
    backward_compat: [],
    todos: []
  };

  const plan = ar.generatePlan(detection, { type: 'dead_code', filePath: 'x.js' });
  ar.approvePlan(plan.plan_id);

  const r = ar.completeStep(plan.plan_id, 0, 'removed');
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.all_done, true);

  const loaded = ar.loadPlan(plan.plan_id);
  assert.strictEqual(loaded.status, 'completed');
});

test('getNextStep returns first incomplete step', () => {
  const ar = freshModule();
  const detection = {
    unused_exports: [
      { name: 'a', line: 1, type: 'function' },
      { name: 'b', line: 2, type: 'function' }
    ],
    backward_compat: [],
    todos: []
  };

  const plan = ar.generatePlan(detection, { type: 'dead_code', filePath: 'x.js' });
  ar.approvePlan(plan.plan_id);

  const next1 = ar.getNextStep(plan.plan_id);
  assert.strictEqual(next1.index, 0);

  ar.completeStep(plan.plan_id, 0);

  const next2 = ar.getNextStep(plan.plan_id);
  assert.strictEqual(next2.index, 1);
});

test('getNextStep returns null for pending plan', () => {
  const ar = freshModule();
  const plan = ar.generatePlan(
    { duplicates: [], reexports: [], wrappers: [] },
    { type: 'duplicate', filePath: 'test.js' }
  );

  assert.strictEqual(ar.getNextStep(plan.plan_id), null);
});

// --- listPlans ---

test('listPlans returns all plans sorted by date', () => {
  const ar = freshModule();
  ar.generatePlan({ duplicates: [], reexports: [], wrappers: [] }, { type: 'duplicate', filePath: 'a.js' });
  ar.generatePlan({ unused_exports: [], backward_compat: [], todos: [] }, { type: 'dead_code', filePath: 'b.js' });

  const plans = ar.listPlans();
  assert.strictEqual(plans.length, 2);
});

test('listPlans filters by status', () => {
  const ar = freshModule();
  const plan = ar.generatePlan({ duplicates: [], reexports: [], wrappers: [] }, { type: 'duplicate', filePath: 'a.js' });
  ar.approvePlan(plan.plan_id);
  ar.generatePlan({ duplicates: [], reexports: [], wrappers: [] }, { type: 'duplicate', filePath: 'b.js' });

  const approved = ar.listPlans({ status: 'approved' });
  assert.strictEqual(approved.length, 1);

  const pending = ar.listPlans({ status: 'pending' });
  assert.strictEqual(pending.length, 1);
});

// --- loadPlan ---

test('loadPlan returns null for missing plan', () => {
  const ar = freshModule();
  assert.strictEqual(ar.loadPlan('nonexistent'), null);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
