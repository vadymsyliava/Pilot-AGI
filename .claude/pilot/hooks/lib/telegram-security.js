/**
 * Telegram Security Module (Phase 6.5)
 *
 * Provides authentication, rate limiting, intent parsing, and audit
 * logging for the Telegram bridge. Key security invariant: messages
 * are parsed as INTENT, never forwarded as raw shell commands.
 *
 * Part of Phase 6.5 (Pilot AGI-6l3)
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const AUDIT_LOG_PATH = '.claude/pilot/state/telegram/audit.jsonl';
const DEFAULT_RATE_LIMIT = { per_minute: 10, per_hour: 100 };
const DEFAULT_KILL_SWITCH_PHRASE = 'LOCKDOWN';

/**
 * Actions that require double confirmation via inline keyboard callback.
 */
const CONFIRMATION_REQUIRED = new Set([
  'pause_all',
  'cancel_sprint',
  'kill_agent',
  'change_priority',
  'reset',
]);

// ============================================================================
// INTENT PATTERNS
// ============================================================================

/**
 * Ordered intent matchers. First match wins.
 * Each entry: { pattern: RegExp, action: string, extract?: (match) => object }
 *
 * SECURITY: No pattern maps to raw shell execution. All intents are
 * structured actions that PM interprets through its policy layer.
 */
