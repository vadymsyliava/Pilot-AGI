/**
 * Agent Connector — WebSocket + HTTP client for agents to talk to PM Hub
 *
 * Primary: WebSocket connection on /api/connect for persistent bidirectional channel.
 * Fallback: HTTP REST via curl (sync) when WS unavailable.
 * Final fallback: file bus (messaging.js) when PM Hub is unreachable.
 *
 * Features:
 *   - Port discovery: pm-hub.json → PILOT_PM_PORT env → default 3847
 *   - WebSocket with auto-reconnect (exponential backoff: 1s→2s→4s→8s, max 30s)
 *   - Event emitters: connected, disconnected, error, message
 *   - Session token auth on WS handshake (register message)
 *   - Graceful degradation chain: WS → HTTP → file bus
 *
 * Part of Phase 5.0 (Pilot AGI-adl.3)
 */

const net = require('net');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

// ============================================================================
// LAZY DEPS
// ============================================================================

let _wsProtocol = null;
function getWsProtocol() {
  if (!_wsProtocol) {
    try { _wsProtocol = require('./ws-protocol'); } catch (e) { _wsProtocol = null; }
  }
  return _wsProtocol;
}

let _messaging = null;
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
const DEFAULT_TIMEOUT_MS = 5000;
const ASK_PM_TIMEOUT_MS = 130000;
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Reconnect backoff
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_MULTIPLIER = 2;

// ============================================================================
// WS FRAME HELPERS (client-side: must mask frames)
// ============================================================================

function wsEncodeTextMasked(text) {
  const payload = Buffer.from(text, 'utf8');
  const maskKey = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) {
    masked[i] ^= maskKey[i % 4];
  }

  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text
    header[1] = 0x80 | payload.length; // mask bit set
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  return Buffer.concat([header, maskKey, masked]);
}

function wsMaskedCloseFrame(code = 1000) {
  const maskKey = crypto.randomBytes(4);
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) {
    masked[i] ^= maskKey[i % 4];
  }
  const header = Buffer.alloc(2);
  header[0] = 0x88; // FIN + close
  header[1] = 0x80 | 2; // masked, 2 bytes
  return Buffer.concat([header, maskKey, masked]);
}

// Import wsParseFrames from pm-hub (server-side parser works for unmasked server frames)
let _wsParseFrames = null;
function getWsParseFrames() {
  if (!_wsParseFrames) {
    try { _wsParseFrames = require('./pm-hub').wsParseFrames; } catch (e) { _wsParseFrames = null; }
  }
  return _wsParseFrames;
}

// ============================================================================
// AGENT CONNECTOR
// ============================================================================

