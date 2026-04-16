#!/usr/bin/env node

/**
 * Verification tests for PM Watcher, PM Loop, Queue, and Stdin Injector
 * Part of Pilot AGI-v1k — Autonomous PM-Executor Loop
 *
 * Run: node tests/pm-watcher.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

// Queue of test functions (supports async)
const _testQueue = [];

function test(name, fn) {
  _testQueue.push({ name, fn });
}

// Run all queued tests sequentially (supports async test functions)
async function runTests() {
  for (const { name, fn } of _testQueue) {
    try {
      await fn();
      passed++;
      console.log('  PASS: ' + name);
    } catch (e) {
      failed++;
      console.log('  FAIL: ' + name + ' - ' + e.message);
    }
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
// SETUP: temp directory for isolated file operations
// =============================================================================

const TMP_DIR = path.join(os.tmpdir(), 'pilot-pm-watcher-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

// Create directory structure
const dirs = [
  '.claude/pilot/state/orchestrator',
  '.claude/pilot/state/sessions',
  '.claude/pilot/state/locks',
  '.claude/pilot/messages/cursors',
  '.claude/pilot/memory/channels',
  '.claude/pilot/memory/schemas',
  'runs'
];
for (const d of dirs) {
  fs.mkdirSync(path.join(TMP_DIR, d), { recursive: true });
}

// Create minimal policy
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
  ''
].join('\n'));

// Create minimal memory index
fs.writeFileSync(path.join(TMP_DIR, '.claude/pilot/memory/index.json'), JSON.stringify({
  version: 1,
  channels: {
    'pm-decisions': {
      description: 'PM decisions',
      publisher: 'pm',
      consumers: []
    }
  }
}));

// Switch CWD
const ORIG_CWD = process.cwd();
process.chdir(TMP_DIR);

// =============================================================================
// TESTS: PM Watcher
// =============================================================================

console.log('\n=== PM Watcher ===');

const { PmWatcher, loadWatcherState, saveWatcherState, readNewBusEvents, isWatcherRunning, readPidFile, removePidFile } = require(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/pm-watcher'));

test('loadWatcherState returns initial state for fresh project', () => {
  const state = loadWatcherState(TMP_DIR);
  assertEqual(state.byte_offset, 0, 'byte_offset');
  assertEqual(state.processed_count, 0, 'processed_count');
  assert(state.started_at, 'should have started_at');
});

test('saveWatcherState persists and loads correctly', () => {
  const state = { byte_offset: 100, processed_count: 5, stats: { events_processed: 5 } };
  saveWatcherState(TMP_DIR, state);
  const loaded = loadWatcherState(TMP_DIR);
  assertEqual(loaded.byte_offset, 100, 'byte_offset persisted');
  assertEqual(loaded.processed_count, 5, 'processed_count persisted');
});

test('readNewBusEvents returns empty for empty bus', async () => {
  const state = { byte_offset: 0 };
  const { events, newOffset } = await readNewBusEvents(TMP_DIR, state);
  assertEqual(events.length, 0, 'no events');
  assertEqual(newOffset, 0, 'offset stays 0');
});

test('readNewBusEvents reads new events from bus.jsonl', async () => {
  const busPath = path.join(TMP_DIR, '.claude/pilot/messages/bus.jsonl');
  const event1 = { id: 'E-test1', ts: new Date().toISOString(), type: 'notify', from: 'S-test', to: 'PM', topic: 'task_complete', priority: 'normal', ttl_ms: 300000, payload: { data: { task_id: 'T-1' } } };
  const event2 = { id: 'E-test2', ts: new Date().toISOString(), type: 'broadcast', from: 'S-test', topic: 'session_announced', priority: 'fyi', ttl_ms: 300000, payload: {} };
  fs.writeFileSync(busPath, JSON.stringify(event1) + '\n' + JSON.stringify(event2) + '\n');

  const state = { byte_offset: 0 };
  const { events, newOffset } = await readNewBusEvents(TMP_DIR, state);
  assertEqual(events.length, 2, 'reads both events');
  assert(newOffset > 0, 'offset advances');
  assertEqual(events[0].id, 'E-test1', 'first event');
  assertEqual(events[1].id, 'E-test2', 'second event');
});

test('readNewBusEvents respects byte offset', async () => {
  const busPath = path.join(TMP_DIR, '.claude/pilot/messages/bus.jsonl');
  const content = fs.readFileSync(busPath, 'utf8');
  const state = { byte_offset: Buffer.byteLength(content, 'utf8') };

  // No new events
  const { events } = await readNewBusEvents(TMP_DIR, state);
  assertEqual(events.length, 0, 'no new events after offset');

  // Add a new event
  const event3 = { id: 'E-test3', ts: new Date().toISOString(), type: 'notify', from: 'S-test', to: 'PM', topic: 'step_complete', priority: 'normal', ttl_ms: 300000, payload: {} };
  fs.appendFileSync(busPath, JSON.stringify(event3) + '\n');

  const { events: newEvents } = await readNewBusEvents(TMP_DIR, state);
  assertEqual(newEvents.length, 1, 'reads only new event');
  assertEqual(newEvents[0].id, 'E-test3', 'correct event');
});

test('isWatcherRunning returns false when no PID file', () => {
  removePidFile(TMP_DIR);
  assert(!isWatcherRunning(TMP_DIR), 'no watcher running');
});

test('PmWatcher classifies events correctly', () => {
  const watcher = new PmWatcher(TMP_DIR);

  const taskComplete = { topic: 'task_complete', type: 'notify' };
  const classification = watcher._classifyEvent(taskComplete);
  assertEqual(classification.action, 'assign_next', 'task_complete → assign_next');
  assertEqual(classification.priority, 'high', 'high priority');

  const blocked = { topic: 'blocked', type: 'notify' };
  const blockedClass = watcher._classifyEvent(blocked);
  assertEqual(blockedClass.action, 'respond_to_agent', 'blocked → respond_to_agent');

  const sessionEnd = { topic: 'session_ended', type: 'notify' };
  const sessionClass = watcher._classifyEvent(sessionEnd);
  assertEqual(sessionClass.action, 'cleanup_session', 'session_ended → cleanup_session');

  const mergeReq = { topic: 'merge_request', type: 'notify' };
  const mergeClass = watcher._classifyEvent(mergeReq);
  assertEqual(mergeClass.action, 'review_merge', 'merge_request → review_merge');

  const stepDone = { topic: 'step_complete', type: 'notify' };
  const stepClass = watcher._classifyEvent(stepDone);
  assertEqual(stepClass.action, 'track_progress', 'step_complete → track_progress');

  const newAgent = { topic: 'session_announced', type: 'notify' };
  const newAgentClass = watcher._classifyEvent(newAgent);
  assertEqual(newAgentClass.action, 'greet_agent', 'session_announced → greet_agent');
});

// =============================================================================
// TESTS: PM Loop
// =============================================================================

console.log('\n=== PM Loop ===');

const { PmLoop } = require(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/pm-loop'));

test('PmLoop initializes with PM session', () => {
  const loop = new PmLoop(TMP_DIR, { dryRun: true });
  loop.initialize('S-pm-test');
  assert(loop.running, 'loop is running');
  assertEqual(loop.pmSessionId, 'S-pm-test', 'PM session set');
});

test('PmLoop processes events in dry-run mode', async () => {
  const loop = new PmLoop(TMP_DIR, { dryRun: true });
  loop.initialize('S-pm-test');

  const events = [{
    event: {
      id: 'E-1',
      from: 'S-agent1',
      topic: 'task_claimed',
      type: 'notify',
      payload: { data: { task_id: 'T-1' } }
    },
    classification: { action: 'track_claim', priority: 'low' }
  }];

  const results = await loop.processEvents(events);
  assertEqual(results.length, 1, 'one result');
  assertEqual(results[0].action, 'track_claim', 'action matches');
  assert(results[0].result.tracked, 'tracked flag set');
});

test('PmLoop respects max actions per cycle', async () => {
  const loop = new PmLoop(TMP_DIR, { dryRun: true, maxActionsPerCycle: 2 });
  loop.initialize('S-pm-test');

  const events = Array.from({ length: 5 }, (_, i) => ({
    event: { id: `E-${i}`, from: `S-a${i}`, topic: 'step_complete', type: 'notify', payload: {} },
    classification: { action: 'track_progress', priority: 'low' }
  }));

  const results = await loop.processEvents(events);
  assertEqual(results.length, 2, 'capped at maxActionsPerCycle');
});

test('PmLoop handles unknown action gracefully', async () => {
  const loop = new PmLoop(TMP_DIR, { dryRun: true });
  loop.initialize('S-pm-test');

  const events = [{
    event: { id: 'E-unk', from: 'S-x', topic: 'unknown', type: 'notify', payload: {} },
    classification: { action: 'nonexistent_action', priority: 'low' }
  }];

  const results = await loop.processEvents(events);
  assertEqual(results.length, 0, 'unknown action produces no result');
});

test('PmLoop stop prevents further processing', async () => {
  const loop = new PmLoop(TMP_DIR, { dryRun: true });
  loop.initialize('S-pm-test');
  loop.stop('test');

  const events = [{
    event: { id: 'E-x', from: 'S-x', topic: 'task_claimed', type: 'notify', payload: { data: {} } },
    classification: { action: 'track_claim', priority: 'low' }
  }];

  const results = await loop.processEvents(events);
  assertEqual(results.length, 0, 'no results after stop');
});

test('PmLoop getStats returns correct state', () => {
  const loop = new PmLoop(TMP_DIR, { dryRun: true });
  loop.initialize('S-pm-test');

  const stats = loop.getStats();
  assert(stats.running, 'running');
  assertEqual(stats.pm_session, 'S-pm-test', 'pm_session');
  assertEqual(stats.queue_size, 0, 'empty queue');
});

// =============================================================================
// TESTS: Stdin Injector
// =============================================================================

console.log('\n=== Stdin Injector ===');

const injector = require(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/stdin-injector'));

test('enqueueAction adds action to queue', () => {
  const action = injector.enqueueAction(TMP_DIR, {
    type: 'assign_task',
    data: { task_id: 'T-1', target_session: 'S-1' }
  });

  assert(action.id, 'has ID');
  assert(action.ts, 'has timestamp');
  assertEqual(action.status, 'pending', 'status is pending');
});

test('readQueue returns queued actions', () => {
  const queue = injector.readQueue(TMP_DIR);
  assert(queue.length >= 1, 'queue has items');
  assertEqual(queue[0].type, 'assign_task', 'correct type');
});

test('dequeueAction returns and marks as processing', () => {
  const action = injector.dequeueAction(TMP_DIR);
  assert(action, 'got action');
  assertEqual(action.status, 'processing', 'marked as processing');
  assertEqual(action.type, 'assign_task', 'correct type');
});

test('completeAction removes from queue', () => {
  const queue = injector.readQueue(TMP_DIR);
  const processing = queue.find(a => a.status === 'processing');
  assert(processing, 'found processing action');

  injector.completeAction(TMP_DIR, processing.id, { ok: true });

  const afterQueue = injector.readQueue(TMP_DIR);
  const stillThere = afterQueue.find(a => a.id === processing.id);
  assert(!stillThere, 'removed from queue');
});

test('getQueueStats returns correct counts', () => {
  // Add a few actions
  injector.enqueueAction(TMP_DIR, { type: 'test1', data: {} });
  injector.enqueueAction(TMP_DIR, { type: 'test2', data: {} });

  const stats = injector.getQueueStats(TMP_DIR);
  assert(stats.pending >= 2, 'at least 2 pending');
  assertEqual(stats.processing, 0, 'none processing');
});

test('actionToPrompt generates correct prompts', () => {
  const assignPrompt = injector.actionToPrompt({
    type: 'assign_task',
    data: { task_id: 'T-1', target_session: 'S-1', reason: 'auto' }
  });
  assert(assignPrompt.includes('T-1'), 'includes task ID');
  assert(assignPrompt.includes('S-1'), 'includes session ID');

  const errorPrompt = injector.actionToPrompt({
    type: 'agent_error',
    data: { agent: 'S-x', error: { type: 'test_failure', snippet: 'FAIL: test 1' } }
  });
  assert(errorPrompt.includes('test_failure'), 'includes error type');
  assert(errorPrompt.includes('S-x'), 'includes agent');

  const driftPrompt = injector.actionToPrompt({
    type: 'drift_alert',
    data: { agent: 'S-x', task_id: 'T-1', score: 0.5, unplanned: ['new.js'] }
  });
  assert(driftPrompt.includes('50%'), 'includes drift score');
  assert(driftPrompt.includes('new.js'), 'includes unplanned file');
});

test('failAction moves to history', () => {
  const action = injector.enqueueAction(TMP_DIR, { type: 'fail_test', data: {} });
  injector.failAction(TMP_DIR, action.id, 'test failure');

  const queue = injector.readQueue(TMP_DIR);
  const stillThere = queue.find(a => a.id === action.id);
  assert(!stillThere, 'removed from queue after failure');
});

// =============================================================================
// TESTS: PM Queue
// =============================================================================

console.log('\n=== PM Queue ===');

const pmQueue = require(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/pm-queue'));

test('isPmAvailable returns false when no PM state', () => {
  assert(!pmQueue.isPmAvailable(TMP_DIR), 'no PM available');
});

test('loadQueueState returns initial state', () => {
  const state = pmQueue.loadQueueState(TMP_DIR);
  assertEqual(state.pm_available, false, 'pm not available');
  assertEqual(state.consecutive_failures, 0, 'no failures');
});

test('drainQueue handles PM unavailable with backoff', () => {
  const result = pmQueue.drainQueue(TMP_DIR);
  assertEqual(result.drained, 0, 'nothing drained');
  assertEqual(result.reason, 'pm_unavailable', 'correct reason');
  assert(result.next_retry_at, 'backoff set');
  assertEqual(result.consecutive_failures, 1, 'failure counted');
});

test('drainQueue respects backoff', () => {
  const result = pmQueue.drainQueue(TMP_DIR);
  assert(result.skipped, 'skipped due to backoff');
  assertEqual(result.reason, 'backoff', 'correct reason');
});

test('forceRetry resets backoff', () => {
  const result = pmQueue.forceRetry(TMP_DIR);
  // Will fail because PM is still unavailable, but backoff was reset
  assertEqual(result.reason, 'pm_unavailable', 'still unavailable');
  assertEqual(result.consecutive_failures, 1, 'reset to 1');
});

test('getQueueHealth returns complete status', () => {
  const health = pmQueue.getQueueHealth(TMP_DIR);
  assert('pm_available' in health, 'has pm_available');
  assert('queue' in health, 'has queue stats');
  assert('needs_attention' in health, 'has needs_attention');
});

// =============================================================================
// TESTS: Post-tool-use hook event emission
// =============================================================================

console.log('\n=== Post-Tool-Use Status Events ===');

// We can't easily test the hook directly (it reads stdin), but we can test
// the event detection patterns it uses

test('bd close command regex matches correctly', () => {
  const patterns = [
    'bd close "Pilot AGI-v1k"',
    'bd close Pilot-AGI-v1k',
    'bd update "Pilot AGI-v1k" --status closed'
  ];

  for (const cmd of patterns) {
    assert(
      /bd\s+close\b/.test(cmd) || /bd\s+update\b.*--status\s+closed/.test(cmd),
      `Should match: ${cmd}`
    );
  }
});

test('bd update in_progress regex matches correctly', () => {
  const cmd = 'bd update "Pilot AGI-v1k" --status in_progress';
  assert(
    /bd\s+update\b.*--status\s+in_progress/.test(cmd),
    'Should match status update'
  );
});

test('git commit regex matches correctly', () => {
  const cmds = [
    'git commit -m "feat: add feature"',
    'git commit -m "$(cat <<EOF\ntest\nEOF)"'
  ];

  for (const cmd of cmds) {
    assert(/git\s+commit\b/.test(cmd), `Should match: ${cmd}`);
  }
});

test('test failure detection regex works', () => {
  const outputs = [
    'FAIL tests/foo.test.js',
    'Error: test failed',
    'AssertionError: expected true',
    '1 test failed, 5 passed'
  ];

  for (const output of outputs) {
    assert(
      /FAIL|Error:|AssertionError|test failed/i.test(output),
      `Should detect failure: ${output}`
    );
  }
});

// =============================================================================
// RUN ALL TESTS (async-aware runner)
// =============================================================================

runTests().then(() => {
  process.chdir(ORIG_CWD);
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch (e) {
    // Best effort cleanup
  }

  console.log(`\n════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`════════════════════════════════════════\n`);

  if (failed > 0 && require.main === module) {
    process.exit(1);
  }
}).catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
