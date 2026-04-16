/**
 * Tests for iTerm2 Bridge — Phase 6.2 (Pilot AGI-3du)
 *
 * Tests the Node.js wrapper (iterm2-bridge.js):
 * - Bridge lifecycle (start, stop, ready signal)
 * - All operations: openTab, sendToTab, readTab, listTabs, closeTab, detectState, setBadge, ping
 * - Request/response protocol with IDs
 * - Error handling, timeout, process exit
 * - Availability checks (mocked)
 *
 * Uses a mock child process to avoid requiring iTerm2.
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/iterm2-bridge.test.js
 */

const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const { Readable, Writable } = require('stream');

// ============================================================================
// TEST INFRASTRUCTURE
// ============================================================================

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

// ============================================================================
// MOCK CHILD PROCESS
// ============================================================================

/**
 * Creates a mock child process that simulates the Python bridge.
 * Provides controllable stdin/stdout/stderr and exit behavior.
 */
function createMockProcess() {
  const stdinData = [];
  const stdin = new Writable({
    write(chunk, encoding, cb) {
      stdinData.push(chunk.toString());
      if (mockProcess._onStdinLine) {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          mockProcess._onStdinLine(line);
        }
      }
      cb();
    }
  });
  stdin.writable = true;

  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });

  const mockProcess = new EventEmitter();
  mockProcess.stdin = stdin;
  mockProcess.stdout = stdout;
  mockProcess.stderr = stderr;
  mockProcess.pid = 99999;
  mockProcess.kill = function(signal) { this.emit('exit', null, signal); };
  mockProcess._stdinData = stdinData;
  mockProcess._onStdinLine = null;

  // Helper to simulate bridge sending a line
  mockProcess.sendLine = (obj) => {
    stdout.push(JSON.stringify(obj) + '\n');
  };

  // Helper to simulate bridge sending ready
  mockProcess.sendReady = () => {
    mockProcess.sendLine({ ok: true, ready: true });
  };

  return mockProcess;
}

// ============================================================================
// MOCK SETUP — override spawn
// ============================================================================

let mockProcess = null;
let spawnCalls = [];

function setupSpawnMock() {
  const cp = require('child_process');
  const originalSpawn = cp.spawn;
  const originalExecFile = cp.execFile;

  spawnCalls = [];
  mockProcess = createMockProcess();

  cp.spawn = (cmd, args, opts) => {
    spawnCalls.push({ cmd, args, opts });
    return mockProcess;
  };

  // Clear cache and re-require
  Object.keys(require.cache).forEach(k => {
    if (k.includes('iterm2-bridge') && !k.includes('__tests__')) {
      delete require.cache[k];
    }
  });

  const mod = require('../iterm2-bridge');

  return {
    mod,
    restore: () => {
      cp.spawn = originalSpawn;
      cp.execFile = originalExecFile;
    }
  };
}

function setupExecFileMock(handler) {
  const cp = require('child_process');
  const originalExecFile = cp.execFile;

  cp.execFile = (cmd, args, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    try {
      const result = handler(cmd, args);
      if (result instanceof Error) cb(result, '', '');
      else cb(null, { stdout: String(result), stderr: '' });
    } catch (err) {
      cb(err, '', '');
    }
  };

  Object.keys(require.cache).forEach(k => {
    if (k.includes('iterm2-bridge') && !k.includes('__tests__')) {
      delete require.cache[k];
    }
  });

  const mod = require('../iterm2-bridge');

  return {
    mod,
    restore: () => { cp.execFile = originalExecFile; }
  };
}

// ============================================================================
// BRIDGE LIFECYCLE TESTS
// ============================================================================

async function testLifecycle() {
  console.log('\n── Bridge Lifecycle ──');

  await test('start() spawns python3 with bridge script', async () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = new mod.ITerm2Bridge();

    // Auto-send ready after small delay
    setTimeout(() => mockProcess.sendReady(), 10);

    await bridge.start();
    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(spawnCalls[0].cmd, 'python3');
    assert.ok(spawnCalls[0].args[0].includes('iterm2-bridge.py'));
    assert.strictEqual(bridge.isRunning(), true);

    restore();
  });

  await test('start() waits for ready signal', async () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = new mod.ITerm2Bridge();

    let resolved = false;
    const p = bridge.start().then(() => { resolved = true; });

    // Not ready yet
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(resolved, false);

    // Now send ready
    mockProcess.sendReady();
    await p;
    assert.strictEqual(resolved, true);

    restore();
  });

  await test('isRunning() returns false before start', () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = new mod.ITerm2Bridge();
    assert.strictEqual(bridge.isRunning(), false);
    restore();
  });

  await test('stop() closes stdin and waits for exit', async () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = new mod.ITerm2Bridge();

    setTimeout(() => mockProcess.sendReady(), 10);
    await bridge.start();

    // Simulate process exit when stdin closes
    mockProcess.stdin.on('finish', () => {
      setTimeout(() => mockProcess.emit('exit', 0, null), 10);
    });

    await bridge.stop();
    assert.strictEqual(bridge.isRunning(), false);

    restore();
  });
}

