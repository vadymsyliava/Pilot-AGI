/**
 * Tests for Telegram Bridge — Phase 6.5 (Pilot AGI-6l3)
 *
 * Tests:
 * - Message splitting for >4096 chars
 * - Markdown escaping
 * - PM inbox/outbox read/write
 * - Inbound message handling (auth, rate limit, intent routing)
 * - Outbound delivery (text, escalation, task_complete, error)
 * - Callback query handling (confirm, cancel, approve, reject)
 * - Lockdown state management
 * - Help command local handling
 *
 * All Telegram API calls are mocked (no actual network).
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/telegram-bridge.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================================
// TEST INFRASTRUCTURE
// ============================================================================

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

// ============================================================================
// MOCK SETUP
// ============================================================================

let mockApiCalls = [];
let mockApiResponses = {};

function resetMocks() {
  mockApiCalls = [];
  mockApiResponses = {};
}

/**
 * Clear require cache for fresh module load with mocked dependencies.
 */
function freshModule(tmpDir) {
  // Clear caches
  Object.keys(require.cache).forEach(key => {
    if (key.includes('telegram-bridge') || key.includes('telegram-security')) {
      delete require.cache[key];
    }
  });

  // Mock the https module by patching telegramApi at the module level
  const bridge = require('../telegram-bridge');

  return bridge;
}

// ============================================================================
// STATIC FUNCTION TESTS
// ============================================================================

async function staticFunctionTests() {
  console.log('\n--- Static Functions ---');

  // Clear cache for fresh load
  Object.keys(require.cache).forEach(key => {
    if (key.includes('telegram-bridge')) delete require.cache[key];
  });
  const { splitMessage, escapeMarkdown } = require('../telegram-bridge');

  await test('splitMessage: short message returns single chunk', () => {
    const result = splitMessage('Hello');
    assert.deepStrictEqual(result, ['Hello']);
  });

  await test('splitMessage: exactly 4096 chars returns single chunk', () => {
    const msg = 'x'.repeat(4096);
    const result = splitMessage(msg);
    assert.strictEqual(result.length, 1);
  });

  await test('splitMessage: 4097 chars splits into 2 chunks', () => {
    const msg = 'x'.repeat(4097);
    const result = splitMessage(msg);
    assert.strictEqual(result.length, 2);
    assert.ok(result[0].length <= 4096, 'First chunk within limit');
    assert.ok(result[1].length <= 4096, 'Second chunk within limit');
  });

  await test('splitMessage: splits at newline when possible', () => {
    const line = 'A'.repeat(2000);
    const msg = `${line}\n${line}\n${line}`;
    const result = splitMessage(msg);
    assert.ok(result.length >= 2, 'Should split into multiple chunks');
    // First chunk should end at a newline boundary
    assert.ok(!result[0].endsWith('\n'), 'Chunk should not end with extra newline');
  });

  await test('splitMessage: handles very long line without newlines', () => {
    const msg = 'x'.repeat(10000);
    const result = splitMessage(msg);
    assert.ok(result.length >= 3, 'Should split into 3+ chunks');
    for (const chunk of result) {
      assert.ok(chunk.length <= 4096, `Chunk length ${chunk.length} exceeds limit`);
    }
  });

  await test('escapeMarkdown: escapes underscores', () => {
    assert.strictEqual(escapeMarkdown('hello_world'), 'hello\\_world');
  });

  await test('escapeMarkdown: escapes asterisks', () => {
    assert.strictEqual(escapeMarkdown('*bold*'), '\\*bold\\*');
  });

  await test('escapeMarkdown: escapes brackets', () => {
    assert.strictEqual(escapeMarkdown('[link]'), '\\[link]');
  });

  await test('escapeMarkdown: escapes backticks', () => {
    assert.strictEqual(escapeMarkdown('`code`'), '\\`code\\`');
  });

  await test('escapeMarkdown: leaves plain text unchanged', () => {
    assert.strictEqual(escapeMarkdown('hello world'), 'hello world');
  });
}

// ============================================================================
// INBOX/OUTBOX TESTS
// ============================================================================

