/**
 * Inter-Agent Messaging
 *
 * File-based message bus for cross-terminal agent communication.
 * Uses append-only JSONL with cursor-based reading.
 *
 * Part of Phase 2.3 — Inter-Agent Messaging (Pilot AGI-oi1)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================================
// CONSTANTS
// ============================================================================

const MESSAGE_BUS_PATH = '.claude/pilot/messages/bus.jsonl';
const CURSOR_DIR = '.claude/pilot/messages/cursors';
const ARCHIVE_DIR = '.claude/pilot/messages/archive';
const NUDGE_DIR = '.claude/pilot/messages/nudge';

const MSG_SIZE_LIMIT = 4000; // bytes, within PIPE_BUF for safety
const COMPACTION_THRESHOLD = 1024 * 1024; // 1MB
const CURSOR_PROCESSED_MAX = 100;
const DEFAULT_TTL_MS = {
  blocking: 30000,   // 30 seconds
  normal: 300000,    // 5 minutes
  fyi: 300000        // 5 minutes
};
const DEFAULT_ACK_DEADLINE_MS = 30000; // 30 seconds

const VALID_TYPES = ['request', 'response', 'notify', 'task_delegate', 'broadcast'];
const VALID_PRIORITIES = ['blocking', 'normal', 'fyi'];

// ============================================================================
// PATH HELPERS
// ============================================================================

function getBusPath() {
  return path.join(process.cwd(), MESSAGE_BUS_PATH);
}

function getCursorDir() {
  return path.join(process.cwd(), CURSOR_DIR);
}

function getCursorPath(sessionId) {
  return path.join(getCursorDir(), `${sessionId}.cursor.json`);
}

function getArchiveDir() {
  return path.join(process.cwd(), ARCHIVE_DIR);
}

function getNudgeDir() {
  return path.join(process.cwd(), NUDGE_DIR);
}

// ============================================================================
// MESSAGE ID GENERATION
// ============================================================================

/**
 * Generate a unique message ID
 * Format: M-<timestamp36>-<random4hex>
 */
