/**
 * Tests for Reliable Message Bus (Phase 3.10)
 * Covers: ACK protocol, DLQ, priority sorting, sender ordering,
 * cursor recovery, auto-compaction
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Create isolated test directory
const TEST_DIR = path.join(os.tmpdir(), `messaging-test-${Date.now()}`);
const ORIGINAL_CWD = process.cwd();

function setup() {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/messages/cursors'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/messages/archive'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.claude/pilot/messages/nudge'), { recursive: true });
  process.chdir(TEST_DIR);
}

function teardown() {
  process.chdir(ORIGINAL_CWD);
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (e) {}
}

function freshModule() {
  // Clear require cache to get fresh state
  const modPath = path.join(ORIGINAL_CWD, '.claude/pilot/hooks/lib/messaging.js');
  delete require.cache[modPath];
  return require(modPath);
}

// ============================================================================
// TEST RUNNER
// ============================================================================

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function test(name, fn) {
  // Fresh setup for each test
  teardown();
  setup();

  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

// ============================================================================
// TESTS
// ============================================================================

console.log('\n=== Reliable Message Bus Tests ===\n');

// --- Sequence Numbers ---

console.log('Sequence Numbers:');

test('sendMessage adds sender_seq', () => {
  const m = freshModule();
  const r1 = m.sendMessage({ type: 'notify', from: 'S-a', to: '*', priority: 'fyi', payload: {} });
  assert(r1.success, 'send should succeed');

  const bus = fs.readFileSync('.claude/pilot/messages/bus.jsonl', 'utf8');
  const msg = JSON.parse(bus.trim());
  assert(msg.sender_seq === 1, `Expected sender_seq=1, got ${msg.sender_seq}`);
});

test('sender_seq increments per sender', () => {
  const m = freshModule();
  m.sendMessage({ type: 'notify', from: 'S-a', to: '*', priority: 'fyi', payload: {} });
  m.sendMessage({ type: 'notify', from: 'S-a', to: '*', priority: 'fyi', payload: {} });
  m.sendMessage({ type: 'notify', from: 'S-b', to: '*', priority: 'fyi', payload: {} });

  const lines = fs.readFileSync('.claude/pilot/messages/bus.jsonl', 'utf8').trim().split('\n');
  const msgs = lines.map(l => JSON.parse(l));

  assertEqual(msgs[0].sender_seq, 1, 'S-a first msg');
  assertEqual(msgs[1].sender_seq, 2, 'S-a second msg');
  assertEqual(msgs[2].sender_seq, 1, 'S-b first msg');
});

// --- Priority Sorting ---

console.log('\nPriority Sorting:');

test('readMessages sorts blocking before normal before fyi', () => {
  const m = freshModule();
  m.sendMessage({ type: 'broadcast', from: 'S-a', to: '*', priority: 'fyi', payload: { data: 'fyi' } });
  m.sendMessage({ type: 'broadcast', from: 'S-a', to: '*', priority: 'blocking', payload: { data: 'blocking' } });
  m.sendMessage({ type: 'broadcast', from: 'S-a', to: '*', priority: 'normal', payload: { data: 'normal' } });

  const cursor = m.initializeCursor('reader');
  // Reset cursor to read from start
  m.writeCursor('reader', { ...cursor, byte_offset: 0 });

  const { messages } = m.readMessages('reader');
  assertEqual(messages.length, 3, 'should read 3 messages');
  assertEqual(messages[0].priority, 'blocking', 'first should be blocking');
  assertEqual(messages[1].priority, 'normal', 'second should be normal');
  assertEqual(messages[2].priority, 'fyi', 'third should be fyi');
});

test('within same priority and sender, sorts by sender_seq', () => {
  const m = freshModule();
  // Send 3 normal messages — should preserve FIFO via sender_seq
  m.sendMessage({ type: 'broadcast', from: 'S-a', to: '*', priority: 'normal', payload: { data: 'msg1' } });
  m.sendMessage({ type: 'broadcast', from: 'S-a', to: '*', priority: 'normal', payload: { data: 'msg2' } });
  m.sendMessage({ type: 'broadcast', from: 'S-a', to: '*', priority: 'normal', payload: { data: 'msg3' } });

  const cursor = m.initializeCursor('reader');
  m.writeCursor('reader', { ...cursor, byte_offset: 0 });

  const { messages } = m.readMessages('reader');
  assertEqual(messages[0].sender_seq, 1, 'first msg seq');
  assertEqual(messages[1].sender_seq, 2, 'second msg seq');
  assertEqual(messages[2].sender_seq, 3, 'third msg seq');
});

// --- ACK Protocol ---

console.log('\nACK Protocol:');

test('sendRequest with ack.required tracks pending ACK', () => {
  const m = freshModule();
  const result = m.sendRequest('S-pm', 'S-worker', 'task.assign', { task: 'test' });
  assert(result.success, 'request should succeed');

  const pending = m.loadPendingAcks();
  assertEqual(pending.length, 1, 'should have 1 pending ACK');
  assertEqual(pending[0].message_id, result.id, 'pending ACK should match message ID');
  assertEqual(pending[0].from, 'S-pm', 'pending ACK from');
  assertEqual(pending[0].to, 'S-worker', 'pending ACK to');
});

test('sendAck clears pending ACK', () => {
  const m = freshModule();
  const result = m.sendRequest('S-pm', 'S-worker', 'task.assign', { task: 'test' });
  m.sendAck('S-worker', result.id, 'S-pm');

  const pending = m.loadPendingAcks();
  assertEqual(pending.length, 0, 'pending ACKs should be cleared');
});

test('sendNack sends rejection response', () => {
  const m = freshModule();
  const result = m.sendRequest('S-pm', 'S-worker', 'task.assign', { task: 'test' });
  const nack = m.sendNack('S-worker', result.id, 'S-pm', 'busy');
  assert(nack.success, 'nack should succeed');

  // Read messages for PM — should see the nack
  const cursor = m.initializeCursor('S-pm');
  m.writeCursor('S-pm', { ...cursor, byte_offset: 0 });
  const { messages } = m.readMessages('S-pm');

  const nackMsg = messages.find(msg => msg.payload && msg.payload.action === 'nack');
  assert(nackMsg, 'should find nack message');
  assertEqual(nackMsg.correlation_id, result.id, 'nack should correlate to original');
});

// --- ACK Timeout Processing ---

console.log('\nACK Timeouts:');

test('processAckTimeouts retries within limit', () => {
  const m = freshModule();
  // Create a pending ACK with expired deadline
  const acksPath = path.join(process.cwd(), '.claude/pilot/messages/pending_acks.jsonl');
  const entry = {
    message_id: 'M-test-1',
    from: 'S-pm',
    to: 'S-worker',
    deadline_at: new Date(Date.now() - 1000).toISOString(), // 1s ago (expired)
    retries: 0,
    created_at: new Date().toISOString()
  };
  fs.writeFileSync(acksPath, JSON.stringify(entry) + '\n');

  const result = m.processAckTimeouts();
  assertEqual(result.retried, 1, 'should retry 1');
  assertEqual(result.dlqd, 0, 'should not DLQ');

  // Check retry count incremented
  const pending = m.loadPendingAcks();
  assertEqual(pending[0].retries, 1, 'retries should increment');
});

test('processAckTimeouts moves to DLQ after max retries', () => {
  const m = freshModule();
  const acksPath = path.join(process.cwd(), '.claude/pilot/messages/pending_acks.jsonl');
  const entry = {
    message_id: 'M-test-dlq',
    from: 'S-pm',
    to: 'S-worker',
    deadline_at: new Date(Date.now() - 1000).toISOString(),
    retries: 3, // at max
    created_at: new Date().toISOString()
  };
  fs.writeFileSync(acksPath, JSON.stringify(entry) + '\n');

  const result = m.processAckTimeouts();
  assertEqual(result.retried, 0, 'should not retry');
  assertEqual(result.dlqd, 1, 'should DLQ 1');

  // Check DLQ
  const dlq = m.getDLQMessages();
  assertEqual(dlq.length, 1, 'DLQ should have 1 entry');
  assertEqual(dlq[0].message_id, 'M-test-dlq', 'DLQ entry message ID');
  assertEqual(dlq[0].reason, 'ack_timeout', 'DLQ reason');
});

// --- Dead Letter Queue ---

console.log('\nDead Letter Queue:');

test('moveToDlq creates DLQ file', () => {
  const m = freshModule();
  m.moveToDlq('M-failed', 'delivery_error', { detail: 'test' });

  const dlq = m.getDLQMessages();
  assertEqual(dlq.length, 1, 'DLQ should have 1 entry');
  assertEqual(dlq[0].reason, 'delivery_error', 'DLQ reason');
  assert(dlq[0].moved_at, 'DLQ entry should have moved_at');
});

test('clearDLQ empties the queue', () => {
  const m = freshModule();
  m.moveToDlq('M-1', 'error1', {});
  m.moveToDlq('M-2', 'error2', {});

  const count = m.clearDLQ();
  assertEqual(count, 2, 'should clear 2 entries');
  assertEqual(m.getDLQMessages().length, 0, 'DLQ should be empty');
});

// --- Cursor Recovery ---

console.log('\nCursor Recovery:');

test('loadCursor recovers from corrupt cursor file', () => {
  const m = freshModule();
  // Write corrupt cursor
  const cursorPath = path.join(process.cwd(), '.claude/pilot/messages/cursors/S-corrupt.cursor.json');
  fs.writeFileSync(cursorPath, 'NOT JSON{{{');

  const cursor = m.loadCursor('S-corrupt');
  assert(cursor !== null, 'should recover, not return null');
  assert(cursor._recovered === true, 'should be marked as recovered');
  assert(typeof cursor.byte_offset === 'number', 'should have valid byte_offset');
});

test('loadCursor handles byte_offset past bus end', () => {
  const m = freshModule();
  // Create a small bus
  m.sendMessage({ type: 'notify', from: 'S-a', to: '*', priority: 'fyi', payload: {} });

  const busSize = fs.statSync('.claude/pilot/messages/bus.jsonl').size;

  // Write cursor pointing past end
  m.writeCursor('S-past', {
    session_id: 'S-past',
    last_seq: -1,
    byte_offset: busSize + 10000,
    processed_ids: []
  });

  const cursor = m.loadCursor('S-past');
  assert(cursor.byte_offset <= busSize, `byte_offset ${cursor.byte_offset} should be <= bus size ${busSize}`);
});

test('loadCursor handles invalid structure', () => {
  const m = freshModule();
  const cursorPath = path.join(process.cwd(), '.claude/pilot/messages/cursors/S-bad.cursor.json');
  fs.writeFileSync(cursorPath, JSON.stringify({ byte_offset: -5, processed_ids: 'not_array' }));

  const cursor = m.loadCursor('S-bad');
  assert(cursor._recovered === true, 'should recover from invalid structure');
});

// --- Auto-Compaction ---

console.log('\nAuto-Compaction:');

test('compaction threshold lowered to 100KB', () => {
  const m = freshModule();
  assertEqual(m.MSG_SIZE_LIMIT, 4000, 'MSG_SIZE_LIMIT unchanged');
  // The COMPACTION_THRESHOLD is not exported directly but we can test needsCompaction
  // Create a bus > 100KB
  const busPath = '.claude/pilot/messages/bus.jsonl';
  const bigLine = JSON.stringify({ id: 'M-big', ts: new Date().toISOString(), type: 'notify', from: 'S-a', priority: 'fyi', payload: { data: 'x'.repeat(500) } }) + '\n';
  // 500 bytes per line, need ~200 lines for 100KB
  let content = '';
  for (let i = 0; i < 220; i++) content += bigLine;
  fs.writeFileSync(busPath, content);

  assert(m.needsCompaction(), 'bus > 100KB should need compaction');
});

test('compactBus archives old messages', () => {
  const m = freshModule();
  const busPath = '.claude/pilot/messages/bus.jsonl';

  // Write some messages
  for (let i = 0; i < 10; i++) {
    m.sendMessage({ type: 'notify', from: 'S-a', to: '*', priority: 'fyi', payload: { i } });
  }

  // Create a cursor partway through
  const cursor = m.initializeCursor('S-reader');
  // Read all messages to advance cursor
  m.writeCursor('S-reader', { ...cursor, byte_offset: 0 });
  const { messages, cursor: newCursor } = m.readMessages('S-reader');
  m.acknowledgeMessages('S-reader', newCursor, messages.map(msg => msg.id));

  // Now compact
  const result = m.compactBus();
  assert(result.success, 'compaction should succeed');

  // Check archive was created
  const archiveDir = '.claude/pilot/messages/archive';
  const archives = fs.readdirSync(archiveDir).filter(f => f.endsWith('.jsonl'));
  assert(archives.length > 0, 'archive file should be created');
});

// --- Priority Constants ---

console.log('\nPriority Constants:');

test('PRIORITY_ORDER is exported correctly', () => {
  const m = freshModule();
  assertEqual(m.PRIORITY_ORDER.blocking, 0, 'blocking = 0');
  assertEqual(m.PRIORITY_ORDER.normal, 1, 'normal = 1');
  assertEqual(m.PRIORITY_ORDER.fyi, 2, 'fyi = 2');
});

// --- Integration ---

console.log('\nIntegration:');

test('full ACK flow: request → ack → cleared', () => {
  const m = freshModule();

  // PM sends request
  const req = m.sendRequest('S-pm', 'S-worker', 'task.assign', { bd_id: 'AGI-99' });
  assert(req.success, 'request sent');

  // Verify pending
  let pending = m.loadPendingAcks();
  assertEqual(pending.length, 1, 'should have pending ACK');

  // Worker reads message
  const cursor = m.initializeCursor('S-worker');
  m.writeCursor('S-worker', { ...cursor, byte_offset: 0 });
  const { messages } = m.readMessages('S-worker');
  const request = messages.find(msg => msg.type === 'request');
  assert(request, 'worker should receive request');

  // Worker sends ACK
  m.sendAck('S-worker', request.id, 'S-pm');

  // Pending should be cleared
  pending = m.loadPendingAcks();
  assertEqual(pending.length, 0, 'ACK should clear pending');
});

test('full DLQ flow: request → timeout → DLQ', () => {
  const m = freshModule();

  // Write an already-expired pending ACK
  const acksPath = path.join(process.cwd(), '.claude/pilot/messages/pending_acks.jsonl');
  const entry = {
    message_id: 'M-timeout-test',
    from: 'S-pm',
    to: 'S-worker',
    deadline_at: new Date(Date.now() - 1000).toISOString(),
    retries: 3,
    created_at: new Date(Date.now() - 120000).toISOString()
  };
  fs.writeFileSync(acksPath, JSON.stringify(entry) + '\n');

  // Process timeouts
  const result = m.processAckTimeouts();
  assertEqual(result.dlqd, 1, 'should DLQ the message');

  // Verify in DLQ
  const dlq = m.getDLQMessages();
  assertEqual(dlq.length, 1, 'DLQ should have entry');
  assertEqual(dlq[0].message_id, 'M-timeout-test', 'DLQ message ID');

  // Clear DLQ
  m.clearDLQ();
  assertEqual(m.getDLQMessages().length, 0, 'DLQ should be empty after clear');
});

// ============================================================================
// SUMMARY
// ============================================================================

teardown();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failures.length > 0) {
  console.log('Failures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}: ${f.error}`);
  }
  process.exit(1);
}
