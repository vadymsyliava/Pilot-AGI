/**
 * Tests for Telegram Conversations — PM-Side Processor (Phase 6.6)
 *
 * Covers:
 * - Intent dispatch for all supported actions
 * - Status, PS, budget, morning report generation
 * - Approve/reject escalation flow
 * - Idea capture → bd task creation
 * - Pause/resume/kill agent commands
 * - Approval timeout tracking and auto-escalation
 * - Conversation history management
 * - PM loop integration via _telegramScan
 *
 * Part of Phase 6.6 (Pilot AGI-pl7)
 */

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================================
// TEST HELPERS
// ============================================================================

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-conv-'));
}

function freshModule(modPath) {
  const resolved = require.resolve(modPath);
  delete require.cache[resolved];
  return require(modPath);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Mock inbox/outbox helpers
function createMockInbox(messages) {
  let cursor = 0;
  return (projectRoot, fromCursor) => {
    const unread = messages.slice(fromCursor);
    return { messages: unread, newCursor: messages.length };
  };
}

function createOutboxCollector() {
  const sent = [];
  return {
    sent,
    fn: (projectRoot, msg) => { sent.push(msg); },
  };
}

// ============================================================================
// TESTS: TelegramConversations Core
// ============================================================================

describe('TelegramConversations', () => {
  let dir;
  let TelegramConversations;

  beforeEach(() => {
    dir = tmpDir();
    ensureDir(path.join(dir, '.claude/pilot/state/telegram'));

    // Clear require cache
    for (const key of Object.keys(require.cache)) {
      if (key.includes('telegram-conversations') || key.includes('telegram-bridge') ||
          key.includes('session') || key.includes('messaging') || key.includes('escalation') ||
          key.includes('cost-tracker') || key.includes('/policy')) {
        delete require.cache[key];
      }
    }

    ({ TelegramConversations } = require('../telegram-conversations'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Construction & State
  // --------------------------------------------------------------------------

  test('constructs with defaults', () => {
    const conv = new TelegramConversations(dir);
    assert.equal(conv.projectRoot, dir);
    assert.equal(conv._inboxCursor, 0);
    assert.equal(conv._pendingApprovals.size, 0);
    assert.equal(conv._conversations.size, 0);
  });

  test('loads persisted inbox cursor', () => {
    const cursorPath = path.join(dir, '.claude/pilot/state/telegram/inbox-cursor.json');
    ensureDir(path.dirname(cursorPath));
    fs.writeFileSync(cursorPath, JSON.stringify({ cursor: 42 }));

    const conv = new TelegramConversations(dir);
    assert.equal(conv._inboxCursor, 42);
  });

  test('loads persisted pending approvals', () => {
    const approvalPath = path.join(dir, '.claude/pilot/state/telegram/pending-approvals.json');
    ensureDir(path.dirname(approvalPath));
    fs.writeFileSync(approvalPath, JSON.stringify({
      esc_123: { taskId: 'Pilot AGI-abc', type: 'merge_conflict', expiresAt: Date.now() + 60000 }
    }));

    const conv = new TelegramConversations(dir);
    assert.equal(conv._pendingApprovals.size, 1);
    assert.equal(conv._pendingApprovals.get('esc_123').taskId, 'Pilot AGI-abc');
  });

  test('loads persisted conversation history', () => {
    const historyPath = path.join(dir, '.claude/pilot/state/telegram/conversations.json');
    ensureDir(path.dirname(historyPath));
    fs.writeFileSync(historyPath, JSON.stringify({
      '12345': [{ role: 'user', text: 'status?', ts: Date.now() }]
    }));

    const conv = new TelegramConversations(dir);
    assert.equal(conv._conversations.size, 1);
    assert.equal(conv.getConversationHistory(12345).length, 1);
  });

  // --------------------------------------------------------------------------
  // Conversation History
  // --------------------------------------------------------------------------

  test('records conversation turns', () => {
    const conv = new TelegramConversations(dir);
    conv._recordTurn(123, 'user', 'what is the status?');
    conv._recordTurn(123, 'bot', 'System is running...');

    const history = conv.getConversationHistory(123);
    assert.equal(history.length, 2);
    assert.equal(history[0].role, 'user');
    assert.equal(history[1].role, 'bot');
  });

  test('trims conversation history to MAX_HISTORY_TURNS', () => {
    const { MAX_HISTORY_TURNS } = require('../telegram-conversations');
    const conv = new TelegramConversations(dir);

    for (let i = 0; i < MAX_HISTORY_TURNS + 5; i++) {
      conv._recordTurn(123, 'user', `message ${i}`);
    }

    assert.equal(conv.getConversationHistory(123).length, MAX_HISTORY_TURNS);
  });

  test('truncates long messages in history', () => {
    const conv = new TelegramConversations(dir);
    const longText = 'x'.repeat(1000);
    conv._recordTurn(123, 'user', longText);

    const history = conv.getConversationHistory(123);
    assert.equal(history[0].text.length, 500);
  });

  // --------------------------------------------------------------------------
  // Intent Dispatch — Status
  // --------------------------------------------------------------------------

  test('handles status intent', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([{ action: 'status', chatId: 123 }]);

    // Mock session module
    const sessionMod = require('../session');
    const origGetActive = sessionMod.getActiveSessions;
    sessionMod.getActiveSessions = () => [
      { session_id: 'S-agent-1', claimed_task: 'Pilot AGI-abc' }
    ];

    try {
      const conv = new TelegramConversations(dir, {
        readInbox: inbox.fn || inbox,
        writeToOutbox: outbox.fn,
        pmSessionId: 'S-pm-1'
      });
      const results = conv.processPendingMessages();

      assert.ok(results.length >= 1);
      assert.ok(outbox.sent.length >= 1);
      assert.ok(outbox.sent[0].text.includes('Pilot AGI Status') || outbox.sent[0].text.includes('Status'));
    } finally {
      sessionMod.getActiveSessions = origGetActive;
    }
  });

  // --------------------------------------------------------------------------
  // Intent Dispatch — PS
  // --------------------------------------------------------------------------

  test('handles ps intent with no agents', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([{ action: 'ps', chatId: 123 }]);

    const sessionMod = require('../session');
    const origGetActive = sessionMod.getActiveSessions;
    sessionMod.getActiveSessions = () => [];

    try {
      const conv = new TelegramConversations(dir, {
        readInbox: inbox,
        writeToOutbox: outbox.fn,
        pmSessionId: 'S-pm-1'
      });
      conv.processPendingMessages();

      assert.ok(outbox.sent[0].text.includes('No active agents'));
    } finally {
      sessionMod.getActiveSessions = origGetActive;
    }
  });

  // --------------------------------------------------------------------------
  // Intent Dispatch — Approve/Reject
  // --------------------------------------------------------------------------

  test('handles approve with no pending approvals', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([{ action: 'approve', chatId: 123 }]);

    const conv = new TelegramConversations(dir, {
      readInbox: inbox,
      writeToOutbox: outbox.fn,
    });
    conv.processPendingMessages();

    assert.ok(outbox.sent[0].text.includes('No pending approvals'));
  });

  test('handles approve with pending approval', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([{ action: 'approve', chatId: 123 }]);

    const conv = new TelegramConversations(dir, {
      readInbox: inbox,
      writeToOutbox: outbox.fn,
    });

    // Register an approval first
    conv.registerApproval('esc_1', {
      taskId: 'Pilot AGI-abc',
      type: 'merge_conflict',
      chatId: 123,
    });

    conv.processPendingMessages();

    assert.ok(outbox.sent[0].text.includes('Approved'));
    assert.equal(conv.pendingApprovalCount, 0);
  });

  test('handles reject for specific taskId', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([{ action: 'reject', chatId: 123, taskId: 'Pilot AGI-xyz' }]);

    const conv = new TelegramConversations(dir, {
      readInbox: inbox,
      writeToOutbox: outbox.fn,
    });

    conv.registerApproval('esc_2', {
      taskId: 'Pilot AGI-xyz',
      type: 'test_failure',
      chatId: 123,
    });

    conv.processPendingMessages();

    assert.ok(outbox.sent[0].text.includes('Rejected'));
    assert.equal(conv.pendingApprovalCount, 0);
  });

  test('handles approve_escalation callback', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([{
      action: 'approve_escalation',
      approvalId: 'esc_3',
      chatId: 123,
      taskId: 'Pilot AGI-abc',
    }]);

    const conv = new TelegramConversations(dir, {
      readInbox: inbox,
      writeToOutbox: outbox.fn,
    });

    conv.registerApproval('esc_3', {
      taskId: 'Pilot AGI-abc',
      type: 'drift',
      chatId: 123,
    });

    conv.processPendingMessages();

    assert.ok(outbox.sent[0].text.includes('Approved'));
  });

  test('handles reject_escalation with expired approval', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([{
      action: 'reject_escalation',
      approvalId: 'esc_nonexistent',
      chatId: 123,
    }]);

    const conv = new TelegramConversations(dir, {
      readInbox: inbox,
      writeToOutbox: outbox.fn,
    });

    conv.processPendingMessages();

    assert.ok(outbox.sent[0].text.includes('expired') || outbox.sent[0].text.includes('not found'));
  });

  // --------------------------------------------------------------------------
  // Intent Dispatch — Idea Capture
  // --------------------------------------------------------------------------

  test('handles idea with no text', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([{ action: 'idea', chatId: 123 }]);

    const conv = new TelegramConversations(dir, {
      readInbox: inbox,
      writeToOutbox: outbox.fn,
    });
    conv.processPendingMessages();

    assert.ok(outbox.sent[0].text.includes('Please provide'));
  });

  // --------------------------------------------------------------------------
  // Intent Dispatch — Pause/Resume
  // --------------------------------------------------------------------------

  test('handles pause intent', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([{ action: 'pause_all', chatId: 123, scope: 'all' }]);

    const messagingMod = require('../messaging');
    const origBroadcast = messagingMod.sendBroadcast;
    let broadcastCalled = false;
    messagingMod.sendBroadcast = () => { broadcastCalled = true; };

    try {
      const conv = new TelegramConversations(dir, {
        readInbox: inbox,
        writeToOutbox: outbox.fn,
        pmSessionId: 'S-pm-1',
      });
      conv.processPendingMessages();

      assert.ok(broadcastCalled);
      assert.ok(outbox.sent[0].text.includes('Pause'));
    } finally {
      messagingMod.sendBroadcast = origBroadcast;
    }
  });

  test('handles resume intent', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([{ action: 'resume', chatId: 123, scope: 'all' }]);

    const messagingMod = require('../messaging');
    const origBroadcast = messagingMod.sendBroadcast;
    let broadcastCalled = false;
    messagingMod.sendBroadcast = () => { broadcastCalled = true; };

    try {
      const conv = new TelegramConversations(dir, {
        readInbox: inbox,
        writeToOutbox: outbox.fn,
        pmSessionId: 'S-pm-1',
      });
      conv.processPendingMessages();

      assert.ok(broadcastCalled);
      assert.ok(outbox.sent[0].text.includes('Resume'));
    } finally {
      messagingMod.sendBroadcast = origBroadcast;
    }
  });

  // --------------------------------------------------------------------------
  // Intent Dispatch — Kill Agent
  // --------------------------------------------------------------------------

  test('handles kill_agent with no taskId', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([{ action: 'kill_agent', chatId: 123 }]);

    const conv = new TelegramConversations(dir, {
      readInbox: inbox,
      writeToOutbox: outbox.fn,
    });
    conv.processPendingMessages();

    assert.ok(outbox.sent[0].text.includes('Specify'));
  });

  test('handles kill_agent with no matching agent', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([{ action: 'kill_agent', chatId: 123, taskId: 'Pilot AGI-nope' }]);

    const sessionMod = require('../session');
    const origGetActive = sessionMod.getActiveSessions;
    sessionMod.getActiveSessions = () => [];

    try {
      const conv = new TelegramConversations(dir, {
        readInbox: inbox,
        writeToOutbox: outbox.fn,
      });
      conv.processPendingMessages();

      assert.ok(outbox.sent[0].text.includes('No agent found'));
    } finally {
      sessionMod.getActiveSessions = origGetActive;
    }
  });

  // --------------------------------------------------------------------------
  // Intent Dispatch — Logs
  // --------------------------------------------------------------------------

  test('handles logs with no taskId', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([{ action: 'logs', chatId: 123 }]);

    const conv = new TelegramConversations(dir, {
      readInbox: inbox,
      writeToOutbox: outbox.fn,
    });
    conv.processPendingMessages();

    assert.ok(outbox.sent[0].text.includes('Specify'));
  });

  test('handles logs with no log file', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([{ action: 'logs', chatId: 123, taskId: 'Pilot AGI-abc' }]);

    const conv = new TelegramConversations(dir, {
      readInbox: inbox,
      writeToOutbox: outbox.fn,
    });
    conv.processPendingMessages();

    assert.ok(outbox.sent[0].text.includes('No logs'));
  });

  test('handles logs with existing log file', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([{ action: 'logs', chatId: 123, taskId: 'Pilot AGI-abc' }]);

    // Create a log file
    const today = new Date().toISOString().slice(0, 10);
    const runsDir = path.join(dir, 'runs');
    ensureDir(runsDir);
    fs.writeFileSync(path.join(runsDir, `${today}.md`), `## Session\n### Task: Pilot AGI-abc\n- Started work on Pilot AGI-abc\n- Completed step 1 for Pilot AGI-abc\n`);

    const conv = new TelegramConversations(dir, {
      readInbox: inbox,
      writeToOutbox: outbox.fn,
    });
    conv.processPendingMessages();

    assert.ok(outbox.sent[0].text.includes('Pilot AGI-abc'));
  });

  // --------------------------------------------------------------------------
  // Intent Dispatch — Lockdown
  // --------------------------------------------------------------------------

  test('handles lockdown intent', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([{ action: 'lockdown', chatId: 123 }]);

    const messagingMod = require('../messaging');
    const origBroadcast = messagingMod.sendBroadcast;
    let broadcastAction = null;
    messagingMod.sendBroadcast = (from, action, data) => { broadcastAction = action; };

    try {
      const conv = new TelegramConversations(dir, {
        readInbox: inbox,
        writeToOutbox: outbox.fn,
        pmSessionId: 'S-pm-1',
      });
      conv.processPendingMessages();

      assert.equal(broadcastAction, 'lockdown');
      assert.ok(outbox.sent[0].text.includes('LOCKDOWN'));
    } finally {
      messagingMod.sendBroadcast = origBroadcast;
    }
  });

  // --------------------------------------------------------------------------
  // Intent Dispatch — Unknown
  // --------------------------------------------------------------------------

  test('handles unknown intent', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([{ action: 'unknown_action', chatId: 123 }]);

    const conv = new TelegramConversations(dir, {
      readInbox: inbox,
      writeToOutbox: outbox.fn,
    });
    conv.processPendingMessages();

    assert.ok(outbox.sent[0].text.includes('Unknown action'));
  });

  // --------------------------------------------------------------------------
  // Approval Timeout Tracking
  // --------------------------------------------------------------------------

  test('registerApproval creates pending entry with expiry', () => {
    const conv = new TelegramConversations(dir, {
      policy: { approval: { timeout_minutes: 30 } },
    });

    conv.registerApproval('esc_42', {
      taskId: 'Pilot AGI-abc',
      type: 'merge_conflict',
      chatId: 123,
    });

    assert.equal(conv.pendingApprovalCount, 1);
    const approvals = conv.getPendingApprovals();
    assert.equal(approvals[0].taskId, 'Pilot AGI-abc');
    assert.ok(approvals[0].expiresAt > Date.now());
    assert.equal(approvals[0].escalated, false);
  });

  test('approval timeout auto-escalates expired approvals', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([]); // No new messages

    const conv = new TelegramConversations(dir, {
      readInbox: inbox,
      writeToOutbox: outbox.fn,
      policy: { approval: { timeout_minutes: 0 } }, // Immediate timeout
    });

    // Register an approval that's already expired
    conv._pendingApprovals.set('esc_expired', {
      taskId: 'Pilot AGI-xyz',
      type: 'test_failure',
      chatId: 123,
      expiresAt: Date.now() - 1000, // Already expired
      escalated: false,
    });

    const results = conv.processPendingMessages();

    // Should have timeout result
    const timeoutResult = results.find(r => r.action === 'approval_timeout');
    assert.ok(timeoutResult, 'Should have timeout result');
    assert.equal(timeoutResult.taskId, 'Pilot AGI-xyz');

    // Should notify on Telegram
    assert.ok(outbox.sent.length >= 1);
    assert.ok(outbox.sent[0].text.includes('timeout') || outbox.sent[0].text.includes('Auto-escalated'));

    // Should mark as escalated (no double-escalation)
    assert.equal(conv._pendingApprovals.get('esc_expired').escalated, true);
  });

  test('escalated approvals are not re-escalated', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([]);

    const conv = new TelegramConversations(dir, {
      readInbox: inbox,
      writeToOutbox: outbox.fn,
    });

    conv._pendingApprovals.set('esc_done', {
      taskId: 'Pilot AGI-old',
      type: 'drift',
      chatId: 123,
      expiresAt: Date.now() - 1000,
      escalated: true, // Already escalated
    });

    const results = conv.processPendingMessages();
    const timeouts = results.filter(r => r.action === 'approval_timeout');
    assert.equal(timeouts.length, 0, 'Should not re-escalate');
  });

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  test('persists and reloads inbox cursor', () => {
    const inbox = createMockInbox([
      { action: 'ps', chatId: 123 },
      { action: 'ps', chatId: 123 },
    ]);

    const sessionMod = require('../session');
    const origGetActive = sessionMod.getActiveSessions;
    sessionMod.getActiveSessions = () => [];

    try {
      const conv1 = new TelegramConversations(dir, {
        readInbox: inbox,
        writeToOutbox: () => {},
        pmSessionId: 'S-pm-1',
      });
      conv1.processPendingMessages();

      // Create new instance — should resume from cursor
      const conv2 = new TelegramConversations(dir, {
        readInbox: inbox,
        writeToOutbox: () => {},
      });
      assert.equal(conv2._inboxCursor, 2);
    } finally {
      sessionMod.getActiveSessions = origGetActive;
    }
  });

  test('persists pending approvals to file', () => {
    const conv = new TelegramConversations(dir);
    conv.registerApproval('esc_100', {
      taskId: 'Pilot AGI-persist',
      type: 'budget_exceeded',
      chatId: 456,
    });

    const approvalPath = path.join(dir, '.claude/pilot/state/telegram/pending-approvals.json');
    assert.ok(fs.existsSync(approvalPath));

    const data = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
    assert.equal(data.esc_100.taskId, 'Pilot AGI-persist');
  });

  test('persists conversation history', () => {
    const outbox = createOutboxCollector();
    const inbox = createMockInbox([{ action: 'ps', chatId: 789 }]);

    const sessionMod = require('../session');
    const origGetActive = sessionMod.getActiveSessions;
    sessionMod.getActiveSessions = () => [];

    try {
      const conv = new TelegramConversations(dir, {
        readInbox: inbox,
        writeToOutbox: outbox.fn,
        pmSessionId: 'S-pm-1',
      });
      conv.processPendingMessages();

      const historyPath = path.join(dir, '.claude/pilot/state/telegram/conversations.json');
      assert.ok(fs.existsSync(historyPath));

      const data = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      assert.ok(data['789']);
      assert.ok(data['789'].length >= 2); // user turn + bot turn
    } finally {
      sessionMod.getActiveSessions = origGetActive;
    }
  });

  // --------------------------------------------------------------------------
  // Morning Report
  // --------------------------------------------------------------------------

  test('buildMorningReport returns formatted markdown', () => {
    const conv = new TelegramConversations(dir);
    const report = conv.buildMorningReport();

    assert.ok(report.includes('PILOT AGI'));
    assert.ok(report.includes('Morning Report'));
    assert.ok(report.includes('Tasks'));
  });

  test('morning report includes pending approvals', () => {
    const conv = new TelegramConversations(dir);
    conv._pendingApprovals.set('esc_rpt', {
      taskId: 'Pilot AGI-attn',
      type: 'merge_conflict',
      details: 'Conflict in types.ts',
      chatId: 123,
      expiresAt: Date.now() + 60000,
      escalated: false,
    });

    const report = conv.buildMorningReport();
    assert.ok(report.includes('Needs Attention'));
    assert.ok(report.includes('Pilot AGI-attn'));
  });

  // --------------------------------------------------------------------------
  // Empty Inbox Processing
  // --------------------------------------------------------------------------

  test('processes empty inbox without error', () => {
    const inbox = createMockInbox([]);
    const outbox = createOutboxCollector();

    const conv = new TelegramConversations(dir, {
      readInbox: inbox,
      writeToOutbox: outbox.fn,
    });

    const results = conv.processPendingMessages();
    assert.ok(Array.isArray(results));
  });

  // --------------------------------------------------------------------------
  // Error Handling
  // --------------------------------------------------------------------------

  test('handles handler errors gracefully', () => {
    // Create inbox with action that will throw
    const inbox = (projectRoot, cursor) => ({
      messages: [{ action: 'budget', chatId: 123 }],
      newCursor: 1,
    });

    const outbox = createOutboxCollector();

    const conv = new TelegramConversations(dir, {
      readInbox: inbox,
      writeToOutbox: outbox.fn,
    });

    // This should not throw even if cost-tracker isn't available
    const results = conv.processPendingMessages();
    assert.ok(Array.isArray(results));
  });

  // --------------------------------------------------------------------------
  // Multiple Messages in One Scan
  // --------------------------------------------------------------------------

  test('processes multiple messages in one scan', () => {
    const inbox = createMockInbox([
      { action: 'ps', chatId: 123 },
      { action: 'ps', chatId: 456 },
    ]);
    const outbox = createOutboxCollector();

    const sessionMod = require('../session');
    const origGetActive = sessionMod.getActiveSessions;
    sessionMod.getActiveSessions = () => [];

    try {
      const conv = new TelegramConversations(dir, {
        readInbox: inbox,
        writeToOutbox: outbox.fn,
        pmSessionId: 'S-pm-1',
      });

      const results = conv.processPendingMessages();
      assert.equal(results.length, 2);
      assert.equal(outbox.sent.length, 2);
    } finally {
      sessionMod.getActiveSessions = origGetActive;
    }
  });
});