function generateMessageId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(2).toString('hex');
  return `M-${ts}-${rand}`;
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate a message object before sending
 * @param {object} msg - The message to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateMessage(msg) {
  const errors = [];

  if (!msg.type || !VALID_TYPES.includes(msg.type)) {
    errors.push(`Invalid type: ${msg.type}. Must be one of: ${VALID_TYPES.join(', ')}`);
  }

  if (!msg.from) {
    errors.push('Missing required field: from');
  }

  if (!msg.priority || !VALID_PRIORITIES.includes(msg.priority)) {
    errors.push(`Invalid priority: ${msg.priority}. Must be one of: ${VALID_PRIORITIES.join(', ')}`);
  }

  if (msg.type === 'response' && !msg.correlation_id) {
    errors.push('Response messages require correlation_id');
  }

  if (msg.type === 'request' && !msg.to) {
    errors.push('Request messages require a recipient (to)');
  }

  if (msg.type === 'task_delegate' && !msg.to) {
    errors.push('Task delegation requires a recipient (to)');
  }

  // Size check (estimate serialized size)
  const serialized = JSON.stringify(msg);
  if (serialized.length > MSG_SIZE_LIMIT) {
    errors.push(`Message exceeds size limit: ${serialized.length} > ${MSG_SIZE_LIMIT} bytes`);
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// SEND
// ============================================================================

/**
 * Send a message to the bus
 * @param {object} msg - Message object (type, from, to, priority, payload, etc.)
 * @returns {{ success: boolean, id?: string, error?: string }}
 */
function sendMessage(msg) {
  const validation = validateMessage(msg);
  if (!validation.valid) {
    return {
      success: false,
      error: `Validation failed: ${validation.errors.join('; ')}`
    };
  }

  const busPath = getBusPath();
  const dir = path.dirname(busPath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const id = msg.id || generateMessageId();
  const ttl_ms = msg.ttl_ms || DEFAULT_TTL_MS[msg.priority] || DEFAULT_TTL_MS.normal;

  const fullMessage = {
    id,
    ts: new Date().toISOString(),
    type: msg.type,
    from: msg.from,
    priority: msg.priority,
    ttl_ms,
    ...msg,
    id, // ensure id is not overridden by spread
  };

  const line = JSON.stringify(fullMessage) + '\n';

  // Atomic append (safe for multi-process, empirically verified)
  fs.appendFileSync(busPath, line);

  // Nudge recipient for blocking messages
  if (msg.priority === 'blocking' && msg.to && msg.to !== '*') {
    nudgeSession(msg.to);
  }

  return { success: true, id };
}

/**
 * Touch a nudge file to signal a session to check the bus immediately
 */
function nudgeSession(sessionId) {
  const nudgeDir = getNudgeDir();
  try {
    if (!fs.existsSync(nudgeDir)) {
      fs.mkdirSync(nudgeDir, { recursive: true });
    }
    const nudgePath = path.join(nudgeDir, sessionId);
    fs.writeFileSync(nudgePath, Date.now().toString());
  } catch (e) {
    // Non-critical — polling will catch it
  }
}

/**
 * Check and clear nudge for a session
 * @returns {boolean} true if nudge was present
 */
function checkNudge(sessionId) {
  const nudgePath = path.join(getNudgeDir(), sessionId);
  try {
    if (fs.existsSync(nudgePath)) {
      fs.unlinkSync(nudgePath);
      return true;
    }
  } catch (e) {
    // Ignore
  }
  return false;
}

// ============================================================================
// CURSOR MANAGEMENT
// ============================================================================

/**
 * Load cursor for a session
 * @returns {{ session_id: string, last_seq: number, byte_offset: number, processed_ids: string[], updated_at: string } | null}
 */
function loadCursor(sessionId) {
  const cursorPath = getCursorPath(sessionId);
  try {
    if (fs.existsSync(cursorPath)) {
      return JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
    }
  } catch (e) {
    // Corrupt cursor — start fresh
  }
  return null;
}

/**
 * Write cursor atomically (write-then-rename)
 */
function writeCursor(sessionId, cursorData) {
  const cursorDir = getCursorDir();
  if (!fs.existsSync(cursorDir)) {
    fs.mkdirSync(cursorDir, { recursive: true });
  }

  const cursorPath = getCursorPath(sessionId);
  const tmpPath = cursorPath + '.tmp';

  const data = {
    ...cursorData,
    session_id: sessionId,
    updated_at: new Date().toISOString()
  };

  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, cursorPath);
}

/**
 * Initialize cursor at end of bus (for new sessions)
 */
function initializeCursor(sessionId) {
  const busPath = getBusPath();
  let byteOffset = 0;

  try {
    if (fs.existsSync(busPath)) {
      const stats = fs.statSync(busPath);
      byteOffset = stats.size;
    }
  } catch (e) {
    // Start from 0
  }

  const cursor = {
    session_id: sessionId,
    last_seq: -1,
    byte_offset: byteOffset,
    processed_ids: [],
    updated_at: new Date().toISOString()
  };

  writeCursor(sessionId, cursor);
  return cursor;
}

/**
 * Remove cursor for a session (on session end)
 */
function removeCursor(sessionId) {
  const cursorPath = getCursorPath(sessionId);
  try {
    if (fs.existsSync(cursorPath)) {
      fs.unlinkSync(cursorPath);
    }
  } catch (e) {
    // Ignore
  }
}

// ============================================================================
// READ
// ============================================================================

/**
 * Read new messages for a session from cursor position
 * @param {string} sessionId - The reading session
 * @param {object} opts - Options
 * @param {string[]} opts.types - Filter by message types
 * @param {string[]} opts.topics - Filter by topics
 * @param {boolean} opts.includeExpired - Include expired messages (default: false)
 * @returns {{ messages: object[], cursor: object }}
 */
function readMessages(sessionId, opts = {}) {
  const busPath = getBusPath();

  if (!fs.existsSync(busPath)) {
    return { messages: [], cursor: loadCursor(sessionId) || initializeCursor(sessionId) };
  }

  let cursor = loadCursor(sessionId);
  if (!cursor) {
    cursor = initializeCursor(sessionId);
  }

  // Read bus from cursor offset
  const fd = fs.openSync(busPath, 'r');
  const stats = fs.fstatSync(fd);

  if (stats.size <= cursor.byte_offset) {
    fs.closeSync(fd);
    return { messages: [], cursor };
  }

  const bufferSize = stats.size - cursor.byte_offset;
  const buffer = Buffer.alloc(bufferSize);
  fs.readSync(fd, buffer, 0, bufferSize, cursor.byte_offset);
  fs.closeSync(fd);

  const content = buffer.toString('utf8');
  const lines = content.split('\n').filter(l => l.trim());

  const now = Date.now();
  const messages = [];
  let lastSeq = cursor.last_seq;
  const processedIds = new Set(cursor.processed_ids || []);

  for (const line of lines) {
    try {
      const msg = JSON.parse(line);

      // Skip already processed (dedup on crash recovery)
      if (processedIds.has(msg.id)) continue;

      // Skip expired messages unless requested
      if (!opts.includeExpired && msg.ts && msg.ttl_ms) {
        const expiresAt = new Date(msg.ts).getTime() + msg.ttl_ms;
        if (now > expiresAt) continue;
      }

      // Filter by recipient: only messages addressed to this session, broadcast, or '*'
      if (msg.to && msg.to !== sessionId && msg.to !== '*' && msg.type !== 'broadcast') {
        continue;
      }

      // Filter by type if specified
      if (opts.types && !opts.types.includes(msg.type)) continue;

      // Filter by topic if specified
      if (opts.topics && msg.topic && !opts.topics.includes(msg.topic)) continue;

      messages.push(msg);

      if (msg.seq !== undefined && msg.seq > lastSeq) {
        lastSeq = msg.seq;
      }
    } catch (e) {
      // Skip malformed lines
    }
  }

  // Update cursor position (advance to end of what we read)
  const newCursor = {
    ...cursor,
    last_seq: lastSeq,
    byte_offset: stats.size,
    processed_ids: cursor.processed_ids || []
  };

  return { messages, cursor: newCursor };
}

/**
 * Mark messages as processed and advance cursor
 * @param {string} sessionId
 * @param {object} cursor - The cursor from readMessages
 * @param {string[]} processedMsgIds - IDs of messages that were processed
 */
function acknowledgeMessages(sessionId, cursor, processedMsgIds = []) {
  const processedSet = new Set(cursor.processed_ids || []);

  for (const id of processedMsgIds) {
    processedSet.add(id);
  }

  // Trim to max size (keep most recent)
  let processedIds = Array.from(processedSet);
  if (processedIds.length > CURSOR_PROCESSED_MAX) {
    processedIds = processedIds.slice(processedIds.length - CURSOR_PROCESSED_MAX);
  }

  writeCursor(sessionId, {
    ...cursor,
    processed_ids: processedIds
  });
}

// ============================================================================
// CONVENIENCE SENDERS
// ============================================================================

/**
 * Send a request (expects a response)
 */
function sendRequest(from, to, topic, payload, opts = {}) {
  return sendMessage({
    type: 'request',
    from,
    to,
    topic,
    priority: opts.priority || 'normal',
    payload: { action: topic, data: payload },
    ttl_ms: opts.ttl_ms || DEFAULT_TTL_MS[opts.priority || 'normal'],
    ack: {
      required: true,
      deadline_ms: opts.deadline_ms || DEFAULT_ACK_DEADLINE_MS
    }
  });
}

/**
 * Send a response to a request
 */
function sendResponse(from, correlationId, payload, opts = {}) {
  return sendMessage({
    type: 'response',
    from,
    to: opts.to, // usually the original sender
    priority: 'normal',
    correlation_id: correlationId,
    payload: { data: payload },
    ttl_ms: opts.ttl_ms || DEFAULT_TTL_MS.normal
  });
}

/**
 * Send a fire-and-forget notification
 */
function sendNotification(from, to, topic, payload) {
  return sendMessage({
    type: 'notify',
    from,
    to,
    topic,
    priority: 'fyi',
    payload: { action: topic, data: payload }
  });
}

/**
 * Send a broadcast to all agents
 */
function sendBroadcast(from, topic, payload) {
  return sendMessage({
    type: 'broadcast',
    from,
    to: '*',
    topic,
    priority: 'fyi',
    payload: { action: topic, data: payload }
  });
}

/**
 * Broadcast agent introduction with identity and capabilities.
 * Sent on session start so other agents discover who's online.
 */
function sendAgentIntroduction(sessionId, { role, agentName, capabilities }) {
  return sendBroadcast(sessionId, 'agent_introduced', {
    session_id: sessionId,
    agent_name: agentName,
    role: role,
    capabilities: capabilities || [],
    status: 'available'
  });
}

/**
 * Delegate a task to another agent
 */
function delegateTask(from, to, taskData) {
  return sendMessage({
    type: 'task_delegate',
    from,
    to,
    topic: 'task.assign',
    priority: 'normal',
    payload: { action: 'create_task', data: taskData },
    ack: { required: true, deadline_ms: 60000 }
  });
}

// ============================================================================
// BUS WATCHER
// ============================================================================

/**
 * Create a watcher that calls handler when new messages arrive
 * @param {string} sessionId
 * @param {function} handler - Called with (messages, cursor) on new messages
 * @param {object} opts - { pollingInterval: 2000 }
 * @returns {{ stop: function }} watcher handle
 */
function createBusWatcher(sessionId, handler, opts = {}) {
  const busPath = getBusPath();
  const pollingInterval = opts.pollingInterval || 2000;
  let fsWatcher = null;
  let pollTimer = null;
  let stopped = false;

  function checkMessages() {
    if (stopped) return;
    try {
      const { messages, cursor } = readMessages(sessionId);
      if (messages.length > 0) {
        handler(messages, cursor);
      }
    } catch (e) {
      // Log but don't crash
    }
  }

  // Primary: fs.watch
  try {
    if (fs.existsSync(busPath)) {
      fsWatcher = fs.watch(busPath, () => {
        checkMessages();
      });
      fsWatcher.on('error', () => {
        // Fall back to polling only
        fsWatcher = null;
      });
    }
  } catch (e) {
    // fs.watch not available — polling only
  }

  // Fallback: periodic polling
  pollTimer = setInterval(checkMessages, pollingInterval);

  return {
    stop() {
      stopped = true;
      if (fsWatcher) {
        fsWatcher.close();
        fsWatcher = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }
  };
}

// ============================================================================
// COMPACTION & CLEANUP
// ============================================================================

/**
 * Check if bus needs compaction
 */
function needsCompaction() {
  const busPath = getBusPath();
  try {
    if (fs.existsSync(busPath)) {
      const stats = fs.statSync(busPath);
      return stats.size > COMPACTION_THRESHOLD;
    }
  } catch (e) {
    // Ignore
  }
  return false;
}

/**
 * Compact the bus by removing messages already read by all active sessions
 * Should only be called by one process (use lock file).
 * @returns {{ success: boolean, removed: number, remaining: number, error?: string }}
 */
function compactBus() {
  const busPath = getBusPath();
  const cursorDir = getCursorDir();
  const lockPath = path.join(path.dirname(busPath), '.compaction.lock');

  // Acquire lock
  try {
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      ts: new Date().toISOString()
    }), { flag: 'wx' }); // fails if exists
  } catch (e) {
    // Check if lock is stale (> 5 min old)
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const age = Date.now() - new Date(lock.ts).getTime();
      if (age < 5 * 60 * 1000) {
        return { success: false, removed: 0, remaining: 0, error: 'Compaction already in progress' };
      }
      // Stale lock — overwrite
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        ts: new Date().toISOString()
      }));
    } catch (e2) {
      return { success: false, removed: 0, remaining: 0, error: `Lock error: ${e2.message}` };
    }
  }

  try {
    if (!fs.existsSync(busPath)) {
      return { success: true, removed: 0, remaining: 0 };
    }

    // Find minimum cursor offset across all active cursors
    let minOffset = Infinity;
    const cursorFiles = fs.existsSync(cursorDir)
      ? fs.readdirSync(cursorDir).filter(f => f.endsWith('.cursor.json'))
      : [];

    for (const file of cursorFiles) {
      try {
        const cursor = JSON.parse(fs.readFileSync(path.join(cursorDir, file), 'utf8'));
        if (cursor.byte_offset < minOffset) {
          minOffset = cursor.byte_offset;
        }
      } catch (e) {
        // Skip corrupt cursors — they'll reinitialize
      }
    }

    if (minOffset === Infinity || minOffset === 0) {
      return { success: true, removed: 0, remaining: 0 };
    }

    // Read full bus
    const content = fs.readFileSync(busPath, 'utf8');
    const totalLines = content.split('\n').filter(l => l.trim()).length;

    // Keep everything from minOffset onward
    const kept = content.substring(minOffset);
    const keptLines = kept.split('\n').filter(l => l.trim()).length;
    const removedLines = totalLines - keptLines;

    // Archive removed portion
    const archiveDir = getArchiveDir();
    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }
    const archiveName = `bus.${new Date().toISOString().split('T')[0]}.jsonl`;
    fs.appendFileSync(path.join(archiveDir, archiveName), content.substring(0, minOffset));

    // Atomic write of compacted bus
    const tmpBus = busPath + '.compacting';
    fs.writeFileSync(tmpBus, kept);
    fs.renameSync(tmpBus, busPath);

    // Adjust all cursor offsets
    for (const file of cursorFiles) {
      try {
        const cursorPath = path.join(cursorDir, file);
        const cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
        cursor.byte_offset = Math.max(0, cursor.byte_offset - minOffset);
        const tmpCursor = cursorPath + '.tmp';
        fs.writeFileSync(tmpCursor, JSON.stringify(cursor, null, 2));
        fs.renameSync(tmpCursor, cursorPath);
      } catch (e) {
        // Skip — cursor will reinitialize if corrupt
      }
    }

    return { success: true, removed: removedLines, remaining: keptLines };
  } finally {
    // Release lock
    try {
      fs.unlinkSync(lockPath);
    } catch (e) {
      // Ignore
    }
  }
}

