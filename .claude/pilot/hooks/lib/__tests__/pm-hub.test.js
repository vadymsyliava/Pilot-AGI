/**
 * Tests for PM Hub Server -- Phase 5.0
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/pm-hub.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

// ============================================================================
// TEST HARNESS
// ============================================================================

let testDir;
let passed = 0;
let failed = 0;
let currentPort = 4100;
const originalCwd = process.cwd();

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-hub-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/messages'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/messages/cursors'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/orchestrator'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/config'), { recursive: true });

  // Write empty bus file
  fs.writeFileSync(path.join(testDir, '.claude/pilot/messages/bus.jsonl'), '');

  // Write minimal policy
  fs.writeFileSync(path.join(testDir, '.claude/pilot/policy.yaml'), `
session:
  max_concurrent_sessions: 6
orchestrator:
  cost_tracking:
    enabled: false
`);

  // Override cwd
  process.cwd = () => testDir;
}

function cleanup() {
  process.cwd = () => originalCwd;
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (e) { /* ok */ }
}

function freshRequire(modPath) {
  const keysToDelete = Object.keys(require.cache).filter(k =>
    k.includes('pm-hub') ||
    k.includes('messaging') ||
    k.includes('session') ||
    k.includes('ws-protocol') ||
    k.includes('agent-connector')
  );
  keysToDelete.forEach(k => delete require.cache[k]);
  return require(modPath);
}

function getPort() {
  return currentPort++;
}

function createSessionFile(sessionId) {
  const sessDir = path.join(testDir, '.claude/pilot/state/sessions');
  fs.writeFileSync(path.join(sessDir, sessionId + '.json'), JSON.stringify({
    id: sessionId,
    status: 'active',
    started_at: new Date().toISOString(),
    role: 'general'
  }));
}

/**
 * HTTP helper: make a request and return { statusCode, body }
 */
function httpRequest(method, urlPath, port, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' }
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Build a masked WebSocket text frame (client must mask per RFC 6455).
 */
function wsEncodeTextMaskedLocal(text) {
  const payload = Buffer.from(text, 'utf8');
  const maskKey = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) {
    masked[i] ^= maskKey[i % 4];
  }

  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = 0x80 | payload.length;
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

/**
 * Perform a raw TCP WebSocket upgrade handshake.
 * Returns { socket, acceptedData } once 101 is received.
 */
function wsUpgrade(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      const wsKey = crypto.randomBytes(16).toString('base64');
      socket.write(
        'GET /api/connect HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${wsKey}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n'
      );

      let buf = '';
      const onData = (data) => {
        buf += data.toString('ascii');
        if (buf.includes('\r\n\r\n')) {
          socket.removeListener('data', onData);
          if (buf.includes('101 Switching Protocols')) {
            resolve({ socket, wsKey });
          } else {
            reject(new Error('Upgrade rejected: ' + buf.split('\r\n')[0]));
          }
        }
      };
      socket.on('data', onData);
    });

    socket.on('error', reject);
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error('Upgrade timeout'));
    });
  });
}

/**
 * Create a buffered WS reader attached to a socket.
 * Accumulates data and parses frames. Call reader.next() to get next message.
 */
function createWsReader(socket, parseFrames) {
  let buffer = Buffer.alloc(0);
  const pendingMessages = [];
  let waitingResolve = null;

  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    const { messages, remaining } = parseFrames(buffer);
    buffer = remaining;

    for (const msg of messages) {
      if (msg.type === 'text') {
        try {
          const parsed = JSON.parse(msg.data);
          if (waitingResolve) {
            const resolve = waitingResolve;
            waitingResolve = null;
            resolve(parsed);
          } else {
            pendingMessages.push(parsed);
          }
        } catch (e) { /* ignore parse errors */ }
      }
    }
  });

  return {
    next(timeoutMs = 3000) {
      if (pendingMessages.length > 0) {
        return Promise.resolve(pendingMessages.shift());
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waitingResolve = null;
          reject(new Error('WS read timeout'));
        }, timeoutMs);
        waitingResolve = (msg) => {
          clearTimeout(timer);
          resolve(msg);
        };
      });
    }
  };
}

/**
 * Wait for a WS text frame from server. Returns parsed JSON.
 * Convenience wrapper for one-shot reads (uses createWsReader internally).
 */
function wsReadMessage(socket, parseFrames, timeoutMs = 3000) {
  // For one-shot, create a temporary reader
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.removeAllListeners('data');
      reject(new Error('WS read timeout'));
    }, timeoutMs);

    const onData = (data) => {
      buffer = Buffer.concat([buffer, data]);
      const { messages, remaining } = parseFrames(buffer);
      buffer = remaining;

      for (const msg of messages) {
        if (msg.type === 'text') {
          clearTimeout(timer);
          socket.removeListener('data', onData);
          try {
            resolve(JSON.parse(msg.data));
          } catch (e) {
            reject(new Error('Invalid JSON: ' + msg.data));
          }
          return;
        }
      }
    };
    socket.on('data', onData);
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Sync test wrapper
function test(name, fn) {
  setup();
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`    ${e.message}`);
    if (e.stack) {
      const lines = e.stack.split('\n').slice(1, 3);
      lines.forEach(l => console.log(`    ${l.trim()}`));
    }
  } finally {
    cleanup();
  }
}

// Async test wrapper
function testAsync(name, fn) {
  return new Promise((resolve) => {
    setup();
    fn()
      .then(() => {
        passed++;
        console.log(`  PASS ${name}`);
      })
      .catch((e) => {
        failed++;
        console.log(`  FAIL ${name}`);
        console.log(`    ${e.message}`);
        if (e.stack) {
          const lines = e.stack.split('\n').slice(1, 3);
          lines.forEach(l => console.log(`    ${l.trim()}`));
        }
      })
      .finally(() => {
        cleanup();
        resolve();
      });
  });
}

