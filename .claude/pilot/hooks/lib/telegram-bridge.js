/**
 * Telegram Bridge — Standalone Daemon (Phase 6.5)
 *
 * Connects PM Daemon to a Telegram bot for remote human interface.
 * Uses pure Node.js HTTPS (no npm dependencies) with long polling.
 *
 * Inbound:  Telegram message → security validate → intent parse → PM inbox
 * Outbound: PM outbox watcher → Telegram delivery
 *
 * Runs as a launchd-compatible daemon with PID file and graceful shutdown.
 *
 * SECURITY INVARIANT: All inbound messages are parsed as intent.
 * Raw text NEVER reaches shell commands or terminal input.
 * PM interprets intent through its normal policy layer.
 *
 * Part of Phase 6.5 (Pilot AGI-6l3)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { parseIntent, validateSender, TokenBucket, audit, CONFIRMATION_REQUIRED } = require('./telegram-security');

// ============================================================================
// CONSTANTS
// ============================================================================

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const POLL_TIMEOUT_S = 30; // Long poll timeout
const OUTBOX_POLL_INTERVAL_MS = 5000;
const PM_INBOX_PATH = '.claude/pilot/state/telegram/pm-inbox.jsonl';
const PM_OUTBOX_PATH = '.claude/pilot/state/telegram/pm-outbox.jsonl';
const PM_OUTBOX_CURSOR_PATH = '.claude/pilot/state/telegram/outbox-cursor.json';
const PID_FILE_PATH = '.claude/pilot/state/telegram/bridge.pid';
const MAX_MESSAGE_LENGTH = 4096;

// ============================================================================
// TELEGRAM API CLIENT (Pure HTTPS)
// ============================================================================

/**
 * Make a Telegram Bot API request.
 *
 * @param {string} token - Bot token
 * @param {string} method - API method (e.g., 'getUpdates', 'sendMessage')
 * @param {object} [body] - Request body
 * @returns {Promise<object>} API response
 */
function telegramApi(token, method, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${TELEGRAM_API_BASE}${token}/${method}`);
    const postData = body ? JSON.stringify(body) : '';

    const options = {
      method: body ? 'POST' : 'GET',
      hostname: url.hostname,
      path: url.pathname,
      headers: body
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
        : {},
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            const err = new Error(`Telegram API error: ${parsed.description || 'unknown'}`);
            err.code = parsed.error_code;
            err.retryAfter = parsed.parameters && parsed.parameters.retry_after;
            reject(err);
          } else {
            resolve(parsed.result);
          }
        } catch (e) {
          reject(new Error(`Failed to parse Telegram response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(POLL_TIMEOUT_S * 1000 + 10000, () => {
      req.destroy(new Error('Telegram API request timeout'));
    });

    if (postData) req.write(postData);
    req.end();
  });
}

// ============================================================================
// MESSAGE FORMATTING
// ============================================================================

/**
 * Split a message into chunks respecting the 4096 char Telegram limit.
 * Tries to split at newlines to preserve formatting.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitMessage(text) {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Find last newline within limit
    let splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (splitAt <= 0) {
      // No newline found, hard split
      splitAt = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }

  return chunks;
}

/**
 * Escape Markdown V1 special characters for Telegram.
 * @param {string} text
 * @returns {string}
 */