/**
 * Remove cursors for sessions that no longer exist
 */
function cleanupCursors(activeSessionIds) {
  const cursorDir = getCursorDir();
  if (!fs.existsSync(cursorDir)) return;

  const activeSet = new Set(activeSessionIds);
  const files = fs.readdirSync(cursorDir).filter(f => f.endsWith('.cursor.json'));

  for (const file of files) {
    const sessionId = file.replace('.cursor.json', '');
    if (!activeSet.has(sessionId)) {
      try {
        fs.unlinkSync(path.join(cursorDir, file));
      } catch (e) {
        // Ignore
      }
    }
  }
}

/**
 * Get bus statistics
 */
function getBusStats() {
  const busPath = getBusPath();
  const cursorDir = getCursorDir();

  const stats = {
    bus_exists: false,
    bus_size_bytes: 0,
    message_count: 0,
    active_cursors: 0,
    needs_compaction: false
  };

  try {
    if (fs.existsSync(busPath)) {
      const fileStats = fs.statSync(busPath);
      stats.bus_exists = true;
      stats.bus_size_bytes = fileStats.size;
      stats.message_count = fs.readFileSync(busPath, 'utf8')
        .split('\n')
        .filter(l => l.trim()).length;
      stats.needs_compaction = fileStats.size > COMPACTION_THRESHOLD;
    }
  } catch (e) {
    // Ignore
  }

  try {
    if (fs.existsSync(cursorDir)) {
      stats.active_cursors = fs.readdirSync(cursorDir)
        .filter(f => f.endsWith('.cursor.json')).length;
    }
  } catch (e) {
    // Ignore
  }

  return stats;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Constants
  MESSAGE_BUS_PATH,
  CURSOR_DIR,
  MSG_SIZE_LIMIT,
  VALID_TYPES,
  VALID_PRIORITIES,
  DEFAULT_TTL_MS,
  // Core
  generateMessageId,
  validateMessage,
  sendMessage,
  readMessages,
  acknowledgeMessages,
  // Convenience senders
  sendRequest,
  sendResponse,
  sendNotification,
  sendBroadcast,
  sendAgentIntroduction,
  delegateTask,
  // Cursor management
  loadCursor,
  writeCursor,
  initializeCursor,
  removeCursor,
  // Nudge
  nudgeSession,
  checkNudge,
  // Bus watcher
  createBusWatcher,
  // Compaction & cleanup
  needsCompaction,
  compactBus,
  cleanupCursors,
  getBusStats
};
