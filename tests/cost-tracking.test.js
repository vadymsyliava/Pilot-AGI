#!/usr/bin/env node

/**
 * Verification tests for Cost & Budget Management (Phase 3.11)
 * Run: node tests/cost-tracking.test.js
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
const TMP_DIR = path.join(require('os').tmpdir(), 'pilot-cost-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

// Create minimal directory structure
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/costs/tasks'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/costs/agents'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/sessions'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/memory/channels'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/memory/schemas'), { recursive: true });

// Copy memory index if it exists
try {
  fs.copyFileSync(
    path.join(ORIG_CWD, '.claude/pilot/memory/index.json'),
    path.join(TMP_DIR, '.claude/pilot/memory/index.json')
  );
} catch (e) {
  // Create minimal index
  fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/memory/index.json'), JSON.stringify({ channels: [] }));
}

// Copy cost-tracking schema
try {
  fs.copyFileSync(
    path.join(ORIG_CWD, '.claude/pilot/memory/schemas/cost-tracking.schema.json'),
    path.join(TMP_DIR, '.claude/pilot/memory/schemas/cost-tracking.schema.json')
  );
} catch (e) {
  // Skip if not found
}

// Create a minimal policy.yaml for budget testing
fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/policy.yaml'), `
version: "2.0"
enforcement:
  require_active_task: false
  require_plan_approval: false
orchestrator:
  cost_tracking:
    enabled: true
    warn_threshold_tokens: 1000
    block_threshold_tokens: 5000
    per_agent_per_day:
      warn_tokens: 2000
      block_tokens: 8000
    per_day:
      warn_tokens: 10000
      block_tokens: 50000
    enforcement: "soft"
`);

// Switch to tmp dir for tests
process.chdir(TMP_DIR);

// Clear require cache for modules that use process.cwd()
function freshModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

// =============================================================================
// TESTS
// =============================================================================

console.log('\n=== Cost & Budget Management Tests (Phase 3.11) ===\n');

// --- Cost Recording ---

console.log('--- Cost Recording ---');

test('recordTaskCost creates task cost file', () => {
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));
  ct.resetTaskCost('TEST-001');
  ct.resetAgentCost('S-test-1');

  ct.recordTaskCost('S-test-1', 'TEST-001', 4000); // 4000 bytes = 1000 tokens

  const taskCost = ct.getTaskCost('TEST-001');
  assert(taskCost.total_bytes === 4000, `Expected 4000 bytes, got ${taskCost.total_bytes}`);
  assert(taskCost.total_tokens === 1000, `Expected 1000 tokens, got ${taskCost.total_tokens}`);
  assert(taskCost.total_calls === 1, `Expected 1 call, got ${taskCost.total_calls}`);
});

test('recordTaskCost accumulates across multiple calls', () => {
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));
  ct.resetTaskCost('TEST-002');
  ct.resetAgentCost('S-test-2');

  ct.recordTaskCost('S-test-2', 'TEST-002', 2000);
  ct.recordTaskCost('S-test-2', 'TEST-002', 3000);
  ct.recordTaskCost('S-test-2', 'TEST-002', 1000);

  const taskCost = ct.getTaskCost('TEST-002');
  assert(taskCost.total_bytes === 6000, `Expected 6000 bytes, got ${taskCost.total_bytes}`);
  assert(taskCost.total_tokens === 1500, `Expected 1500 tokens, got ${taskCost.total_tokens}`);
  assert(taskCost.total_calls === 3, `Expected 3 calls, got ${taskCost.total_calls}`);
});

test('recordTaskCost tracks per-session contributions', () => {
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));
  ct.resetTaskCost('TEST-003');
  ct.resetAgentCost('S-agent-A');
  ct.resetAgentCost('S-agent-B');

  ct.recordTaskCost('S-agent-A', 'TEST-003', 4000);
  ct.recordTaskCost('S-agent-B', 'TEST-003', 8000);

  const taskCost = ct.getTaskCost('TEST-003');
  assert(taskCost.sessions['S-agent-A'].tokens === 1000, 'Agent A should have 1000 tokens');
  assert(taskCost.sessions['S-agent-B'].tokens === 2000, 'Agent B should have 2000 tokens');
  assert(taskCost.total_tokens === 3000, 'Total should be 3000');
});

test('recordTaskCost handles null/empty inputs gracefully', () => {
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));
  // Should not throw
  ct.recordTaskCost(null, null, 0);
  ct.recordTaskCost('S-test', null, 0);
  ct.recordTaskCost(null, 'T-1', 0);
  assert(true, 'No errors on null input');
});

// --- Cost Retrieval ---

console.log('\n--- Cost Retrieval ---');

test('getTaskCost returns zeros for unknown task', () => {
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));
  const cost = ct.getTaskCost('NONEXISTENT');
  assert(cost.total_tokens === 0, 'Should return 0 tokens');
  assert(cost.cost_usd === 0, 'Should return 0 USD');
});

test('getAgentCost returns zeros for unknown agent', () => {
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));
  const cost = ct.getAgentCost('S-nonexistent');
  assert(cost.total_tokens === 0, 'Should return 0 tokens');
  assert(cost.today_tokens === 0, 'Should return 0 today tokens');
});

test('getAgentCost tracks daily totals', () => {
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));
  ct.resetAgentCost('S-daily-test');
  ct.resetTaskCost('DAILY-T1');

  ct.recordTaskCost('S-daily-test', 'DAILY-T1', 8000);
  ct.recordTaskCost('S-daily-test', 'DAILY-T1', 12000);

  const agentCost = ct.getAgentCost('S-daily-test');
  assert(agentCost.today_tokens === 5000, `Expected 5000 today tokens, got ${agentCost.today_tokens}`);
  assert(agentCost.total_tokens === 5000, `Expected 5000 total tokens, got ${agentCost.total_tokens}`);
  assert(agentCost.tasks_worked.includes('DAILY-T1'), 'Should track task');
});

test('getTaskCost calculates cost_usd correctly', () => {
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));
  ct.resetTaskCost('COST-USD');
  ct.resetAgentCost('S-usd-test');

  // 4,000,000 bytes = 1,000,000 tokens = $10.00
  ct.recordTaskCost('S-usd-test', 'COST-USD', 4000000);

  const taskCost = ct.getTaskCost('COST-USD');
  assert(taskCost.cost_usd === 10, `Expected $10.00, got $${taskCost.cost_usd}`);
});

test('getDailyCost aggregates across agents', () => {
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));

  // Clear ALL agent files to isolate this test
  const agentsDir = path.join(TMP_DIR, '.claude/pilot/state/costs/agents');
  if (fs.existsSync(agentsDir)) {
    for (const f of fs.readdirSync(agentsDir)) {
      fs.unlinkSync(path.join(agentsDir, f));
    }
  }

  ct.recordTaskCost('S-daily-A', 'DAILY-A1', 4000);
  ct.recordTaskCost('S-daily-B', 'DAILY-B1', 8000);

  const daily = ct.getDailyCost();
  assert(daily.total_tokens === 3000, `Expected 3000 total tokens, got ${daily.total_tokens}`);
  assert(daily.agents.length === 2, `Expected 2 agents, got ${daily.agents.length}`);
});

// --- Budget Checking ---

console.log('\n--- Budget Checking ---');

// Helper: clean all cost state for budget isolation
function cleanAllCostState() {
  const agentsDir = path.join(TMP_DIR, '.claude/pilot/state/costs/agents');
  const tasksDir = path.join(TMP_DIR, '.claude/pilot/state/costs/tasks');
  for (const dir of [agentsDir, tasksDir]) {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        fs.unlinkSync(path.join(dir, f));
      }
    }
  }
}

test('checkBudget returns ok when under limits', () => {
  cleanAllCostState();
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));

  ct.recordTaskCost('S-budget-ok', 'BUDGET-OK', 400); // 100 tokens — well under 1000 warn

  const budget = ct.checkBudget('S-budget-ok', 'BUDGET-OK');
  assert(budget.status === 'ok', `Expected ok, got ${budget.status}`);
});

test('checkBudget returns warning when at warn threshold', () => {
  cleanAllCostState();
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));

  // 4000 bytes = 1000 tokens = exactly at warn_threshold_tokens (1000)
  ct.recordTaskCost('S-budget-warn', 'BUDGET-WARN', 4000);

  const budget = ct.checkBudget('S-budget-warn', 'BUDGET-WARN');
  assert(budget.status === 'warning', `Expected warning, got ${budget.status}`);
  assert(budget.details.task.type === 'warn', 'Should be task warn');
});

test('checkBudget returns exceeded when at block threshold', () => {
  cleanAllCostState();
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));

  // 20000 bytes = 5000 tokens = exactly at block_threshold_tokens (5000)
  ct.recordTaskCost('S-budget-block', 'BUDGET-BLOCK', 20000);

  const budget = ct.checkBudget('S-budget-block', 'BUDGET-BLOCK');
  assert(budget.status === 'exceeded', `Expected exceeded, got ${budget.status}`);
  assert(budget.details.task.type === 'block', 'Should be task block');
});

test('checkBudget checks per-agent-per-day budget', () => {
  cleanAllCostState();
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));

  // Stay under per-task limit but exceed per-agent-per-day warn (2000 tokens)
  ct.recordTaskCost('S-agent-budget', 'AGENT-B1', 3600);  // 900 tokens (under 1000 per-task warn)
  ct.recordTaskCost('S-agent-budget', 'AGENT-B2', 3600);  // 900 tokens → 1800 total today
  ct.recordTaskCost('S-agent-budget', 'AGENT-B2', 1600);  // +400 tokens → 1300 on task, 2200 agent total

  const budget = ct.checkBudget('S-agent-budget', 'AGENT-B2');
  // Per-task: 1300 tokens > 1000 warn → warning
  // Per-agent-per-day: 2200 tokens > 2000 warn → warning
  assert(budget.status === 'warning', `Expected warning, got ${budget.status}`);
  assert(budget.details.agent !== undefined, 'Should have agent budget details');
});

test('checkBudget exceeded overrides warning', () => {
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));
  ct.resetTaskCost('OVERRIDE-TEST');
  ct.resetAgentCost('S-override');

  // Exceed block threshold
  ct.recordTaskCost('S-override', 'OVERRIDE-TEST', 20000); // 5000 tokens = block

  const budget = ct.checkBudget('S-override', 'OVERRIDE-TEST');
  assert(budget.status === 'exceeded', 'Exceeded should override any warning');
});

// --- Efficiency Metrics ---

console.log('\n--- Efficiency Metrics ---');

test('getEfficiencyMetrics returns null tokens_per_commit with no commits', () => {
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));
  ct.resetTaskCost('EFF-001');
  ct.resetAgentCost('S-eff');

  ct.recordTaskCost('S-eff', 'EFF-001', 4000);

  const metrics = ct.getEfficiencyMetrics('EFF-001');
  assert(metrics.tokens_total === 1000, `Expected 1000 tokens, got ${metrics.tokens_total}`);
  assert(metrics.tokens_per_commit === null, 'Should be null with no commits');
  assert(metrics.commit_count === 0, 'Should be 0 commits');
});

test('getAgentEfficiency calculates avg tokens per task', () => {
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));
  ct.resetAgentCost('S-eff-agent');
  ct.resetTaskCost('EFF-T1');
  ct.resetTaskCost('EFF-T2');

  ct.recordTaskCost('S-eff-agent', 'EFF-T1', 8000);  // 2000 tokens
  ct.recordTaskCost('S-eff-agent', 'EFF-T2', 12000); // 3000 tokens

  const eff = ct.getAgentEfficiency('S-eff-agent');
  assert(eff.tasks_completed === 2, `Expected 2 tasks, got ${eff.tasks_completed}`);
  assert(eff.avg_tokens_per_task === 2500, `Expected 2500 avg, got ${eff.avg_tokens_per_task}`);
  assert(eff.total_tokens === 5000, `Expected 5000 total, got ${eff.total_tokens}`);
});

test('getAgentEfficiency returns null avg for no tasks', () => {
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));
  const eff = ct.getAgentEfficiency('S-no-tasks');
  assert(eff.avg_tokens_per_task === null, 'Should be null with no tasks');
  assert(eff.tasks_completed === 0, 'Should be 0 tasks');
});

// --- Policy Integration ---

console.log('\n--- Policy Integration ---');

test('loadBudgetPolicy reads from policy.yaml', () => {
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));
  const policy = ct.loadBudgetPolicy();
  assert(policy.per_task.warn_tokens === 1000, `Expected 1000 warn, got ${policy.per_task.warn_tokens}`);
  assert(policy.per_task.block_tokens === 5000, `Expected 5000 block, got ${policy.per_task.block_tokens}`);
  assert(policy.per_agent_per_day.warn_tokens === 2000, `Expected 2000 agent warn`);
  assert(policy.enforcement === 'soft', `Expected soft enforcement, got ${policy.enforcement}`);
});

// --- Module Exports ---

console.log('\n--- Module Exports ---');

test('cost-tracker exports all expected functions', () => {
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));
  const expected = [
    'recordTaskCost', 'getTaskCost', 'getAgentCost', 'getDailyCost',
    'checkBudget', 'loadBudgetPolicy',
    'getEfficiencyMetrics', 'getAgentEfficiency',
    'publishCostChannel',
    'resetTaskCost', 'resetAgentCost',
    'getTaskCostPath', 'getAgentCostPath',
    'COST_PER_MILLION_TOKENS', 'BYTES_PER_TOKEN'
  ];
  for (const name of expected) {
    assert(ct[name] !== undefined, `Missing export: ${name}`);
  }
});

test('constants match pressure.js values', () => {
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));
  assert(ct.COST_PER_MILLION_TOKENS === 10.0, 'Cost per million should be $10');
  assert(ct.BYTES_PER_TOKEN === 4, 'Bytes per token should be 4');
});

// --- PM Loop Integration ---

console.log('\n--- PM Loop Integration ---');

test('PmLoop has _costScan method', () => {
  // Clear caches for pm-loop and its dependencies
  const modulesToClear = [
    'cost-tracker', 'orchestrator', 'session', 'messaging',
    'pm-research', 'decomposition', 'pm-loop'
  ];
  for (const mod of modulesToClear) {
    const key = Object.keys(require.cache).find(k => k.includes(`/lib/${mod}.js`) || k.includes(`lib/${mod}`));
    if (key) delete require.cache[key];
  }

  try {
    const { PmLoop } = require(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/pm-loop'));
    const loop = new PmLoop(TMP_DIR, { dryRun: true });
    assert(typeof loop._costScan === 'function', '_costScan should be a function');
    assert(loop.lastCostScan === 0, 'lastCostScan should start at 0');
  } catch (e) {
    // PmLoop may have dependencies that fail in test env — check method exists
    assert(false, 'PmLoop load failed: ' + e.message);
  }
});

// --- Filesystem Safety ---

console.log('\n--- Filesystem Safety ---');

test('task ID with spaces is sanitized for filesystem', () => {
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));
  const p = ct.getTaskCostPath('Pilot AGI-v0a');
  assert(p.includes('Pilot_AGI-v0a'), `Path should be sanitized: ${p}`);
  assert(!p.includes('Pilot AGI'), 'Should not contain spaces');
});

test('concurrent writes do not corrupt data', () => {
  const ct = freshModule(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/cost-tracker'));
  ct.resetTaskCost('CONCUR-001');
  ct.resetAgentCost('S-concur');

  // Simulate rapid sequential writes (not truly concurrent in single-threaded node)
  for (let i = 0; i < 50; i++) {
    ct.recordTaskCost('S-concur', 'CONCUR-001', 100);
  }

  const cost = ct.getTaskCost('CONCUR-001');
  assert(cost.total_bytes === 5000, `Expected 5000 bytes, got ${cost.total_bytes}`);
  assert(cost.total_calls === 50, `Expected 50 calls, got ${cost.total_calls}`);
});

// =============================================================================
// CLEANUP
// =============================================================================

process.chdir(ORIG_CWD);

// Clean up tmp dir
try {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
} catch (e) {
  // Best effort
}

// =============================================================================
// SUMMARY
// =============================================================================

console.log('\n════════════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
console.log('════════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