// ============================================================================
// TESTS
// ============================================================================

async function runTests() {
  console.log('\nPmHub Tests');
  console.log('='.repeat(60));

  // ========================================================================
  // RateLimiter tests
  // ========================================================================

  console.log('\n  RateLimiter');

  test('allow() returns true up to max requests', () => {
    const { RateLimiter } = freshRequire('../pm-hub');
    const rl = new RateLimiter(60000, 5);
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(rl.allow('1.2.3.4'), true, `Request ${i + 1} should be allowed`);
    }
  });

  test('allow() returns false when limit exceeded', () => {
    const { RateLimiter } = freshRequire('../pm-hub');
    const rl = new RateLimiter(60000, 3);
    assert.strictEqual(rl.allow('1.2.3.4'), true);
    assert.strictEqual(rl.allow('1.2.3.4'), true);
    assert.strictEqual(rl.allow('1.2.3.4'), true);
    assert.strictEqual(rl.allow('1.2.3.4'), false, 'Fourth request should be rejected');
  });

  test('allow() tracks separate IPs independently', () => {
    const { RateLimiter } = freshRequire('../pm-hub');
    const rl = new RateLimiter(60000, 2);
    assert.strictEqual(rl.allow('1.1.1.1'), true);
    assert.strictEqual(rl.allow('1.1.1.1'), true);
    assert.strictEqual(rl.allow('1.1.1.1'), false);
    // Different IP still allowed
    assert.strictEqual(rl.allow('2.2.2.2'), true);
  });

  test('cleanup() removes stale entries', () => {
    const { RateLimiter } = freshRequire('../pm-hub');
    const rl = new RateLimiter(100, 10); // 100ms window
    rl.allow('stale-ip');
    assert.strictEqual(rl.hits.size, 1);

    // Manipulate timestamps to simulate staleness
    const timestamps = rl.hits.get('stale-ip');
    timestamps[0] = Date.now() - 200; // 200ms ago, beyond 100ms window

    rl.cleanup();
    assert.strictEqual(rl.hits.size, 0, 'Stale IP should be removed');
  });

  // ========================================================================
  // wsEncodeText / wsParseFrames tests
  // ========================================================================

  console.log('\n  WebSocket frame helpers');

  test('wsEncodeText + wsParseFrames round-trip', () => {
    const { wsEncodeText, wsParseFrames } = freshRequire('../pm-hub');
    const text = 'Hello, WebSocket!';
    const frame = wsEncodeText(text);
    const { messages, remaining } = wsParseFrames(frame);

    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].type, 'text');
    assert.strictEqual(messages[0].data, text);
    assert.strictEqual(remaining.length, 0);
  });

  test('wsParseFrames handles multiple concatenated frames', () => {
    const { wsEncodeText, wsParseFrames } = freshRequire('../pm-hub');
    const frame1 = wsEncodeText('frame-one');
    const frame2 = wsEncodeText('frame-two');
    const combined = Buffer.concat([frame1, frame2]);

    const { messages, remaining } = wsParseFrames(combined);
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[0].data, 'frame-one');
    assert.strictEqual(messages[1].data, 'frame-two');
    assert.strictEqual(remaining.length, 0);
  });

  test('wsParseFrames identifies close frame', () => {
    const { wsParseFrames, wsCloseFrame } = freshRequire('../pm-hub');
    const close = wsCloseFrame(1000);
    const { messages } = wsParseFrames(close);

    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].type, 'close');
  });

  test('wsParseFrames identifies ping frame', () => {
    const { wsParseFrames } = freshRequire('../pm-hub');
    // Build a ping frame (opcode 0x09) with no payload
    const ping = Buffer.alloc(2);
    ping[0] = 0x89; // FIN + ping opcode
    ping[1] = 0;    // no payload

    const { messages } = wsParseFrames(ping);
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].type, 'ping');
  });

  test('wsPongFrame builds valid pong', () => {
    const { wsPongFrame, wsParseFrames } = freshRequire('../pm-hub');
    const pong = wsPongFrame(Buffer.from('test'));
    const { messages } = wsParseFrames(pong);

    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].type, 'pong');
  });

  test('wsParseFrames returns remaining bytes for incomplete frame', () => {
    const { wsEncodeText, wsParseFrames } = freshRequire('../pm-hub');
    const frame = wsEncodeText('complete message');
    // Truncate: remove last 3 bytes to simulate incomplete
    const partial = frame.subarray(0, frame.length - 3);

    const { messages, remaining } = wsParseFrames(partial);
    assert.strictEqual(messages.length, 0, 'No complete messages from partial frame');
    assert.ok(remaining.length > 0, 'Should have remaining bytes');
  });

  test('wsEncodeText handles large payload (>125 bytes, 2-byte length)', () => {
    const { wsEncodeText, wsParseFrames } = freshRequire('../pm-hub');
    const longText = 'A'.repeat(200);
    const frame = wsEncodeText(longText);
    const { messages } = wsParseFrames(frame);

    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].data, longText);
  });

  // ========================================================================
  // PmHub lifecycle tests
  // ========================================================================

  console.log('\n  PmHub lifecycle');

  await testAsync('start() binds to port and writes port file', async () => {
    const { PmHub, HUB_STATE_PATH } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });

    try {
      const result = await hub.start();
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.port, port);
      assert.strictEqual(hub.listening, true);

      // Port file should exist
      const portFile = path.join(testDir, HUB_STATE_PATH);
      assert.ok(fs.existsSync(portFile), 'Port file should exist');
      const portData = JSON.parse(fs.readFileSync(portFile, 'utf8'));
      assert.strictEqual(portData.port, port);
      assert.ok(portData.pid);
    } finally {
      hub.stop();
    }
  });

  await testAsync('stop() cleans up connections and removes port file', async () => {
    const { PmHub, HUB_STATE_PATH } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });

    await hub.start();
    const portFile = path.join(testDir, HUB_STATE_PATH);
    assert.ok(fs.existsSync(portFile), 'Port file should exist before stop');

    hub.stop();
    assert.strictEqual(hub.listening, false);
    assert.strictEqual(hub.agents.size, 0);
    assert.ok(!fs.existsSync(portFile), 'Port file should be removed after stop');
  });

  await testAsync('port auto-increment on EADDRINUSE', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();

    // Occupy the port with a plain server
    const blocker = http.createServer();
    await new Promise((resolve) => {
      blocker.listen(port, '127.0.0.1', resolve);
    });

    try {
      const hub = new PmHub(testDir, { port });
      const result = await hub.start();
      assert.strictEqual(result.success, true);
      assert.ok(result.port > port, `Port should have incremented from ${port}, got ${result.port}`);
      hub.stop();
    } finally {
      blocker.close();
    }
    // Advance currentPort past what might have been used
    currentPort = Math.max(currentPort, port + 5);
  });

  await testAsync('start() is idempotent if already started', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });

    try {
      const r1 = await hub.start();
      assert.strictEqual(r1.success, true);
      const r2 = await hub.start();
      assert.strictEqual(r2.success, true);
      assert.strictEqual(r2.port, port);
    } finally {
      hub.stop();
    }
  });

  // ========================================================================
  // HTTP endpoint tests
  // ========================================================================

  console.log('\n  HTTP endpoints');

  await testAsync('GET /api/status returns status object', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });

    try {
      await hub.start();
      const { statusCode, body } = await httpRequest('GET', '/api/status', port);
      assert.strictEqual(statusCode, 200);
      assert.strictEqual(body.listening, true);
      assert.strictEqual(body.port, port);
      assert.strictEqual(body.connected_agents, 0);
      assert.strictEqual(body.brain_available, false);
    } finally {
      hub.stop();
    }
  });

  await testAsync('POST /api/register with valid session creates agent entry', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });
    createSessionFile('test-agent');

    try {
      await hub.start();
      const { statusCode, body } = await httpRequest('POST', '/api/register', port, {
        sessionId: 'test-agent',
        role: 'backend'
      });
      assert.strictEqual(statusCode, 200);
      assert.strictEqual(body.connected, true);
      assert.strictEqual(body.agents_count, 1);

      // Verify agent is registered
      assert.ok(hub.agents.has('test-agent'));
      assert.strictEqual(hub.agents.get('test-agent').role, 'backend');
    } finally {
      hub.stop();
    }
  });

  await testAsync('POST /api/register without sessionId returns 400', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });

    try {
      await hub.start();
      const { statusCode, body } = await httpRequest('POST', '/api/register', port, {
        role: 'backend'
      });
      assert.strictEqual(statusCode, 400);
      assert.ok(body.error.includes('sessionId'));
    } finally {
      hub.stop();
    }
  });

  await testAsync('POST /api/register with invalid session returns 403', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });
    // Do NOT create session file -- should fail validation

    try {
      await hub.start();
      const { statusCode, body } = await httpRequest('POST', '/api/register', port, {
        sessionId: 'nonexistent-session'
      });
      assert.strictEqual(statusCode, 403);
      assert.ok(body.error.includes('Invalid session'));
    } finally {
      hub.stop();
    }
  });

  await testAsync('POST /api/heartbeat updates agent lastHeartbeat', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });
    createSessionFile('hb-agent');

    try {
      await hub.start();
      // Register first
      await httpRequest('POST', '/api/register', port, { sessionId: 'hb-agent' });

      const beforeHb = hub.agents.get('hb-agent').lastHeartbeat;
      await delay(20);

      const { statusCode, body } = await httpRequest('POST', '/api/heartbeat', port, {
        sessionId: 'hb-agent',
        pressure: 0.5
      });
      assert.strictEqual(statusCode, 200);
      assert.strictEqual(body.ok, true);

      const afterHb = hub.agents.get('hb-agent').lastHeartbeat;
      assert.ok(afterHb >= beforeHb, 'Heartbeat should update lastHeartbeat');
      assert.strictEqual(hub.agents.get('hb-agent').pressure, 0.5);
    } finally {
      hub.stop();
    }
  });

  await testAsync('POST /api/heartbeat auto-registers unknown agent', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });

    try {
      await hub.start();
      // Heartbeat without prior registration
      const { statusCode, body } = await httpRequest('POST', '/api/heartbeat', port, {
        sessionId: 'auto-reg-agent',
        taskId: 'T-abc'
      });
      assert.strictEqual(statusCode, 200);
      assert.ok(hub.agents.has('auto-reg-agent'), 'Agent should be auto-registered');
      assert.strictEqual(hub.agents.get('auto-reg-agent').taskId, 'T-abc');
    } finally {
      hub.stop();
    }
  });

  await testAsync('POST /api/ask-pm returns 503 when no brain', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port }); // no brain

    try {
      await hub.start();
      const { statusCode, body } = await httpRequest('POST', '/api/ask-pm', port, {
        sessionId: 'ask-agent',
        question: 'What should I do?'
      });
      assert.strictEqual(statusCode, 503);
      assert.ok(body.error.includes('Brain not available'));
    } finally {
      hub.stop();
    }
  });

  await testAsync('POST /api/ask-pm with brain returns guidance', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();

    const mockBrain = {
      ask: (sessionId, question, ctx) => {
        return { guidance: 'Do X then Y', confidence: 0.9 };
      }
    };
    const hub = new PmHub(testDir, { port, brain: mockBrain });

    try {
      await hub.start();
      const { statusCode, body } = await httpRequest('POST', '/api/ask-pm', port, {
        sessionId: 'ask-agent',
        question: 'What should I do?'
      });
      assert.strictEqual(statusCode, 200);
      assert.strictEqual(body.guidance, 'Do X then Y');
      assert.strictEqual(body.confidence, 0.9);
    } finally {
      hub.stop();
    }
  });

  await testAsync('POST /api/ask-pm with async brain works', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();

    const mockBrain = {
      ask: async (sessionId, question, ctx) => {
        await delay(10);
        return { guidance: 'Async answer' };
      }
    };
    const hub = new PmHub(testDir, { port, brain: mockBrain });

    try {
      await hub.start();
      const { statusCode, body } = await httpRequest('POST', '/api/ask-pm', port, {
        sessionId: 's1',
        question: 'Async?'
      });
      assert.strictEqual(statusCode, 200);
      assert.strictEqual(body.guidance, 'Async answer');
    } finally {
      hub.stop();
    }
  });

  await testAsync('POST /api/tasks/:id/complete emits task_complete event', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });
    createSessionFile('complete-agent');

    let emitted = null;
    hub.on('task_complete', (sessionId, taskId, result) => {
      emitted = { sessionId, taskId, result };
    });

    try {
      await hub.start();
      await httpRequest('POST', '/api/register', port, { sessionId: 'complete-agent', taskId: 'T1' });

      const { statusCode, body } = await httpRequest('POST', '/api/tasks/T1/complete', port, {
        sessionId: 'complete-agent',
        result: { status: 'done' }
      });
      assert.strictEqual(statusCode, 200);
      assert.strictEqual(body.ok, true);
      assert.ok(emitted, 'task_complete event should have been emitted');
      assert.strictEqual(emitted.sessionId, 'complete-agent');
      assert.strictEqual(emitted.taskId, 'T1');

      // Agent taskId should be cleared
      assert.strictEqual(hub.agents.get('complete-agent').taskId, null);
    } finally {
      hub.stop();
    }
  });

  await testAsync('GET /api/messages/:sessionId returns pending messages', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });

    try {
      await hub.start();

      // Queue messages manually
      hub._queueMessage('msg-agent', { type: 'hello', data: 1 });
      hub._queueMessage('msg-agent', { type: 'hello', data: 2 });

      const { statusCode, body } = await httpRequest('GET', '/api/messages/msg-agent', port);
      assert.strictEqual(statusCode, 200);
      assert.strictEqual(body.messages.length, 2);
      assert.strictEqual(body.messages[0].data, 1);
      assert.strictEqual(body.messages[1].data, 2);

      // Second pull should be empty (messages cleared after retrieval)
      const { body: body2 } = await httpRequest('GET', '/api/messages/msg-agent', port);
      assert.strictEqual(body2.messages.length, 0);
    } finally {
      hub.stop();
    }
  });

  await testAsync('GET /api/nonexistent returns 404', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });

    try {
      await hub.start();
      const { statusCode, body } = await httpRequest('GET', '/api/nonexistent', port);
      assert.strictEqual(statusCode, 404);
      assert.ok(body.error.includes('Not found'));
    } finally {
      hub.stop();
    }
  });

  await testAsync('rate limiter rejects excessive requests', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port, rateLimitMax: 3 });

    try {
      await hub.start();
      await httpRequest('GET', '/api/status', port);
      await httpRequest('GET', '/api/status', port);
      await httpRequest('GET', '/api/status', port);
      const { statusCode } = await httpRequest('GET', '/api/status', port);
      assert.strictEqual(statusCode, 429);
    } finally {
      hub.stop();
    }
  });

  // ========================================================================
  // WebSocket tests
  // ========================================================================

  console.log('\n  WebSocket');

  await testAsync('WS upgrade on /api/connect returns 101', async () => {
    const { PmHub, wsParseFrames } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });

    try {
      await hub.start();
      const { socket } = await wsUpgrade(port);
      assert.ok(socket, 'Should get a socket after upgrade');
      socket.destroy();
    } finally {
      hub.stop();
    }
  });

  await testAsync('WS register message receives welcome', async () => {
    const { PmHub, wsParseFrames } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });
    createSessionFile('ws-agent');

    try {
      await hub.start();
      const { socket } = await wsUpgrade(port);

      // Send register
      const regMsg = JSON.stringify({ type: 'register', sessionId: 'ws-agent', role: 'testing' });
      socket.write(wsEncodeTextMaskedLocal(regMsg));

      // Read welcome
      const welcome = await wsReadMessage(socket, wsParseFrames);
      assert.strictEqual(welcome.type, 'welcome');
      assert.strictEqual(welcome.pmPort, port);
      assert.ok(welcome.connectedAgents >= 1);

      // Verify agent registered
      assert.ok(hub.agents.has('ws-agent'));
      assert.ok(hub.wsConnections.has('ws-agent'));

      socket.destroy();
    } finally {
      hub.stop();
    }
  });

  await testAsync('WS heartbeat updates agent state', async () => {
    const { PmHub, wsParseFrames } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });
    createSessionFile('ws-hb-agent');

    try {
      await hub.start();
      const { socket } = await wsUpgrade(port);

      // Register
      socket.write(wsEncodeTextMaskedLocal(JSON.stringify({
        type: 'register', sessionId: 'ws-hb-agent'
      })));
      await wsReadMessage(socket, wsParseFrames); // consume welcome

      const beforeHb = hub.agents.get('ws-hb-agent').lastHeartbeat;
      await delay(20);

      // Send heartbeat
      socket.write(wsEncodeTextMaskedLocal(JSON.stringify({
        type: 'heartbeat', sessionId: 'ws-hb-agent', taskId: 'T-ws', pressure: 0.7
      })));

      // Give server time to process
      await delay(50);

      const agent = hub.agents.get('ws-hb-agent');
      assert.ok(agent.lastHeartbeat >= beforeHb, 'Heartbeat time should be updated');
      assert.strictEqual(agent.taskId, 'T-ws');
      assert.strictEqual(agent.pressure, 0.7);

      socket.destroy();
    } finally {
      hub.stop();
    }
  });

  await testAsync('sendToAgent() delivers message to WS client', async () => {
    const { PmHub, wsParseFrames } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });
    createSessionFile('ws-recv-agent');

    try {
      await hub.start();
      const { socket } = await wsUpgrade(port);

      // Register
      socket.write(wsEncodeTextMaskedLocal(JSON.stringify({
        type: 'register', sessionId: 'ws-recv-agent'
      })));
      await wsReadMessage(socket, wsParseFrames); // consume welcome

      // Send to agent
      const sent = hub.sendToAgent('ws-recv-agent', { type: 'task_delegate', taskId: 'T-del' });
      assert.strictEqual(sent, true, 'Should return true for WS delivery');

      const msg = await wsReadMessage(socket, wsParseFrames);
      assert.strictEqual(msg.type, 'task_delegate');
      assert.strictEqual(msg.taskId, 'T-del');

      socket.destroy();
    } finally {
      hub.stop();
    }
  });

  await testAsync('sendToAgent() queues message when no WS connection', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });

    try {
      await hub.start();

      // No WS connection for this agent
      const sent = hub.sendToAgent('offline-agent', { type: 'ping', data: 'hello' });
      assert.strictEqual(sent, false, 'Should return false (queued)');

      // Verify pending message
      const queue = hub.pendingMessages.get('offline-agent');
      assert.ok(queue, 'Should have pending queue');
      assert.strictEqual(queue.length, 1);
      assert.strictEqual(queue[0].msg.type, 'ping');
    } finally {
      hub.stop();
    }
  });

  await testAsync('broadcast() delivers to all WS clients except excluded one', async () => {
    const { PmHub, wsParseFrames } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });
    createSessionFile('ws-bc-a');
    createSessionFile('ws-bc-b');
    createSessionFile('ws-bc-c');

    try {
      await hub.start();

      // Connect 3 agents, create readers BEFORE register to avoid missing data
      const { socket: sockA } = await wsUpgrade(port);
      const readerA = createWsReader(sockA, wsParseFrames);
      sockA.write(wsEncodeTextMaskedLocal(JSON.stringify({ type: 'register', sessionId: 'ws-bc-a' })));
      await readerA.next(); // welcome

      const { socket: sockB } = await wsUpgrade(port);
      const readerB = createWsReader(sockB, wsParseFrames);
      sockB.write(wsEncodeTextMaskedLocal(JSON.stringify({ type: 'register', sessionId: 'ws-bc-b' })));
      await readerB.next(); // welcome

      const { socket: sockC } = await wsUpgrade(port);
      const readerC = createWsReader(sockC, wsParseFrames);
      sockC.write(wsEncodeTextMaskedLocal(JSON.stringify({ type: 'register', sessionId: 'ws-bc-c' })));
      await readerC.next(); // welcome

      // Small delay to ensure all registrations are fully processed
      await delay(50);

      // Broadcast excluding agent A
      hub.broadcast({ type: 'alert', msg: 'test' }, 'ws-bc-a');

      // B and C should receive the broadcast
      const msgB = await readerB.next();
      assert.strictEqual(msgB.type, 'alert');

      const msgC = await readerC.next();
      assert.strictEqual(msgC.type, 'alert');

      // A should NOT receive (check by expecting timeout)
      let aReceived = false;
      try {
        await readerA.next(300);
        aReceived = true;
      } catch (e) {
        // Expected timeout
      }
      assert.strictEqual(aReceived, false, 'Excluded agent should not receive broadcast');

      sockA.destroy();
      sockB.destroy();
      sockC.destroy();
    } finally {
      hub.stop();
    }
  });

  await testAsync('WS disconnect emits agent_disconnected', async () => {
    const { PmHub, wsParseFrames } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });
    createSessionFile('ws-disc-agent');

    let disconnectedId = null;
    hub.on('agent_disconnected', (sid) => {
      disconnectedId = sid;
    });

    try {
      await hub.start();
      const { socket } = await wsUpgrade(port);

      socket.write(wsEncodeTextMaskedLocal(JSON.stringify({
        type: 'register', sessionId: 'ws-disc-agent'
      })));
      await wsReadMessage(socket, wsParseFrames); // welcome

      // Wait to ensure server-side sessionId closure is fully set
      await delay(50);

      // Send a masked WS close frame to trigger server-side close handling
      const maskKey = crypto.randomBytes(4);
      const closePayload = Buffer.alloc(2);
      closePayload.writeUInt16BE(1000, 0);
      const maskedPayload = Buffer.from(closePayload);
      for (let i = 0; i < maskedPayload.length; i++) {
        maskedPayload[i] ^= maskKey[i % 4];
      }
      const closeHeader = Buffer.alloc(2);
      closeHeader[0] = 0x88; // FIN + close opcode
      closeHeader[1] = 0x80 | 2; // masked, 2 bytes payload
      socket.write(Buffer.concat([closeHeader, maskKey, maskedPayload]));

      await delay(200);
      socket.destroy();
      await delay(100);

      assert.strictEqual(disconnectedId, 'ws-disc-agent');
      assert.ok(!hub.wsConnections.has('ws-disc-agent'));
    } finally {
      hub.stop();
    }
  });

  await testAsync('WS register without sessionId sends error', async () => {
    const { PmHub, wsParseFrames } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });

    try {
      await hub.start();
      const { socket } = await wsUpgrade(port);

      socket.write(wsEncodeTextMaskedLocal(JSON.stringify({ type: 'register' })));

      const errorMsg = await wsReadMessage(socket, wsParseFrames);
      assert.strictEqual(errorMsg.type, 'error');
      assert.ok(errorMsg.message.includes('sessionId'));

      socket.destroy();
    } finally {
      hub.stop();
    }
  });

  // ========================================================================
  // Audit trail tests
  // ========================================================================

  console.log('\n  Audit trail');

  await testAsync('_auditToFileBus writes entries to bus.jsonl', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });

    try {
      await hub.start();

      hub._auditToFileBus('agent_registered', { sessionId: 'audit-agent', role: 'testing', via: 'test' });

      // Read bus.jsonl
      const busPath = path.join(testDir, '.claude/pilot/messages/bus.jsonl');
      const content = fs.readFileSync(busPath, 'utf8').trim();
      const lines = content.split('\n').filter(l => l.trim());

      // Find the audit entry
      const auditLine = lines.find(l => {
        try {
          const msg = JSON.parse(l);
          return msg.topic === 'hub.agent_registered';
        } catch (e) { return false; }
      });
      assert.ok(auditLine, 'Should find audit entry in bus.jsonl');

      const auditMsg = JSON.parse(auditLine);
      assert.strictEqual(auditMsg.from, 'pm-hub');
      assert.strictEqual(auditMsg.topic, 'hub.agent_registered');
      assert.strictEqual(auditMsg.payload.data.sessionId, 'audit-agent');
    } finally {
      hub.stop();
    }
  });

  await testAsync('HTTP register creates audit entry', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });
    createSessionFile('audit-reg-agent');

    try {
      await hub.start();
      await httpRequest('POST', '/api/register', port, { sessionId: 'audit-reg-agent', role: 'backend' });

      const busPath = path.join(testDir, '.claude/pilot/messages/bus.jsonl');
      const content = fs.readFileSync(busPath, 'utf8');
      const auditLine = content.split('\n').find(l => {
        try {
          const msg = JSON.parse(l);
          return msg.topic === 'hub.agent_registered' && msg.payload.data.via === 'http';
        } catch (e) { return false; }
      });
      assert.ok(auditLine, 'Should have HTTP register audit entry');
    } finally {
      hub.stop();
    }
  });

  await testAsync('HTTP task complete creates audit entry', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });
    createSessionFile('audit-comp-agent');

    try {
      await hub.start();
      await httpRequest('POST', '/api/register', port, { sessionId: 'audit-comp-agent' });
      await httpRequest('POST', '/api/tasks/T-audit/complete', port, {
        sessionId: 'audit-comp-agent',
        result: { status: 'done' }
      });

      const busPath = path.join(testDir, '.claude/pilot/messages/bus.jsonl');
      const content = fs.readFileSync(busPath, 'utf8');
      const auditLine = content.split('\n').find(l => {
        try {
          const msg = JSON.parse(l);
          return msg.topic === 'hub.task_complete' && msg.payload.data.taskId === 'T-audit';
        } catch (e) { return false; }
      });
      assert.ok(auditLine, 'Should have task_complete audit entry');
    } finally {
      hub.stop();
    }
  });

  await testAsync('WS agent disconnect creates audit entry', async () => {
    const { PmHub, wsParseFrames } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });
    createSessionFile('audit-disc-agent');

    try {
      await hub.start();
      const { socket } = await wsUpgrade(port);

      socket.write(wsEncodeTextMaskedLocal(JSON.stringify({
        type: 'register', sessionId: 'audit-disc-agent'
      })));
      await wsReadMessage(socket, wsParseFrames); // welcome

      // Wait to ensure server-side sessionId closure is fully set
      await delay(50);

      // Send a masked WS close frame to trigger server-side close handling
      const maskKey = crypto.randomBytes(4);
      const closePayload = Buffer.alloc(2);
      closePayload.writeUInt16BE(1000, 0);
      const maskedPayload = Buffer.from(closePayload);
      for (let i = 0; i < maskedPayload.length; i++) {
        maskedPayload[i] ^= maskKey[i % 4];
      }
      const closeHeader = Buffer.alloc(2);
      closeHeader[0] = 0x88; // FIN + close opcode
      closeHeader[1] = 0x80 | 2; // masked, 2 bytes payload
      socket.write(Buffer.concat([closeHeader, maskKey, maskedPayload]));

      await delay(200);
      socket.destroy();
      await delay(100);

      const busPath = path.join(testDir, '.claude/pilot/messages/bus.jsonl');
      const content = fs.readFileSync(busPath, 'utf8');
      const auditLine = content.split('\n').find(l => {
        try {
          const msg = JSON.parse(l);
          return msg.topic === 'hub.agent_disconnected' && msg.payload.data.sessionId === 'audit-disc-agent';
        } catch (e) { return false; }
      });
      assert.ok(auditLine, 'Should have agent_disconnected audit entry');
    } finally {
      hub.stop();
    }
  });

  // ========================================================================
  // Reconciliation tests
  // ========================================================================

  console.log('\n  Reconciliation');

  await testAsync('_reconcileFromFileBus processes ask_pm messages from bus', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const messaging = freshRequire('../messaging');
    const port = getPort();

    const mockBrain = {
      ask: (sid, question, ctx) => {
        return { guidance: `Answer for ${sid}` };
      }
    };
    const hub = new PmHub(testDir, { port, brain: mockBrain });

    // Write an ask_pm message to bus before hub starts
    messaging.sendMessage({
      type: 'ask_pm',
      from: 'agent-reconcile',
      to: 'pm',
      priority: 'normal',
      payload: { question: 'Need guidance', context: {} }
    });

    try {
      await hub.start();
      // Reconciliation runs in start(), so it should have processed the ask_pm

      // Check that a pm_response was written back to bus
      const busPath = path.join(testDir, '.claude/pilot/messages/bus.jsonl');
      const content = fs.readFileSync(busPath, 'utf8');
      const pmResponseLine = content.split('\n').find(l => {
        try {
          const msg = JSON.parse(l);
          return msg.type === 'pm_response';
        } catch (e) { return false; }
      });
      assert.ok(pmResponseLine, 'Should have pm_response in bus after reconciliation');
    } finally {
      hub.stop();
    }
  });

  // ========================================================================
  // Stale agent reaping
  // ========================================================================

  console.log('\n  Stale agent reaping');

  await testAsync('agent with old lastHeartbeat gets reaped', async () => {
    const { PmHub, HEARTBEAT_STALE_MS } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });
    createSessionFile('stale-agent');

    let reapedId = null;
    hub.on('agent_reaped', (sid) => {
      reapedId = sid;
    });

    try {
      await hub.start();

      // Register agent
      await httpRequest('POST', '/api/register', port, { sessionId: 'stale-agent' });
      assert.ok(hub.agents.has('stale-agent'), 'Agent should be registered');

      // Simulate old heartbeat (double-stale threshold is HEARTBEAT_STALE_MS * 2)
      hub.agents.get('stale-agent').lastHeartbeat = Date.now() - (HEARTBEAT_STALE_MS * 2 + 1000);

      // Trigger reaping manually
      hub._reapStaleAgents();

      assert.ok(!hub.agents.has('stale-agent'), 'Stale agent should be removed');
      assert.strictEqual(reapedId, 'stale-agent');
    } finally {
      hub.stop();
    }
  });

  await testAsync('non-stale agent is NOT reaped', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });
    createSessionFile('fresh-agent');

    try {
      await hub.start();
      await httpRequest('POST', '/api/register', port, { sessionId: 'fresh-agent' });
      assert.ok(hub.agents.has('fresh-agent'));

      // Heartbeat is recent, should not be reaped
      hub._reapStaleAgents();
      assert.ok(hub.agents.has('fresh-agent'), 'Fresh agent should NOT be reaped');
    } finally {
      hub.stop();
    }
  });

  // ========================================================================
  // getStatus tests
  // ========================================================================

  console.log('\n  getStatus');

  await testAsync('getStatus includes agent details and stale flag', async () => {
    const { PmHub, HEARTBEAT_STALE_MS } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });
    createSessionFile('status-agent');

    try {
      await hub.start();
      await httpRequest('POST', '/api/register', port, {
        sessionId: 'status-agent',
        role: 'frontend',
        taskId: 'T-status'
      });

      const status = hub.getStatus();
      assert.strictEqual(status.connected_agents, 1);
      assert.strictEqual(status.agents[0].sessionId, 'status-agent');
      assert.strictEqual(status.agents[0].role, 'frontend');
      assert.strictEqual(status.agents[0].taskId, 'T-status');
      assert.strictEqual(status.agents[0].stale, false);
      assert.strictEqual(status.agents[0].ws_connected, false);

      // Make stale
      hub.agents.get('status-agent').lastHeartbeat = Date.now() - HEARTBEAT_STALE_MS - 1;
      const status2 = hub.getStatus();
      assert.strictEqual(status2.agents[0].stale, true);
    } finally {
      hub.stop();
    }
  });

  // ========================================================================
  // Pending messages queue
  // ========================================================================

  console.log('\n  Pending messages queue');

  test('pending message queue caps at MAX_PENDING_MESSAGES', () => {
    const { PmHub } = freshRequire('../pm-hub');
    const hub = new PmHub(testDir, { port: 9999 });

    for (let i = 0; i < 105; i++) {
      hub._queueMessage('capped-agent', { idx: i });
    }

    const queue = hub.pendingMessages.get('capped-agent');
    assert.strictEqual(queue.length, 100, 'Queue should be capped at 100');
    // Oldest should be dropped
    assert.strictEqual(queue[0].msg.idx, 5, 'First 5 should have been dropped');
  });

  await testAsync('pending messages flushed on WS register', async () => {
    const { PmHub, wsParseFrames } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });
    createSessionFile('flush-agent');

    try {
      await hub.start();

      // Queue messages before WS connect
      hub._queueMessage('flush-agent', { type: 'queued', idx: 1 });
      hub._queueMessage('flush-agent', { type: 'queued', idx: 2 });

      const { socket } = await wsUpgrade(port);

      // Create reader BEFORE sending register to avoid missing data
      const reader = createWsReader(socket, wsParseFrames);

      // Register -- should flush pending
      socket.write(wsEncodeTextMaskedLocal(JSON.stringify({
        type: 'register', sessionId: 'flush-agent'
      })));

      // Welcome first
      const welcome = await reader.next();
      assert.strictEqual(welcome.type, 'welcome');

      // Then queued messages
      const msg1 = await reader.next();
      assert.strictEqual(msg1.type, 'queued');
      assert.strictEqual(msg1.idx, 1);

      const msg2 = await reader.next();
      assert.strictEqual(msg2.type, 'queued');
      assert.strictEqual(msg2.idx, 2);

      // Pending queue should be empty now
      assert.ok(!hub.pendingMessages.has('flush-agent') ||
        hub.pendingMessages.get('flush-agent').length === 0);

      socket.destroy();
    } finally {
      hub.stop();
    }
  });

  // ========================================================================
  // WS task_complete via WebSocket
  // ========================================================================

  console.log('\n  WS task_complete');

  await testAsync('WS task_complete emits event and clears agent taskId', async () => {
    const { PmHub, wsParseFrames } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });
    createSessionFile('ws-comp-agent');

    let emitted = null;
    hub.on('task_complete', (sid, taskId, result) => {
      emitted = { sid, taskId, result };
    });

    try {
      await hub.start();
      const { socket } = await wsUpgrade(port);

      socket.write(wsEncodeTextMaskedLocal(JSON.stringify({
        type: 'register', sessionId: 'ws-comp-agent', taskId: 'T-ws-comp'
      })));
      await wsReadMessage(socket, wsParseFrames); // welcome

      // Send task_complete via WS
      socket.write(wsEncodeTextMaskedLocal(JSON.stringify({
        type: 'task_complete', taskId: 'T-ws-comp', result: { output: 'done' }
      })));

      await delay(100);

      assert.ok(emitted, 'task_complete event should be emitted');
      assert.strictEqual(emitted.taskId, 'T-ws-comp');

      // Agent taskId should be cleared
      const agent = hub.agents.get('ws-comp-agent');
      assert.strictEqual(agent.taskId, null);

      socket.destroy();
    } finally {
      hub.stop();
    }
  });

  // ========================================================================
  // WS ask_pm via WebSocket
  // ========================================================================

  console.log('\n  WS ask_pm');

  await testAsync('WS ask_pm without brain returns error answer', async () => {
    const { PmHub, wsParseFrames } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port }); // no brain
    createSessionFile('ws-ask-agent');

    try {
      await hub.start();
      const { socket } = await wsUpgrade(port);

      socket.write(wsEncodeTextMaskedLocal(JSON.stringify({
        type: 'register', sessionId: 'ws-ask-agent'
      })));
      await wsReadMessage(socket, wsParseFrames); // welcome

      socket.write(wsEncodeTextMaskedLocal(JSON.stringify({
        type: 'ask_pm', question: 'Help?', requestId: 'req-1'
      })));

      const answer = await wsReadMessage(socket, wsParseFrames);
      assert.strictEqual(answer.type, 'answer');
      assert.strictEqual(answer.requestId, 'req-1');
      assert.ok(answer.error.includes('Brain not available'));

      socket.destroy();
    } finally {
      hub.stop();
    }
  });

  await testAsync('WS ask_pm with brain returns guidance', async () => {
    const { PmHub, wsParseFrames } = freshRequire('../pm-hub');
    const port = getPort();
    const mockBrain = {
      ask: (sid, question, ctx) => ({ guidance: 'WS guidance' })
    };
    const hub = new PmHub(testDir, { port, brain: mockBrain });
    createSessionFile('ws-ask-brain');

    try {
      await hub.start();
      const { socket } = await wsUpgrade(port);

      socket.write(wsEncodeTextMaskedLocal(JSON.stringify({
        type: 'register', sessionId: 'ws-ask-brain'
      })));
      await wsReadMessage(socket, wsParseFrames); // welcome

      socket.write(wsEncodeTextMaskedLocal(JSON.stringify({
        type: 'ask_pm', question: 'Advice?', requestId: 'req-2'
      })));

      const answer = await wsReadMessage(socket, wsParseFrames);
      assert.strictEqual(answer.type, 'answer');
      assert.strictEqual(answer.requestId, 'req-2');
      assert.strictEqual(answer.guidance, 'WS guidance');

      socket.destroy();
    } finally {
      hub.stop();
    }
  });

  // ========================================================================
  // Session validation
  // ========================================================================

  console.log('\n  Session validation');

  await testAsync('WS register with invalid session sends error', async () => {
    const { PmHub, wsParseFrames } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });
    // No session file created

    try {
      await hub.start();
      const { socket } = await wsUpgrade(port);

      socket.write(wsEncodeTextMaskedLocal(JSON.stringify({
        type: 'register', sessionId: 'invalid-session'
      })));

      const errorMsg = await wsReadMessage(socket, wsParseFrames);
      assert.strictEqual(errorMsg.type, 'error');
      assert.ok(errorMsg.message.includes('Invalid session'));

      socket.destroy();
    } finally {
      hub.stop();
    }
  });

  await testAsync('session with special chars is rejected', async () => {
    const { PmHub } = freshRequire('../pm-hub');
    const port = getPort();
    const hub = new PmHub(testDir, { port });

    try {
      await hub.start();
      const { statusCode, body } = await httpRequest('POST', '/api/register', port, {
        sessionId: '../../../etc/passwd'
      });
      assert.strictEqual(statusCode, 403);
    } finally {
      hub.stop();
    }
  });

  // ========================================================================
  // Module exports
  // ========================================================================

  console.log('\n  Module exports');

  test('exports all expected symbols', () => {
    const mod = freshRequire('../pm-hub');
    assert.strictEqual(typeof mod.PmHub, 'function');
    assert.strictEqual(typeof mod.DEFAULT_PORT, 'number');
    assert.strictEqual(typeof mod.HUB_STATE_PATH, 'string');
    assert.strictEqual(typeof mod.HEARTBEAT_STALE_MS, 'number');
    assert.strictEqual(typeof mod.RATE_LIMIT_WINDOW_MS, 'number');
    assert.strictEqual(typeof mod.RATE_LIMIT_MAX, 'number');
    assert.ok(Array.isArray(mod.AUDIT_EVENT_TYPES));
    assert.strictEqual(typeof mod.wsEncodeText, 'function');
    assert.strictEqual(typeof mod.wsParseFrames, 'function');
    assert.strictEqual(typeof mod.wsCloseFrame, 'function');
    assert.strictEqual(typeof mod.wsPongFrame, 'function');
    assert.strictEqual(typeof mod.RateLimiter, 'function');
  });

  // ========================================================================
  // SUMMARY
  // ========================================================================

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('='.repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});