const INTENT_PATTERNS = [
  // Kill switch — highest priority
  {
    pattern: /^LOCKDOWN$/i,
    action: 'lockdown',
    extract: () => ({}),
  },
  // Status queries
  {
    pattern: /(?:what(?:'s| is) the )?status\??$/i,
    action: 'status',
    extract: () => ({}),
  },
  {
    pattern: /\/status/i,
    action: 'status',
    extract: () => ({}),
  },
  // Process table
  {
    pattern: /\/ps|(?:show|list) (?:agents?|processes?)/i,
    action: 'ps',
    extract: () => ({}),
  },
  // Logs
  {
    pattern: /\/logs?\s+(.+)/i,
    action: 'logs',
    extract: (m) => ({ taskId: m[1].trim() }),
  },
  {
    pattern: /(?:show|tail|get) logs?\s+(?:for\s+)?(.+)/i,
    action: 'logs',
    extract: (m) => ({ taskId: m[1].trim() }),
  },
  // Kill agent
  {
    pattern: /\/kill\s+(.+)/i,
    action: 'kill_agent',
    extract: (m) => ({ taskId: m[1].trim() }),
  },
  {
    pattern: /(?:stop|kill|terminate)\s+(?:agent\s+)?(?:for\s+)?(.+)/i,
    action: 'kill_agent',
    extract: (m) => ({ taskId: m[1].trim() }),
  },
  // Pause
  {
    pattern: /\/pause(?:\s+(.+))?/i,
    action: 'pause',
    extract: (m) => ({ scope: (m[1] || 'all').trim() }),
  },
  {
    pattern: /pause\s+(?:all\s+)?(?:agents?|work|everything)/i,
    action: 'pause_all',
    extract: () => ({ scope: 'all' }),
  },
  {
    pattern: /pause\s+(.+?)(?:\s+agents?)?$/i,
    action: 'pause',
    extract: (m) => ({ scope: m[1].trim() }),
  },
  // Resume
  {
    pattern: /\/resume(?:\s+(.+))?/i,
    action: 'resume',
    extract: (m) => ({ scope: (m[1] || 'all').trim() }),
  },
  {
    pattern: /resume\s+(?:all\s+)?(?:agents?|work|everything)/i,
    action: 'resume',
    extract: () => ({ scope: 'all' }),
  },
  // Approve / Reject
  {
    pattern: /\/approve(?:\s+(.+))?/i,
    action: 'approve',
    extract: (m) => ({ taskId: (m[1] || '').trim() || null }),
  },
  {
    pattern: /\/reject(?:\s+(.+))?/i,
    action: 'reject',
    extract: (m) => ({ taskId: (m[1] || '').trim() || null }),
  },
  // Morning report
  {
    pattern: /\/morning|morning report/i,
    action: 'morning_report',
    extract: () => ({}),
  },
  // Budget
  {
    pattern: /\/budget|(?:show|what(?:'s| is)) (?:the )?(?:budget|cost|spending)/i,
    action: 'budget',
    extract: () => ({}),
  },
  // Help
  {
    pattern: /\/help|(?:what )?(?:can|commands?)\s+(?:you|i)\s+(?:do|use)\??/i,
    action: 'help',
    extract: () => ({}),
  },
  // Idea capture
  {
    pattern: /(?:add|create|note)\s+(?:idea|task|todo)[\s:]+(.+)/i,
    action: 'idea',
    extract: (m) => ({ text: m[1].trim() }),
  },
  // Priority change
  {
    pattern: /(?:prioritize|priority|focus(?:\s+on)?)\s+(.+)/i,
    action: 'change_priority',
    extract: (m) => ({ text: m[1].trim() }),
  },
  // Cancel sprint
  {
    pattern: /cancel\s+(?:the\s+)?sprint/i,
    action: 'cancel_sprint',
    extract: () => ({}),
  },
  // Reset
  {
    pattern: /reset\s+(?:all|everything)/i,
    action: 'reset',
    extract: () => ({}),
  },
];

// ============================================================================
// RATE LIMITER — Token Bucket
// ============================================================================

class TokenBucket {
  constructor(limits = DEFAULT_RATE_LIMIT) {
    this.limits = limits;
    // Per-user buckets: chatId -> { minute: { tokens, refillAt }, hour: { tokens, refillAt } }
    this.buckets = new Map();
  }

  /**
   * Check if a request is allowed. Consumes a token if so.
   * @param {number} chatId
   * @returns {{ allowed: boolean, retryAfterMs?: number }}
   */
  consume(chatId) {
    const now = Date.now();
    let bucket = this.buckets.get(chatId);
    if (!bucket) {
      bucket = {
        minute: { tokens: this.limits.per_minute, refillAt: now + 60000 },
        hour: { tokens: this.limits.per_hour, refillAt: now + 3600000 },
      };
      this.buckets.set(chatId, bucket);
    }

    // Refill if window expired
    if (now >= bucket.minute.refillAt) {
      bucket.minute.tokens = this.limits.per_minute;
      bucket.minute.refillAt = now + 60000;
    }
    if (now >= bucket.hour.refillAt) {
      bucket.hour.tokens = this.limits.per_hour;
      bucket.hour.refillAt = now + 3600000;
    }

    // Check minute limit
    if (bucket.minute.tokens <= 0) {
      return { allowed: false, retryAfterMs: bucket.minute.refillAt - now };
    }
    // Check hour limit
    if (bucket.hour.tokens <= 0) {
      return { allowed: false, retryAfterMs: bucket.hour.refillAt - now };
    }

    bucket.minute.tokens--;
    bucket.hour.tokens--;
    return { allowed: true };
  }

  /**
   * Reset all buckets (for testing).
   */
  reset() {
    this.buckets.clear();
  }
}

// ============================================================================
// INTENT PARSER
// ============================================================================

/**
 * Parse a natural language message into a structured intent.
 * SECURITY INVARIANT: Never returns raw shell commands. All outputs are
 * structured action objects that PM interprets through policy.
 *
 * @param {string} text - Raw message text
 * @param {string} [killSwitchPhrase] - Custom kill switch phrase
 * @returns {{ action: string, [key: string]: any }}
 */
function parseIntent(text, killSwitchPhrase) {
  if (!text || typeof text !== 'string') {
    return { action: 'unknown', raw: '' };
  }

  const trimmed = text.trim();

  // Check custom kill switch phrase first
  const phrase = killSwitchPhrase || DEFAULT_KILL_SWITCH_PHRASE;
  if (trimmed.toUpperCase() === phrase.toUpperCase()) {
    return { action: 'lockdown' };
  }

  for (const { pattern, action, extract } of INTENT_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      const extra = extract ? extract(match) : {};
      return { action, ...extra };
    }
  }

  return { action: 'unknown', raw: trimmed };
}

// ============================================================================
// AUTHENTICATION
// ============================================================================

/**
 * Validate a message sender against the allowlist.
 *
 * @param {number} chatId - Telegram chat ID
 * @param {number[]} allowedChatIds - Allowlist of numeric chat IDs
 * @returns {{ authorized: boolean }}
 */
function validateSender(chatId, allowedChatIds) {
  if (!Array.isArray(allowedChatIds) || allowedChatIds.length === 0) {
    // No allowlist configured = reject all (secure default)
    return { authorized: false };
  }
  return { authorized: allowedChatIds.includes(chatId) };
}

// ============================================================================
// AUDIT LOGGING
// ============================================================================

/**
 * Append an audit entry to the Telegram audit log.
 *
 * @param {string} projectRoot
 * @param {object} entry - { event, chatId, username, action, details, timestamp }
 */
function audit(projectRoot, entry) {
  const logPath = path.join(projectRoot, AUDIT_LOG_PATH);
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const record = {
    timestamp: new Date().toISOString(),
    ...entry,
  };

  fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
}

/**
 * Read recent audit entries.
 *
 * @param {string} projectRoot
 * @param {number} [limit=50]
 * @returns {object[]}
 */
function readAuditLog(projectRoot, limit = 50) {
  const logPath = path.join(projectRoot, AUDIT_LOG_PATH);
  if (!fs.existsSync(logPath)) return [];

  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  return lines
    .slice(-limit)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Intent parsing
  parseIntent,
  INTENT_PATTERNS,
  CONFIRMATION_REQUIRED,

  // Authentication
  validateSender,

  // Rate limiting
  TokenBucket,

  // Audit
  audit,
  readAuditLog,
  AUDIT_LOG_PATH,

  // Constants
  DEFAULT_RATE_LIMIT,
  DEFAULT_KILL_SWITCH_PHRASE,
};
