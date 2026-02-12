/**
 * Telegram Conversations — PM-Side Telegram Processor (Phase 6.6)
 *
 * Reads intents from the Telegram inbox, dispatches to handlers,
 * builds responses, and writes to the outbox for delivery.
 *
 * Features:
 * - Intent dispatch: status, ps, morning_report, budget, approve/reject,
 *   idea capture, pause/resume, kill_agent, logs
 * - Approval timeout tracking with auto-escalation
 * - Morning report generation with task/cost/commit stats
 * - Conversation history for context continuity
 * - Idea capture → bd task creation
 *
 * Part of Phase 6.6 (Pilot AGI-pl7)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ============================================================================
// CONSTANTS
// ============================================================================

const INBOX_CURSOR_PATH = '.claude/pilot/state/telegram/inbox-cursor.json';
const APPROVAL_STATE_PATH = '.claude/pilot/state/telegram/pending-approvals.json';
const CONVERSATION_HISTORY_PATH = '.claude/pilot/state/telegram/conversations.json';
const MAX_HISTORY_TURNS = 20; // Per chatId
const APPROVAL_CHECK_INTERVAL_MS = 60000; // Check timeouts every 60s

// ============================================================================
// TELEGRAM CONVERSATIONS CLASS
// ============================================================================

class TelegramConversations {
  /**
   * @param {string} projectRoot
   * @param {object} [opts]
   * @param {object} [opts.policy] - Telegram policy section from policy.yaml
   * @param {string} [opts.pmSessionId] - PM session ID for messaging
   */
  constructor(projectRoot, opts = {}) {
    this.projectRoot = projectRoot;
    this.policy = opts.policy || {};
    this.pmSessionId = opts.pmSessionId || null;
    this._inboxCursor = 0;
    this._conversations = new Map(); // chatId -> [{role, text, ts}]
    this._pendingApprovals = new Map(); // approvalId -> {taskId, type, chatId, expiresAt, escalated}

    // Dependency injection for testing
    this._readInbox = opts.readInbox || null;
    this._writeToOutbox = opts.writeToOutbox || null;

    this._loadState();
  }

  // ==========================================================================
  // STATE PERSISTENCE
  // ==========================================================================

  _loadState() {
    // Load inbox cursor
    const cursorPath = path.join(this.projectRoot, INBOX_CURSOR_PATH);
    try {
      if (fs.existsSync(cursorPath)) {
        this._inboxCursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8')).cursor || 0;
      }
    } catch { /* start from 0 */ }

    // Load pending approvals
    const approvalPath = path.join(this.projectRoot, APPROVAL_STATE_PATH);
    try {
      if (fs.existsSync(approvalPath)) {
        const data = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
        for (const [id, val] of Object.entries(data)) {
          this._pendingApprovals.set(id, val);
        }
      }
    } catch { /* fresh start */ }

    // Load conversation history
    const historyPath = path.join(this.projectRoot, CONVERSATION_HISTORY_PATH);
    try {
      if (fs.existsSync(historyPath)) {
        const data = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        for (const [chatId, turns] of Object.entries(data)) {
          this._conversations.set(Number(chatId), turns);
        }
      }
    } catch { /* fresh start */ }
  }

  _saveInboxCursor() {
    const cursorPath = path.join(this.projectRoot, INBOX_CURSOR_PATH);
    const dir = path.dirname(cursorPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cursorPath, JSON.stringify({ cursor: this._inboxCursor }));
  }

  _savePendingApprovals() {
    const approvalPath = path.join(this.projectRoot, APPROVAL_STATE_PATH);
    const dir = path.dirname(approvalPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj = {};
    for (const [id, val] of this._pendingApprovals) {
      obj[id] = val;
    }
    fs.writeFileSync(approvalPath, JSON.stringify(obj, null, 2));
  }

  _saveConversationHistory() {
    const historyPath = path.join(this.projectRoot, CONVERSATION_HISTORY_PATH);
    const dir = path.dirname(historyPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj = {};
    for (const [chatId, turns] of this._conversations) {
      obj[chatId] = turns;
    }
    fs.writeFileSync(historyPath, JSON.stringify(obj, null, 2));
  }

  // ==========================================================================
  // CONVERSATION HISTORY
  // ==========================================================================

  _recordTurn(chatId, role, text) {
    if (!this._conversations.has(chatId)) {
      this._conversations.set(chatId, []);
    }
    const history = this._conversations.get(chatId);
    history.push({ role, text: text.slice(0, 500), ts: Date.now() });

    // Trim to MAX_HISTORY_TURNS
    if (history.length > MAX_HISTORY_TURNS) {
      history.splice(0, history.length - MAX_HISTORY_TURNS);
    }
  }

  getConversationHistory(chatId) {
    return this._conversations.get(chatId) || [];
  }

  // ==========================================================================
  // INBOX PROCESSING (Main entry point for PM loop)
  // ==========================================================================

  /**
   * Process all unread messages from the Telegram inbox.
   * Called by PM loop's _telegramScan().
   *
   * @returns {Array<{action: string, result: object}>} Actions taken
   */
  processPendingMessages() {
    const results = [];

    // Read inbox
    let inbox;
    if (this._readInbox) {
      inbox = this._readInbox(this.projectRoot, this._inboxCursor);
    } else {
      const { readInbox } = require('./telegram-bridge');
      inbox = readInbox(this.projectRoot, this._inboxCursor);
    }

    if (!inbox.messages || inbox.messages.length === 0) {
      // Still check approval timeouts even with no new messages
      const timeoutResults = this._checkApprovalTimeouts();
      results.push(...timeoutResults);
      return results;
    }

    // Process each message
    for (const msg of inbox.messages) {
      try {
        const result = this._dispatchIntent(msg);
        if (result) results.push(result);
      } catch (e) {
        results.push({ action: 'error', error: e.message, intent: msg.action });
      }
    }

    // Update cursor
    this._inboxCursor = inbox.newCursor;
    this._saveInboxCursor();

    // Check approval timeouts
    const timeoutResults = this._checkApprovalTimeouts();
    results.push(...timeoutResults);

    // Persist state
    this._saveConversationHistory();

    return results;
  }

  // ==========================================================================
  // INTENT DISPATCH
  // ==========================================================================

  _dispatchIntent(msg) {
    const { action, chatId } = msg;

    // Record inbound turn
    this._recordTurn(chatId, 'user', msg.raw || msg.text || action);

    let response;

    switch (action) {
      case 'status':
        response = this._handleStatus(msg);
        break;
      case 'ps':
        response = this._handlePs(msg);
        break;
      case 'morning_report':
        response = this._handleMorningReport(msg);
        break;
      case 'budget':
        response = this._handleBudget(msg);
        break;
      case 'approve':
        response = this._handleApprove(msg);
        break;
      case 'reject':
        response = this._handleReject(msg);
        break;
      case 'approve_escalation':
        response = this._handleApproveEscalation(msg);
        break;
      case 'reject_escalation':
        response = this._handleRejectEscalation(msg);
        break;
      case 'idea':
        response = this._handleIdea(msg);
        break;
      case 'pause':
      case 'pause_all':
        response = this._handlePause(msg);
        break;
      case 'resume':
        response = this._handleResume(msg);
        break;
      case 'kill_agent':
        response = this._handleKillAgent(msg);
        break;
      case 'logs':
        response = this._handleLogs(msg);
        break;
      case 'lockdown':
        response = this._handleLockdown(msg);
        break;
      default:
        response = { type: 'text', text: `Unknown action: ${action}. Send /help for commands.` };
        break;
    }

    // Record outbound turn
    if (response && response.text) {
      this._recordTurn(chatId, 'bot', response.text);
    }

    // Write to outbox
    if (response) {
      this._writeOutbound({ ...response, chatId });
    }

    return { action: `telegram_${action}`, chatId, result: response ? 'sent' : 'skipped' };
  }

  _writeOutbound(msg) {
    if (this._writeToOutbox) {
      this._writeToOutbox(this.projectRoot, msg);
    } else {
      const { writeToOutbox } = require('./telegram-bridge');
      writeToOutbox(this.projectRoot, msg);
    }
  }

  // ==========================================================================
  // INTENT HANDLERS
  // ==========================================================================

  _handleStatus(msg) {
    try {
      const session = require('./session');
      const activeSessions = session.getActiveSessions();
      const agents = activeSessions.filter(s => s.session_id !== this.pmSessionId);

      let taskStats = { total: 0, done: 0, in_progress: 0, open: 0 };
      try {
        const output = execFileSync('bd', ['list', '--json', '--limit', '50'], {
          cwd: this.projectRoot, encoding: 'utf8', timeout: 10000
        });
        const tasks = JSON.parse(output);
        taskStats.total = tasks.length;
        for (const t of tasks) {
          if (t.status === 'closed') taskStats.done++;
          else if (t.status === 'in_progress') taskStats.in_progress++;
          else taskStats.open++;
        }
      } catch { /* bd unavailable */ }

      const lines = [
        '*Pilot AGI Status*',
        '',
        `Agents: ${agents.length} active`,
        `Tasks: ${taskStats.done}/${taskStats.total} done, ${taskStats.in_progress} in progress, ${taskStats.open} queued`,
      ];

      for (const agent of agents.slice(0, 5)) {
        const task = agent.claimed_task || 'idle';
        lines.push(`  - \`${agent.session_id.slice(0, 12)}\`: ${task}`);
      }

      return { type: 'text', text: lines.join('\n'), parse_mode: 'Markdown' };
    } catch (e) {
      return { type: 'text', text: `Status error: ${e.message}` };
    }
  }

  _handlePs(msg) {
    try {
      const session = require('./session');
      const activeSessions = session.getActiveSessions();
      const agents = activeSessions.filter(s => s.session_id !== this.pmSessionId);

      if (agents.length === 0) {
        return { type: 'text', text: 'No active agents.' };
      }

      const lines = ['*Active Agents*', ''];
      for (const agent of agents) {
        const sid = agent.session_id.slice(0, 12);
        const task = agent.claimed_task || 'idle';
        const started = agent.started_at ? new Date(agent.started_at).toLocaleTimeString() : '?';
        lines.push(`\`${sid}\` | ${task} | since ${started}`);
      }

      return { type: 'text', text: lines.join('\n'), parse_mode: 'Markdown' };
    } catch (e) {
      return { type: 'text', text: `PS error: ${e.message}` };
    }
  }

  _handleBudget(msg) {
    try {
      const costTracker = require('./cost-tracker');
      const dailyCost = costTracker.getDailyCost(this.projectRoot);

      const lines = [
        '*Cost Summary*',
        '',
        `Today: ${dailyCost.total_tokens ? dailyCost.total_tokens.toLocaleString() : '0'} tokens`,
      ];

      if (dailyCost.by_agent) {
        for (const [agent, tokens] of Object.entries(dailyCost.by_agent)) {
          lines.push(`  ${agent.slice(0, 12)}: ${tokens.toLocaleString()} tokens`);
        }
      }

      return { type: 'text', text: lines.join('\n'), parse_mode: 'Markdown' };
    } catch (e) {
      return { type: 'text', text: `Budget info unavailable: ${e.message}` };
    }
  }

  _handleApprove(msg) {
    const taskId = msg.taskId;
    if (!taskId) {
      // Find first pending approval
      if (this._pendingApprovals.size === 0) {
        return { type: 'text', text: 'No pending approvals.' };
      }
      const [firstId, firstApproval] = this._pendingApprovals.entries().next().value;
      return this._resolveApproval(firstId, firstApproval, 'approved', msg.chatId);
    }
    // Find approval by taskId
    for (const [id, approval] of this._pendingApprovals) {
      if (approval.taskId === taskId) {
        return this._resolveApproval(id, approval, 'approved', msg.chatId);
      }
    }
    return { type: 'text', text: `No pending approval for task ${taskId}.` };
  }

  _handleReject(msg) {
    const taskId = msg.taskId;
    if (!taskId) {
      if (this._pendingApprovals.size === 0) {
        return { type: 'text', text: 'No pending approvals.' };
      }
      const [firstId, firstApproval] = this._pendingApprovals.entries().next().value;
      return this._resolveApproval(firstId, firstApproval, 'rejected', msg.chatId);
    }
    for (const [id, approval] of this._pendingApprovals) {
      if (approval.taskId === taskId) {
        return this._resolveApproval(id, approval, 'rejected', msg.chatId);
      }
    }
    return { type: 'text', text: `No pending approval for task ${taskId}.` };
  }

  _handleApproveEscalation(msg) {
    const { approvalId } = msg;
    const approval = this._pendingApprovals.get(approvalId);
    if (!approval) {
      return { type: 'text', text: 'Approval expired or not found.' };
    }
    return this._resolveApproval(approvalId, approval, 'approved', msg.chatId);
  }

  _handleRejectEscalation(msg) {
    const { approvalId } = msg;
    const approval = this._pendingApprovals.get(approvalId);
    if (!approval) {
      return { type: 'text', text: 'Approval expired or not found.' };
    }
    return this._resolveApproval(approvalId, approval, 'rejected', msg.chatId);
  }

  _resolveApproval(approvalId, approval, decision, chatId) {
    this._pendingApprovals.delete(approvalId);
    this._savePendingApprovals();

    // Notify escalation engine of resolution
    try {
      const escalation = require('./escalation');
      if (decision === 'approved') {
        escalation.resolveEscalation(approval.type, approval.sessionId, approval.taskId);
      }
    } catch { /* best effort */ }

    // Notify agent via messaging bus
    try {
      const messaging = require('./messaging');
      if (approval.sessionId) {
        messaging.sendNotification(
          this.pmSessionId,
          approval.sessionId,
          `escalation_${decision}`,
          { taskId: approval.taskId, type: approval.type, decision }
        );
      }
    } catch { /* best effort */ }

    const label = decision === 'approved' ? 'Approved' : 'Rejected';
    return {
      type: 'text',
      text: `${label}: ${approval.type || 'escalation'} for \`${approval.taskId || 'unknown'}\``,
      parse_mode: 'Markdown'
    };
  }

  _handleIdea(msg) {
    const text = msg.text;
    if (!text) {
      return { type: 'text', text: 'Please provide an idea description.' };
    }

    try {
      const output = execFileSync('bd', ['create', '--title', text, '--type', 'task'], {
        cwd: this.projectRoot, encoding: 'utf8', timeout: 10000
      });
      // Parse bd output for task ID
      const match = output.match(/(Pilot AGI-\w+)/);
      const taskId = match ? match[1] : 'unknown';
      return { type: 'text', text: `Task created: \`${taskId}\`\n${text}`, parse_mode: 'Markdown' };
    } catch (e) {
      return { type: 'text', text: `Failed to create task: ${e.message}` };
    }
  }

  _handlePause(msg) {
    try {
      const messaging = require('./messaging');
      messaging.sendBroadcast(this.pmSessionId, 'pause_all', {
        scope: msg.scope || 'all',
        source: 'telegram',
      });
      return { type: 'text', text: 'Pause command broadcast to all agents.' };
    } catch (e) {
      return { type: 'text', text: `Pause error: ${e.message}` };
    }
  }

  _handleResume(msg) {
    try {
      const messaging = require('./messaging');
      messaging.sendBroadcast(this.pmSessionId, 'resume', {
        scope: msg.scope || 'all',
        source: 'telegram',
      });
      return { type: 'text', text: 'Resume command broadcast to all agents.' };
    } catch (e) {
      return { type: 'text', text: `Resume error: ${e.message}` };
    }
  }

  _handleKillAgent(msg) {
    const taskId = msg.taskId;
    if (!taskId) {
      return { type: 'text', text: 'Specify a task ID to kill: /kill <taskId>' };
    }

    try {
      const session = require('./session');
      const activeSessions = session.getActiveSessions();
      const target = activeSessions.find(s => s.claimed_task === taskId);

      if (!target) {
        return { type: 'text', text: `No agent found working on ${taskId}.` };
      }

      // Signal kill via messaging
      const messaging = require('./messaging');
      messaging.sendNotification(
        this.pmSessionId,
        target.session_id,
        'kill_agent',
        { taskId, source: 'telegram' }
      );

      return { type: 'text', text: `Kill signal sent to agent on \`${taskId}\`.`, parse_mode: 'Markdown' };
    } catch (e) {
      return { type: 'text', text: `Kill error: ${e.message}` };
    }
  }

  _handleLogs(msg) {
    const taskId = msg.taskId;
    if (!taskId) {
      return { type: 'text', text: 'Specify a task ID: /logs <taskId>' };
    }

    try {
      // Read recent session log
      const today = new Date().toISOString().slice(0, 10);
      const logPath = path.join(this.projectRoot, 'runs', `${today}.md`);
      if (!fs.existsSync(logPath)) {
        return { type: 'text', text: `No logs found for today.` };
      }

      const content = fs.readFileSync(logPath, 'utf8');
      // Find section for this task
      const taskSection = content.split('\n').filter(
        line => line.includes(taskId)
      ).slice(-10).join('\n');

      if (!taskSection) {
        return { type: 'text', text: `No log entries for ${taskId} today.` };
      }

      return { type: 'text', text: `*Logs for ${taskId}*\n\`\`\`\n${taskSection.slice(0, 3000)}\n\`\`\``, parse_mode: 'Markdown' };
    } catch (e) {
      return { type: 'text', text: `Logs error: ${e.message}` };
    }
  }

  _handleLockdown(msg) {
    try {
      const messaging = require('./messaging');
      messaging.sendBroadcast(this.pmSessionId, 'lockdown', {
        source: 'telegram',
        chatId: msg.chatId,
      });
      return { type: 'text', text: 'LOCKDOWN confirmed. All agents being stopped.' };
    } catch (e) {
      return { type: 'text', text: `Lockdown error: ${e.message}` };
    }
  }

  // ==========================================================================
  // MORNING REPORT
  // ==========================================================================

  _handleMorningReport(msg) {
    return { type: 'morning_report', text: this.buildMorningReport(), parse_mode: 'Markdown' };
  }

  /**
   * Build a formatted morning report with task/cost/commit stats.
   * @returns {string} Markdown-formatted report
   */
  buildMorningReport() {
    const today = new Date().toISOString().slice(0, 10);
    const lines = [
      '*PILOT AGI — Morning Report*',
      `Date: ${today}`,
      '',
    ];

    // Task stats
    let taskStats = { total: 0, done: 0, failed: 0, blocked: 0, in_progress: 0 };
    try {
      const output = execFileSync('bd', ['list', '--json', '--limit', '100'], {
        cwd: this.projectRoot, encoding: 'utf8', timeout: 10000
      });
      const tasks = JSON.parse(output);
      taskStats.total = tasks.length;
      for (const t of tasks) {
        if (t.status === 'closed') taskStats.done++;
        else if (t.status === 'in_progress') taskStats.in_progress++;
        else taskStats.blocked++; // simplification
      }
    } catch { /* bd unavailable */ }

    lines.push(`Tasks completed: ${taskStats.done}/${taskStats.total}`);
    if (taskStats.in_progress) lines.push(`Tasks in progress: ${taskStats.in_progress}`);
    if (taskStats.blocked) lines.push(`Tasks queued: ${taskStats.blocked}`);
    lines.push('');

    // Cost summary
    try {
      const costTracker = require('./cost-tracker');
      const dailyCost = costTracker.getDailyCost(this.projectRoot);
      if (dailyCost.total_tokens) {
        lines.push('*Token Usage:*');
        lines.push(`  Total: ${dailyCost.total_tokens.toLocaleString()} tokens`);
        if (dailyCost.by_agent) {
          for (const [agent, tokens] of Object.entries(dailyCost.by_agent)) {
            lines.push(`  ${agent.slice(0, 12)}: ${tokens.toLocaleString()}`);
          }
        }
        lines.push('');
      }
    } catch { /* cost tracker unavailable */ }

    // Recent commits
    try {
      const gitLog = execFileSync('git', ['log', '--oneline', '-5', '--since=yesterday'], {
        cwd: this.projectRoot, encoding: 'utf8', timeout: 10000
      });
      if (gitLog.trim()) {
        lines.push('*Recent Commits:*');
        for (const line of gitLog.trim().split('\n').slice(0, 5)) {
          lines.push(`  ${line}`);
        }
        lines.push('');
      }
    } catch { /* git unavailable */ }

    // Needs attention — pending escalations
    if (this._pendingApprovals.size > 0) {
      lines.push('*Needs Attention:*');
      for (const [id, approval] of this._pendingApprovals) {
        lines.push(`  [${approval.taskId}] ${approval.type}: ${approval.details || 'pending review'}`);
      }
    }

    return lines.join('\n');
  }

  // ==========================================================================
  // APPROVAL TIMEOUT TRACKING
  // ==========================================================================

  /**
   * Register a pending approval for timeout tracking.
   * Called when an escalation is sent to Telegram with approve/reject buttons.
   *
   * @param {string} approvalId
   * @param {object} details - { taskId, type, sessionId, chatId, details }
   */
  registerApproval(approvalId, details) {
    const timeoutMin = (this.policy.approval && this.policy.approval.timeout_minutes) || 60;
    this._pendingApprovals.set(approvalId, {
      ...details,
      expiresAt: Date.now() + timeoutMin * 60000,
      escalated: false,
    });
    this._savePendingApprovals();
  }

  /**
   * Check for expired approvals and auto-escalate.
   * @returns {Array<{action: string, result: object}>}
   */
  _checkApprovalTimeouts() {
    const results = [];
    const now = Date.now();

    for (const [id, approval] of this._pendingApprovals) {
      if (now >= approval.expiresAt && !approval.escalated) {
        // Mark as escalated to prevent re-escalation
        approval.escalated = true;

        // Auto-escalate to next level
        try {
          const escalation = require('./escalation');
          escalation.triggerEscalation(
            approval.type || 'approval_timeout',
            approval.sessionId,
            approval.taskId,
            { source: 'telegram_timeout', approvalId: id }
          );
        } catch { /* best effort */ }

        // Notify on Telegram
        this._writeOutbound({
          type: 'text',
          chatId: approval.chatId,
          text: `Approval timeout: \`${approval.taskId}\` (${approval.type}). Auto-escalated.`,
          parse_mode: 'Markdown',
        });

        results.push({
          action: 'approval_timeout',
          approvalId: id,
          taskId: approval.taskId,
          type: approval.type,
        });
      }
    }

    if (results.length > 0) {
      this._savePendingApprovals();
    }

    return results;
  }

  /**
   * Get count of pending approvals.
   * @returns {number}
   */
  get pendingApprovalCount() {
    return this._pendingApprovals.size;
  }

  /**
   * Get all pending approvals for display.
   * @returns {Array<{id: string, taskId: string, type: string, expiresAt: number}>}
   */
  getPendingApprovals() {
    const list = [];
    for (const [id, approval] of this._pendingApprovals) {
      list.push({ id, ...approval });
    }
    return list;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  TelegramConversations,

  // Path constants (for testing)
  INBOX_CURSOR_PATH,
  APPROVAL_STATE_PATH,
  CONVERSATION_HISTORY_PATH,
  MAX_HISTORY_TURNS,
  APPROVAL_CHECK_INTERVAL_MS,
};