// ============================================================================
// OPERATIONS TESTS
// ============================================================================

async function testOperations() {
  console.log('\n── Operations ──');

  // Helper: start bridge, set up auto-response
  async function startBridge(mod) {
    const bridge = new mod.ITerm2Bridge();
    setTimeout(() => mockProcess.sendReady(), 10);
    await bridge.start();
    return bridge;
  }

  await test('openTab sends open command and returns result', async () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = await startBridge(mod);

    // Auto-respond to open command
    mockProcess._onStdinLine = (line) => {
      const cmd = JSON.parse(line);
      if (cmd.action === 'open') {
        mockProcess.sendLine({
          id: cmd.id,
          ok: true,
          terminalId: 'session-uuid-123',
          title: 'pilot-agent1',
        });
      }
    };

    const result = await bridge.openTab({
      command: 'echo hello',
      title: 'pilot-agent1',
      target: 'tab',
    });

    assert.strictEqual(result.tabId, 'session-uuid-123');
    assert.strictEqual(result.title, 'pilot-agent1');
    restore();
  });

  await test('sendToTab sends command to session', async () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = await startBridge(mod);

    let receivedCmd = null;
    mockProcess._onStdinLine = (line) => {
      const cmd = JSON.parse(line);
      receivedCmd = cmd;
      mockProcess.sendLine({ id: cmd.id, ok: true });
    };

    await bridge.sendToTab('session-uuid-123', 'echo test');
    assert.strictEqual(receivedCmd.action, 'send');
    assert.strictEqual(receivedCmd.terminalId, 'session-uuid-123');
    assert.strictEqual(receivedCmd.command, 'echo test');
    restore();
  });

  await test('readTab returns output text', async () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = await startBridge(mod);

    mockProcess._onStdinLine = (line) => {
      const cmd = JSON.parse(line);
      if (cmd.action === 'read') {
        mockProcess.sendLine({
          id: cmd.id,
          ok: true,
          output: 'line 1\nline 2\nline 3',
        });
      }
    };

    const output = await bridge.readTab('session-uuid-123', { lines: 3 });
    assert.strictEqual(output, 'line 1\nline 2\nline 3');
    restore();
  });

  await test('listTabs returns session list', async () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = await startBridge(mod);

    mockProcess._onStdinLine = (line) => {
      const cmd = JSON.parse(line);
      if (cmd.action === 'list') {
        mockProcess.sendLine({
          id: cmd.id,
          ok: true,
          sessions: [
            { terminalId: 'ses-1', title: 'Agent 1', alive: true },
            { terminalId: 'ses-2', title: 'Agent 2', alive: false },
          ],
        });
      }
    };

    const tabs = await bridge.listTabs();
    assert.strictEqual(tabs.length, 2);
    assert.strictEqual(tabs[0].tabId, 'ses-1');
    assert.strictEqual(tabs[0].title, 'Agent 1');
    assert.strictEqual(tabs[0].alive, true);
    assert.strictEqual(tabs[1].alive, false);
    restore();
  });

  await test('closeTab returns true on success', async () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = await startBridge(mod);

    mockProcess._onStdinLine = (line) => {
      const cmd = JSON.parse(line);
      if (cmd.action === 'close') {
        mockProcess.sendLine({ id: cmd.id, ok: true });
      }
    };

    const result = await bridge.closeTab('session-uuid-123');
    assert.strictEqual(result, true);
    restore();
  });

  await test('detectState returns state info', async () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = await startBridge(mod);

    mockProcess._onStdinLine = (line) => {
      const cmd = JSON.parse(line);
      if (cmd.action === 'detect') {
        mockProcess.sendLine({
          id: cmd.id,
          ok: true,
          state: 'working',
          match: 'Running',
        });
      }
    };

    const result = await bridge.detectState('session-uuid-123');
    assert.strictEqual(result.state, 'working');
    assert.strictEqual(result.match, 'Running');
    restore();
  });

  await test('setBadge sends badge command', async () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = await startBridge(mod);

    let receivedCmd = null;
    mockProcess._onStdinLine = (line) => {
      const cmd = JSON.parse(line);
      receivedCmd = cmd;
      mockProcess.sendLine({ id: cmd.id, ok: true });
    };

    await bridge.setBadge('session-uuid-123', 'Task: abc');
    assert.strictEqual(receivedCmd.action, 'badge');
    assert.strictEqual(receivedCmd.terminalId, 'session-uuid-123');
    assert.strictEqual(receivedCmd.text, 'Task: abc');
    restore();
  });

  await test('ping returns true when bridge responds', async () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = await startBridge(mod);

    mockProcess._onStdinLine = (line) => {
      const cmd = JSON.parse(line);
      if (cmd.action === 'ping') {
        mockProcess.sendLine({ id: cmd.id, ok: true, pong: true });
      }
    };

    const result = await bridge.ping();
    assert.strictEqual(result, true);
    restore();
  });
}

