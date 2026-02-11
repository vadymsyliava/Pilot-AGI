#!/usr/bin/env node

/**
 * Verification tests for Performance Analytics (Phase 3.13)
 * Run: node tests/analytics.test.js
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
const TMP_DIR = path.join(require('os').tmpdir(), 'pilot-analytics-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

// Create minimal directory structure
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/analytics/snapshots'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/costs/tasks'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/costs/agents'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/sessions'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/memory/channels'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/memory/schemas'), { recursive: true });

// Create minimal policy.yaml
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
  analytics:
    enabled: true
    scan_interval_sec: 300
    retention_days: 30
    slow_task_threshold_min: 30
    rework_alert_threshold: 0.3
    queue_depth_warning: 5
`);

// Create minimal memory index
fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/memory/index.json'), JSON.stringify({ channels: [] }));

// Switch to temp dir
process.chdir(TMP_DIR);

// Fresh module loader
function freshModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

// Clear all analytics-related require cache
function freshAnalytics() {
  const libDir = path.join(ORIG_CWD, '.claude/pilot/hooks/lib');
  const modules = ['analytics.js', 'cost-tracker.js', 'memory.js', 'messaging.js', 'policy.js'];
  for (const m of modules) {
    try { delete require.cache[require.resolve(path.join(libDir, m))]; } catch (e) { /* ok */ }
  }
  return require(path.join(libDir, 'analytics.js'));
}

// =============================================================================
// TESTS
// =============================================================================

console.log('\n  === Phase 3.13 Performance Analytics Tests ===\n');

// --- Lifecycle Event Recording ---

console.log('  --- Lifecycle Events ---');

test('recordLifecycleEvent writes to lifecycle.jsonl', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  analytics.recordLifecycleEvent('task-1', 'assigned', { agent: 'agent-A' });

  const lifecyclePath = path.join(TMP_DIR, '.claude/pilot/state/analytics/lifecycle.jsonl');
  assert(fs.existsSync(lifecyclePath), 'lifecycle.jsonl should exist');

  const content = fs.readFileSync(lifecyclePath, 'utf8').trim();
  const entry = JSON.parse(content);
  assert(entry.task_id === 'task-1', 'task_id should be task-1');
  assert(entry.event === 'assigned', 'event should be assigned');
  assert(entry.agent === 'agent-A', 'agent should be agent-A');
  assert(entry.ts, 'should have timestamp');
});

test('getTaskLifecycle returns events for a specific task', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  analytics.recordLifecycleEvent('task-1', 'assigned', { agent: 'agent-A' });
  analytics.recordLifecycleEvent('task-2', 'assigned', { agent: 'agent-B' });
  analytics.recordLifecycleEvent('task-1', 'completed', { agent: 'agent-A' });

  const events = analytics.getTaskLifecycle('task-1');
  assert(events.length === 2, 'should have 2 events for task-1, got ' + events.length);
  assert(events[0].event === 'assigned', 'first event should be assigned');
  assert(events[1].event === 'completed', 'second event should be completed');
});

test('getTaskCycleTime calculates elapsed time', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  const t0 = new Date('2026-02-10T10:00:00Z').toISOString();
  const t1 = new Date('2026-02-10T10:30:00Z').toISOString();

  // Write events with controlled timestamps
  const lifecyclePath = path.join(TMP_DIR, '.claude/pilot/state/analytics/lifecycle.jsonl');
  fs.writeFileSync(lifecyclePath,
    JSON.stringify({ ts: t0, task_id: 'task-1', event: 'assigned', agent: 'agent-A' }) + '\n' +
    JSON.stringify({ ts: t1, task_id: 'task-1', event: 'completed', agent: 'agent-A' }) + '\n'
  );

  const cycleTime = analytics.getTaskCycleTime('task-1');
  assert(cycleTime === 30 * 60 * 1000, 'cycle time should be 30 min, got ' + cycleTime);
});

test('getTaskCycleTime returns null for incomplete tasks', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  analytics.recordLifecycleEvent('task-1', 'assigned', { agent: 'agent-A' });

  const cycleTime = analytics.getTaskCycleTime('task-1');
  assert(cycleTime === null, 'should return null for incomplete task');
});

// --- Agent Performance ---

console.log('\n  --- Agent Performance ---');