// ============================================================================
// TESTS: PM Loop Integration
// ============================================================================

describe('PM Loop _telegramScan integration', () => {
  let dir;

  beforeEach(() => {
    dir = tmpDir();
    ensureDir(path.join(dir, '.claude/pilot/state/telegram'));
    ensureDir(path.join(dir, '.claude/pilot/state/orchestrator'));

    // Clear caches
    for (const key of Object.keys(require.cache)) {
      if (key.includes('pm-loop') || key.includes('telegram-conversations') ||
          key.includes('/policy') || key.includes('telegram-bridge')) {
        delete require.cache[key];
      }
    }
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('_telegramScan returns empty when telegram disabled', () => {
    const { PmLoop } = require('../pm-loop');
    const loop = new PmLoop(dir, { pmSessionId: 'S-pm-test' });
    loop.running = true;
    loop.pmSessionId = 'S-pm-test';

    // Mock policy-loader to return telegram disabled
    const policyMod = require('../policy');
    const origLoad = policyMod.loadPolicy;
    policyMod.loadPolicy =() => ({ telegram: { enabled: false } });

    try {
      const results = loop._telegramScan();
      assert.deepEqual(results, []);
      assert.equal(loop._telegramConversations, null);
    } finally {
      policyMod.loadPolicy = origLoad;
    }
  });

  test('_telegramScan initializes TelegramConversations when enabled', () => {
    const { PmLoop } = require('../pm-loop');
    const loop = new PmLoop(dir, { pmSessionId: 'S-pm-test' });
    loop.running = true;
    loop.pmSessionId = 'S-pm-test';

    // Mock policy-loader
    const policyMod = require('../policy');
    const origLoad = policyMod.loadPolicy;
    policyMod.loadPolicy =() => ({
      telegram: { enabled: true, approval: { timeout_minutes: 60 } }
    });

    try {
      const results = loop._telegramScan();
      assert.ok(loop._telegramConversations !== null);
    } finally {
      policyMod.loadPolicy = origLoad;
    }
  });

  test('_telegramScan handles errors gracefully', () => {
    const { PmLoop } = require('../pm-loop');
    const loop = new PmLoop(dir, { pmSessionId: 'S-pm-test' });
    loop.running = true;
    loop.pmSessionId = 'S-pm-test';

    // Mock policy-loader to throw
    const policyMod = require('../policy');
    const origLoad = policyMod.loadPolicy;
    policyMod.loadPolicy =() => { throw new Error('test error'); };

    try {
      const results = loop._telegramScan();
      assert.deepEqual(results, []);
    } finally {
      policyMod.loadPolicy = origLoad;
    }
  });
});
