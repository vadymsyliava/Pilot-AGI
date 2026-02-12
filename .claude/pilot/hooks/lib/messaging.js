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
const DLQ_PATH = '.claude/pilot/messages/dlq.jsonl';
const PENDING_ACKS_PATH = '.claude/pilot/messages/pending_acks.jsonl';

const MSG_SIZE_LIMIT = 4000; // bytes, within PIPE_BUF for safety
const COMPACTION_THRESHOLD = 100 * 1024; // 100KB (lowered for earlier compaction)
const CURSOR_PROCESSED_MAX = 1000;
const DEFAULT_TTL_MS = {
  blocking: 30000,   // 30 seconds
  normal: 300000,    // 5 minutes
  fyi: 300000        // 5 minutes
};
const DEFAULT_ACK_DEADLINE_MS = 30000; // 30 seconds
const ACK_MAX_RETRIES = 3;
const PRIORITY_ORDER = { blocking: 0, normal: 1, fyi: 2 };

const VALID_TYPES = ['request', 'response', 'notify', 'task_delegate', 'broadcast', 'query', 'block_on_task', 'ask_pm', 'pm_response'];
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

function getDlqPath() {
  return path.join(process.cwd(), DLQ_PATH);
}

function getPendingAcksPath() {
  return path.join(process.cwd(), PENDING_ACKS_PATH);
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

  if (msg.type === 'request' && !msg.to && !msg.to_role && !msg.to_agent) {
    errors.push('Request messages require a recipient (to, to_role, or to_agent)');
  }

  if (msg.type === 'task_delegate' && !msg.to && !msg.to_role) {
    errors.push('Task delegation requires a recipient (to or to_role)');
  }

  if (msg.type === 'query' && !msg.to && !msg.to_role && !msg.to_agent) {
    errors.push('Query messages require a recipient (to, to_role, or to_agent)');
  }

  // Size check (estimate serialized size)
  const serialized = JSON.stringify(msg);
  if (serialized.length > MSG_SIZE_LIMIT) {
    errors.push(`Message exceeds size limit: ${serialized.length} > ${MSG_SIZE_LIMIT} bytes`);
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// SEQUENCE NUMBERS (per-sender FIFO ordering)
// ============================================================================

// In-memory sender sequence counters (initialized from bus on first use)
const _senderSeqs = {};

/**
 * Get next sequence number for a sender.
 * First checks cursor cache, then falls back to bus scan on first call.
 */
function getNextSenderSeq(senderId) {
  if (_senderSeqs[senderId] === undefined) {
    // Try cursor cache first (avoids full bus scan on restart)
    let maxSeq = 0;
    try {
      const cursorPath = getCursorPath(senderId);
      if (fs.existsSync(cursorPath)) {
        const cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
        if (typeof cursor._cached_sender_seq === 'number' && cursor._cached_sender_seq > 0) {
          maxSeq = cursor._cached_sender_seq;
        }
      }
    } catch (e) { /* fall through to bus scan */ }

    // Fall back to bus scan only if no cached value
    if (maxSeq === 0) {
      const busPath = getBusPath();
      try {
        if (fs.existsSync(busPath)) {
          const lines = fs.readFileSync(busPath, 'utf8').split('\n').filter(l => l.trim());
          for (const line of lines) {
            try {
              const msg = JSON.parse(line);
              if (msg.from === senderId && msg.sender_seq !== undefined && msg.sender_seq > maxSeq) {
                maxSeq = msg.sender_seq;
              }
            } catch (e) { /* skip */ }
          }
        }
      } catch (e) { /* start from 0 */ }
    }
    _senderSeqs[senderId] = maxSeq;
  }
  _senderSeqs[senderId]++;
  return _senderSeqs[senderId];
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
  const senderSeq = getNextSenderSeq(msg.from);

  const fullMessage = {
    id,
    ts: new Date().toISOString(),
    type: msg.type,
    from: msg.from,
    priority: msg.priority,
    ttl_ms,
    sender_seq: senderSeq,
    ...msg,
    id, // ensure id is not overridden by spread
    sender_seq: senderSeq, // ensure seq is not overridden
  };

  const line = JSON.stringify(fullMessage) + '\n';

  // Atomic append (safe for multi-process, empirically verified)
  fs.appendFileSync(busPath, line);

  // Persist sender_seq to cursor cache (avoids full bus scan on restart)
  try {
    const cursorDir = getCursorDir();
    if (!fs.existsSync(cursorDir)) fs.mkdirSync(cursorDir, { recursive: true });
    const cursorPath = getCursorPath(msg.from);
    let cursorData = {};
    if (fs.existsSync(cursorPath)) {
      cursorData = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
    }
    cursorData._cached_sender_seq = senderSeq;
    const tmpPath = cursorPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(cursorData, null, 2));
    fs.renameSync(tmpPath, cursorPath);
  } catch (e) { /* non-critical — bus scan fallback still works */ }

  // Track ACK if required
  if (msg.ack && msg.ack.required) {
    const escalateTopm = !!(msg.payload && msg.payload.data && msg.payload.data.escalate_to_pm);
    trackPendingAck(id, msg.from, msg.to, msg.ack.deadline_ms || DEFAULT_ACK_DEADLINE_MS, {
      to_role: msg.to_role || null,
      escalate_to_pm: escalateTopm
    });
  }

  // Nudge recipient for blocking messages
  if (msg.priority === 'blocking' && msg.to && msg.to !== '*') {
    nudgeSession(msg.to);
  }

  // Auto-compact if bus exceeds threshold
  if (needsCompaction()) {
    try { compactBus(); } catch (e) { /* non-critical */ }
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
 * Load cursor for a session with corruption recovery.
 * If cursor is corrupt or invalid, resets to the last archive boundary
 * instead of replaying all messages from the start.
 * @returns {{ session_id: string, last_seq: number, byte_offset: number, processed_ids: string[], updated_at: string } | null}
 */
function loadCursor(sessionId) {
  const cursorPath = getCursorPath(sessionId);
  try {
    if (!fs.existsSync(cursorPath)) return null;
    const raw = fs.readFileSync(cursorPath, 'utf8');
    const cursor = JSON.parse(raw);

    // Validate structure
    if (typeof cursor.byte_offset !== 'number' || cursor.byte_offset < 0) {
      throw new Error('Invalid byte_offset');
    }
    if (!Array.isArray(cursor.processed_ids)) {
      throw new Error('Invalid processed_ids');
    }

    // Validate byte_offset doesn't exceed bus size
    const busPath = getBusPath();
    if (fs.existsSync(busPath)) {
      const busSize = fs.statSync(busPath).size;
      if (cursor.byte_offset > busSize) {
        // Cursor points past end of bus (bus was truncated/compacted)
        // Reset to current bus end to avoid reading garbage
        cursor.byte_offset = busSize;
        writeCursor(sessionId, cursor);
      }
    }

    return cursor;
  } catch (e) {
    // Corrupt cursor — recover to archive boundary
    const busPath = getBusPath();
    let safeOffset = 0;
    try {
      // Find the latest archive to determine safe starting point
      const archiveDir = getArchiveDir();
      if (fs.existsSync(archiveDir)) {
        const archives = fs.readdirSync(archiveDir).filter(f => f.endsWith('.jsonl')).sort();
        if (archives.length > 0) {
          // We've been compacted, so offset 0 in the current bus is safe
          safeOffset = 0;
        }
      }
      // If no archives, bus hasn't been compacted — start from current end
      // to avoid replaying everything (accept missing messages over replay storm)
      if (safeOffset === 0 && fs.existsSync(busPath)) {
        safeOffset = fs.statSync(busPath).size;
      }
    } catch (e2) { /* use 0 */ }

    const recovered = {
      session_id: sessionId,
      last_seq: -1,
      byte_offset: safeOffset,
      processed_ids: [],
      updated_at: new Date().toISOString(),
      _recovered: true
    };
    writeCursor(sessionId, recovered);
    return recovered;
  }
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
    updated_at: new Date().toISOString(),
    // Cache sender_seq to avoid full bus scan on restart
    _cached_sender_seq: _senderSeqs[sessionId] || cursorData._cached_sender_seq || 0
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
 * @param {string} opts.role - Reader's agent role (enables role-addressed message matching)
 * @param {string} opts.agentName - Reader's agent name (enables name-addressed message matching)
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

      // Filter by recipient: session ID, role, agent name, broadcast, or '*'
      const hasTargeting = msg.to || msg.to_role || msg.to_agent;
      const isBroadcast = msg.type === 'broadcast' || msg.to === '*';
      const isSessionMatch = msg.to && msg.to === sessionId;
      const isRoleMatch = msg.to_role && opts.role && msg.to_role === opts.role;
      const isNameMatch = msg.to_agent && opts.agentName && msg.to_agent === opts.agentName;
      const isUntargeted = !hasTargeting; // Messages with no recipient go to everyone
      if (!isBroadcast && !isSessionMatch && !isRoleMatch && !isNameMatch && !isUntargeted) {
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

  // Sort by priority (blocking → normal → fyi), then by sender_seq within same sender
  messages.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 1;
    const pb = PRIORITY_ORDER[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    // Within same sender, sort by sender_seq (FIFO)
    if (a.from === b.from && a.sender_seq !== undefined && b.sender_seq !== undefined) {
      return a.sender_seq - b.sender_seq;
    }
    return 0; // preserve arrival order otherwise
  });

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

/**
 * Delegate a task to a role with automatic bd subtask creation.
 * Creates a bd issue, then sends a task_delegate message on the bus.
 *
 * @param {string} from - Sender session ID
 * @param {string} toRole - Target agent role
 * @param {object} taskData - { title, description, parent_task_id, labels }
 * @param {object} [opts] - { priority, deadline_ms }
 * @returns {{ success: boolean, message_id?: string, bd_task_id?: string, error?: string }}
 */
function delegateTaskWithBd(from, toRole, taskData, opts = {}) {
  const { execSync } = require('child_process');
  let bdTaskId = null;

  // 1. Create bd subtask
  try {
    const labelFlag = taskData.labels ? ` --label "${taskData.labels.join(',')}"` : '';
    const parentFlag = taskData.parent_task_id ? ` --parent "${taskData.parent_task_id}"` : '';
    const cmd = `bd create --title "${(taskData.title || 'Delegated task').replace(/"/g, '\\"')}" --label "delegated,${toRole}"${parentFlag} 2>/dev/null`;
    const output = execSync(cmd, { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 }).trim();
    // Extract task ID from bd create output (typically the last word or ID pattern)
    const idMatch = output.match(/[A-Za-z0-9]+-[a-z0-9]+/);
    if (idMatch) bdTaskId = idMatch[0];
  } catch (e) {
    // bd may not be available — continue with bus message only
  }

  // 2. Send task_delegate message on bus
  const result = sendMessage({
    type: 'task_delegate',
    from,
    to_role: toRole,
    topic: 'task.delegate',
    priority: opts.priority || 'normal',
    payload: {
      action: 'delegate_task',
      data: {
        ...taskData,
        bd_task_id: bdTaskId,
        delegated_by: from,
        delegated_at: new Date().toISOString()
      }
    },
    ttl_ms: opts.deadline_ms || 5 * 60 * 1000,
    ack: { required: true, deadline_ms: opts.deadline_ms || 60000 }
  });

  return {
    success: result.success,
    message_id: result.id,
    bd_task_id: bdTaskId,
    error: result.error
  };
}

// ============================================================================
// AGENT-TO-AGENT COLLABORATION (Phase 3.9)
// ============================================================================

/**
 * Send a message to any active agent with a specific role.
 * The message is addressed by role, not session ID.
 * Any agent reading the bus with opts.role matching will receive it.
 *
 * @param {string} from - Sender session ID
 * @param {string} targetRole - Target agent role (e.g., 'backend', 'frontend')
 * @param {string} topic - Message topic
 * @param {object} payload - Message data
 * @param {object} opts - Options (priority, ttl_ms, ack)
 */
function sendToRole(from, targetRole, topic, payload, opts = {}) {
  return sendMessage({
    type: opts.type || 'request',
    from,
    to_role: targetRole,
    topic,
    priority: opts.priority || 'normal',
    payload: { action: topic, data: payload },
    ttl_ms: opts.ttl_ms || DEFAULT_TTL_MS[opts.priority || 'normal'],
    ack: opts.ack || undefined
  });
}

/**
 * Send a message to a specific agent by name (e.g., "backend-1").
 *
 * @param {string} from - Sender session ID
 * @param {string} agentName - Target agent name
 * @param {string} topic - Message topic
 * @param {object} payload - Message data
 * @param {object} opts - Options
 */
function sendToAgent(from, agentName, topic, payload, opts = {}) {
  return sendMessage({
    type: opts.type || 'request',
    from,
    to_agent: agentName,
    topic,
    priority: opts.priority || 'normal',
    payload: { action: topic, data: payload },
    ttl_ms: opts.ttl_ms || DEFAULT_TTL_MS[opts.priority || 'normal'],
    ack: opts.ack || undefined
  });
}

/**
 * Send a message to any agent that has a specific capability.
 * Uses service discovery to find the recipient.
 *
 * @param {string} from - Sender session ID
 * @param {string} capability - Required capability (e.g., 'api_design')
 * @param {string} topic - Message topic
 * @param {object} payload - Message data
 * @param {object} [opts] - { priority, ttl_ms, ack }
 * @returns {{ success: boolean, id?: string, matched_agent?: object, error?: string }}
 */
function sendToCapability(from, capability, topic, payload, opts = {}) {
  // Lazy-load to avoid circular dependency
  const agentContext = require('./agent-context');
  const agents = agentContext.discoverAgentByCap(capability);

  if (agents.length === 0) {
    return {
      success: false,
      error: `No active agent found with capability: ${capability}`
    };
  }

  // Pick the first available (not busy) agent, or fall back to first match
  const target = agents.find(a => !a.claimed_task) || agents[0];

  const result = sendMessage({
    type: opts.type || 'request',
    from,
    to: target.session_id,
    to_agent: target.agent_name,
    topic,
    priority: opts.priority || 'normal',
    payload: { action: topic, data: payload },
    ttl_ms: opts.ttl_ms || DEFAULT_TTL_MS[opts.priority || 'normal'],
    ack: opts.ack || undefined
  });

  return {
    success: result.success,
    id: result.id,
    matched_agent: { session_id: target.session_id, agent_name: target.agent_name, role: target.role },
    error: result.error
  };
}

/**
 * Send a query to an agent by role (peer-to-peer question/answer).
 * Uses ACK protocol — caller expects a response.
 *
 * @param {string} from - Sender session ID
 * @param {string} targetRole - Target agent role
 * @param {string} question - The question or request
 * @param {object} opts - { timeout_ms, context }
 */
function queryAgent(from, targetRole, question, opts = {}) {
  const timeoutMs = opts.timeout_ms || 60000;
  return sendMessage({
    type: 'query',
    from,
    to_role: targetRole,
    topic: 'agent.query',
    priority: 'normal',
    payload: {
      action: 'query',
      data: {
        question,
        context: opts.context || null,
        response_requested: true
      }
    },
    ttl_ms: timeoutMs,
    ack: { required: true, deadline_ms: timeoutMs }
  });
}

/**
 * Respond to a peer query.
 *
 * @param {string} from - Responder session ID
 * @param {string} queryMessageId - The original query message ID
 * @param {string} querySender - Who sent the original query
 * @param {object} answer - The response data
 */
function respondToQuery(from, queryMessageId, querySender, answer) {
  return sendMessage({
    type: 'response',
    from,
    to: querySender,
    priority: 'normal',
    correlation_id: queryMessageId,
    payload: { action: 'query_response', data: answer }
  });
}

/**
 * Send a blocking request to an agent by role.
 * If no response within deadline, auto-escalates to PM.
 *
 * @param {string} from - Sender session ID
 * @param {string} targetRole - Target agent role
 * @param {string} reason - Why this is blocking
 * @param {object} opts - { deadline_ms, context }
 */
function sendBlockingRequest(from, targetRole, reason, opts = {}) {
  const deadlineMs = opts.deadline_ms || 30000;
  return sendMessage({
    type: 'request',
    from,
    to_role: targetRole,
    topic: 'agent.blocking_request',
    priority: 'blocking',
    payload: {
      action: 'blocking_request',
      data: {
        reason,
        context: opts.context || null,
        escalate_to_pm: true
      }
    },
    ttl_ms: deadlineMs * 2, // Message lives longer than ACK deadline
    ack: { required: true, deadline_ms: deadlineMs }
  });
}

// ============================================================================
// ESCALATION CHAIN (Phase 3.9)
// ============================================================================

/**
 * Default escalation chain: peer → PM → human
 */
const DEFAULT_ESCALATION_CHAIN = [
  { level: 'peer', timeout_ms: 30000, retries: 2 },
  { level: 'pm', timeout_ms: 60000, retries: 1 },
  { level: 'human', timeout_ms: 0, retries: 0 }
];

/**
 * Send a message with configurable escalation chain.
 * If the initial recipient doesn't respond, escalates through the chain.
 *
 * @param {string} from - Sender session ID
 * @param {string} to - Initial recipient (session ID or role via to_role)
 * @param {string} topic - Message topic
 * @param {object} payload - Message data
 * @param {object[]} [escalationChain] - Array of { level, timeout_ms, retries }
 * @returns {{ success: boolean, id?: string, escalation_chain: object[] }}
 */
function sendWithEscalation(from, to, topic, payload, escalationChain) {
  const chain = escalationChain || DEFAULT_ESCALATION_CHAIN;
  const firstLevel = chain[0];

  const result = sendMessage({
    type: 'request',
    from,
    to: firstLevel.level === 'peer' ? to : undefined,
    to_role: firstLevel.level !== 'peer' ? to : undefined,
    topic,
    priority: 'blocking',
    payload: { action: topic, data: payload },
    ttl_ms: (firstLevel.timeout_ms || 30000) * 2,
    ack: {
      required: true,
      deadline_ms: firstLevel.timeout_ms || 30000,
      escalation_chain: chain.slice(1), // Store remaining chain for processAckTimeouts
      current_level: 0
    }
  });

  return {
    success: result.success,
    id: result.id,
    escalation_chain: chain
  };
}

// ============================================================================
// DEPENDENCY BLOCKING PROTOCOL (Phase 3.9)
// ============================================================================

/**
 * Send a "blocked on task" message. Agent declares it cannot proceed until taskId completes.
 * Other agents or PM can see the block. When the task completes, notifyTaskComplete() resolves it.
 *
 * @param {string} from - Sender session ID
 * @param {string} taskId - The task ID to wait for
 * @param {string} reason - Why this agent is blocked
 * @param {object} opts - { deadline_ms }
 * @returns {{ success: boolean, id?: string }}
 */
function sendBlockOnTask(from, taskId, reason, opts = {}) {
  const deadlineMs = opts.deadline_ms || 5 * 60 * 1000; // 5 minutes
  return sendMessage({
    type: 'block_on_task',
    from,
    to: '*', // broadcast so PM and all agents see it
    topic: 'task.blocked_on',
    priority: 'blocking',
    payload: {
      action: 'block_on_task',
      data: {
        blocked_task_id: taskId,
        reason,
        waiting_since: new Date().toISOString()
      }
    },
    ttl_ms: deadlineMs * 2,
    ack: { required: true, deadline_ms: deadlineMs }
  });
}

/**
 * Broadcast that a task has completed. Any agent blocked on this task gets notified.
 *
 * @param {string} from - Session ID of the agent that completed the task
 * @param {string} taskId - The completed task ID
 * @param {object} result - Summary of what was done
 * @returns {{ success: boolean, id?: string }}
 */
function notifyTaskComplete(from, taskId, result = {}) {
  return sendBroadcast(from, 'task.completed', {
    task_id: taskId,
    completed_by: from,
    completed_at: new Date().toISOString(),
    result
  });
}

// ============================================================================
// ACK / NACK PROTOCOL
// ============================================================================

/**
 * Track a pending ACK (persisted to file for crash recovery)
 */
function trackPendingAck(messageId, from, to, deadlineMs, opts = {}) {
  const acksPath = getPendingAcksPath();
  const dir = path.dirname(acksPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const entry = {
    message_id: messageId,
    from,
    to,
    to_role: opts.to_role || null,
    escalate_to_pm: opts.escalate_to_pm || false,
    deadline_at: new Date(Date.now() + deadlineMs).toISOString(),
    retries: 0,
    created_at: new Date().toISOString()
  };
  fs.appendFileSync(acksPath, JSON.stringify(entry) + '\n');
}

/**
 * Load all pending ACKs
 * @returns {object[]}
 */
function loadPendingAcks() {
  const acksPath = getPendingAcksPath();
  if (!fs.existsSync(acksPath)) return [];

  const lines = fs.readFileSync(acksPath, 'utf8').split('\n').filter(l => l.trim());
  const acks = [];
  for (const line of lines) {
    try { acks.push(JSON.parse(line)); } catch (e) { /* skip */ }
  }
  return acks;
}

/**
 * Remove a pending ACK (message was acknowledged)
 */
function clearPendingAck(messageId) {
  const acksPath = getPendingAcksPath();
  if (!fs.existsSync(acksPath)) return;

  const acks = loadPendingAcks().filter(a => a.message_id !== messageId);
  fs.writeFileSync(acksPath, acks.map(a => JSON.stringify(a)).join('\n') + (acks.length ? '\n' : ''));
}

/**
 * Send an ACK for a received message
 * @param {string} from - The acknowledging session
 * @param {string} originalMessageId - The message being acknowledged
 * @param {string} originalSender - Who sent the original message
 */
function sendAck(from, originalMessageId, originalSender) {
  const result = sendMessage({
    type: 'response',
    from,
    to: originalSender,
    priority: 'normal',
    correlation_id: originalMessageId,
    payload: { action: 'ack', data: { status: 'acknowledged' } }
  });
  // Clear from pending acks on the sender side (if we are the sender reading our own ack)
  clearPendingAck(originalMessageId);
  return result;
}

/**
 * Send a NACK (rejection) for a received message
 * @param {string} from - The rejecting session
 * @param {string} originalMessageId - The message being rejected
 * @param {string} originalSender - Who sent the original message
 * @param {string} reason - Why the message was rejected
 */
function sendNack(from, originalMessageId, originalSender, reason) {
  return sendMessage({
    type: 'response',
    from,
    to: originalSender,
    priority: 'normal',
    correlation_id: originalMessageId,
    payload: { action: 'nack', data: { status: 'rejected', reason } }
  });
}

/**
 * Process pending ACKs: retry expired ones or move to DLQ
 * Should be called periodically (e.g., in PM loop)
 * @returns {{ retried: number, dlqd: number }}
 */
function processAckTimeouts() {
  const acks = loadPendingAcks();
  if (acks.length === 0) return { retried: 0, dlqd: 0 };

  const now = Date.now();
  const stillPending = [];
  let retried = 0;
  let dlqd = 0;

  for (const ack of acks) {
    const deadlineAt = new Date(ack.deadline_at).getTime();
    if (now <= deadlineAt) {
      stillPending.push(ack);
      continue;
    }

    // Deadline passed
    if (ack.retries < ACK_MAX_RETRIES) {
      // Retry: re-send a nudge
      if (ack.to) nudgeSession(ack.to);
      ack.retries++;
      ack.deadline_at = new Date(now + DEFAULT_ACK_DEADLINE_MS).toISOString();
      stillPending.push(ack);
      retried++;
    } else if (ack.escalation_chain && ack.escalation_level != null) {
      // Multi-level escalation chain (Phase 3.9)
      const nextLevel = (ack.escalation_level || 0) + 1;
      const chain = ack.escalation_chain;

      if (nextLevel < chain.length) {
        const nextStep = chain[nextLevel];
        if ((nextStep.level || nextStep.target) === 'human') {
          // Human escalation — write to JSONL for human review
          try {
            const agentContext = require('./agent-context');
            agentContext.recordHumanEscalation({
              from: ack.from,
              reason: `Escalation chain exhausted automated levels`,
              original_message_id: ack.message_id,
              original_target: ack.to || ack.to_role,
              retries: ack.retries
            });
          } catch (e) { /* best effort */ }
          moveToDlq(ack.message_id, 'escalated_to_human', {
            from: ack.from, escalation_level: nextLevel
          });
          dlqd++;
        } else {
          // Escalate to next level (e.g., pm)
          sendMessage({
            type: 'request',
            from: ack.from,
            to_role: nextStep.level || nextStep.target,
            topic: 'escalation.timeout',
            priority: 'blocking',
            payload: {
              action: 'escalation',
              data: {
                original_message_id: ack.message_id,
                original_target: ack.to || ack.to_role,
                reason: `Timed out at escalation level ${ack.escalation_level}`,
                from: ack.from,
                level: nextLevel
              }
            },
            ack: {
              required: true,
              deadline_ms: nextStep.timeout_ms || 60000,
              escalation_chain: chain,
              escalation_level: nextLevel
            }
          });
          retried++;
        }
      } else {
        moveToDlq(ack.message_id, 'escalation_exhausted', {
          from: ack.from, levels_tried: nextLevel
        });
        dlqd++;
      }
    } else {
      // Legacy: escalate to PM if blocking request
      if (ack.escalate_to_pm) {
        sendMessage({
          type: 'request',
          from: ack.from,
          to_role: 'pm',
          topic: 'escalation.blocking_timeout',
          priority: 'blocking',
          payload: {
            action: 'escalation',
            data: {
              original_message_id: ack.message_id,
              original_target: ack.to || ack.to_role,
              reason: `Blocking request timed out after ${ack.retries} retries`,
              from: ack.from,
              retries: ack.retries
            }
          }
        });
      }
      moveToDlq(ack.message_id, 'ack_timeout', {
        from: ack.from,
        to: ack.to,
        to_role: ack.to_role,
        retries: ack.retries,
        original_deadline: ack.created_at,
        escalated_to_pm: !!ack.escalate_to_pm
      });
      dlqd++;
    }
  }

  // Rewrite pending acks
  const acksPath = getPendingAcksPath();
  fs.writeFileSync(acksPath, stillPending.map(a => JSON.stringify(a)).join('\n') + (stillPending.length ? '\n' : ''));

  return { retried, dlqd };
}

// ============================================================================
// DEAD LETTER QUEUE
// ============================================================================

/**
 * Move a message to the dead letter queue
 * @param {string} messageId - ID of the failed message
 * @param {string} reason - Why it was moved to DLQ
 * @param {object} metadata - Additional context
 */
function moveToDlq(messageId, reason, metadata = {}) {
  const dlqPath = getDlqPath();
  const dir = path.dirname(dlqPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Try to find the original message from bus
  let originalMessage = null;
  try {
    const busPath = getBusPath();
    if (fs.existsSync(busPath)) {
      const lines = fs.readFileSync(busPath, 'utf8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === messageId) { originalMessage = msg; break; }
        } catch (e) { /* skip */ }
      }
    }
  } catch (e) { /* no original found */ }

  const dlqEntry = {
    message_id: messageId,
    reason,
    moved_at: new Date().toISOString(),
    metadata,
    original_message: originalMessage
  };

  fs.appendFileSync(dlqPath, JSON.stringify(dlqEntry) + '\n');
}

/**
 * Read all messages in the dead letter queue
 * @returns {object[]}
 */
function getDLQMessages() {
  const dlqPath = getDlqPath();
  if (!fs.existsSync(dlqPath)) return [];

  const lines = fs.readFileSync(dlqPath, 'utf8').split('\n').filter(l => l.trim());
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch (e) { /* skip */ }
  }
  return entries;
}

/**
 * Clear the dead letter queue (after PM review)
 * @returns {number} Number of entries cleared
 */
function clearDLQ() {
  const dlqPath = getDlqPath();
  if (!fs.existsSync(dlqPath)) return 0;
  const count = getDLQMessages().length;
  fs.writeFileSync(dlqPath, '');
  return count;
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
  let debounceTimer = null;
  const DEBOUNCE_MS = 50; // Coalesce rapid writes into single read

  function checkMessages() {
    if (stopped) return;
    try {
      const { messages, cursor } = readMessages(sessionId, {
        role: opts.role,
        agentName: opts.agentName
      });
      if (messages.length > 0) {
        handler(messages, cursor);
      }
    } catch (e) {
      // Log but don't crash
    }
  }

  function debouncedCheck() {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(checkMessages, DEBOUNCE_MS);
  }

  // Primary: fs.watch with debounce
  try {
    if (fs.existsSync(busPath)) {
      fsWatcher = fs.watch(busPath, () => {
        debouncedCheck();
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
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
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
// PM BRAIN MESSAGING (Phase 5.0)
// ============================================================================

/**
 * Send an ask-pm message (agent → PM brain via file bus).
 */
function sendAskPm(from, question, context = {}) {
  return sendMessage({
    type: 'ask_pm',
    from,
    to: 'pm',
    topic: 'ask_pm',
    priority: 'normal',
    payload: { question, context },
    ttl_ms: DEFAULT_TTL_MS.normal
  });
}

/**
 * Send a pm-response message (PM brain → agent via file bus).
 */
function sendPmResponse(correlationId, recipientSessionId, answer) {
  return sendMessage({
    type: 'pm_response',
    from: 'pm',
    to: recipientSessionId,
    topic: 'pm_response',
    priority: 'normal',
    payload: { answer, correlation_id: correlationId },
    ttl_ms: DEFAULT_TTL_MS.normal
  });
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Constants
  MESSAGE_BUS_PATH,
  CURSOR_DIR,
  DLQ_PATH,
  MSG_SIZE_LIMIT,
  VALID_TYPES,
  VALID_PRIORITIES,
  DEFAULT_TTL_MS,
  DEFAULT_ACK_DEADLINE_MS,
  ACK_MAX_RETRIES,
  PRIORITY_ORDER,
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
  // ACK protocol
  sendAck,
  sendNack,
  trackPendingAck,
  loadPendingAcks,
  clearPendingAck,
  processAckTimeouts,
  // Dead letter queue
  moveToDlq,
  getDLQMessages,
  clearDLQ,
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
  // Agent-to-agent collaboration (Phase 3.9)
  sendToRole,
  sendToAgent,
  sendToCapability,
  queryAgent,
  respondToQuery,
  sendBlockingRequest,
  sendBlockOnTask,
  notifyTaskComplete,
  delegateTaskWithBd,
  sendWithEscalation,
  DEFAULT_ESCALATION_CHAIN,
  // PM Brain messaging (Phase 5.0)
  sendAskPm,
  sendPmResponse,
  // Compaction & cleanup
  needsCompaction,
  compactBus,
  cleanupCursors,
  getBusStats
};
