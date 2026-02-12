/**
 * PM Hub — lightweight HTTP + WebSocket server embedded in PM daemon
 *
 * Agents connect TO PM via HTTP or WebSocket. PM responds with full-knowledge
 * intelligence via pm-brain.js. File bus stays as fallback.
 *
 * REST Routes:
 *   GET  /api/status                — PM status, connected agents, queue depth
 *   POST /api/register              — agent registration
 *   POST /api/heartbeat             — agent heartbeat
 *   POST /api/ask-pm               — routes to PmBrain.ask() (synchronous)
 *   POST /api/report                — task completion/error report
 *   GET  /api/tasks/ready           — ready tasks list
 *   POST /api/tasks/:id/claim       — claim task
 *   POST /api/tasks/:id/complete    — task completion
 *   GET  /api/messages/:sessionId   — pull pending messages for agent
 *
 * WebSocket:
 *   GET  /api/connect               — upgrade to WS for persistent bidirectional channel
 *
 * Part of Phase 5.0 (Pilot AGI-adl)
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

// ============================================================================
// LAZY DEPS
// ============================================================================

let _session = null;
let _messaging = null;

function getSession() {
  if (!_session) {
    try { _session = require('./session'); } catch (e) { _session = null; }
  }
  return _session;
}

function getMessaging() {
  if (!_messaging) {
    try { _messaging = require('./messaging'); } catch (e) { _messaging = null; }
  }
  return _messaging;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_PORT = 3847;
const HUB_STATE_PATH = '.claude/pilot/state/orchestrator/pm-hub.json';
const HEARTBEAT_STALE_MS = 60000; // 60s without heartbeat = stale
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX = 120; // max requests per window per IP
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PENDING_MESSAGES = 100; // per agent

// Audit: event types that get written to file bus as audit trail
const AUDIT_EVENT_TYPES = [
  'task_claimed', 'task_complete', 'agent_registered',
  'agent_disconnected', 'agent_reaped', 'ask_pm'
];

// ============================================================================
// WEBSOCKET FRAME HELPERS (zero-dependency, RFC 6455)
// ============================================================================

/**
 * Encode a text message into a WebSocket frame.
 * @param {string} text
 * @returns {Buffer}
 */
function wsEncodeText(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    // Node 18 BigInt write
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

/**
 * WebSocket frame parser (accumulates partial frames).
 * Returns parsed messages and remaining buffer.
 */
function wsParseFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (buffer.length - offset < 2) break; // need at least 2 bytes

    const byte1 = buffer[offset];
    const byte2 = buffer[offset + 1];
    const opcode = byte1 & 0x0f;
    const masked = (byte2 & 0x80) !== 0;
    let payloadLen = byte2 & 0x7f;
    let headerLen = 2;

    if (payloadLen === 126) {
      if (buffer.length - offset < 4) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (buffer.length - offset < 10) break;
      payloadLen = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }

    if (masked) headerLen += 4;

    const totalLen = headerLen + payloadLen;
    if (buffer.length - offset < totalLen) break; // incomplete frame

    let payload = buffer.subarray(offset + headerLen, offset + headerLen + payloadLen);

    if (masked) {
      const maskKey = buffer.subarray(offset + headerLen - 4, offset + headerLen);
      payload = Buffer.from(payload); // copy before mutating
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }

    if (opcode === 0x01) {
      // Text frame
      messages.push({ type: 'text', data: payload.toString('utf8') });
    } else if (opcode === 0x08) {
      // Close frame
      messages.push({ type: 'close' });
    } else if (opcode === 0x09) {
      // Ping
      messages.push({ type: 'ping', data: payload });
    } else if (opcode === 0x0a) {
      // Pong
      messages.push({ type: 'pong' });
    }

    offset += totalLen;
  }

  return { messages, remaining: buffer.subarray(offset) };
}

/**
 * Build a WebSocket close frame.
 * @param {number} code - Status code (e.g., 1000 for normal)
 * @returns {Buffer}
 */