test('getAgentPerformance calculates success rate', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  const lifecyclePath = path.join(TMP_DIR, '.claude/pilot/state/analytics/lifecycle.jsonl');
  const events = [
    { ts: '2026-02-10T10:00:00Z', task_id: 'task-1', event: 'assigned', agent: 'agent-A' },
    { ts: '2026-02-10T10:15:00Z', task_id: 'task-1', event: 'completed', agent: 'agent-A' },
    { ts: '2026-02-10T10:30:00Z', task_id: 'task-2', event: 'assigned', agent: 'agent-A' },
    { ts: '2026-02-10T10:45:00Z', task_id: 'task-2', event: 'completed', agent: 'agent-A' },
    { ts: '2026-02-10T11:00:00Z', task_id: 'task-3', event: 'assigned', agent: 'agent-A' },
    { ts: '2026-02-10T11:10:00Z', task_id: 'task-3', event: 'failed', agent: 'agent-A' },
  ];
  fs.writeFileSync(lifecyclePath, events.map(e => JSON.stringify(e)).join('\n') + '\n');

  const perf = analytics.getAgentPerformance('agent-A');
  assert(perf.session_id === 'agent-A', 'session_id should match');
  assert(perf.tasks_completed === 2, 'should have 2 completed tasks, got ' + perf.tasks_completed);
  assert(perf.tasks_failed === 1, 'should have 1 failed task, got ' + perf.tasks_failed);
  assert(Math.abs(perf.success_rate - 0.67) < 0.01, 'success rate should be ~0.67, got ' + perf.success_rate);
});

test('getAgentPerformance calculates avg cycle time', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  const lifecyclePath = path.join(TMP_DIR, '.claude/pilot/state/analytics/lifecycle.jsonl');
  const events = [
    { ts: '2026-02-10T10:00:00Z', task_id: 'task-1', event: 'assigned', agent: 'agent-B' },
    { ts: '2026-02-10T10:20:00Z', task_id: 'task-1', event: 'completed', agent: 'agent-B' },
    { ts: '2026-02-10T10:30:00Z', task_id: 'task-2', event: 'assigned', agent: 'agent-B' },
    { ts: '2026-02-10T11:10:00Z', task_id: 'task-2', event: 'completed', agent: 'agent-B' },
  ];
  fs.writeFileSync(lifecyclePath, events.map(e => JSON.stringify(e)).join('\n') + '\n');

  const perf = analytics.getAgentPerformance('agent-B');
  assert(perf.tasks_completed === 2, 'should have 2 completed');
  // avg of 20min and 40min = 30min = 1800000ms
  assert(perf.avg_cycle_time_ms === 1800000, 'avg cycle time should be 1800000ms, got ' + perf.avg_cycle_time_ms);
});

test('getAgentPerformance tracks rework (reassigned)', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  const lifecyclePath = path.join(TMP_DIR, '.claude/pilot/state/analytics/lifecycle.jsonl');
  const events = [
    { ts: '2026-02-10T10:00:00Z', task_id: 'task-1', event: 'assigned', agent: 'agent-C' },
    { ts: '2026-02-10T10:20:00Z', task_id: 'task-1', event: 'reassigned', agent: 'agent-C' },
    { ts: '2026-02-10T10:30:00Z', task_id: 'task-2', event: 'assigned', agent: 'agent-C' },
    { ts: '2026-02-10T10:50:00Z', task_id: 'task-2', event: 'completed', agent: 'agent-C' },
  ];
  fs.writeFileSync(lifecyclePath, events.map(e => JSON.stringify(e)).join('\n') + '\n');

  const perf = analytics.getAgentPerformance('agent-C');
  assert(perf.rework_count === 1, 'should have 1 rework, got ' + perf.rework_count);
  assert(perf.tasks_completed === 1, 'should have 1 completed');
  assert(perf.tasks_reassigned === 1, 'should have 1 reassigned');
  assert(perf.success_rate === 0.5, 'success rate should be 0.5, got ' + perf.success_rate);
});