// ============================================================================
// ERROR HANDLING TESTS
// ============================================================================

async function testErrorHandling() {
  console.log('\n── Error Handling ──');

  await test('rejects when bridge returns error', async () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = new mod.ITerm2Bridge();
    setTimeout(() => mockProcess.sendReady(), 10);
    await bridge.start();

    mockProcess._onStdinLine = (line) => {
      const cmd = JSON.parse(line);
      mockProcess.sendLine({
        id: cmd.id,
        ok: false,
        error: 'Session not found: bad-id',
      });
    };

    await assert.rejects(
      () => bridge.sendToTab('bad-id', 'echo'),
      /Session not found/
    );
    restore();
  });

  await test('rejects pending requests on process exit', async () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = new mod.ITerm2Bridge();
    setTimeout(() => mockProcess.sendReady(), 10);
    await bridge.start();

    // Don't respond, just exit
    mockProcess._onStdinLine = null;

    // Use sendToTab which doesn't catch errors (unlike ping)
    const promise = bridge.sendToTab('ses-1', 'echo');

    // Simulate process exit
    setTimeout(() => mockProcess.emit('exit', 1, null), 50);

    await assert.rejects(promise, /Bridge process exited/);
    restore();
  });

  await test('ping returns false when bridge not running', async () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = new mod.ITerm2Bridge();

    // ping() catches errors and returns false
    const result = await bridge.ping();
    assert.strictEqual(result, false);
    restore();
  });

  await test('readTab returns empty string on empty output', async () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = new mod.ITerm2Bridge();
    setTimeout(() => mockProcess.sendReady(), 10);
    await bridge.start();

    mockProcess._onStdinLine = (line) => {
      const cmd = JSON.parse(line);
      mockProcess.sendLine({ id: cmd.id, ok: true, output: '' });
    };

    const output = await bridge.readTab('ses-1');
    assert.strictEqual(output, '');
    restore();
  });
}

// ============================================================================
// REQUEST ID PROTOCOL TESTS
// ============================================================================

async function testProtocol() {
  console.log('\n── Request/Response Protocol ──');

  await test('matches responses by request ID', async () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = new mod.ITerm2Bridge();
    setTimeout(() => mockProcess.sendReady(), 10);
    await bridge.start();

    // Respond to requests out of order
    const receivedCmds = [];
    mockProcess._onStdinLine = (line) => {
      const cmd = JSON.parse(line);
      receivedCmds.push(cmd);
      // Respond to second request first
      if (receivedCmds.length === 2) {
        mockProcess.sendLine({ id: receivedCmds[1].id, ok: true, pong: true });
        mockProcess.sendLine({ id: receivedCmds[0].id, ok: true, output: 'hello' });
      }
    };

    const [readResult, pingResult] = await Promise.all([
      bridge.readTab('ses-1'),
      bridge.ping(),
    ]);

    assert.strictEqual(readResult, 'hello');
    assert.strictEqual(pingResult, true);
    restore();
  });

  await test('increments request IDs', async () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = new mod.ITerm2Bridge();
    setTimeout(() => mockProcess.sendReady(), 10);
    await bridge.start();

    const ids = [];
    mockProcess._onStdinLine = (line) => {
      const cmd = JSON.parse(line);
      ids.push(cmd.id);
      mockProcess.sendLine({ id: cmd.id, ok: true, pong: true });
    };

    await bridge.ping();
    await bridge.ping();
    await bridge.ping();

    assert.strictEqual(ids.length, 3);
    assert.ok(ids[0] !== ids[1]);
    assert.ok(ids[1] !== ids[2]);
    restore();
  });

  await test('ignores non-JSON stdout lines', async () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = new mod.ITerm2Bridge();
    setTimeout(() => mockProcess.sendReady(), 10);
    await bridge.start();

    mockProcess._onStdinLine = (line) => {
      const cmd = JSON.parse(line);
      // Send garbage then real response
      mockProcess.process ? null : null;
      mockProcess.stdout.push('not json garbage\n');
      mockProcess.sendLine({ id: cmd.id, ok: true, pong: true });
    };

    const result = await bridge.ping();
    assert.strictEqual(result, true);
    restore();
  });
}