function wsCloseFrame(code = 1000) {
  const buf = Buffer.alloc(4);
  buf[0] = 0x88; // FIN + close opcode
  buf[1] = 2;    // payload length
  buf.writeUInt16BE(code, 2);
  return buf;
}

/**
 * Build a WebSocket pong frame.
 * @param {Buffer} data
 * @returns {Buffer}
 */
function wsPongFrame(data) {
  const len = data ? data.length : 0;
  const header = Buffer.alloc(2);
  header[0] = 0x8a; // FIN + pong opcode
  header[1] = len;
  return len > 0 ? Buffer.concat([header, data]) : header;
}

// ============================================================================
// RATE LIMITER (in-memory sliding window)
// ============================================================================

class RateLimiter {
  constructor(windowMs = RATE_LIMIT_WINDOW_MS, maxRequests = RATE_LIMIT_MAX) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.hits = new Map(); // ip → [timestamps]
  }

  /**
   * Check if request is allowed. Returns true if within limits.
   * @param {string} ip
   * @returns {boolean}
   */
  allow(ip) {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.hits.get(ip);
    if (!timestamps) {
      timestamps = [];
      this.hits.set(ip, timestamps);
    }

    // Prune old entries
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= this.maxRequests) {
      return false;
    }

    timestamps.push(now);
    return true;
  }

  /** Periodic cleanup of stale IPs */
  cleanup() {
    const cutoff = Date.now() - this.windowMs;
    for (const [ip, timestamps] of this.hits) {
      while (timestamps.length > 0 && timestamps[0] < cutoff) {
        timestamps.shift();
      }
      if (timestamps.length === 0) this.hits.delete(ip);
    }
  }
}

// ============================================================================
// PM HUB
// ============================================================================

class PmHub extends EventEmitter {
  /**
   * @param {string} projectRoot
   * @param {object} opts
   * @param {number} opts.port
   * @param {object} opts.brain — PmBrain instance
   * @param {number} opts.rateLimitMax — max requests per minute per IP
   */
  constructor(projectRoot, opts = {}) {
    super();
    this.projectRoot = projectRoot;
    this.port = opts.port || DEFAULT_PORT;
    this.brain = opts.brain || null;
    this.server = null;
    this.listening = false;

    // Connected agent registry: sessionId → { role, registeredAt, lastHeartbeat, taskId, pressure, ws }
    this.agents = new Map();

    // Pending messages per agent (for /api/messages/:sessionId pull)
    this.pendingMessages = new Map(); // sessionId → [{msg, ts}]

    // WebSocket connections: sessionId → socket
    this.wsConnections = new Map();

    // Rate limiter
    this.rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, opts.rateLimitMax || RATE_LIMIT_MAX);

