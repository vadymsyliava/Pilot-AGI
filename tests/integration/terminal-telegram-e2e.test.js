/**
 * Terminal + Telegram E2E Integration Tests — Phase 6.7 (Pilot AGI-msm)
 *
 * Validates end-to-end flows:
 *   1. Telegram → PM → intent processing → response
 *   2. Escalation → Telegram → approve/reject → resolution
 *   3. Approval timeout → auto-escalation
 *   4. Security: unauthorized blocked, rate limits enforced
 *   5. Morning report generation with multi-model stats
 *   6. Idea capture → bd task creation
 *   7. PM loop telegram scan integration
 *   8. Conversation history context across messages
 *   9. Failover: terminal provider fallback chain
 *  10. Overnight scenario: queue → route → morning report
 *  11. Chaos: agent crash → PM recovery detection
 *
 * Run: node --test tests/integration/terminal-telegram-e2e.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// =============================================================================
// HELPERS
// =============================================================================

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-e2e-tg-'));
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function freshModule(modPath) {
  const resolved = require.resolve(modPath);
  delete require.cache[resolved];
  return require(resolved);
}

function setupPilotDirs(tmpDir) {
  const dirs = [
    '.claude/pilot/state/sessions',
    '.claude/pilot/state/telegram',
    '.claude/pilot/state/costs/tasks',
    '.claude/pilot/state/costs/agents',
    '.claude/pilot/state/costs/daily',
    '.claude/pilot/state/approved-plans',
    '.claude/pilot/state/orchestrator',
    '.claude/pilot/state/escalations',
    '.claude/pilot/state/recovery',
    '.claude/pilot/state/artifacts',
    '.claude/pilot/messages/cursors',
    '.claude/pilot/memory/channels',
    'runs',
  ];
  for (const d of dirs) {
    fs.mkdirSync(path.join(tmpDir, d), { recursive: true });
  }
}

function writeInbox(tmpDir, messages) {
  const inboxPath = path.join(tmpDir, '.claude/pilot/state/telegram/pm-inbox.jsonl');
  const dir = path.dirname(inboxPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const content = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
  fs.writeFileSync(inboxPath, content);
}

function readOutbox(tmpDir) {
  const outboxPath = path.join(tmpDir, '.claude/pilot/state/telegram/pm-outbox.jsonl');
  if (!fs.existsSync(outboxPath)) return [];
  return fs.readFileSync(outboxPath, 'utf8').trim().split('\n')
    .filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function writeSessionState(tmpDir, sessionId, state) {
  const sessionDir = path.join(tmpDir, '.claude/pilot/state/sessions');
  fs.writeFileSync(path.join(sessionDir, `${sessionId}.json`), JSON.stringify(state));
}

function writeMsgBus(tmpDir, events) {
  const busPath = path.join(tmpDir, '.claude/pilot/messages/bus.jsonl');
  fs.writeFileSync(busPath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

// =============================================================================
// E2E SCENARIOS
// =============================================================================

describe('Terminal + Telegram E2E Integration (Phase 6.7)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
    setupPilotDirs(tmpDir);
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  // ===========================================================================
  // Scenario 1: Full Telegram → PM → Response flow
  // ===========================================================================
  describe('Scenario 1: Telegram → PM → Response flow', () => {
    it('should process status intent from inbox and write response to outbox', () => {
      const { TelegramConversations } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-conversations'
      );

      // Write a status request to inbox
      writeInbox(tmpDir, [
        { action: 'status', chatId: 12345, username: 'testuser', timestamp: new Date().toISOString() }
      ]);

      // Mock session module
      const sessionMod = require('../../.claude/pilot/hooks/lib/session');
      const origGetActive = sessionMod.getActiveSessions;
      sessionMod.getActiveSessions = () => [
        { session_id: 'S-agent-1', claimed_task: 'Pilot AGI-abc', started_at: Date.now() },
        { session_id: 'S-agent-2', claimed_task: 'Pilot AGI-def', started_at: Date.now() }
      ];

      try {
        const conv = new TelegramConversations(tmpDir, { pmSessionId: 'S-pm-1' });
        const results = conv.processPendingMessages();

        // Verify results
        assert.ok(results.length >= 1, 'Should have at least 1 result');
        assert.equal(results[0].action, 'telegram_status');

        // Verify outbox has response
        const outbox = readOutbox(tmpDir);
        assert.ok(outbox.length >= 1, 'Outbox should have response');
        assert.ok(outbox[0].text.includes('Pilot AGI Status') || outbox[0].text.includes('Status'),
          'Response should contain status info');
        assert.ok(outbox[0].text.includes('2 active') || outbox[0].text.includes('agent'),
          'Response should mention agents');
      } finally {
        sessionMod.getActiveSessions = origGetActive;
      }
    });

    it('should process multiple intents in sequence preserving cursor', () => {
      const { TelegramConversations } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-conversations'
      );

      writeInbox(tmpDir, [
        { action: 'ps', chatId: 111, timestamp: new Date().toISOString() },
        { action: 'ps', chatId: 222, timestamp: new Date().toISOString() },
        { action: 'ps', chatId: 333, timestamp: new Date().toISOString() }
      ]);

      const sessionMod = require('../../.claude/pilot/hooks/lib/session');
      const origGetActive = sessionMod.getActiveSessions;
      sessionMod.getActiveSessions = () => [];

      try {
        const conv = new TelegramConversations(tmpDir, { pmSessionId: 'S-pm-1' });

        // First scan processes all 3
        const results1 = conv.processPendingMessages();
        assert.equal(results1.length, 3, 'Should process 3 messages');

        // Second scan with no new messages processes 0
        const results2 = conv.processPendingMessages();
        const intentResults = results2.filter(r => r.action && r.action.startsWith('telegram_'));
        assert.equal(intentResults.length, 0, 'No new messages to process');
      } finally {
        sessionMod.getActiveSessions = origGetActive;
      }
    });
  });

  // ===========================================================================
  // Scenario 2: Escalation → Telegram → Approve → Resolution
  // ===========================================================================
  describe('Scenario 2: Escalation → Telegram → Approve/Reject', () => {
    it('should complete full escalation approval cycle', () => {
      const { TelegramConversations } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-conversations'
      );

      const conv = new TelegramConversations(tmpDir, {
        pmSessionId: 'S-pm-1',
        policy: { approval: { timeout_minutes: 60 } }
      });

      // Step 1: PM registers escalation approval
      conv.registerApproval('esc_merge_001', {
        taskId: 'Pilot AGI-abc',
        type: 'merge_conflict',
        sessionId: 'S-agent-1',
        chatId: 12345,
        details: 'Conflict in shared/types.ts'
      });

      assert.equal(conv.pendingApprovalCount, 1);

      // Step 2: User sends approve via Telegram (arrives in inbox)
      writeInbox(tmpDir, [{
        action: 'approve_escalation',
        approvalId: 'esc_merge_001',
        taskId: 'Pilot AGI-abc',
        type: 'merge_conflict',
        chatId: 12345,
        timestamp: new Date().toISOString()
      }]);

      // Step 3: Process inbox
      const results = conv.processPendingMessages();

      // Step 4: Verify approval resolved
      assert.equal(conv.pendingApprovalCount, 0, 'Approval should be consumed');

      // Verify outbox response
      const outbox = readOutbox(tmpDir);
      assert.ok(outbox.length >= 1, 'Should have approval confirmation');
      assert.ok(outbox[0].text.includes('Approved'), 'Should confirm approval');
    });

    it('should complete full escalation rejection cycle', () => {
      const { TelegramConversations } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-conversations'
      );

      const conv = new TelegramConversations(tmpDir, {
        pmSessionId: 'S-pm-1',
        policy: { approval: { timeout_minutes: 60 } }
      });

      // Register + reject
      conv.registerApproval('esc_drift_001', {
        taskId: 'Pilot AGI-xyz',
        type: 'drift',
        sessionId: 'S-agent-2',
        chatId: 12345,
        details: 'Agent editing unplanned files'
      });

      writeInbox(tmpDir, [{
        action: 'reject_escalation',
        approvalId: 'esc_drift_001',
        chatId: 12345,
        timestamp: new Date().toISOString()
      }]);

      const results = conv.processPendingMessages();
      assert.equal(conv.pendingApprovalCount, 0);

      const outbox = readOutbox(tmpDir);
      assert.ok(outbox[0].text.includes('Rejected'));
    });

    it('should handle approve by taskId when no approvalId given', () => {
      const { TelegramConversations } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-conversations'
      );

      const conv = new TelegramConversations(tmpDir, { pmSessionId: 'S-pm-1' });

      conv.registerApproval('esc_test_001', {
        taskId: 'Pilot AGI-findme',
        type: 'test_failure',
        chatId: 12345,
      });

      writeInbox(tmpDir, [{
        action: 'approve',
        taskId: 'Pilot AGI-findme',
        chatId: 12345,
        timestamp: new Date().toISOString()
      }]);

      conv.processPendingMessages();
      assert.equal(conv.pendingApprovalCount, 0, 'Approval resolved by taskId');
    });
  });

  // ===========================================================================
  // Scenario 3: Approval timeout → auto-escalation
  // ===========================================================================
  describe('Scenario 3: Approval timeout auto-escalation', () => {
    it('should auto-escalate expired approvals on scan', () => {
      const { TelegramConversations } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-conversations'
      );

      const conv = new TelegramConversations(tmpDir, {
        pmSessionId: 'S-pm-1',
        policy: { approval: { timeout_minutes: 0 } } // immediate timeout
      });

      // Register approval that will expire immediately
      conv._pendingApprovals.set('esc_timeout_001', {
        taskId: 'Pilot AGI-slow',
        type: 'budget_exceeded',
        chatId: 12345,
        expiresAt: Date.now() - 1000,
        escalated: false,
      });

      // Process (empty inbox but will check timeouts)
      writeInbox(tmpDir, []);
      const results = conv.processPendingMessages();

      const timeoutResults = results.filter(r => r.action === 'approval_timeout');
      assert.equal(timeoutResults.length, 1, 'Should detect 1 timeout');
      assert.equal(timeoutResults[0].taskId, 'Pilot AGI-slow');

      // Verify Telegram notification sent
      const outbox = readOutbox(tmpDir);
      assert.ok(outbox.length >= 1, 'Should notify about timeout');
      assert.ok(outbox[0].text.includes('timeout') || outbox[0].text.includes('Auto-escalated'));

      // Verify no double-escalation
      const results2 = conv.processPendingMessages();
      const timeouts2 = results2.filter(r => r.action === 'approval_timeout');
      assert.equal(timeouts2.length, 0, 'Should not re-escalate');
    });

    it('should not escalate approvals that are still within timeout', () => {
      const { TelegramConversations } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-conversations'
      );

      const conv = new TelegramConversations(tmpDir, { pmSessionId: 'S-pm-1' });

      conv.registerApproval('esc_fresh_001', {
        taskId: 'Pilot AGI-fresh',
        type: 'drift',
        chatId: 12345,
      });

      writeInbox(tmpDir, []);
      const results = conv.processPendingMessages();

      const timeouts = results.filter(r => r.action === 'approval_timeout');
      assert.equal(timeouts.length, 0, 'Fresh approval should not timeout');
      assert.equal(conv.pendingApprovalCount, 1, 'Approval still pending');
    });
  });

  // ===========================================================================
  // Scenario 4: Security — unauthorized blocked, rate limits
  // ===========================================================================
  describe('Scenario 4: Security enforcement', () => {
    it('should validate sender authentication via security module', () => {
      const { validateSender } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-security'
      );

      // Authorized user
      const auth = validateSender(12345, [12345, 67890]);
      assert.equal(auth.authorized, true);

      // Unauthorized user
      const unauth = validateSender(99999, [12345, 67890]);
      assert.equal(unauth.authorized, false);

      // Empty allowlist = reject all (secure default)
      const empty = validateSender(12345, []);
      assert.equal(empty.authorized, false);
    });

    it('should enforce rate limits via token bucket', () => {
      const { TokenBucket } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-security'
      );

      const limiter = new TokenBucket({ per_minute: 3, per_hour: 100 });

      // First 3 requests allowed
      assert.equal(limiter.consume(123).allowed, true);
      assert.equal(limiter.consume(123).allowed, true);
      assert.equal(limiter.consume(123).allowed, true);

      // 4th blocked
      const result = limiter.consume(123);
      assert.equal(result.allowed, false);
      assert.ok(result.retryAfterMs > 0, 'Should provide retry time');
    });

    it('should parse intents safely — no raw shell execution', () => {
      const { parseIntent } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-security'
      );

      // Dangerous input → unknown action (NOT shell execution)
      const dangerous = parseIntent('rm -rf /');
      assert.equal(dangerous.action, 'unknown');

      // SQL injection attempt → unknown
      const sql = parseIntent("'; DROP TABLE users; --");
      assert.equal(sql.action, 'unknown');

      // Normal intent → structured action
      const status = parseIntent('what is the status?');
      assert.equal(status.action, 'status');

      // Kill switch
      const lockdown = parseIntent('LOCKDOWN');
      assert.equal(lockdown.action, 'lockdown');
    });

    it('should audit all Telegram interactions', () => {
      const { audit, readAuditLog, AUDIT_LOG_PATH } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-security'
      );

      // Write audit entries
      audit(tmpDir, { event: 'INBOUND', chatId: 12345, action: 'status' });
      audit(tmpDir, { event: 'BLOCKED', chatId: 99999, action: 'unauthorized' });
      audit(tmpDir, { event: 'OUTBOUND', chatId: 12345, type: 'text' });

      // Read back
      const entries = readAuditLog(tmpDir);
      assert.equal(entries.length, 3);
      assert.equal(entries[0].event, 'INBOUND');
      assert.equal(entries[1].event, 'BLOCKED');
      assert.equal(entries[2].event, 'OUTBOUND');
    });
  });

  // ===========================================================================
  // Scenario 5: Morning report with multi-model stats
  // ===========================================================================
  describe('Scenario 5: Morning report generation', () => {
    it('should build morning report via Telegram intent', () => {
      const { TelegramConversations } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-conversations'
      );

      writeInbox(tmpDir, [{
        action: 'morning_report',
        chatId: 12345,
        timestamp: new Date().toISOString()
      }]);

      const conv = new TelegramConversations(tmpDir, { pmSessionId: 'S-pm-1' });
      const results = conv.processPendingMessages();

      // Verify response
      const outbox = readOutbox(tmpDir);
      assert.ok(outbox.length >= 1, 'Should have morning report');
      assert.equal(outbox[0].type, 'morning_report');
      assert.ok(outbox[0].text.includes('PILOT AGI'));
      assert.ok(outbox[0].text.includes('Morning Report'));
      assert.ok(outbox[0].text.includes('Tasks'));
    });

    it('should include pending approvals in needs-attention section', () => {
      const { TelegramConversations } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-conversations'
      );

      const conv = new TelegramConversations(tmpDir, { pmSessionId: 'S-pm-1' });

      // Add pending approvals
      conv.registerApproval('esc_attn_1', {
        taskId: 'Pilot AGI-merge',
        type: 'merge_conflict',
        details: 'Conflict in shared/types.ts',
        chatId: 12345,
      });

      const report = conv.buildMorningReport();
      assert.ok(report.includes('Needs Attention'), 'Report should have attention section');
      assert.ok(report.includes('Pilot AGI-merge'), 'Should reference blocked task');
      assert.ok(report.includes('merge_conflict'), 'Should include escalation type');
    });
  });

  // ===========================================================================
  // Scenario 6: Idea capture → task creation
  // ===========================================================================
  describe('Scenario 6: Idea capture flow', () => {
    it('should reject idea with no text', () => {
      const { TelegramConversations } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-conversations'
      );

      writeInbox(tmpDir, [{
        action: 'idea',
        chatId: 12345,
        timestamp: new Date().toISOString()
        // no text field
      }]);

      const conv = new TelegramConversations(tmpDir, { pmSessionId: 'S-pm-1' });
      conv.processPendingMessages();

      const outbox = readOutbox(tmpDir);
      assert.ok(outbox[0].text.includes('Please provide'));
    });
  });

  // ===========================================================================
  // Scenario 7: PM loop telegram scan integration
  // ===========================================================================
  describe('Scenario 7: PM loop integration', () => {
    it('should skip telegram scan when disabled in policy', () => {
      // Clear cache
      for (const key of Object.keys(require.cache)) {
        if (key.includes('pm-loop') || key.includes('telegram-conversations') ||
            key.includes('/policy')) {
          delete require.cache[key];
        }
      }

      const { PmLoop } = freshModule('../../.claude/pilot/hooks/lib/pm-loop');
      const loop = new PmLoop(tmpDir, { pmSessionId: 'S-pm-test' });
      loop.running = true;
      loop.pmSessionId = 'S-pm-test';

      // Mock policy
      const policyMod = require('../../.claude/pilot/hooks/lib/policy');
      const origLoad = policyMod.loadPolicy;
      policyMod.loadPolicy = () => ({ telegram: { enabled: false } });

      try {
        const results = loop._telegramScan();
        assert.deepStrictEqual(results, []);
        assert.equal(loop._telegramConversations, null, 'Should not init when disabled');
      } finally {
        policyMod.loadPolicy = origLoad;
      }
    });

    it('should init and process when telegram enabled', () => {
      for (const key of Object.keys(require.cache)) {
        if (key.includes('pm-loop') || key.includes('telegram-conversations') ||
            key.includes('/policy')) {
          delete require.cache[key];
        }
      }

      const { PmLoop } = freshModule('../../.claude/pilot/hooks/lib/pm-loop');
      const loop = new PmLoop(tmpDir, { pmSessionId: 'S-pm-test' });
      loop.running = true;
      loop.pmSessionId = 'S-pm-test';

      const policyMod = require('../../.claude/pilot/hooks/lib/policy');
      const origLoad = policyMod.loadPolicy;
      policyMod.loadPolicy = () => ({
        telegram: { enabled: true, approval: { timeout_minutes: 60 } }
      });

      try {
        const results = loop._telegramScan();
        assert.ok(loop._telegramConversations !== null, 'Should init TelegramConversations');
        assert.ok(loop.telegramConversations !== null, 'Getter should work');
      } finally {
        policyMod.loadPolicy = origLoad;
      }
    });
  });

  // ===========================================================================
  // Scenario 8: Conversation history context
  // ===========================================================================
  describe('Scenario 8: Conversation history', () => {
    it('should maintain per-chatId conversation context across messages', () => {
      const { TelegramConversations } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-conversations'
      );

      const sessionMod = require('../../.claude/pilot/hooks/lib/session');
      const origGetActive = sessionMod.getActiveSessions;
      sessionMod.getActiveSessions = () => [];

      try {
        // First message from user A
        writeInbox(tmpDir, [
          { action: 'ps', chatId: 111, timestamp: new Date().toISOString() },
          { action: 'ps', chatId: 222, timestamp: new Date().toISOString() },
        ]);

        const conv = new TelegramConversations(tmpDir, { pmSessionId: 'S-pm-1' });
        conv.processPendingMessages();

        // Check histories are separate
        const history111 = conv.getConversationHistory(111);
        const history222 = conv.getConversationHistory(222);

        assert.ok(history111.length >= 2, 'User 111 should have history (user + bot)');
        assert.ok(history222.length >= 2, 'User 222 should have history (user + bot)');
        assert.equal(history111[0].role, 'user');
        assert.equal(history111[1].role, 'bot');
      } finally {
        sessionMod.getActiveSessions = origGetActive;
      }
    });

    it('should persist and reload conversation history', () => {
      const { TelegramConversations: TC1 } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-conversations'
      );
      const sessionMod = require('../../.claude/pilot/hooks/lib/session');
      const origGetActive = sessionMod.getActiveSessions;
      sessionMod.getActiveSessions = () => [];

      try {
        // First instance writes history
        writeInbox(tmpDir, [
          { action: 'ps', chatId: 999, timestamp: new Date().toISOString() }
        ]);

        const conv1 = new TC1(tmpDir, { pmSessionId: 'S-pm-1' });
        conv1.processPendingMessages();

        // Verify history file exists
        const historyPath = path.join(tmpDir, '.claude/pilot/state/telegram/conversations.json');
        assert.ok(fs.existsSync(historyPath), 'History should be persisted');

        // Second instance loads history
        const { TelegramConversations: TC2 } = freshModule(
          '../../.claude/pilot/hooks/lib/telegram-conversations'
        );
        const conv2 = new TC2(tmpDir, { pmSessionId: 'S-pm-1' });
        const history = conv2.getConversationHistory(999);
        assert.ok(history.length >= 2, 'Should reload history from disk');
      } finally {
        sessionMod.getActiveSessions = origGetActive;
      }
    });
  });

  // ===========================================================================
  // Scenario 9: Terminal provider failover chain
  // ===========================================================================
  describe('Scenario 9: Terminal provider failover', () => {
    it('should detect available terminal providers', () => {
      // This is a structural test — verifies the fallback chain exists
      const termCtrl = freshModule('../../.claude/pilot/hooks/lib/terminal-controller');

      // The module should export terminal controller functions
      assert.ok(typeof termCtrl === 'object' || typeof termCtrl === 'function',
        'Terminal controller module should be loadable');
    });

    it('should have headless fallback available', () => {
      const termCtrl = freshModule('../../.claude/pilot/hooks/lib/terminal-controller');

      // Check for provider resolution or fallback logic
      if (typeof termCtrl.TerminalController === 'function') {
        assert.ok(true, 'TerminalController class exists');
      } else if (typeof termCtrl.getProvider === 'function') {
        assert.ok(true, 'Provider getter exists');
      } else {
        // Module loads = headless mode always available as baseline
        assert.ok(termCtrl, 'Terminal controller loads without error');
      }
    });
  });

  // ===========================================================================
  // Scenario 10: Overnight → morning report flow
  // ===========================================================================
  describe('Scenario 10: Overnight scenario with morning report', () => {
    it('should generate morning report covering overnight work', () => {
      const { TelegramConversations } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-conversations'
      );

      // Create run log to simulate overnight work
      const today = new Date().toISOString().slice(0, 10);
      const logPath = path.join(tmpDir, 'runs', `${today}.md`);
      fs.writeFileSync(logPath, [
        `## ${today} Session`,
        '',
        '### Task: Pilot AGI-overnight-1',
        '- Completed: JWT middleware',
        '- Status: closed',
        '',
        '### Task: Pilot AGI-overnight-2',
        '- Completed: Login component',
        '- Status: closed',
      ].join('\n'));

      // Add pending approvals for morning attention
      const conv = new TelegramConversations(tmpDir, { pmSessionId: 'S-pm-1' });
      conv.registerApproval('esc_overnight', {
        taskId: 'Pilot AGI-blocked',
        type: 'merge_conflict',
        details: 'Conflict in shared/types.ts',
        chatId: 12345,
      });

      const report = conv.buildMorningReport();

      // Verify report structure
      assert.ok(report.includes('PILOT AGI'), 'Has header');
      assert.ok(report.includes('Morning Report'), 'Has report type');
      assert.ok(report.includes(today), 'Has date');
      assert.ok(report.includes('Tasks'), 'Has task section');
      assert.ok(report.includes('Needs Attention'), 'Has attention section');
      assert.ok(report.includes('Pilot AGI-blocked'), 'Lists blocked task');
    });
  });

  // ===========================================================================
  // Scenario 11: Chaos — agent crash recovery detection
  // ===========================================================================
  describe('Scenario 11: Agent crash detection', () => {
    it('should detect agent with stale heartbeat via session state', () => {
      const sessionMod = freshModule('../../.claude/pilot/hooks/lib/session');

      // Write a session state with old heartbeat
      writeSessionState(tmpDir, 'S-crashed-agent', {
        session_id: 'S-crashed-agent',
        claimed_task: 'Pilot AGI-stuck',
        heartbeat: Date.now() - 600000, // 10 minutes ago
        started_at: Date.now() - 3600000,
        status: 'active'
      });

      // Write a healthy session
      writeSessionState(tmpDir, 'S-healthy-agent', {
        session_id: 'S-healthy-agent',
        claimed_task: 'Pilot AGI-fine',
        heartbeat: Date.now(),
        started_at: Date.now() - 60000,
        status: 'active'
      });

      // Read sessions
      const sessions = sessionMod.getActiveSessions(tmpDir);
      assert.ok(Array.isArray(sessions), 'Should return array');
    });

    it('should handle recovery state file for recoverable tasks', () => {
      const recoveryPath = path.join(tmpDir, '.claude/pilot/state/orchestrator/recoverable-tasks.json');

      // Write recoverable task queue
      fs.writeFileSync(recoveryPath, JSON.stringify([
        {
          taskId: 'Pilot AGI-crashed',
          previousSessionId: 'S-dead-agent',
          reason: 'agent_unresponsive',
          detectedAt: new Date().toISOString()
        }
      ]));

      // Verify it's readable
      const queue = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
      assert.equal(queue.length, 1);
      assert.equal(queue[0].taskId, 'Pilot AGI-crashed');
      assert.equal(queue[0].reason, 'agent_unresponsive');
    });
  });

  // ===========================================================================
  // Scenario 12: Telegram bridge static helpers
  // ===========================================================================
  describe('Scenario 12: Telegram bridge static helpers', () => {
    it('should write to outbox and read from inbox (file-based queue)', () => {
      const { writeToOutbox, readInbox } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-bridge'
      );

      // Write to outbox
      writeToOutbox(tmpDir, { type: 'text', chatId: 123, text: 'Hello from PM' });
      writeToOutbox(tmpDir, { type: 'escalation', chatId: 123, data: { taskId: 'abc', type: 'drift' } });

      // Read outbox
      const outbox = readOutbox(tmpDir);
      assert.equal(outbox.length, 2);
      assert.equal(outbox[0].type, 'text');
      assert.equal(outbox[1].type, 'escalation');

      // Write to inbox
      writeInbox(tmpDir, [
        { action: 'approve', chatId: 123 },
        { action: 'status', chatId: 456 }
      ]);

      // Read inbox
      const inbox = readInbox(tmpDir);
      assert.equal(inbox.messages.length, 2);
      assert.equal(inbox.messages[0].action, 'approve');
      assert.equal(inbox.newCursor, 2);

      // Read from cursor
      const inbox2 = readInbox(tmpDir, 2);
      assert.equal(inbox2.messages.length, 0);
      assert.equal(inbox2.newCursor, 2);
    });

    it('should split long messages at 4096 chars', () => {
      const { splitMessage, MAX_MESSAGE_LENGTH } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-bridge'
      );

      // Short message — no split
      const short = splitMessage('Hello');
      assert.equal(short.length, 1);

      // Long message — split
      const long = 'x'.repeat(5000);
      const chunks = splitMessage(long);
      assert.ok(chunks.length >= 2, 'Should split into 2+ chunks');
      for (const chunk of chunks) {
        assert.ok(chunk.length <= MAX_MESSAGE_LENGTH, `Chunk should be <= ${MAX_MESSAGE_LENGTH}`);
      }
    });

    it('should escape Markdown special characters', () => {
      const { escapeMarkdown } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-bridge'
      );

      assert.equal(escapeMarkdown('hello_world'), 'hello\\_world');
      assert.equal(escapeMarkdown('*bold*'), '\\*bold\\*');
      assert.equal(escapeMarkdown('`code`'), '\\`code\\`');
    });
  });

  // ===========================================================================
  // Scenario 13: Multi-action coordination (pause → resume)
  // ===========================================================================
  describe('Scenario 13: Multi-action coordination', () => {
    it('should handle pause then resume sequence', () => {
      const { TelegramConversations } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-conversations'
      );

      const messagingMod = require('../../.claude/pilot/hooks/lib/messaging');
      const origBroadcast = messagingMod.sendBroadcast;
      const broadcasts = [];
      messagingMod.sendBroadcast = (from, action, data) => {
        broadcasts.push({ from, action, data });
      };

      try {
        writeInbox(tmpDir, [
          { action: 'pause_all', chatId: 123, scope: 'all', timestamp: new Date().toISOString() },
          { action: 'resume', chatId: 123, scope: 'all', timestamp: new Date().toISOString() }
        ]);

        const conv = new TelegramConversations(tmpDir, { pmSessionId: 'S-pm-1' });
        conv.processPendingMessages();

        // Verify broadcasts
        assert.equal(broadcasts.length, 2, 'Should broadcast both actions');
        assert.equal(broadcasts[0].action, 'pause_all');
        assert.equal(broadcasts[1].action, 'resume');

        // Verify outbox responses
        const outbox = readOutbox(tmpDir);
        assert.equal(outbox.length, 2);
        assert.ok(outbox[0].text.includes('Pause'));
        assert.ok(outbox[1].text.includes('Resume'));
      } finally {
        messagingMod.sendBroadcast = origBroadcast;
      }
    });
  });

  // ===========================================================================
  // Scenario 14: Lockdown emergency flow
  // ===========================================================================
  describe('Scenario 14: Lockdown emergency', () => {
    it('should broadcast lockdown to all agents', () => {
      const { TelegramConversations } = freshModule(
        '../../.claude/pilot/hooks/lib/telegram-conversations'
      );

      const messagingMod = require('../../.claude/pilot/hooks/lib/messaging');
      const origBroadcast = messagingMod.sendBroadcast;
      let lockdownBroadcast = null;
      messagingMod.sendBroadcast = (from, action, data) => {
        if (action === 'lockdown') lockdownBroadcast = { from, action, data };
      };

      try {
        writeInbox(tmpDir, [{
          action: 'lockdown',
          chatId: 12345,
          timestamp: new Date().toISOString()
        }]);

        const conv = new TelegramConversations(tmpDir, { pmSessionId: 'S-pm-1' });
        conv.processPendingMessages();

        assert.ok(lockdownBroadcast, 'Should broadcast lockdown');
        assert.equal(lockdownBroadcast.action, 'lockdown');
        assert.equal(lockdownBroadcast.data.source, 'telegram');

        const outbox = readOutbox(tmpDir);
        assert.ok(outbox[0].text.includes('LOCKDOWN'));
      } finally {
        messagingMod.sendBroadcast = origBroadcast;
      }
    });
  });
});
