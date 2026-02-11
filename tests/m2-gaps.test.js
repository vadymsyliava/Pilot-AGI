#!/usr/bin/env node

/**
 * Tests for M2 gap fixes: cost tracking + pre-commit token enforcement
 * Part of Pilot AGI-poz
 *
 * Run: node tests/m2-gaps.test.js
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

// =============================================================================
// SETUP
// =============================================================================

const TMP_DIR = path.join(os.tmpdir(), 'pilot-m2-gaps-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

const dirs = [
  '.claude/pilot/state/sessions',
  '.claude/pilot/state/orchestrator',
  '.claude/pilot/state/locks',
  '.claude/pilot/messages/cursors',
  '.claude/pilot/memory/channels',
  '.claude/pilot/memory/schemas',
  'runs'
];
for (const d of dirs) {
  fs.mkdirSync(path.join(TMP_DIR, d), { recursive: true });
}

fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/policy.yaml'), [
  'enforcement:',
  '  require_active_task: false',
  '  require_plan_approval: false',
  'session:',
  '  heartbeat_interval_sec: 60',
  '  max_concurrent_sessions: 6',
  'orchestrator:',
  '  drift_threshold: 0.3',
  '  auto_reassign_stale: true',
  '  cost_tracking:',
  '    enabled: true',
  '    warn_threshold_tokens: 500000',
  '    block_threshold_tokens: 2000000',
  ''
].join('\n'));

fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/memory/index.json'), JSON.stringify({
  version: 1,
  channels: {}
}));

const ORIG_CWD = process.cwd();
process.chdir(TMP_DIR);

// =============================================================================
// TESTS: Cost Tracking (pressure.js)
// =============================================================================

console.log('\n=== Cost Tracking ===');

const pressure = require(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/pressure'));

test('getCostEstimate returns zero for new session', () => {
  const cost = pressure.getCostEstimate('S-cost-test-new');
  assertEqual(cost.tokens_estimate, 0, 'zero tokens');
  assertEqual(cost.cost_usd, 0, 'zero cost');
  assertEqual(cost.calls, 0, 'zero calls');
});

test('getCostEstimate calculates from accumulated bytes', () => {
  // Simulate some tool calls
  pressure.recordToolCall('S-cost-test-1', 40000);  // 40KB
  pressure.recordToolCall('S-cost-test-1', 60000);  // 60KB

  const cost = pressure.getCostEstimate('S-cost-test-1');
  // 100,000 bytes / 4 bytes per token = 25,000 tokens
  assertEqual(cost.tokens_estimate, 25000, 'token estimate');
  assertEqual(cost.calls, 2, 'call count');
  // 25,000 / 1,000,000 * 10 = 0.25
  assertEqual(cost.cost_usd, 0.25, 'cost estimate');
});

test('getCostEstimate handles large sessions', () => {
  // Simulate a heavy session: 8MB of output
  pressure.resetPressure('S-cost-heavy');
  pressure.recordToolCall('S-cost-heavy', 8 * 1024 * 1024);

  const cost = pressure.getCostEstimate('S-cost-heavy');
  assert(cost.tokens_estimate > 2000000, 'over 2M tokens');
  assert(cost.cost_usd > 20, 'cost > $20');
});

test('isCostOverThreshold detects threshold breach', () => {
  // S-cost-test-1 has 25,000 tokens from earlier
  assert(!pressure.isCostOverThreshold('S-cost-test-1', 500000), 'under 500k');
  assert(pressure.isCostOverThreshold('S-cost-test-1', 20000), 'over 20k');
});

test('isCostOverThreshold returns false for empty session', () => {
  assert(!pressure.isCostOverThreshold('S-nonexistent', 500000), 'nonexistent is under');
});

test('COST_PER_MILLION_TOKENS is exported', () => {
  assert(typeof pressure.COST_PER_MILLION_TOKENS === 'number', 'is number');
  assert(pressure.COST_PER_MILLION_TOKENS > 0, 'positive');
});

test('BYTES_PER_TOKEN is exported', () => {
  assert(typeof pressure.BYTES_PER_TOKEN === 'number', 'is number');
  assertEqual(pressure.BYTES_PER_TOKEN, 4, 'default 4');
});

// =============================================================================
// TESTS: Dashboard Cost Collection
// =============================================================================

console.log('\n=== Dashboard Cost Collection ===');

const dashboard = require(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/dashboard'));

test('dashboard.collect includes costs array', () => {
  const data = dashboard.collect();
  assert(Array.isArray(data.costs), 'costs is array');
});

test('dashboard.getAlerts handles empty costs', () => {
  const data = {
    agents: [],
    tasks: { open: 0, in_progress: 0, closed: 0, total: 0, items: [] },
    locks: { areas: [], files: [] },
    worktrees: [],
    messaging: { needs_compaction: false },
    memory: [],
    drift: [],
    pressure: [],
    costs: [],
    events: []
  };

  const alerts = dashboard.getAlerts(data);
  assert(Array.isArray(alerts), 'alerts is array');
  const costAlerts = alerts.filter(a => a.type === 'cost_threshold_exceeded');
  assertEqual(costAlerts.length, 0, 'no cost alerts');
});

test('dashboard.getAlerts fires cost warning (from real project)', () => {
  // Switch to real project dir so policy.yaml is loadable
  process.chdir(ORIG_CWD);

  const data = {
    agents: [],
    tasks: { open: 0, in_progress: 0, closed: 0, total: 0, items: [] },
    locks: { areas: [], files: [] },
    worktrees: [],
    messaging: { needs_compaction: false },
    memory: [],
    drift: [],
    pressure: [],
    costs: [{
      session_id: 'S-expensive',
      claimed_task: 'T-1',
      tokens_estimate: 750000,
      cost_usd: 7.5,
      calls: 100
    }],
    events: []
  };

  const alerts = dashboard.getAlerts(data);
  const costAlerts = alerts.filter(a => a.type === 'cost_threshold_exceeded');
  assertEqual(costAlerts.length, 1, 'one cost alert');
  assertEqual(costAlerts[0].severity, 'warning', 'warning severity');
  assert(costAlerts[0].message.includes('750,000'), 'includes token count');

  process.chdir(TMP_DIR);
});

test('dashboard.getAlerts fires critical for block threshold (from real project)', () => {
  process.chdir(ORIG_CWD);

  const data = {
    agents: [],
    tasks: { open: 0, in_progress: 0, closed: 0, total: 0, items: [] },
    locks: { areas: [], files: [] },
    worktrees: [],
    messaging: { needs_compaction: false },
    memory: [],
    drift: [],
    pressure: [],
    costs: [{
      session_id: 'S-runaway',
      claimed_task: 'T-2',
      tokens_estimate: 3000000,
      cost_usd: 30,
      calls: 500
    }],
    events: []
  };

  const alerts = dashboard.getAlerts(data);
  const costAlerts = alerts.filter(a => a.type === 'cost_threshold_exceeded');
  assertEqual(costAlerts.length, 1, 'one cost alert');
  assertEqual(costAlerts[0].severity, 'critical', 'critical severity');

  process.chdir(TMP_DIR);
});

// =============================================================================
// TESTS: Pre-commit hook existence
// =============================================================================

console.log('\n=== Pre-commit Hook ===');

test('pre-commit hook contains token enforcement section', () => {
  const hookPath = path.join(ORIG_CWD, '.git/hooks/pre-commit');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert(content.includes('Design Token Enforcement'), 'has enforcement section');
  assert(content.includes('detect-drift.js'), 'references detect-drift');
  assert(content.includes('export-all.js'), 'references export-all');
  assert(content.includes('design/tokens/'), 'checks token source changes');
});

// =============================================================================
// CLEANUP
// =============================================================================

process.chdir(ORIG_CWD);
try {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
} catch (e) {
  // Best effort
}

// =============================================================================
// SUMMARY
// =============================================================================

console.log(`\n════════════════════════════════════════`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`════════════════════════════════════════\n`);

if (failed > 0 && require.main === module) {
  process.exit(1);
}