test('getAllAgentPerformance returns all agents', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  const lifecyclePath = path.join(TMP_DIR, '.claude/pilot/state/analytics/lifecycle.jsonl');
  const events = [
    { ts: '2026-02-10T10:00:00Z', task_id: 'task-1', event: 'completed', agent: 'agent-X' },
    { ts: '2026-02-10T10:00:00Z', task_id: 'task-2', event: 'completed', agent: 'agent-Y' },
  ];
  fs.writeFileSync(lifecyclePath, events.map(e => JSON.stringify(e)).join('\n') + '\n');

  const all = analytics.getAllAgentPerformance();
  assert(all.length === 2, 'should have 2 agents, got ' + all.length);
  const ids = all.map(a => a.session_id).sort();
  assert(ids[0] === 'agent-X', 'should include agent-X');
  assert(ids[1] === 'agent-Y', 'should include agent-Y');
});

// --- Complexity Scoring ---

console.log('\n  --- Complexity Scoring ---');

test('recordPredictedComplexity and recordActualComplexity', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  analytics.recordPredictedComplexity('task-1', 'M', { files: 5 });
  analytics.recordActualComplexity('task-1', 'L', { files_touched: 8 });

  const events = analytics.getTaskLifecycle('task-1');
  assert(events.length === 2, 'should have 2 events');
  assert(events[0].event === 'complexity_predicted', 'first should be prediction');
  assert(events[0].predicted_complexity === 'M', 'predicted should be M');
  assert(events[1].event === 'complexity_actual', 'second should be actual');
  assert(events[1].actual_complexity === 'L', 'actual should be L');
});

test('getComplexityCalibration detects underestimates', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  const lifecyclePath = path.join(TMP_DIR, '.claude/pilot/state/analytics/lifecycle.jsonl');
  const events = [
    // Task 1: predicted S, actual M → underestimate
    { ts: '2026-02-10T10:00:00Z', task_id: 'task-1', event: 'complexity_predicted', predicted_complexity: 'S' },
    { ts: '2026-02-10T10:30:00Z', task_id: 'task-1', event: 'complexity_actual', actual_complexity: 'M' },
    // Task 2: predicted M, actual M → match
    { ts: '2026-02-10T11:00:00Z', task_id: 'task-2', event: 'complexity_predicted', predicted_complexity: 'M' },
    { ts: '2026-02-10T11:30:00Z', task_id: 'task-2', event: 'complexity_actual', actual_complexity: 'M' },
    // Task 3: predicted L, actual S → overestimate
    { ts: '2026-02-10T12:00:00Z', task_id: 'task-3', event: 'complexity_predicted', predicted_complexity: 'L' },
    { ts: '2026-02-10T12:30:00Z', task_id: 'task-3', event: 'complexity_actual', actual_complexity: 'S' },
  ];
  fs.writeFileSync(lifecyclePath, events.map(e => JSON.stringify(e)).join('\n') + '\n');

  const cal = analytics.getComplexityCalibration();
  assert(cal.total_predictions === 3, 'should have 3 predictions');
  assert(cal.total_compared === 3, 'should have 3 comparisons');
  assert(Math.abs(cal.accuracy_rate - 0.33) < 0.01, 'accuracy should be ~0.33, got ' + cal.accuracy_rate);
  assert(cal.underestimates === 1, 'should have 1 underestimate, got ' + cal.underestimates);
  assert(cal.overestimates === 1, 'should have 1 overestimate, got ' + cal.overestimates);
});

test('getComplexityCalibration returns zeroes with no data', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  const cal = analytics.getComplexityCalibration();
  assert(cal.total_predictions === 0, 'should have 0 predictions');
  assert(cal.accuracy_rate === 0, 'accuracy should be 0');
});

// --- Bottleneck Detection ---

console.log('\n  --- Bottleneck Detection ---');

test('detectBottlenecks returns healthy state with no data', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  const bottlenecks = analytics.detectBottlenecks();
  assert(bottlenecks.assessment === 'healthy', 'should be healthy, got ' + bottlenecks.assessment);
  assert(Array.isArray(bottlenecks.blocking_tasks), 'blocking_tasks should be array');
  assert(Array.isArray(bottlenecks.slow_tasks), 'slow_tasks should be array');
  assert(Array.isArray(bottlenecks.bottleneck_agents), 'bottleneck_agents should be array');
});