// ============================================================================
// AVAILABILITY CHECK TESTS
// ============================================================================

async function testAvailability() {
  console.log('\n── Availability Checks ──');

  await test('isITerm2Installed returns true when mdfind finds it', async () => {
    const { mod, restore } = setupExecFileMock((cmd, args) => {
      if (cmd === 'mdfind') return '/Applications/iTerm.app';
      return '';
    });

    const result = await mod.isITerm2Installed();
    assert.strictEqual(result, true);
    restore();
  });

  await test('isITerm2Installed returns false when not found', async () => {
    const { mod, restore } = setupExecFileMock((cmd, args) => {
      if (cmd === 'mdfind') return '';
      return '';
    });

    const result = await mod.isITerm2Installed();
    assert.strictEqual(result, false);
    restore();
  });

  await test('isITerm2Running returns true when running', async () => {
    const { mod, restore } = setupExecFileMock((cmd, args) => {
      if (cmd === 'osascript') return 'true';
      return '';
    });

    const result = await mod.isITerm2Running();
    assert.strictEqual(result, true);
    restore();
  });

  await test('isITerm2Running returns false when not running', async () => {
    const { mod, restore } = setupExecFileMock((cmd, args) => {
      if (cmd === 'osascript') return 'false';
      return '';
    });

    const result = await mod.isITerm2Running();
    assert.strictEqual(result, false);
    restore();
  });

  await test('isPythonAPIAvailable returns true when import succeeds', async () => {
    const { mod, restore } = setupExecFileMock((cmd, args) => {
      if (cmd === 'python3' && args.includes('-c')) return '';
      return '';
    });

    const result = await mod.isPythonAPIAvailable();
    assert.strictEqual(result, true);
    restore();
  });

  await test('isPythonAPIAvailable returns false when import fails', async () => {
    const { mod, restore } = setupExecFileMock((cmd, args) => {
      if (cmd === 'python3') throw new Error('ModuleNotFoundError');
      return '';
    });

    const result = await mod.isPythonAPIAvailable();
    assert.strictEqual(result, false);
    restore();
  });

  await test('checkAvailability returns full status', async () => {
    const { mod, restore } = setupExecFileMock((cmd, args) => {
      if (cmd === 'mdfind') return '/Applications/iTerm.app';
      if (cmd === 'osascript') return 'true';
      if (cmd === 'python3') return '';
      return '';
    });

    const result = await mod.checkAvailability();
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.running, true);
    assert.strictEqual(result.pythonAPI, true);
    restore();
  });

  await test('checkAvailability returns unavailable without python API', async () => {
    const { mod, restore } = setupExecFileMock((cmd, args) => {
      if (cmd === 'mdfind') return '/Applications/iTerm.app';
      if (cmd === 'osascript') return 'true';
      if (cmd === 'python3') throw new Error('no module');
      return '';
    });

    const result = await mod.checkAvailability();
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.pythonAPI, false);
    restore();
  });
}

// ============================================================================
// STANDALONE MODE TEST
// ============================================================================

async function testStandaloneMode() {
  console.log('\n── Standalone Mode ──');

  await test('bridge supports standalone flag', () => {
    const { mod, restore } = setupSpawnMock();
    const bridge = new mod.ITerm2Bridge({ standalone: true });

    // Don't actually start, just verify the flag is set
    assert.strictEqual(bridge.standalone, true);
    restore();
  });
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================

async function runAll() {
  console.log('iTerm2 Bridge — Phase 6.2 Tests\n');

  await testLifecycle();
  await testOperations();
  await testErrorHandling();
  await testProtocol();
  await testAvailability();
  await testStandaloneMode();

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const { name, error } of failures) {
      console.log(`\n  ✗ ${name}`);
      console.log(`    ${error.stack || error.message}`);
    }
  }

  console.log(`${'═'.repeat(50)}`);
  process.exit(failed > 0 ? 1 : 0);
}

runAll();