class AgentConnector extends EventEmitter {
  /**
   * @param {string} sessionId
   * @param {object} opts
   * @param {string} opts.projectRoot
   * @param {number} opts.port — override port discovery
   * @param {string} opts.role — agent role
   * @param {string[]} opts.capabilities — agent capabilities
   * @param {boolean} opts.autoReconnect — enable auto-reconnect (default true)
   */
  constructor(sessionId, opts = {}) {
    super();
    this.sessionId = sessionId;
    this.projectRoot = opts.projectRoot || process.cwd();
    this.port = opts.port || null;
    this.role = opts.role || 'general';
    this.capabilities = opts.capabilities || [];
    this.autoReconnect = opts.autoReconnect !== false;

    // WS state
    this._socket = null;
    this._wsConnected = false;
    this._buffer = Buffer.alloc(0);
    this._reconnectDelay = RECONNECT_INITIAL_MS;
    this._reconnectTimer = null;
    this._intentionalDisconnect = false;
    this._messageHandlers = [];

    // HTTP state
    this._httpConnected = false;
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Connect to PM Hub. Tries HTTP register first (sync), then starts WS
   * upgrade in background. Returns immediately with connection state.
   *
   * Connection priority:
   *   1. HTTP register (sync, immediate)
   *   2. WS upgrade (async, background — upgrades to bidirectional when ready)
   *   3. File bus fallback (when PM Hub is unreachable)
   *
   * @returns {{ connected: boolean, mode?: string, port?: number, fallback?: string }}
   */
  connect() {
    this.discoverPort();
    this._intentionalDisconnect = false;

    // Try HTTP registration first (sync, reliable for hooks)
    const httpResult = this._httpRegister();
    if (httpResult.connected) {
      // Start WS upgrade in background (will emit 'connected' with mode: websocket)
      this._wsConnect();
      return { connected: true, mode: 'http', port: this.port };
    }

    // If HTTP fails, try WS directly (async, won't block)
    this._wsConnect();

    // File bus fallback
    return { connected: false, fallback: 'file_bus' };
  }

  /**
   * Send a message to PM Hub. Prefers WS, falls back to HTTP, then file bus.
   * @param {object} msg — protocol message object
   * @returns {{ sent: boolean, via?: string }}
   */
  send(msg) {
    // Try WS
    if (this._wsConnected && this._socket && this._socket.writable) {
      try {
        this._socket.write(wsEncodeTextMasked(JSON.stringify(msg)));
        return { sent: true, via: 'websocket' };
      } catch (e) { /* fall through */ }
    }

    // Try HTTP POST based on message type
    const httpResult = this._httpSendMessage(msg);
    if (httpResult.sent) return httpResult;

    // File bus fallback
    const messaging = getMessaging();
    if (messaging) {
      try {
        messaging.sendBroadcast(this.sessionId, msg.type || 'message', msg);
        return { sent: true, via: 'file_bus' };
      } catch (e) { /* ignore */ }
    }

    return { sent: false };
  }

  /**
   * Register a message handler for incoming PM messages.
   * @param {function} handler — (msg: object) => void
   */
  onMessage(handler) {
    this._messageHandlers.push(handler);
  }

  /**
   * Disconnect from PM Hub.
   */
  disconnect() {
    this._intentionalDisconnect = true;
    this._clearReconnectTimer();

    if (this._socket) {
      try {
        this._socket.write(wsMaskedCloseFrame(1000));
        this._socket.end();
      } catch (e) { /* already closed */ }
      this._socket = null;
    }

    this._wsConnected = false;
    this._httpConnected = false;
    this.emit('disconnected', { reason: 'intentional' });
  }

  /**
   * Check if connected to PM Hub via any channel.
   * @returns {boolean}
   */
  isConnected() {
    return this._wsConnected || this._httpConnected;
  }

  /**
   * Check if connected via WebSocket specifically.
   * @returns {boolean}
   */
  isWsConnected() {
    return this._wsConnected;
  }

  // ==========================================================================
  // CONVENIENCE METHODS (delegate to send with protocol builders)
  // ==========================================================================

  /**
   * Send heartbeat.
   */
  heartbeat(data = {}) {
    const proto = getWsProtocol();
    if (proto) {
      return this.send(proto.buildHeartbeat(this.sessionId, data));
    }
    return this.send({
      type: 'heartbeat',
      sessionId: this.sessionId,
      ...data
    });
  }

  /**
   * Ask PM for guidance.
   * For sync HTTP path, returns the result directly.
   * For WS path, sends the message (response arrives via onMessage).
   */
  askPm(question, context = {}) {
    // Prefer sync HTTP for ask-pm since caller usually needs the response
    this.discoverPort();
    const result = this._post('/api/ask-pm', {
      sessionId: this.sessionId,
      question,
      context
    }, ASK_PM_TIMEOUT_MS);

    if (result.success) return result.data;
    return { success: false, error: result.error || 'PM Hub unreachable' };
  }

  /**
   * Report task completion.
   */
  reportTaskComplete(taskId, result = {}) {
    const proto = getWsProtocol();
    if (proto) {
      return this.send(proto.buildTaskComplete(this.sessionId, taskId, result));
    }
    return this.send({
      type: 'task_complete',
      sessionId: this.sessionId,
      taskId,
      result
    });
  }

  // ==========================================================================
  // PORT DISCOVERY
  // ==========================================================================

  /**
   * Discover PM Hub port from: pm-hub.json → env → default.
   * @returns {number}
   */
  discoverPort() {
    if (this.port) return this.port;

    // 1. Read pm-hub.json
    try {
      const hubFile = path.join(this.projectRoot, HUB_STATE_PATH);
      if (fs.existsSync(hubFile)) {
        const data = JSON.parse(fs.readFileSync(hubFile, 'utf8'));
        if (data.port) {
          this.port = data.port;
          return this.port;
        }
      }
    } catch (e) { /* ignore */ }

    // 2. Environment variable
    if (process.env.PILOT_PM_PORT) {
      this.port = parseInt(process.env.PILOT_PM_PORT, 10);
      return this.port;
    }

    // 3. Default
    this.port = DEFAULT_PORT;
    return this.port;
  }

  // ==========================================================================
  // WEBSOCKET CONNECTION
  // ==========================================================================

  /**
   * Attempt synchronous-ish WS connection (blocks briefly for handshake).
   * Returns immediately if PM Hub is not reachable.
   */
  _wsConnect() {
    const parseFrames = getWsParseFrames();
    if (!parseFrames) {
      return { connected: false };
    }

    try {
      const socket = net.createConnection({ host: '127.0.0.1', port: this.port });
      let handshakeComplete = false;
      let handshakeError = null;

      // Synchronous wait for connection (brief timeout)
      socket.setTimeout(2000);

      const wsKey = crypto.randomBytes(16).toString('base64');

      socket.on('connect', () => {
        // Send HTTP upgrade request
        socket.write(
          'GET /api/connect HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${this.port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${wsKey}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n'
        );
      });

      socket.on('error', (err) => {
        handshakeError = err;
        if (!handshakeComplete) {
          this._handleWsDisconnect('error');
        }
      });

      // Set up data handler for both handshake and messages
      let handshakeBuffer = '';
      let wsMode = false;

      socket.on('data', (data) => {
        if (!wsMode) {
          // Still in HTTP upgrade phase
          handshakeBuffer += data.toString('ascii');
          if (handshakeBuffer.includes('\r\n\r\n')) {
            if (handshakeBuffer.includes('101 Switching Protocols')) {
              wsMode = true;
              handshakeComplete = true;
              this._socket = socket;
              this._wsConnected = true;
              this._reconnectDelay = RECONNECT_INITIAL_MS;
              this._buffer = Buffer.alloc(0);

              socket.setTimeout(0); // clear timeout for long-lived connection

              // Send register
              const proto = getWsProtocol();
              const regMsg = proto
                ? proto.buildRegister(this.sessionId, { role: this.role, capabilities: this.capabilities })
                : { type: 'register', sessionId: this.sessionId, role: this.role, capabilities: this.capabilities };
              socket.write(wsEncodeTextMasked(JSON.stringify(regMsg)));

              this.emit('connected', { mode: 'websocket', port: this.port });

              // Reconcile: deliver any messages from file bus during disconnect
              this._reconcileFileBusMessages();

              // Check if there's remaining data after HTTP headers
              const headerEnd = handshakeBuffer.indexOf('\r\n\r\n') + 4;
              const remaining = data.subarray(data.toString('ascii').indexOf('\r\n\r\n') + 4);
              if (remaining.length > 0) {
                this._processWsData(remaining, parseFrames);
              }
            } else {
              handshakeError = new Error('WS upgrade rejected');
              socket.destroy();
            }
          }
        } else {
          // WebSocket mode
          this._processWsData(data, parseFrames);
        }
      });

      socket.on('close', () => {
        this._handleWsDisconnect('close');
      });

      socket.on('timeout', () => {
        if (!handshakeComplete) {
          socket.destroy();
          handshakeError = new Error('WS handshake timeout');
        }
      });

      // Give the connection a moment to establish
      // (This is a best-effort sync approach — WS will complete async)
      // We return immediately; the 'connected' event fires when handshake completes
      if (handshakeError) {
        return { connected: false, error: handshakeError.message };
      }

      // Return optimistically — actual connection state managed by events
      return { connected: false, pending: true };
    } catch (e) {
      return { connected: false, error: e.message };
    }
  }

  _processWsData(data, parseFrames) {
    this._buffer = Buffer.concat([this._buffer, data]);
    const { messages, remaining } = parseFrames(this._buffer);
    this._buffer = remaining;

    for (const msg of messages) {
      if (msg.type === 'close') {
        this._handleWsDisconnect('close_frame');
        return;
      }

      if (msg.type === 'ping') {
        // Respond with masked pong
        if (this._socket && this._socket.writable) {
          const maskKey = crypto.randomBytes(4);
          const pongData = msg.data || Buffer.alloc(0);
          const masked = Buffer.from(pongData);
          for (let i = 0; i < masked.length; i++) {
            masked[i] ^= maskKey[i % 4];
          }
          const header = Buffer.alloc(2);
          header[0] = 0x8a; // FIN + pong
          header[1] = 0x80 | pongData.length;
          try {
            this._socket.write(Buffer.concat([header, maskKey, masked]));
          } catch (e) { /* ignore */ }
        }
        continue;
      }

      if (msg.type === 'text') {
        try {
          const parsed = JSON.parse(msg.data);
          this.emit('message', parsed);
          for (const handler of this._messageHandlers) {
            try { handler(parsed); } catch (e) { /* handler error */ }
          }
        } catch (e) {
          this.emit('error', new Error('Invalid JSON from PM'));
        }
      }
    }
  }

  _handleWsDisconnect(reason) {
    const wasConnected = this._wsConnected;
    this._wsConnected = false;
    this._socket = null;

    if (wasConnected) {
      this.emit('disconnected', { reason });
    }

    // Auto-reconnect
    if (this.autoReconnect && !this._intentionalDisconnect) {
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    this._clearReconnectTimer();

    this._reconnectTimer = setTimeout(() => {
      if (this._intentionalDisconnect) return;
      this.discoverPort(); // re-discover in case port changed
      this._wsConnect();
    }, this._reconnectDelay);

    if (this._reconnectTimer.unref) this._reconnectTimer.unref();

    // Exponential backoff
    this._reconnectDelay = Math.min(
      this._reconnectDelay * RECONNECT_MULTIPLIER,
      RECONNECT_MAX_MS
    );
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  // ==========================================================================
  // FILE BUS RECONCILIATION
  // ==========================================================================

  /**
   * On WS reconnect, check file bus for PM messages that arrived during disconnect.
   * Delivers them to message handlers so agent doesn't miss anything.
   */
  _reconcileFileBusMessages() {
    const messaging = getMessaging();
    if (!messaging) return;

    try {
      // Ensure cursor starts at 0 if none exists, to catch messages from disconnect period
      const cursor0 = messaging.loadCursor(this.sessionId);
      if (!cursor0) {
        messaging.writeCursor(this.sessionId, {
          session_id: this.sessionId,
          last_seq: -1,
          byte_offset: 0,
          processed_ids: []
        });
      }

      const { messages, cursor } = messaging.readMessages(this.sessionId, {
        types: ['pm_response', 'notify', 'broadcast', 'request', 'task_delegate']
      });

      if (messages.length === 0) return;

      // Deliver file bus messages to handlers
      for (const msg of messages) {
        this.emit('message', msg);
        for (const handler of this._messageHandlers) {
          try { handler(msg); } catch (e) { /* handler error */ }
        }
      }

      // Acknowledge so we don't re-deliver
      messaging.acknowledgeMessages(this.sessionId, cursor, messages.map(m => m.id));
    } catch (e) { /* best effort */ }
  }

  // ==========================================================================
  // HTTP FALLBACK
  // ==========================================================================

  _httpRegister() {
    const result = this._post('/api/register', {
      sessionId: this.sessionId,
      role: this.role,
      capabilities: this.capabilities
    }, DEFAULT_TIMEOUT_MS);

    if (result.success) {
      this._httpConnected = true;
      return { connected: true, mode: 'http' };
    }

    this._httpConnected = false;
    return { connected: false };
  }

  /**
   * Route a protocol message to the appropriate HTTP endpoint.
   */
  _httpSendMessage(msg) {
    if (!msg || !msg.type) return { sent: false };

    this.discoverPort();

    switch (msg.type) {
      case 'heartbeat':
        return this._httpPost('/api/heartbeat', msg);
      case 'task_complete':
        if (msg.taskId) {
          return this._httpPost(`/api/tasks/${encodeURIComponent(msg.taskId)}/complete`, msg);
        }
        return this._httpPost('/api/report', msg);
      case 'ask_pm':
        return this._httpPost('/api/ask-pm', msg);
      case 'checkpoint':
      case 'request':
      case 'register':
        return this._httpPost('/api/report', msg);
      default:
        return this._httpPost('/api/report', msg);
    }
  }

  _httpPost(urlPath, body) {
    const result = this._post(urlPath, body, DEFAULT_TIMEOUT_MS);
    return { sent: result.success, via: 'http', data: result.data };
  }

  // ==========================================================================
  // HTTP CLIENT (sync via curl)
  // ==========================================================================

  _post(urlPath, body, timeoutMs) {
    try {
      const { execFileSync } = require('child_process');
      const payload = JSON.stringify(body);

      const output = execFileSync('curl', [
        '-s',
        '-X', 'POST',
        '-H', 'Content-Type: application/json',
        '-d', payload,
        '--connect-timeout', String(Math.ceil(Math.min(timeoutMs, 5000) / 1000)),
        '--max-time', String(Math.ceil(timeoutMs / 1000)),
        `http://127.0.0.1:${this.port}${urlPath}`
      ], {
        encoding: 'utf8',
        timeout: timeoutMs + 1000,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      if (!output || output.trim() === '') {
        return { success: false, error: 'Empty response' };
      }

      const data = JSON.parse(output);
      return { success: true, data };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  _get(urlPath, timeoutMs) {
    try {
      const { execFileSync } = require('child_process');

      const output = execFileSync('curl', [
        '-s',
        '--connect-timeout', String(Math.ceil(Math.min(timeoutMs, 5000) / 1000)),
        '--max-time', String(Math.ceil(timeoutMs / 1000)),
        `http://127.0.0.1:${this.port}${urlPath}`
      ], {
        encoding: 'utf8',
        timeout: timeoutMs + 1000,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      if (!output || output.trim() === '') {
        return { success: false, error: 'Empty response' };
      }

      const data = JSON.parse(output);
      return { success: true, data };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Pull pending messages via HTTP (for non-WS agents).
   * @returns {object[]} array of messages
   */
  pullMessages() {
    this.discoverPort();
    const result = this._get(`/api/messages/${encodeURIComponent(this.sessionId)}`, DEFAULT_TIMEOUT_MS);
    if (result.success && result.data && Array.isArray(result.data.messages)) {
      return result.data.messages;
    }
    return [];
  }
}

module.exports = { AgentConnector, DEFAULT_PORT, HUB_STATE_PATH };