test('detectBottlenecks flags slow agents', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  // Create data for a very slow agent (avg 2 hours per task)
  const lifecyclePath = path.join(TMP_DIR, '.claude/pilot/state/analytics/lifecycle.jsonl');
  const events = [
    { ts: '2026-02-10T08:00:00Z', task_id: 'task-1', event: 'assigned', agent: 'slow-agent' },
    { ts: '2026-02-10T10:00:00Z', task_id: 'task-1', event: 'completed', agent: 'slow-agent' },
    { ts: '2026-02-10T10:30:00Z', task_id: 'task-2', event: 'assigned', agent: 'slow-agent' },
    { ts: '2026-02-10T12:30:00Z', task_id: 'task-2', event: 'completed', agent: 'slow-agent' },
  ];
  fs.writeFileSync(lifecyclePath, events.map(e => JSON.stringify(e)).join('\n') + '\n');

  const bottlenecks = analytics.detectBottlenecks({ slowThresholdMs: 60 * 60 * 1000 }); // 1 hour
  assert(bottlenecks.bottleneck_agents.length === 1, 'should have 1 bottleneck agent, got ' + bottlenecks.bottleneck_agents.length);
  assert(bottlenecks.bottleneck_agents[0].session_id === 'slow-agent', 'should be slow-agent');
  assert(bottlenecks.bottleneck_agents[0].reason === 'slow', 'reason should be slow');
});

// --- Daily Aggregation ---

console.log('\n  --- Daily Aggregation ---');

test('aggregateDaily creates a snapshot', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  const today = new Date().toISOString().split('T')[0];
  const lifecyclePath = path.join(TMP_DIR, '.claude/pilot/state/analytics/lifecycle.jsonl');
  const events = [
    { ts: today + 'T10:00:00Z', task_id: 'task-1', event: 'assigned', agent: 'agent-A' },
    { ts: today + 'T10:30:00Z', task_id: 'task-1', event: 'completed', agent: 'agent-A' },
  ];
  fs.writeFileSync(lifecyclePath, events.map(e => JSON.stringify(e)).join('\n') + '\n');

  const snapshot = analytics.aggregateDaily();
  assert(snapshot.date === today, 'date should be today');
  assert(snapshot.tasks_assigned === 1, 'should have 1 assigned, got ' + snapshot.tasks_assigned);
  assert(snapshot.tasks_completed === 1, 'should have 1 completed, got ' + snapshot.tasks_completed);
  assert(snapshot.avg_cycle_time_ms === 30 * 60 * 1000, 'avg cycle time should be 30min');
  assert(snapshot.tasks_failed === 0, 'should have 0 failed');
});

test('getSnapshot retrieves persisted snapshot', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  const today = new Date().toISOString().split('T')[0];

  // Write events and aggregate
  const lifecyclePath = path.join(TMP_DIR, '.claude/pilot/state/analytics/lifecycle.jsonl');
  fs.writeFileSync(lifecyclePath,
    JSON.stringify({ ts: today + 'T10:00:00Z', task_id: 'task-1', event: 'completed', agent: 'a' }) + '\n'
  );
  analytics.aggregateDaily();

  // Read it back
  const snapshot = analytics.getSnapshot(today);
  assert(snapshot !== null, 'snapshot should exist');
  assert(snapshot.date === today, 'date should match');
  assert(snapshot.tasks_completed === 1, 'should have 1 completed');
});

test('getRecentSnapshots returns multiple days', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  // Write snapshots for today and yesterday
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  const snapshotsDir = path.join(TMP_DIR, '.claude/pilot/state/analytics/snapshots');
  fs.writeFileSync(path.join(snapshotsDir, `${today}.json`), JSON.stringify({ date: today, tasks_completed: 3 }));
  fs.writeFileSync(path.join(snapshotsDir, `${yesterday}.json`), JSON.stringify({ date: yesterday, tasks_completed: 2 }));

  const recent = analytics.getRecentSnapshots(7);
  assert(recent.length === 2, 'should have 2 snapshots, got ' + recent.length);
});

// --- Sprint Retrospective ---

console.log('\n  --- Sprint Retrospective ---');