async function inboxOutboxTests() {
  console.log('\n--- PM Inbox/Outbox ---');

  Object.keys(require.cache).forEach(key => {
    if (key.includes('telegram-bridge')) delete require.cache[key];
  });
  const { writeToOutbox, readInbox, PM_INBOX_PATH, PM_OUTBOX_PATH } = require('../telegram-bridge');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-bridge-io-'));

  await test('writeToOutbox: creates directory and file', () => {
    writeToOutbox(tmpDir, { type: 'text', text: 'Hello' });
    const outboxPath = path.join(tmpDir, PM_OUTBOX_PATH);
    assert.ok(fs.existsSync(outboxPath), 'Outbox file should exist');
  });

  await test('writeToOutbox: appends JSONL entries with timestamp', () => {
    writeToOutbox(tmpDir, { type: 'text', text: 'Message 2' });
    const outboxPath = path.join(tmpDir, PM_OUTBOX_PATH);
    const lines = fs.readFileSync(outboxPath, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 2);
    const entry = JSON.parse(lines[1]);
    assert.strictEqual(entry.type, 'text');
    assert.ok(entry.timestamp, 'Should have timestamp');
  });

  await test('readInbox: returns empty for missing file', () => {
    const result = readInbox(tmpDir);
    assert.deepStrictEqual(result.messages, []);
    assert.strictEqual(result.newCursor, 0);
  });

  await test('readInbox: reads messages from cursor', () => {
    const inboxPath = path.join(tmpDir, PM_INBOX_PATH);
    const dir = path.dirname(inboxPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(inboxPath, [
      JSON.stringify({ action: 'status', chatId: 1 }),
      JSON.stringify({ action: 'logs', chatId: 2, taskId: 'x' }),
      JSON.stringify({ action: 'budget', chatId: 1 }),
    ].join('\n') + '\n');

    const all = readInbox(tmpDir, 0);
    assert.strictEqual(all.messages.length, 3);
    assert.strictEqual(all.newCursor, 3);
  });

  await test('readInbox: cursor skips already-read messages', () => {
    const result = readInbox(tmpDir, 2);
    assert.strictEqual(result.messages.length, 1);
    assert.strictEqual(result.messages[0].action, 'budget');
    assert.strictEqual(result.newCursor, 3);
  });

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
}

// ============================================================================
// BRIDGE CLASS TESTS (with mocked Telegram API)
// ============================================================================

async function bridgeClassTests() {
  console.log('\n--- TelegramBridge Class ---');

  Object.keys(require.cache).forEach(key => {
    if (key.includes('telegram-bridge') || key.includes('telegram-security')) {
      delete require.cache[key];
    }
  });
  const { TelegramBridge, PM_INBOX_PATH } = require('../telegram-bridge');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-bridge-class-'));

  function createBridge(opts = {}) {
    return new TelegramBridge({
      token: 'test-token-123',
      allowedChatIds: [12345],
      projectRoot: tmpDir,
      rateLimit: { per_minute: 50, per_hour: 200 },
      ...opts,
    });
  }

  // -- Inbound message handling --

  await test('_handleMessage: rejects unauthorized sender silently', async () => {
    const bridge = createBridge();
    const sentMessages = [];

    // Override _sendText to capture
    bridge._sendText = async (chatId, text) => {
      sentMessages.push({ chatId, text });
      return { message_id: 1 };
    };

    await bridge._handleMessage({
      chat: { id: 99999 }, // Not in allowlist
      from: { username: 'hacker' },
      text: '/status',
    });

    assert.strictEqual(sentMessages.length, 0, 'Should not send any response');

    // Check audit log
    const auditPath = path.join(tmpDir, '.claude/pilot/state/telegram/audit.jsonl');
    const auditContent = fs.readFileSync(auditPath, 'utf8');
    assert.ok(auditContent.includes('BLOCKED'), 'Should log BLOCKED event');
  });

  await test('_handleMessage: rate limits when exceeded', async () => {
    const bridge = createBridge({ rateLimit: { per_minute: 1, per_hour: 100 } });
    const sentMessages = [];
    bridge._sendText = async (chatId, text) => {
      sentMessages.push({ chatId, text });
      return { message_id: 1 };
    };

    const msg = { chat: { id: 12345 }, from: { username: 'user' }, text: '/status' };

    // First message ok (consumes token)
    await bridge._handleMessage(msg);
    // Second message should be rate limited
    await bridge._handleMessage(msg);

    const rateMsg = sentMessages.find(m => m.text.includes('Rate limit'));
    assert.ok(rateMsg, 'Should send rate limit message');
  });

  await test('_handleMessage: routes /status to PM inbox', async () => {
    // Fresh bridge with new rate limit bucket
    const bridge = createBridge();
    bridge._sendText = async () => ({ message_id: 1 });

    await bridge._handleMessage({
      chat: { id: 12345 },
      from: { username: 'owner' },
      text: '/status',
    });

    const inboxPath = path.join(tmpDir, PM_INBOX_PATH);
    const content = fs.readFileSync(inboxPath, 'utf8');
    const messages = content.trim().split('\n').map(l => JSON.parse(l));
    const statusMsg = messages.find(m => m.action === 'status');
    assert.ok(statusMsg, 'Should write status intent to inbox');
  });

  await test('_handleMessage: sends help locally (no PM inbox)', async () => {
    const bridge = createBridge();
    const sentMessages = [];
    bridge._sendText = async (chatId, text, opts) => {
      sentMessages.push({ chatId, text, opts });
      return { message_id: 1 };
    };

    // Clear inbox before
    const inboxPath = path.join(tmpDir, PM_INBOX_PATH);
    const beforeCount = fs.existsSync(inboxPath)
      ? fs.readFileSync(inboxPath, 'utf8').trim().split('\n').length
      : 0;

    await bridge._handleMessage({
      chat: { id: 12345 },
      from: { username: 'owner' },
      text: '/help',
    });

    const helpMsg = sentMessages.find(m => m.text.includes('Pilot AGI Telegram Bot'));
    assert.ok(helpMsg, 'Should send help text');

    // Help should NOT write to inbox
    const afterCount = fs.existsSync(inboxPath)
      ? fs.readFileSync(inboxPath, 'utf8').trim().split('\n').length
      : 0;
    assert.strictEqual(afterCount, beforeCount, 'Help should not write to inbox');
  });

  await test('_handleMessage: LOCKDOWN activates lockdown state', async () => {
    const bridge = createBridge();
    bridge._sendText = async () => ({ message_id: 1 });

    assert.strictEqual(bridge.isLockedDown, false);

    await bridge._handleMessage({
      chat: { id: 12345 },
      from: { username: 'owner' },
      text: 'LOCKDOWN',
    });

    assert.strictEqual(bridge.isLockedDown, true);
  });

  await test('_handleMessage: rejects messages during lockdown', async () => {
    const bridge = createBridge();
    const sentMessages = [];
    bridge._sendText = async (chatId, text) => {
      sentMessages.push({ chatId, text });
      return { message_id: 1 };
    };

    // Activate lockdown
    bridge._lockdown = true;

    await bridge._handleMessage({
      chat: { id: 12345 },
      from: { username: 'owner' },
      text: '/status',
    });

    const lockdownMsg = sentMessages.find(m => m.text.includes('LOCKDOWN'));
    assert.ok(lockdownMsg, 'Should inform user of lockdown');
  });

  await test('resetLockdown: resets lockdown state', () => {
    const bridge = createBridge();
    bridge._lockdown = true;
    bridge.resetLockdown();
    assert.strictEqual(bridge.isLockedDown, false);
  });

  await test('_handleMessage: dangerous action requests confirmation', async () => {
    const bridge = createBridge();
    const sentMessages = [];
    bridge._sendText = async (chatId, text, opts) => {
      sentMessages.push({ chatId, text, opts });
      return { message_id: 1 };
    };

    await bridge._handleMessage({
      chat: { id: 12345 },
      from: { username: 'owner' },
      text: 'pause all agents',
    });

    const confirmMsg = sentMessages.find(m => m.text.includes('Are you sure'));
    assert.ok(confirmMsg, 'Should ask for confirmation');
    assert.ok(confirmMsg.opts.reply_markup, 'Should include inline keyboard');
  });

  await test('_handleMessage: unknown message sends help hint', async () => {
    const bridge = createBridge();
    const sentMessages = [];
    bridge._sendText = async (chatId, text) => {
      sentMessages.push({ chatId, text });
      return { message_id: 1 };
    };

    await bridge._handleMessage({
      chat: { id: 12345 },
      from: { username: 'owner' },
      text: 'some random gibberish',
    });

    const unknownMsg = sentMessages.find(m => m.text.includes("didn't understand"));
    assert.ok(unknownMsg, 'Should send "didn\'t understand" response');
  });

  // -- Callback query handling --

  await test('_handleCallbackQuery: confirm triggers inbox write', async () => {
    const bridge = createBridge();
    bridge._editMessage = async () => {};
    bridge._answerCallback = async () => {};

    // Set up a pending confirmation
    const confirmId = 'confirm_1000';
    bridge._pendingApprovals.set(confirmId, {
      chatId: 12345,
      intent: { action: 'pause_all', scope: 'all' },
      expiresAt: Date.now() + 120000,
    });

    const inboxPath = path.join(tmpDir, PM_INBOX_PATH);
    const beforeLines = fs.existsSync(inboxPath)
      ? fs.readFileSync(inboxPath, 'utf8').trim().split('\n').length
      : 0;

    await bridge._handleCallbackQuery({
      id: 'callback-1',
      message: { chat: { id: 12345 }, message_id: 42 },
      data: `confirm:${confirmId}`,
    });

    const afterLines = fs.readFileSync(inboxPath, 'utf8').trim().split('\n').length;
    assert.ok(afterLines > beforeLines, 'Should write confirmed intent to inbox');
    assert.strictEqual(bridge._pendingApprovals.has(confirmId), false, 'Should remove pending approval');
  });

  await test('_handleCallbackQuery: cancel removes pending approval', async () => {
    const bridge = createBridge();
    bridge._editMessage = async () => {};
    bridge._answerCallback = async () => {};

    const confirmId = 'confirm_2000';
    bridge._pendingApprovals.set(confirmId, {
      chatId: 12345,
      intent: { action: 'kill_agent', taskId: 'x' },
      expiresAt: Date.now() + 120000,
    });

    await bridge._handleCallbackQuery({
      id: 'callback-2',
      message: { chat: { id: 12345 }, message_id: 43 },
      data: `cancel:${confirmId}`,
    });

    assert.strictEqual(bridge._pendingApprovals.has(confirmId), false);
  });

  await test('_handleCallbackQuery: expired confirmation rejected', async () => {
    const bridge = createBridge();
    let answerText = null;
    bridge._answerCallback = async (id, text) => { answerText = text; };

    const confirmId = 'confirm_3000';
    bridge._pendingApprovals.set(confirmId, {
      chatId: 12345,
      intent: { action: 'reset' },
      expiresAt: Date.now() - 1000, // Already expired
    });

    await bridge._handleCallbackQuery({
      id: 'callback-3',
      message: { chat: { id: 12345 }, message_id: 44 },
      data: `confirm:${confirmId}`,
    });

    assert.ok(answerText && answerText.includes('Expired'), 'Should indicate expired');
  });

  await test('_handleCallbackQuery: approve escalation writes to inbox', async () => {
    const bridge = createBridge();
    bridge._editMessage = async () => {};
    bridge._answerCallback = async () => {};

    const approvalId = 'esc_5000';
    bridge._pendingApprovals.set(approvalId, {
      taskId: 'task-abc',
      type: 'drift',
      summary: 'Agent drifting',
      chatId: 12345,
      expiresAt: Date.now() + 3600000,
    });

    await bridge._handleCallbackQuery({
      id: 'callback-5',
      message: { chat: { id: 12345 }, message_id: 45 },
      data: `approve:${approvalId}`,
    });

    const inboxPath = path.join(tmpDir, PM_INBOX_PATH);
    const content = fs.readFileSync(inboxPath, 'utf8');
    const messages = content.trim().split('\n').map(l => JSON.parse(l));
    const approveMsg = messages.find(m => m.action === 'approve_escalation');
    assert.ok(approveMsg, 'Should write approve_escalation to inbox');
    assert.strictEqual(approveMsg.taskId, 'task-abc');
  });

  await test('_handleCallbackQuery: reject escalation writes to inbox', async () => {
    const bridge = createBridge();
    bridge._editMessage = async () => {};
    bridge._answerCallback = async () => {};

    const approvalId = 'esc_6000';
    bridge._pendingApprovals.set(approvalId, {
      taskId: 'task-def',
      type: 'budget_exceeded',
      summary: 'Over budget',
      chatId: 12345,
      expiresAt: Date.now() + 3600000,
    });

    await bridge._handleCallbackQuery({
      id: 'callback-6',
      message: { chat: { id: 12345 }, message_id: 46 },
      data: `reject:${approvalId}`,
    });

    const inboxPath = path.join(tmpDir, PM_INBOX_PATH);
    const content = fs.readFileSync(inboxPath, 'utf8');
    const messages = content.trim().split('\n').map(l => JSON.parse(l));
    const rejectMsg = messages.find(m => m.action === 'reject_escalation');
    assert.ok(rejectMsg, 'Should write reject_escalation to inbox');
    assert.strictEqual(rejectMsg.taskId, 'task-def');
  });

  await test('_handleCallbackQuery: unauthorized callback ignored', async () => {
    const bridge = createBridge();
    let callbackAnswered = false;
    bridge._answerCallback = async () => { callbackAnswered = true; };

    await bridge._handleCallbackQuery({
      id: 'callback-7',
      message: { chat: { id: 99999 }, message_id: 47 },
      data: 'confirm:xyz',
    });

    assert.strictEqual(callbackAnswered, false, 'Should not answer unauthorized callback');
  });

  // -- Outbound delivery --

  await test('_deliverOutbound: text message calls _sendText', async () => {
    const bridge = createBridge();
    let sentText = null;
    bridge._sendText = async (chatId, text) => { sentText = text; };

    await bridge._deliverOutbound({
      chatId: 12345,
      type: 'text',
      text: 'Hello from PM',
    });

    assert.strictEqual(sentText, 'Hello from PM');
  });

  await test('_deliverOutbound: task_complete formats correctly', async () => {
    const bridge = createBridge();
    let sentText = null;
    bridge._sendText = async (chatId, text) => { sentText = text; };

    await bridge._deliverOutbound({
      chatId: 12345,
      type: 'task_complete',
      data: { taskId: 'task-xyz', summary: 'Auth module done' },
    });

    assert.ok(sentText.includes('Task Complete'), 'Should include header');
    assert.ok(sentText.includes('task-xyz'), 'Should include task ID');
    assert.ok(sentText.includes('Auth module done'), 'Should include summary');
  });

  await test('_deliverOutbound: error truncates long error text', async () => {
    const bridge = createBridge();
    let sentText = null;
    bridge._sendText = async (chatId, text) => { sentText = text; };

    await bridge._deliverOutbound({
      chatId: 12345,
      type: 'error',
      data: { taskId: 'task-err', error: 'x'.repeat(5000) },
    });

    assert.ok(sentText.length < 4096, 'Should truncate to fit Telegram limit');
  });

  await test('_deliverOutbound: escalation creates approval buttons', async () => {
    const bridge = createBridge();
    let sentOpts = null;
    bridge._sendText = async (chatId, text, opts) => {
      sentOpts = opts;
      return { message_id: 100 };
    };

    await bridge._deliverOutbound({
      chatId: 12345,
      type: 'escalation',
      data: { taskId: 'task-esc', type: 'drift', level: 2, details: 'Agent drifting' },
    });

    assert.ok(sentOpts, 'Should pass options');
    assert.ok(sentOpts.reply_markup, 'Should include reply markup');
    const markup = typeof sentOpts.reply_markup === 'string'
      ? JSON.parse(sentOpts.reply_markup) : sentOpts.reply_markup;
    assert.ok(markup.inline_keyboard, 'Should have inline keyboard');
    assert.strictEqual(markup.inline_keyboard[0].length, 2, 'Should have 2 buttons');
  });

  await test('_deliverOutbound: uses first allowedChatId as default', async () => {
    const bridge = createBridge({ allowedChatIds: [11111, 22222] });
    let targetChatId = null;
    bridge._sendText = async (chatId, text) => { targetChatId = chatId; };

    await bridge._deliverOutbound({
      type: 'text',
      text: 'No explicit chatId',
      // chatId omitted
    });

    assert.strictEqual(targetChatId, 11111, 'Should default to first allowed chat ID');
  });

  // -- _onIntent hook for testing --

  await test('_onIntent hook fires on successful intent', async () => {
    const bridge = createBridge();
    bridge._sendText = async () => ({ message_id: 1 });

    let hookCalled = false;
    let hookIntent = null;
    bridge._onIntent = (chatId, intent) => {
      hookCalled = true;
      hookIntent = intent;
    };

    await bridge._handleMessage({
      chat: { id: 12345 },
      from: { username: 'owner' },
      text: '/budget',
    });

    assert.strictEqual(hookCalled, true, 'Hook should be called');
    assert.strictEqual(hookIntent.action, 'budget');
  });

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
}

// ============================================================================
// RUN ALL
// ============================================================================

async function main() {
  console.log('Telegram Bridge Tests (Phase 6.5)\n');

  await staticFunctionTests();
  await inboxOutboxTests();
  await bridgeClassTests();

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(50)}`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const { name, error } of failures) {
      console.log(`  ✗ ${name}`);
      console.log(`    ${error.stack || error.message}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