    // Cleanup interval
    this._cleanupInterval = null;
  }

  /**
   * Start the HTTP + WebSocket server.
   * @returns {Promise<{ success: boolean, port?: number, error?: string }>}
   */
  start() {
    if (this.server) {
      return Promise.resolve({ success: true, port: this.port });
    }

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this._handleRequest(req, res);
      });

      // WebSocket upgrade
      this.server.on('upgrade', (req, socket, head) => {
        this._handleWsUpgrade(req, socket, head);
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          this.port++;
          this.server.listen(this.port, '127.0.0.1');
        } else {
          this.listening = false;
          resolve({ success: false, error: err.message });
        }
      });

      this.server.on('listening', () => {
        this.listening = true;
        this._writePortFile();

        // Reconcile any events from file bus that happened while hub was down
        try { this._reconcileFromFileBus(); } catch (e) { /* best effort */ }

        // Periodic cleanup: stale agents + rate limiter
        this._cleanupInterval = setInterval(() => {
          this._reapStaleAgents();
          this.rateLimiter.cleanup();
        }, 30000);
        if (this._cleanupInterval.unref) this._cleanupInterval.unref();

        resolve({ success: true, port: this.port });
      });

      this.server.listen(this.port, '127.0.0.1');
    });
  }

  /**
   * Stop the HTTP server and clean up all connections.
   */
  stop() {
    // Close all WebSocket connections
    for (const [sessionId, socket] of this.wsConnections) {
      try {
        socket.write(wsCloseFrame(1001)); // going away
        socket.end();
      } catch (e) { /* best effort */ }
    }
    this.wsConnections.clear();

    if (this.server) {
      try {
        this.server.close();
      } catch (e) { /* best effort */ }
      this.server = null;
    }

    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }

    this.listening = false;
    this.agents.clear();
    this.pendingMessages.clear();
    this._removePortFile();
  }

  /**
   * Get hub status.
   */
  getStatus() {
    const agents = [];
    for (const [sessionId, info] of this.agents) {
      agents.push({
        sessionId,
        role: info.role,
        taskId: info.taskId,
        registeredAt: info.registeredAt,
        lastHeartbeat: info.lastHeartbeat,
        stale: (Date.now() - info.lastHeartbeat) > HEARTBEAT_STALE_MS,
        ws_connected: this.wsConnections.has(sessionId)
      });
    }

    return {
      listening: this.listening,
      port: this.port,
      connected_agents: agents.length,
      ws_connections: this.wsConnections.size,
      agents,
      brain_available: !!this.brain
    };
  }

  // ==========================================================================
  // WEBSOCKET UPGRADE
  // ==========================================================================

  _handleWsUpgrade(req, socket, head) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    if (url.pathname !== '/api/connect') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // Validate WebSocket headers
    const wsKey = req.headers['sec-websocket-key'];
    if (!wsKey) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // Complete handshake
    const acceptKey = crypto
      .createHash('sha1')
      .update(wsKey + WS_MAGIC)
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
      '\r\n'
    );

    // Track the raw socket with a buffer for frame accumulation
    let buffer = Buffer.alloc(0);
    let sessionId = null;

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      const { messages, remaining } = wsParseFrames(buffer);
      buffer = remaining;

      for (const msg of messages) {
        if (msg.type === 'close') {
          if (sessionId) this._wsDisconnect(sessionId);
          try {
            socket.write(wsCloseFrame(1000));
            socket.end();
          } catch (e) { /* already closed */ }
          return;
        }

        if (msg.type === 'ping') {
          try { socket.write(wsPongFrame(msg.data)); } catch (e) { /* ignore */ }
          continue;
        }

        if (msg.type === 'text') {
          try {
            const parsed = JSON.parse(msg.data);
            sessionId = this._handleWsMessage(parsed, socket, sessionId);
          } catch (e) {
            this._wsSend(socket, { type: 'error', message: 'Invalid JSON' });
          }
        }
      }
    });

    socket.on('close', () => {
      if (sessionId) this._wsDisconnect(sessionId);
    });

    socket.on('error', () => {
      if (sessionId) this._wsDisconnect(sessionId);
    });
  }

  /**
   * Handle a parsed WS message from an agent.
   * @returns {string|null} sessionId after registration
   */
  _handleWsMessage(msg, socket, currentSessionId) {
    if (!msg || !msg.type) return currentSessionId;

    switch (msg.type) {
      case 'register': {
        const sid = msg.sessionId;
        if (!sid) {
          this._wsSend(socket, { type: 'error', message: 'sessionId required' });
          return currentSessionId;
        }

        // Validate session if session module available
        if (!this._validateSession(sid)) {
          this._wsSend(socket, { type: 'error', message: 'Invalid session' });
          return currentSessionId;
        }

        const now = Date.now();
        this.agents.set(sid, {
          role: msg.role || 'general',
          registeredAt: now,
          lastHeartbeat: now,
          taskId: msg.taskId || null,
          pressure: msg.pressure || null,
          capabilities: msg.capabilities || []
        });

        this.wsConnections.set(sid, socket);
        this.emit('agent_registered', sid, msg);
        this._auditToFileBus('agent_registered', { sessionId: sid, role: msg.role, via: 'ws' });

        // Send welcome
        this._wsSend(socket, {
          type: 'welcome',
          pmPort: this.port,
          connectedAgents: this.agents.size
        });

        // Flush any pending messages
        this._flushPendingMessages(sid);

        return sid;
      }

      case 'heartbeat': {
        const sid = msg.sessionId || currentSessionId;
        if (!sid) return currentSessionId;

        const agent = this.agents.get(sid);
        if (agent) {
          agent.lastHeartbeat = Date.now();
          if (msg.taskId !== undefined) agent.taskId = msg.taskId;
          if (msg.pressure !== undefined) agent.pressure = msg.pressure;
        }

        this.emit('agent_heartbeat', sid, msg);
        return currentSessionId;
      }

      case 'task_complete': {
        const sid = msg.sessionId || currentSessionId;
        if (!sid) return currentSessionId;

        this.emit('task_complete', sid, msg.taskId, msg.result || {});
        this._auditToFileBus('task_complete', { sessionId: sid, taskId: msg.taskId });

        const agent = this.agents.get(sid);
        if (agent) agent.taskId = null;
        return currentSessionId;
      }

      case 'ask_pm': {
        const sid = msg.sessionId || currentSessionId;
        if (!sid || !msg.question) return currentSessionId;

        if (!this.brain) {
          this._wsSend(socket, {
            type: 'answer',
            requestId: msg.requestId,
            error: 'PM Brain not available'
          });
          return currentSessionId;
        }

        // Brain.ask may be async
        Promise.resolve(this.brain.ask(sid, msg.question, msg.context || {}))
          .then((result) => {
            this._wsSend(socket, {
              type: 'answer',
              requestId: msg.requestId,
              ...result
            });
          })
          .catch((e) => {
            this._wsSend(socket, {
              type: 'answer',
              requestId: msg.requestId,
              error: e.message
            });
          });
        return currentSessionId;
      }

      case 'checkpoint': {
        const sid = msg.sessionId || currentSessionId;
        if (!sid) return currentSessionId;
        this.emit('checkpoint', sid, msg.taskId, msg.step, msg.state);
        return currentSessionId;
      }

      case 'request': {
        const sid = msg.sessionId || currentSessionId;
        if (!sid) return currentSessionId;
        this.emit('request', sid, msg.topic, msg.payload);
        return currentSessionId;
      }

      default:
        return currentSessionId;
    }
  }

  /**
   * Disconnect a WS agent.
   */
  _wsDisconnect(sessionId) {
    this.wsConnections.delete(sessionId);
    this.emit('agent_disconnected', sessionId);
    this._auditToFileBus('agent_disconnected', { sessionId });
  }

  // ==========================================================================
  // WS SEND HELPERS
  // ==========================================================================

  /**
   * Send a message to a specific socket.
   */
  _wsSend(socket, msg) {
    try {
      if (socket.writable) {
        socket.write(wsEncodeText(JSON.stringify(msg)));
      }
    } catch (e) { /* socket gone */ }
  }

  /**
   * Send a message to a specific agent by sessionId.
   * Falls back to pending queue if no WS connection.
   * @param {string} sessionId
   * @param {object} msg
   * @returns {boolean} true if sent via WS, false if queued
   */
  sendToAgent(sessionId, msg) {
    const socket = this.wsConnections.get(sessionId);
    if (socket && socket.writable) {
      this._wsSend(socket, msg);
      return true;
    }

    // Queue for later pull via /api/messages/:sessionId
    this._queueMessage(sessionId, msg);
    return false;
  }

  /**
   * Broadcast a message to all connected WS agents.
   * @param {object} msg
   * @param {string} [excludeSessionId] - optional session to exclude
   */
  broadcast(msg, excludeSessionId) {
    for (const [sessionId, socket] of this.wsConnections) {
      if (sessionId === excludeSessionId) continue;
      this._wsSend(socket, msg);
    }
  }

  /**
   * Queue a message for an agent to pull later.
   */
  _queueMessage(sessionId, msg) {
    let queue = this.pendingMessages.get(sessionId);
    if (!queue) {
      queue = [];
      this.pendingMessages.set(sessionId, queue);
    }
    queue.push({ msg, ts: Date.now() });
    // Cap queue size
    if (queue.length > MAX_PENDING_MESSAGES) {
      queue.shift();
    }
  }

  /**
   * Flush pending messages to a newly connected WS agent.
   */
  _flushPendingMessages(sessionId) {
    const queue = this.pendingMessages.get(sessionId);
    if (!queue || queue.length === 0) return;

    const socket = this.wsConnections.get(sessionId);
    if (!socket) return;

    for (const entry of queue) {
      this._wsSend(socket, entry.msg);
    }
    this.pendingMessages.delete(sessionId);
  }

  // ==========================================================================
  // SESSION VALIDATION
  // ==========================================================================

  /**
   * Validate that a sessionId corresponds to a real session file.
   * @param {string} sessionId
   * @returns {boolean}
   */
  _validateSession(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') return false;

    // Sanitize: sessionId should be alphanumeric + dashes
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return false;

    const sess = getSession();
    if (!sess) return true; // if session module unavailable, allow (graceful degradation)

    try {
      const sessDir = path.join(this.projectRoot, '.claude/pilot/state/sessions');
      const sessFile = path.join(sessDir, sessionId + '.json');
      return fs.existsSync(sessFile);
    } catch (e) {
      return true; // graceful degradation
    }
  }

  // ==========================================================================
  // HTTP REQUEST HANDLER
  // ==========================================================================

  _handleRequest(req, res) {
    // Rate limiting
    const ip = req.socket.remoteAddress || '127.0.0.1';
    if (!this.rateLimiter.allow(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
    }

    // Parse URL
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const pathname = url.pathname;
    const method = req.method;

    res.setHeader('Content-Type', 'application/json');

    // Route
    if (method === 'GET' && pathname === '/api/status') {
      return this._handleStatus(req, res);
    }
    if (method === 'POST' && pathname === '/api/register') {
      return this._handleRegister(req, res);
    }
    if (method === 'POST' && pathname === '/api/heartbeat') {
      return this._handleHeartbeat(req, res);
    }
    if (method === 'POST' && pathname === '/api/ask-pm') {
      return this._handleAskPm(req, res);
    }
    if (method === 'POST' && pathname === '/api/report') {
      return this._handleReport(req, res);
    }
    if (method === 'GET' && pathname === '/api/tasks/ready') {
      return this._handleTasksReady(req, res);
    }

    // Messages route: /api/messages/:sessionId
    const msgMatch = pathname.match(/^\/api\/messages\/([a-zA-Z0-9_-]+)$/);
    if (method === 'GET' && msgMatch) {
      return this._handleMessages(req, res, msgMatch[1]);
    }

    // Task routes: /api/tasks/:id/claim or /api/tasks/:id/complete
    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/(claim|complete)$/);
    if (method === 'POST' && taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]);
      const action = taskMatch[2];
      if (action === 'claim') return this._handleTaskClaim(req, res, taskId);
      if (action === 'complete') return this._handleTaskComplete(req, res, taskId);
    }

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  // ==========================================================================
  // ROUTE HANDLERS
  // ==========================================================================

  _handleStatus(req, res) {
    res.writeHead(200);
    res.end(JSON.stringify(this.getStatus()));
  }

  _handleRegister(req, res) {
    this._readBody(req, (body) => {
      if (!body || !body.sessionId) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'sessionId required' }));
      }

      if (!this._validateSession(body.sessionId)) {
        res.writeHead(403);
        return res.end(JSON.stringify({ error: 'Invalid session' }));
      }

      const now = Date.now();
      this.agents.set(body.sessionId, {
        role: body.role || 'general',
        registeredAt: now,
        lastHeartbeat: now,
        taskId: body.taskId || null,
        pressure: body.pressure || null,
        capabilities: body.capabilities || []
      });

      this.emit('agent_registered', body.sessionId, body);
      this._auditToFileBus('agent_registered', { sessionId: body.sessionId, role: body.role, via: 'http' });

      res.writeHead(200);
      res.end(JSON.stringify({
        connected: true,
        port: this.port,
        agents_count: this.agents.size
      }));
    });
  }

  _handleHeartbeat(req, res) {
    this._readBody(req, (body) => {
      if (!body || !body.sessionId) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'sessionId required' }));
      }

      const agent = this.agents.get(body.sessionId);
      if (!agent) {
        // Auto-register on heartbeat
        this.agents.set(body.sessionId, {
          role: body.role || 'general',
          registeredAt: Date.now(),
          lastHeartbeat: Date.now(),
          taskId: body.taskId || null,
          pressure: body.pressure || null
        });
      } else {
        agent.lastHeartbeat = Date.now();
        if (body.taskId !== undefined) agent.taskId = body.taskId;
        if (body.pressure !== undefined) agent.pressure = body.pressure;
      }

      this.emit('agent_heartbeat', body.sessionId, body);

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    });
  }

  _handleAskPm(req, res) {
    this._readBody(req, (body) => {
      if (!body || !body.question) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'question required' }));
      }

      if (!this.brain) {
        res.writeHead(503);
        return res.end(JSON.stringify({ error: 'PM Brain not available' }));
      }

      Promise.resolve(
        this.brain.ask(
          body.sessionId || 'anonymous',
          body.question,
          body.context || {}
        )
      ).then((result) => {
        res.writeHead(200);
        res.end(JSON.stringify(result));
      }).catch((e) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      });
    });
  }

  _handleReport(req, res) {
    this._readBody(req, (body) => {
      if (!body || !body.sessionId) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'sessionId required' }));
      }

      this.emit('report', body.sessionId, body);

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    });
  }

  _handleTasksReady(req, res) {
    try {
      const { execFileSync } = require('child_process');
      const output = execFileSync('bd', ['ready', '--json'], {
        cwd: this.projectRoot,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const tasks = JSON.parse(output);
      res.writeHead(200);
      res.end(JSON.stringify({ tasks }));
    } catch (e) {
      res.writeHead(200);
      res.end(JSON.stringify({ tasks: [], error: e.message }));
    }
  }

  _handleTaskClaim(req, res, taskId) {
    this._readBody(req, (body) => {
      if (!body || !body.sessionId) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'sessionId required' }));
      }

      try {
        const { execFileSync } = require('child_process');
        execFileSync('bd', ['update', taskId, '--status', 'in_progress'], {
          cwd: this.projectRoot,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe']
        });

        const agent = this.agents.get(body.sessionId);
        if (agent) agent.taskId = taskId;

        this.emit('task_claimed', body.sessionId, taskId);
        this._auditToFileBus('task_claimed', { sessionId: body.sessionId, taskId });

        // Broadcast to other agents
        this.broadcast({
          type: 'task_claimed',
          taskId,
          claimedBy: body.sessionId
        }, body.sessionId);

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, taskId }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }

  _handleTaskComplete(req, res, taskId) {
    this._readBody(req, (body) => {
      if (!body || !body.sessionId) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'sessionId required' }));
      }

      this.emit('task_complete', body.sessionId, taskId, body.result || {});
      this._auditToFileBus('task_complete', { sessionId: body.sessionId, taskId });

      const agent = this.agents.get(body.sessionId);
      if (agent) agent.taskId = null;

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, taskId }));
    });
  }

  _handleMessages(req, res, sessionId) {
    const queue = this.pendingMessages.get(sessionId) || [];
    const messages = queue.map(entry => entry.msg);

    // Clear after retrieval
    this.pendingMessages.delete(sessionId);

    res.writeHead(200);
    res.end(JSON.stringify({ messages }));
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  _readBody(req, callback) {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try {
        callback(data ? JSON.parse(data) : null);
      } catch (e) {
        callback(null);
      }
    });
  }

  /**
   * Remove stale agents (no heartbeat for > HEARTBEAT_STALE_MS).
   */
  _reapStaleAgents() {
    const now = Date.now();
    for (const [sessionId, info] of this.agents) {
      if ((now - info.lastHeartbeat) > HEARTBEAT_STALE_MS * 2) {
        // Double-stale: remove from registry
        this.agents.delete(sessionId);
        const socket = this.wsConnections.get(sessionId);
        if (socket) {
          try {
            socket.write(wsCloseFrame(1001));
            socket.end();
          } catch (e) { /* already gone */ }
          this.wsConnections.delete(sessionId);
        }
        this.emit('agent_reaped', sessionId);
        this._auditToFileBus('agent_reaped', { sessionId });
      }
    }
  }

  // ==========================================================================
  // FILE BUS AUDIT TRAIL
  // ==========================================================================

  /**
   * Write important events to bus.jsonl as audit trail, regardless of WS.
   * Ensures events are persisted even if PM Hub crashes or restarts.
   *
   * @param {string} eventType — event type (task_claimed, task_complete, etc.)
   * @param {object} data — event data
   */
  _auditToFileBus(eventType, data) {
    const messaging = getMessaging();
    if (!messaging) return;

    try {
      messaging.sendMessage({
        type: 'notify',
        from: 'pm-hub',
        to: '*',
        topic: `hub.${eventType}`,
        priority: 'fyi',
        payload: { action: `hub.${eventType}`, data }
      });
    } catch (e) { /* best effort — don't break hub operation */ }
  }

  /**
   * Reconcile events from file bus that happened while PM Hub was down.
   * Called once during start() after server is listening.
   *
   * Reads bus.jsonl for ask_pm messages that arrived while hub was offline,
   * and any task_complete/task_claimed events from agents using file bus fallback.
   *
   * @returns {{ reconciled: number }}
   */
  _reconcileFromFileBus() {
    const messaging = getMessaging();
    if (!messaging) return { reconciled: 0 };

    let reconciled = 0;

    try {
      // Use session ID 'pm' since agents address messages to='pm'
      const PM_SESSION = 'pm';

      // On first start, initialize cursor at byte_offset=0 to read all pending messages
      const cursor0 = messaging.loadCursor(PM_SESSION);
      if (!cursor0) {
        messaging.writeCursor(PM_SESSION, {
          session_id: PM_SESSION,
          last_seq: -1,
          byte_offset: 0,
          processed_ids: []
        });
      }

      // Read as 'pm' session — only unprocessed messages for PM
      const { messages, cursor } = messaging.readMessages(PM_SESSION, {
        types: ['ask_pm', 'notify', 'request'],
        role: 'pm'
      });

      for (const msg of messages) {
        // Handle ask_pm messages that came via file bus
        if (msg.type === 'ask_pm' && msg.payload && msg.payload.question && this.brain) {
          const question = msg.payload.question;
          const ctx = msg.payload.context || {};
          try {
            const result = this.brain.ask(msg.from, question, ctx);
            // Send response back via file bus (agent may not be on WS)
            messaging.sendPmResponse(msg.id, msg.from, result);
            reconciled++;
          } catch (e) { /* skip failed brain calls */ }
        }

        // Handle task_complete notifications from file bus
        if (msg.topic === 'task.completed' && msg.payload && msg.payload.data) {
          const taskId = msg.payload.data.task_id;
          const completedBy = msg.payload.data.completed_by;
          if (taskId && completedBy) {
            this.emit('task_complete', completedBy, taskId, msg.payload.data.result || {});
            reconciled++;
          }
        }
      }

      // Acknowledge processed messages
      if (messages.length > 0) {
        messaging.acknowledgeMessages(PM_SESSION, cursor, messages.map(m => m.id));
      }
    } catch (e) { /* best effort */ }

    return { reconciled };
  }

  _writePortFile() {
    const filePath = path.join(this.projectRoot, HUB_STATE_PATH);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify({
      port: this.port,
      pid: process.pid,
      started_at: new Date().toISOString()
    }, null, 2));
    fs.renameSync(tmpPath, filePath);
  }

  _removePortFile() {
    const filePath = path.join(this.projectRoot, HUB_STATE_PATH);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) { /* best effort */ }
  }
}

module.exports = {
  PmHub,
  DEFAULT_PORT,
  HUB_STATE_PATH,
  HEARTBEAT_STALE_MS,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
  AUDIT_EVENT_TYPES,
  // Exported for testing
  wsEncodeText,
  wsParseFrames,
  wsCloseFrame,
  wsPongFrame,
  RateLimiter
};