test('generateRetrospective produces summary from snapshots', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  const today = new Date().toISOString().split('T')[0];
  const snapshotsDir = path.join(TMP_DIR, '.claude/pilot/state/analytics/snapshots');
  fs.writeFileSync(path.join(snapshotsDir, `${today}.json`), JSON.stringify({
    date: today,
    tasks_assigned: 5,
    tasks_completed: 4,
    tasks_failed: 1,
    tasks_reassigned: 0,
    avg_cycle_time_ms: 1200000,
    total_tokens: 100000,
    cost_usd: 1.0,
    success_rate: 0.8,
    rework_rate: 0,
    queue_depth: 2,
    blocking_task_count: 0,
    bottleneck_assessment: 'healthy',
    agents: []
  }));

  const retro = analytics.generateRetrospective(7);
  assert(retro.period.start === today, 'period start should be today');
  assert(retro.velocity.tasks_completed === 4, 'should have 4 completed, got ' + retro.velocity.tasks_completed);
  assert(retro.velocity.tasks_failed === 1, 'should have 1 failed');
  assert(retro.cost.total_tokens === 100000, 'total tokens should be 100000');
  assert(retro.cost.cost_usd === 1.0, 'cost should be $1.00');
  assert(Array.isArray(retro.highlights), 'highlights should be array');
  assert(Array.isArray(retro.concerns), 'concerns should be array');
  assert(Array.isArray(retro.recommendations), 'recommendations should be array');
});

test('generateRetrospective flags high rework rate', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  const today = new Date().toISOString().split('T')[0];
  const snapshotsDir = path.join(TMP_DIR, '.claude/pilot/state/analytics/snapshots');
  fs.writeFileSync(path.join(snapshotsDir, `${today}.json`), JSON.stringify({
    date: today,
    tasks_assigned: 5,
    tasks_completed: 2,
    tasks_failed: 0,
    tasks_reassigned: 3,
    avg_cycle_time_ms: 600000,
    total_tokens: 50000,
    cost_usd: 0.5,
    success_rate: 0.4,
    rework_rate: 0.6,
    queue_depth: 1,
    blocking_task_count: 0,
    bottleneck_assessment: 'healthy',
    agents: []
  }));

  const retro = analytics.generateRetrospective(7);
  assert(retro.quality.rework_rate === 0.6, 'rework rate should be 0.6');
  const hasReworkConcern = retro.concerns.some(c => c.includes('rework'));
  assert(hasReworkConcern, 'should flag rework concern');
});

test('generateRetrospective handles empty data', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  const retro = analytics.generateRetrospective(7);
  assert(retro.velocity.tasks_completed === 0, 'should have 0 completed');
  assert(retro.highlights.length > 0, 'should have at least one highlight/message');
  assert(retro.recommendations.length > 0, 'should have recommendations');
});

// --- getSummary ---

console.log('\n  --- Dashboard Summary ---');

test('getSummary returns live data when no snapshot exists', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  const today = new Date().toISOString().split('T')[0];
  const lifecyclePath = path.join(TMP_DIR, '.claude/pilot/state/analytics/lifecycle.jsonl');
  fs.writeFileSync(lifecyclePath,
    JSON.stringify({ ts: today + 'T10:00:00Z', task_id: 'task-1', event: 'completed', agent: 'a' }) + '\n' +
    JSON.stringify({ ts: today + 'T10:30:00Z', task_id: 'task-2', event: 'assigned', agent: 'b' }) + '\n'
  );

  const summary = analytics.getSummary();
  assert(summary.date === today, 'date should be today');
  assert(summary.tasks_completed === 1, 'should have 1 completed, got ' + summary.tasks_completed);
  assert(summary.tasks_assigned === 1, 'should have 1 assigned, got ' + summary.tasks_assigned);
});

test('getSummary returns snapshot data when available', () => {
  const analytics = freshAnalytics();
  analytics.resetAll();

  const today = new Date().toISOString().split('T')[0];
  const snapshotsDir = path.join(TMP_DIR, '.claude/pilot/state/analytics/snapshots');
  fs.writeFileSync(path.join(snapshotsDir, `${today}.json`), JSON.stringify({
    date: today,
    tasks_completed: 10,
    success_rate: 0.95,
    avg_cycle_time_ms: 600000,
    queue_depth: 3,
    bottleneck_assessment: 'healthy',
    total_tokens: 200000,
    cost_usd: 2.0
  }));

  const summary = analytics.getSummary();
  assert(summary.tasks_completed === 10, 'should have 10 completed from snapshot');
  assert(summary.success_rate === 0.95, 'success rate should be 0.95');
  assert(summary.bottleneck_assessment === 'healthy', 'should be healthy');
});