function escapeMarkdown(text) {
  return text.replace(/([_*\[`])/g, '\\$1');
}

// ============================================================================
// HELP TEXT
// ============================================================================

const HELP_TEXT = `*Pilot AGI Telegram Bot*

*Commands:*
/status — System status overview
/ps — Active agent process table
/logs <taskId> — Tail agent logs
/kill <taskId> — Stop an agent
/approve [taskId] — Approve pending escalation
/reject [taskId] — Reject pending escalation
/morning — Morning report
/budget — Cost summary
/help — This message

*Natural Language:*
"what's the status?" — Status overview
"pause all agents" — Pause everything
"resume work" — Resume agents
"prioritize auth flow" — Change priority
"add idea: dark mode" — Capture idea

*Emergency:*
Send LOCKDOWN to immediately stop all agents.`;

// ============================================================================
// TELEGRAM BRIDGE CLASS
// ============================================================================

class TelegramBridge {
  /**
   * @param {object} opts
   * @param {string} opts.token - Telegram bot token
   * @param {number[]} opts.allowedChatIds - Authorized chat IDs
   * @param {string} opts.projectRoot - Project root path
   * @param {object} [opts.rateLimit] - { per_minute, per_hour }
   * @param {string} [opts.killSwitchPhrase] - Custom kill switch phrase
   * @param {object} [opts.notifications] - Which notifications to send
   * @param {object} [opts.approval] - { enabled, timeout_minutes }
   */
  constructor(opts) {
    this.token = opts.token;
    this.allowedChatIds = opts.allowedChatIds || [];
    this.projectRoot = opts.projectRoot;
    this.killSwitchPhrase = opts.killSwitchPhrase || 'LOCKDOWN';
    this.notifications = opts.notifications || {};
    this.approval = opts.approval || { enabled: true, timeout_minutes: 60 };
    this.rateLimiter = new TokenBucket(opts.rateLimit);

    this._offset = 0; // Telegram update offset
    this._running = false;
    this._pollTimer = null;
    this._outboxTimer = null;
    this._pendingApprovals = new Map(); // approvalId -> { taskId, type, chatId, expiresAt, messageId }
    this._lockdown = false;

    // Hooks for testability — override to intercept
    this._onIntent = null; // (chatId, intent) => void
    this._onOutbound = null; // (chatId, message) => void
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /**
   * Start the bridge: begin polling Telegram and watching PM outbox.
   */
  async start() {
    if (this._running) return;
    this._running = true;

    // Validate token
    try {
      const me = await telegramApi(this.token, 'getMe');
      this._botUsername = me.username;
    } catch (e) {
      throw new Error(`Invalid Telegram bot token: ${e.message}`);
    }

    // Write PID file
    this._writePidFile();

    // Start polling loops
    this._pollLoop();
    this._startOutboxWatcher();

    return { username: this._botUsername };
  }

  /**
   * Stop the bridge gracefully.
   */
  async stop() {
    this._running = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._outboxTimer) {
      clearInterval(this._outboxTimer);
      this._outboxTimer = null;
    }
    this._removePidFile();
  }

  // ==========================================================================
  // INBOUND: Telegram → PM
  // ==========================================================================

  /**
   * Long-poll Telegram for updates and process them.
   */
  async _pollLoop() {
    while (this._running) {
      try {
        const updates = await telegramApi(this.token, 'getUpdates', {
          offset: this._offset,
          timeout: POLL_TIMEOUT_S,
          allowed_updates: ['message', 'callback_query'],
        });

        for (const update of updates) {
          this._offset = update.update_id + 1;

          if (update.message) {
            await this._handleMessage(update.message);
          } else if (update.callback_query) {
            await this._handleCallbackQuery(update.callback_query);
          }
        }
      } catch (e) {
        if (e.retryAfter) {
          // Rate limited — wait
          await this._sleep(e.retryAfter * 1000);
        } else if (this._running) {
          // Network error — back off
          await this._sleep(5000);
        }
      }
    }
  }

  /**
   * Handle an inbound text message.
   * @param {object} msg - Telegram message object
   */
  async _handleMessage(msg) {
    const chatId = msg.chat.id;
    const text = msg.text || '';
    const username = msg.from && msg.from.username || 'unknown';

    // 1. Authentication
    const { authorized } = validateSender(chatId, this.allowedChatIds);
    if (!authorized) {
      audit(this.projectRoot, {
        event: 'BLOCKED',
        chatId,
        username,
        action: 'unauthorized_message',
        details: text.slice(0, 100),
      });
      return; // Silent rejection — don't reveal bot exists
    }

    // 2. Rate limiting
    const { allowed, retryAfterMs } = this.rateLimiter.consume(chatId);
    if (!allowed) {
      audit(this.projectRoot, {
        event: 'RATE_LIMITED',
        chatId,
        username,
        details: `retry_after_ms=${retryAfterMs}`,
      });
      await this._sendText(chatId, `Rate limit reached. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`);
      return;
    }

    // 3. Parse intent
    const intent = parseIntent(text, this.killSwitchPhrase);

    // 4. Audit
    audit(this.projectRoot, {
      event: 'INBOUND',
      chatId,
      username,
      action: intent.action,
      details: text.slice(0, 200),
    });

    // 5. Handle lockdown immediately
    if (intent.action === 'lockdown') {
      this._lockdown = true;
      await this._writeToInbox({ action: 'lockdown', chatId, timestamp: new Date().toISOString() });
      await this._sendText(chatId, 'LOCKDOWN ACTIVATED. All agents will be stopped immediately.');
      return;
    }

    // 6. Check lockdown — reject all non-lockdown actions during lockdown
    if (this._lockdown) {
      await this._sendText(chatId, 'System is in LOCKDOWN. Only LOCKDOWN command accepted.');
      return;
    }

    // 7. Handle help locally (no PM needed)
    if (intent.action === 'help') {
      await this._sendText(chatId, HELP_TEXT, { parse_mode: 'Markdown' });
      return;
    }

    // 8. Check if action requires confirmation
    if (CONFIRMATION_REQUIRED.has(intent.action)) {
      const confirmId = `confirm_${Date.now()}`;
      this._pendingApprovals.set(confirmId, {
        chatId,
        intent,
        expiresAt: Date.now() + 120000, // 2 min to confirm
      });

      await this._sendText(chatId, `Are you sure you want to *${intent.action.replace(/_/g, ' ')}*?`, {
        parse_mode: 'Markdown',
        reply_markup: JSON.stringify({
          inline_keyboard: [[
            { text: 'Yes, proceed', callback_data: `confirm:${confirmId}` },
            { text: 'Cancel', callback_data: `cancel:${confirmId}` },
          ]],
        }),
      });
      return;
    }

    // 9. Forward to PM inbox
    await this._writeToInbox({
      action: intent.action,
      ...intent,
      chatId,
      username,
      timestamp: new Date().toISOString(),
    });

    // 10. Invoke hook if set (testing)
    if (this._onIntent) this._onIntent(chatId, intent);

    // 11. Acknowledge
    if (intent.action === 'unknown') {
      await this._sendText(chatId,
        `I didn't understand that. Send /help for available commands.`);
    } else {
      await this._sendText(chatId, `Processing: ${intent.action.replace(/_/g, ' ')}...`);
    }
  }

  /**
   * Handle an inline keyboard callback query.
   * @param {object} query - Telegram callback query
   */
  async _handleCallbackQuery(query) {
    const chatId = query.message && query.message.chat.id;
    const data = query.data || '';
    const [action, id] = data.split(':');

    // Auth check
    const { authorized } = validateSender(chatId, this.allowedChatIds);
    if (!authorized) return;

    audit(this.projectRoot, {
      event: 'CALLBACK',
      chatId,
      action: `${action}:${id}`,
    });

    // Confirmation flow (dangerous actions)
    if (action === 'confirm') {
      const pending = this._pendingApprovals.get(id);
      if (!pending || Date.now() > pending.expiresAt) {
        await this._answerCallback(query.id, 'Expired. Send the command again.');
        return;
      }
      this._pendingApprovals.delete(id);

      // Forward confirmed intent to PM inbox
      await this._writeToInbox({
        ...pending.intent,
        chatId: pending.chatId,
        confirmed: true,
        timestamp: new Date().toISOString(),
      });

      await this._editMessage(chatId, query.message.message_id,
        `Confirmed: ${pending.intent.action.replace(/_/g, ' ')}`);
      await this._answerCallback(query.id, 'Confirmed');
      return;
    }

    if (action === 'cancel') {
      this._pendingApprovals.delete(id);
      await this._editMessage(chatId, query.message.message_id, 'Cancelled.');
      await this._answerCallback(query.id, 'Cancelled');
      return;
    }

    // Approve/reject escalation
    if (action === 'approve' || action === 'reject') {
      const approval = this._pendingApprovals.get(id);
      if (!approval) {
        await this._answerCallback(query.id, 'Approval expired');
        return;
      }
      this._pendingApprovals.delete(id);

      await this._writeToInbox({
        action: action === 'approve' ? 'approve_escalation' : 'reject_escalation',
        approvalId: id,
        taskId: approval.taskId,
        type: approval.type,
        chatId,
        timestamp: new Date().toISOString(),
      });

      const label = action === 'approve' ? 'Approved' : 'Rejected';
      await this._editMessage(chatId, query.message.message_id,
        `${label}: ${approval.summary || approval.taskId}`);
      await this._answerCallback(query.id, label);
      return;
    }

    await this._answerCallback(query.id, 'Unknown action');
  }

  // ==========================================================================
  // OUTBOUND: PM → Telegram
  // ==========================================================================

  /**
   * Start watching PM outbox for messages to send to Telegram.
   */
  _startOutboxWatcher() {
    this._outboxTimer = setInterval(() => {
      this._processOutbox().catch(() => {});
    }, OUTBOX_POLL_INTERVAL_MS);
  }

  /**
   * Read unprocessed messages from PM outbox and send them.
   */
  async _processOutbox() {
    const outboxPath = path.join(this.projectRoot, PM_OUTBOX_PATH);
    if (!fs.existsSync(outboxPath)) return;

    const cursorPath = path.join(this.projectRoot, PM_OUTBOX_CURSOR_PATH);
    let cursor = 0;
    try {
      if (fs.existsSync(cursorPath)) {
        cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8')).offset || 0;
      }
    } catch { /* start from 0 */ }

    const content = fs.readFileSync(outboxPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);

    let processed = 0;
    for (let i = cursor; i < lines.length; i++) {
      try {
        const msg = JSON.parse(lines[i]);
        await this._deliverOutbound(msg);
        processed++;
      } catch { /* skip malformed */ }
    }

    if (processed > 0) {
      // Update cursor
      const dir = path.dirname(cursorPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(cursorPath, JSON.stringify({ offset: lines.length }));
    }
  }

  /**
   * Deliver a single outbound message to Telegram.
   *
   * @param {object} msg - { chatId?, type, text?, data?, parse_mode? }
   */
  async _deliverOutbound(msg) {
    const chatId = msg.chatId || this.allowedChatIds[0];
    if (!chatId) return;

    if (this._onOutbound) this._onOutbound(chatId, msg);

    switch (msg.type) {
      case 'text':
        await this._sendText(chatId, msg.text, { parse_mode: msg.parse_mode });
        break;

      case 'escalation':
        await this._sendEscalation(chatId, msg.data);
        break;

      case 'task_complete':
        await this._sendText(chatId,
          `*Task Complete*\n\`${msg.data.taskId}\`\n${msg.data.summary || ''}`,
          { parse_mode: 'Markdown' });
        break;

      case 'error':
        await this._sendText(chatId,
          `*Agent Error*\n\`${msg.data.taskId}\`\n\`\`\`\n${(msg.data.error || '').slice(0, 3000)}\n\`\`\``,
          { parse_mode: 'Markdown' });
        break;

      case 'morning_report':
        await this._sendText(chatId, msg.text || msg.data, { parse_mode: 'Markdown' });
        break;

      default:
        await this._sendText(chatId, msg.text || JSON.stringify(msg.data || {}));
        break;
    }

    audit(this.projectRoot, {
      event: 'OUTBOUND',
      chatId,
      type: msg.type,
      details: (msg.text || '').slice(0, 100),
    });
  }

  /**
   * Send an escalation with inline approve/reject buttons.
   */
  async _sendEscalation(chatId, escalation) {
    const approvalId = `esc_${Date.now()}`;
    const text = [
      `*Escalation: ${escapeMarkdown(escalation.type || 'unknown')}*`,
      `Task: \`${escalation.taskId || 'N/A'}\``,
      `Level: ${escalation.level || 'unknown'}`,
      `Details: ${escapeMarkdown(escalation.details || 'No details')}`,
    ].join('\n');

    const result = await this._sendText(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: JSON.stringify({
        inline_keyboard: [[
          { text: 'Approve', callback_data: `approve:${approvalId}` },
          { text: 'Reject', callback_data: `reject:${approvalId}` },
        ]],
      }),
    });

    this._pendingApprovals.set(approvalId, {
      taskId: escalation.taskId,
      type: escalation.type,
      summary: escalation.details,
      chatId,
      messageId: result && result.message_id,
      expiresAt: Date.now() + (this.approval.timeout_minutes || 60) * 60000,
    });
  }

  // ==========================================================================
  // TELEGRAM API HELPERS
  // ==========================================================================

  async _sendText(chatId, text, opts = {}) {
    const chunks = splitMessage(text);
    let lastResult = null;

    for (const chunk of chunks) {
      const body = {
        chat_id: chatId,
        text: chunk,
        ...opts,
      };
      // Parse reply_markup if string
      if (typeof body.reply_markup === 'string') {
        body.reply_markup = JSON.parse(body.reply_markup);
      }
      lastResult = await telegramApi(this.token, 'sendMessage', body);
    }

    return lastResult;
  }

  async _editMessage(chatId, messageId, text) {
    return telegramApi(this.token, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
    });
  }

  async _answerCallback(callbackQueryId, text) {
    return telegramApi(this.token, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  // ==========================================================================
  // PM INBOX / OUTBOX
  // ==========================================================================

  /**
   * Write intent to PM inbox (file-based message queue).
   */
  async _writeToInbox(intent) {
    const inboxPath = path.join(this.projectRoot, PM_INBOX_PATH);
    const dir = path.dirname(inboxPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(inboxPath, JSON.stringify(intent) + '\n');
  }

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  _sleep(ms) {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      // Allow stop() to break out of sleep
      if (!this._running) {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  _writePidFile() {
    const pidPath = path.join(this.projectRoot, PID_FILE_PATH);
    const dir = path.dirname(pidPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pidPath, String(process.pid));
  }

  _removePidFile() {
    const pidPath = path.join(this.projectRoot, PID_FILE_PATH);
    try { fs.unlinkSync(pidPath); } catch { /* may not exist */ }
  }

  /**
   * Get the current lockdown state.
   * @returns {boolean}
   */
  get isLockedDown() {
    return this._lockdown;
  }

  /**
   * Reset lockdown (for PM to use after recovery).
   */
  resetLockdown() {
    this._lockdown = false;
  }
}

// ============================================================================
// STATIC HELPERS (for PM daemon integration)
// ============================================================================

/**
 * Write a message to the Telegram outbox for the bridge to deliver.
 *
 * @param {string} projectRoot
 * @param {object} msg - { chatId?, type, text?, data?, parse_mode? }
 */
function writeToOutbox(projectRoot, msg) {
  const outboxPath = path.join(projectRoot, PM_OUTBOX_PATH);
  const dir = path.dirname(outboxPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(outboxPath, JSON.stringify({ ...msg, timestamp: new Date().toISOString() }) + '\n');
}

/**
 * Read unprocessed intent messages from the PM inbox.
 *
 * @param {string} projectRoot
 * @param {number} [cursor=0] - Line offset to start reading from
 * @returns {{ messages: object[], newCursor: number }}
 */
function readInbox(projectRoot, cursor = 0) {
  const inboxPath = path.join(projectRoot, PM_INBOX_PATH);
  if (!fs.existsSync(inboxPath)) return { messages: [], newCursor: 0 };

  const lines = fs.readFileSync(inboxPath, 'utf8').trim().split('\n').filter(Boolean);
  const messages = [];
  for (let i = cursor; i < lines.length; i++) {
    try { messages.push(JSON.parse(lines[i])); } catch { /* skip */ }
  }

  return { messages, newCursor: lines.length };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  TelegramBridge,
  telegramApi,
  splitMessage,
  escapeMarkdown,
  writeToOutbox,
  readInbox,

  // Path constants (for testing)
  PM_INBOX_PATH,
  PM_OUTBOX_PATH,
  PM_OUTBOX_CURSOR_PATH,
  PID_FILE_PATH,
  MAX_MESSAGE_LENGTH,
  HELP_TEXT,
};