// --- resetAll ---

console.log('\n  --- Reset ---');

test('resetAll clears all analytics state', () => {
  const analytics = freshAnalytics();

  // Write some data
  analytics.recordLifecycleEvent('task-1', 'assigned', { agent: 'a' });
  analytics.aggregateDaily();

  const lifecyclePath = path.join(TMP_DIR, '.claude/pilot/state/analytics/lifecycle.jsonl');
  assert(fs.existsSync(lifecyclePath), 'lifecycle should exist before reset');

  analytics.resetAll();

  assert(!fs.existsSync(lifecyclePath), 'lifecycle should be gone after reset');
});

// --- PM Loop Integration ---

console.log('\n  --- PM Loop Integration ---');

test('PmLoop has _analyticsScan method', () => {
  // Clear pm-loop from cache
  const libDir = path.join(ORIG_CWD, '.claude/pilot/hooks/lib');
  const pmLoopModules = ['pm-loop.js', 'orchestrator.js', 'session.js', 'messaging.js',
    'pm-research.js', 'decomposition.js', 'analytics.js', 'cost-tracker.js',
    'scheduler.js', 'escalation.js', 'recovery.js', 'pressure.js', 'policy.js', 'memory.js'];
  for (const m of pmLoopModules) {
    try { delete require.cache[require.resolve(path.join(libDir, m))]; } catch (e) { /* ok */ }
  }

  const { PmLoop } = require(path.join(libDir, 'pm-loop.js'));
  const loop = new PmLoop(TMP_DIR, { dryRun: true });
  assert(typeof loop._analyticsScan === 'function', '_analyticsScan should be a function');
});

test('PmLoop._analyticsScan returns results array', () => {
  const libDir = path.join(ORIG_CWD, '.claude/pilot/hooks/lib');
  for (const m of ['pm-loop.js', 'analytics.js', 'cost-tracker.js', 'memory.js', 'policy.js']) {
    try { delete require.cache[require.resolve(path.join(libDir, m))]; } catch (e) { /* ok */ }
  }

  const { PmLoop } = require(path.join(libDir, 'pm-loop.js'));
  const loop = new PmLoop(TMP_DIR, { dryRun: true, pmSessionId: 'pm-test' });
  loop.initialize('pm-test');

  const results = loop._analyticsScan();
  assert(Array.isArray(results), 'should return array, got ' + typeof results);
});

test('PmLoop constructor has analyticsScanIntervalMs option', () => {
  const libDir = path.join(ORIG_CWD, '.claude/pilot/hooks/lib');
  try { delete require.cache[require.resolve(path.join(libDir, 'pm-loop.js'))]; } catch (e) { /* ok */ }

  const { PmLoop } = require(path.join(libDir, 'pm-loop.js'));
  const loop = new PmLoop(TMP_DIR, { analyticsScanIntervalMs: 120000 });
  assert(loop.opts.analyticsScanIntervalMs === 120000, 'should respect custom interval');
});

// --- Dashboard Integration ---

console.log('\n  --- Dashboard Integration ---');

test('dashboard.collect() includes analytics field', () => {
  const libDir = path.join(ORIG_CWD, '.claude/pilot/hooks/lib');
  // Clear caches
  for (const m of ['dashboard.js', 'analytics.js', 'orchestrator.js', 'session.js',
    'messaging.js', 'pressure.js', 'worktree.js', 'memory.js', 'cost-tracker.js', 'policy.js']) {
    try { delete require.cache[require.resolve(path.join(libDir, m))]; } catch (e) { /* ok */ }
  }

  const dashboard = require(path.join(libDir, 'dashboard.js'));
  const data = dashboard.collect();
  assert('analytics' in data, 'collect() should include analytics field');
});

// =============================================================================
// CLEANUP
// =============================================================================

process.chdir(ORIG_CWD);

// Clean up temp directory
try {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
} catch (e) {
  // Best effort cleanup
}

// =============================================================================
// RESULTS
// =============================================================================

console.log('\n  ─────────────────────────────────');
console.log(`  Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
console.log('  ─────────────────────────────────\n');

process.exit(failed > 0 ? 1 : 0);
