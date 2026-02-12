/**
 * Tests for AppleScript Bridge Foundation — Phase 6.1 (Pilot AGI-xqn)
 *
 * Tests all 8 core operations plus utilities:
 * - openTab, sendToTab, readTab, listTabs, closeTab
 * - detectState, showDialog, preventSleep
 * - stripAnsi, parseTabId, buildTabId, isAvailable
 *
 * Uses mocked child_process.execFile to avoid actual osascript calls.
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/applescript-bridge.test.js
 */

const assert = require('assert');
const path = require('path');

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
// MOCK SETUP
// ============================================================================

/**
 * Mock execFile to intercept osascript calls.
 * Returns configurable responses based on script content.
 * Uses execFile (not exec) — safe from shell injection.
 */
let mockExecFileHandler = null;
let execFileCalls = [];

function setupMock() {
  execFileCalls = [];
  mockExecFileHandler = null;

  const bridgePath = path.resolve(__dirname, '../applescript-bridge.js');

  // Clear require cache for fresh module with mock
  Object.keys(require.cache).forEach(key => {
    if (key.includes('applescript-bridge')) {
      delete require.cache[key];
    }
  });

  // Override child_process.execFile before requiring the bridge
  const cp = require('child_process');
  const originalExecFile = cp.execFile;

  cp.execFile = function mockedExecFile(cmd, args, opts, cb) {
    // Handle (cmd, args, cb) signature
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }

    const call = { cmd, args, opts };
    execFileCalls.push(call);

    // Extract the script content from args
    const script = args && args.length > 0 ? args[args.length - 1] : '';

    if (mockExecFileHandler) {
      try {
        const result = mockExecFileHandler(cmd, args, script);
        if (result instanceof Error) {
          cb(result, '', result.message);
        } else {
          cb(null, { stdout: String(result), stderr: '' });
        }
      } catch (err) {
        cb(err, '', err.message);
      }
    } else {
      // Default: return empty string
      cb(null, { stdout: '', stderr: '' });
    }
  };

  // Re-require the bridge with mocked execFile
  const bridge = require(bridgePath);

  return { bridge, restore: () => { cp.execFile = originalExecFile; } };
}

// ============================================================================
// STRIP ANSI TESTS
// ============================================================================

async function testStripAnsi() {
  console.log('\n── stripAnsi ──');

  const { bridge, restore } = setupMock();

  await test('strips CSI color codes', () => {
    const input = '\x1B[31mError\x1B[0m: something failed';
    assert.strictEqual(bridge.stripAnsi(input), 'Error: something failed');
  });

  await test('strips CSI cursor movement', () => {
    const input = '\x1B[2A\x1B[K> prompt';
    assert.strictEqual(bridge.stripAnsi(input), '> prompt');
  });

  await test('strips OSC title sequences', () => {
    const input = '\x1B]1;My Title\x07rest of text';
    assert.strictEqual(bridge.stripAnsi(input), 'rest of text');
  });

  await test('strips OSC with ST terminator', () => {
    const input = '\x1B]0;Window Title\x1B\\more text';
    assert.strictEqual(bridge.stripAnsi(input), 'more text');
  });

  await test('handles null/empty input', () => {
    assert.strictEqual(bridge.stripAnsi(''), '');
    assert.strictEqual(bridge.stripAnsi(null), '');
    assert.strictEqual(bridge.stripAnsi(undefined), '');
  });

  await test('preserves text without ANSI', () => {
    const input = 'Hello, world! No escapes here.';
    assert.strictEqual(bridge.stripAnsi(input), input);
  });

  await test('strips multiple mixed sequences', () => {
    const input = '\x1B[1m\x1B[32mOK\x1B[0m done \x1B]2;title\x07end';
    assert.strictEqual(bridge.stripAnsi(input), 'OK done end');
  });

  restore();
}

// ============================================================================
// PARSE TAB ID TESTS
// ============================================================================

async function testParseTabId() {
  console.log('\n── parseTabId / buildTabId ──');

  const { bridge, restore } = setupMock();

  await test('parses standard tabId', () => {
    const result = bridge.parseTabId('terminal:42:pilot-1234');
    assert.strictEqual(result.provider, 'terminal');
    assert.strictEqual(result.windowId, '42');
    assert.strictEqual(result.title, 'pilot-1234');
  });

  await test('handles title with colons', () => {
    const result = bridge.parseTabId('terminal:7:pilot-task:Pilot AGI-abc');
    assert.strictEqual(result.provider, 'terminal');
    assert.strictEqual(result.windowId, '7');
    assert.strictEqual(result.title, 'pilot-task:Pilot AGI-abc');
  });

  await test('throws on invalid format', () => {
    assert.throws(() => bridge.parseTabId('invalid'), /Invalid tabId format/);
    assert.throws(() => bridge.parseTabId('a:b'), /Invalid tabId format/);
  });

  await test('buildTabId constructs correct format', () => {
    assert.strictEqual(bridge.buildTabId('42', 'pilot-test'), 'terminal:42:pilot-test');
  });

  await test('roundtrip parse/build', () => {
    const tabId = bridge.buildTabId('99', 'pilot-my-task');
    const parsed = bridge.parseTabId(tabId);
    assert.strictEqual(parsed.windowId, '99');
    assert.strictEqual(parsed.title, 'pilot-my-task');
  });

  restore();
}

// ============================================================================
// OPEN TAB TESTS
// ============================================================================

async function testOpenTab() {
  console.log('\n── openTab ──');

  const { bridge, restore } = setupMock();

  await test('opens tab with command and returns tabId', async () => {
    mockExecFileHandler = (cmd, args, script) => {
      if (script.includes('do script')) return '42';
      return '';
    };

    const result = await bridge.openTab({ command: 'echo hello' });
    assert.ok(result.tabId.startsWith('terminal:42:'));
    assert.ok(result.title.startsWith('pilot-'));
  });

  await test('includes cwd in command', async () => {
    let capturedScript = '';
    mockExecFileHandler = (cmd, args, script) => {
      capturedScript = script;
      return '1';
    };

    await bridge.openTab({ command: 'ls', cwd: '/my/project' });
    assert.ok(capturedScript.includes('cd \\"/my/project\\"'), 'Should include cd command');
  });

  await test('includes env variables', async () => {
    let capturedScript = '';
    mockExecFileHandler = (cmd, args, script) => {
      capturedScript = script;
      return '1';
    };

    await bridge.openTab({
      command: 'node app.js',
      env: { PILOT_TASK_ID: 'abc', NODE_ENV: 'test' }
    });
    assert.ok(capturedScript.includes('PILOT_TASK_ID'), 'Should include env var');
    assert.ok(capturedScript.includes('NODE_ENV'), 'Should include env var');
  });

  await test('uses custom title when provided', async () => {
    mockExecFileHandler = () => '5';

    const result = await bridge.openTab({ command: 'echo test', title: 'pilot-custom' });
    assert.strictEqual(result.title, 'pilot-custom');
    assert.ok(result.tabId.includes('pilot-custom'));
  });

  await test('generates title when not provided', async () => {
    mockExecFileHandler = () => '5';

    const result = await bridge.openTab({ command: 'echo test' });
    assert.ok(result.title.startsWith('pilot-'), `Expected pilot- prefix, got: ${result.title}`);
  });

  restore();
}

// ============================================================================
// SEND TO TAB TESTS
// ============================================================================

async function testSendToTab() {
  console.log('\n── sendToTab ──');

  const { bridge, restore } = setupMock();

  await test('sends command to matching tab', async () => {
    mockExecFileHandler = (cmd, args, script) => {
      if (script.includes('custom title')) return 'sent';
      return '';
    };

    await bridge.sendToTab('terminal:1:pilot-test', 'echo hello');
  });

  await test('throws when tab not found', async () => {
    mockExecFileHandler = () => 'not_found';

    await assert.rejects(
      () => bridge.sendToTab('terminal:1:pilot-missing', 'echo hello'),
      /Tab not found/
    );
  });

  await test('escapes command with special characters', async () => {
    let capturedScript = '';
    mockExecFileHandler = (cmd, args, script) => {
      capturedScript = script;
      return 'sent';
    };

    await bridge.sendToTab('terminal:1:pilot-test', 'echo "hello world"');
    assert.ok(capturedScript.includes('\\"hello world\\"'), 'Should escape double quotes');
  });

  restore();
}

// ============================================================================
// READ TAB TESTS
// ============================================================================

async function testReadTab() {
  console.log('\n── readTab ──');

  const { bridge, restore } = setupMock();

  await test('returns last N lines of output', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    mockExecFileHandler = () => lines.join('\n');

    const result = await bridge.readTab('terminal:1:pilot-test', { lines: 10 });
    const resultLines = result.split('\n');
    assert.strictEqual(resultLines.length, 10);
    assert.strictEqual(resultLines[0], 'line 91');
    assert.strictEqual(resultLines[9], 'line 100');
  });

  await test('strips ANSI by default', async () => {
    mockExecFileHandler = () => '\x1B[31mError\x1B[0m: bad input';

    const result = await bridge.readTab('terminal:1:pilot-test', { lines: 1 });
    assert.strictEqual(result, 'Error: bad input');
  });

  await test('preserves ANSI when raw=true', async () => {
    const raw = '\x1B[31mError\x1B[0m: bad input';
    mockExecFileHandler = () => raw;

    const result = await bridge.readTab('terminal:1:pilot-test', { lines: 1, raw: true });
    assert.strictEqual(result, raw);
  });

  await test('returns empty string for empty tab', async () => {
    mockExecFileHandler = () => '';

    const result = await bridge.readTab('terminal:1:pilot-test');
    assert.strictEqual(result, '');
  });

  await test('defaults to 50 lines', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `l${i}`);
    mockExecFileHandler = () => lines.join('\n');

    const result = await bridge.readTab('terminal:1:pilot-test');
    assert.strictEqual(result.split('\n').length, 50);
  });

  restore();
}

// ============================================================================
// LIST TABS TESTS
// ============================================================================

async function testListTabs() {
  console.log('\n── listTabs ──');

  const { bridge, restore } = setupMock();

  await test('returns pilot-prefixed tabs', async () => {
    mockExecFileHandler = () => '42:pilot-agent1\n99:pilot-agent2\n';

    const tabs = await bridge.listTabs();
    assert.strictEqual(tabs.length, 2);
    assert.strictEqual(tabs[0].title, 'pilot-agent1');
    assert.strictEqual(tabs[0].windowId, '42');
    assert.ok(tabs[0].tabId.includes('pilot-agent1'));
    assert.strictEqual(tabs[1].title, 'pilot-agent2');
  });

  await test('returns empty array when no tabs', async () => {
    mockExecFileHandler = () => '';

    const tabs = await bridge.listTabs();
    assert.strictEqual(tabs.length, 0);
  });

  await test('handles single tab', async () => {
    mockExecFileHandler = () => '7:pilot-solo';

    const tabs = await bridge.listTabs();
    assert.strictEqual(tabs.length, 1);
    assert.strictEqual(tabs[0].windowId, '7');
    assert.strictEqual(tabs[0].title, 'pilot-solo');
  });

  restore();
}

// ============================================================================
// CLOSE TAB TESTS
// ============================================================================

async function testCloseTab() {
  console.log('\n── closeTab ──');

  const { bridge, restore } = setupMock();

  await test('returns true when tab is closed', async () => {
    mockExecFileHandler = () => 'closed';

    const result = await bridge.closeTab('terminal:1:pilot-test');
    assert.strictEqual(result, true);
  });

  await test('returns false when tab not found', async () => {
    mockExecFileHandler = () => 'not_found';

    const result = await bridge.closeTab('terminal:1:pilot-missing');
    assert.strictEqual(result, false);
  });

  await test('uses System Events for Cmd+W', async () => {
    let capturedScript = '';
    mockExecFileHandler = (cmd, args, script) => {
      capturedScript = script;
      return 'closed';
    };

    await bridge.closeTab('terminal:1:pilot-test');
    assert.ok(capturedScript.includes('System Events'), 'Should use System Events');
    assert.ok(capturedScript.includes('keystroke'), 'Should use keystroke');
  });

  restore();
}

// ============================================================================
// DETECT STATE TESTS
// ============================================================================

async function testDetectState() {
  console.log('\n── detectState ──');

  const { bridge, restore } = setupMock();

  await test('detects idle state', async () => {
    mockExecFileHandler = () => 'some output\n> \n';
    const { state } = await bridge.detectState('terminal:1:pilot-test');
    assert.strictEqual(state, 'idle');
  });

  await test('detects error state', async () => {
    mockExecFileHandler = () => 'running...\nError: something went wrong\n> ';
    const { state, match } = await bridge.detectState('terminal:1:pilot-test');
    assert.strictEqual(state, 'error');
    assert.ok(match.includes('Error:'));
  });

  await test('detects working state via spinner', async () => {
    mockExecFileHandler = () => '⠋ Running tests...';
    const { state } = await bridge.detectState('terminal:1:pilot-test');
    assert.strictEqual(state, 'working');
  });

  await test('detects checkpoint state', async () => {
    mockExecFileHandler = () => 'CHECKPOINT SAVED at step 3';
    const { state } = await bridge.detectState('terminal:1:pilot-test');
    assert.strictEqual(state, 'checkpoint');
  });

  await test('detects plan_approval state', async () => {
    mockExecFileHandler = () => 'Waiting for plan approval...';
    const { state } = await bridge.detectState('terminal:1:pilot-test');
    assert.strictEqual(state, 'plan_approval');
  });

  await test('detects complete state', async () => {
    mockExecFileHandler = () => 'All plan steps complete!';
    const { state } = await bridge.detectState('terminal:1:pilot-test');
    assert.strictEqual(state, 'complete');
  });

  await test('detects waiting_input state', async () => {
    mockExecFileHandler = () => '? approve this plan? yes/no';
    const { state } = await bridge.detectState('terminal:1:pilot-test');
    assert.strictEqual(state, 'waiting_input');
  });

  await test('returns unknown for unrecognized output', async () => {
    mockExecFileHandler = () => 'just some random text here';
    const { state, match } = await bridge.detectState('terminal:1:pilot-test');
    assert.strictEqual(state, 'unknown');
    assert.strictEqual(match, null);
  });

  await test('returns unknown for empty output', async () => {
    mockExecFileHandler = () => '';
    const { state } = await bridge.detectState('terminal:1:pilot-test');
    assert.strictEqual(state, 'unknown');
  });

  await test('error takes priority over idle', async () => {
    mockExecFileHandler = () => 'Error: fail\n> \n';
    const { state } = await bridge.detectState('terminal:1:pilot-test');
    assert.strictEqual(state, 'error');
  });

  await test('detects high context pressure as checkpoint', async () => {
    mockExecFileHandler = () => 'Context pressure: 92%\nStill working...';
    const { state } = await bridge.detectState('terminal:1:pilot-test');
    assert.strictEqual(state, 'checkpoint');
  });

  restore();
}

// ============================================================================
// SHOW DIALOG TESTS
// ============================================================================

async function testShowDialog() {
  console.log('\n── showDialog ──');

  const { bridge, restore } = setupMock();

  await test('shows dialog with message and returns button', async () => {
    mockExecFileHandler = () => 'OK';

    const result = await bridge.showDialog({ message: 'Agent done' });
    assert.strictEqual(result, 'OK');
  });

  await test('includes custom title and buttons', async () => {
    let capturedScript = '';
    mockExecFileHandler = (cmd, args, script) => {
      capturedScript = script;
      return 'Approve';
    };

    await bridge.showDialog({
      message: 'Merge PR?',
      title: 'PM Review',
      buttons: ['Approve', 'Reject'],
      icon: 'caution',
    });
    assert.ok(capturedScript.includes('PM Review'));
    assert.ok(capturedScript.includes('Approve'));
    assert.ok(capturedScript.includes('Reject'));
    assert.ok(capturedScript.includes('caution'));
  });

  await test('uses defaults for optional params', async () => {
    let capturedScript = '';
    mockExecFileHandler = (cmd, args, script) => {
      capturedScript = script;
      return 'OK';
    };

    await bridge.showDialog({ message: 'Hello' });
    assert.ok(capturedScript.includes('Pilot AGI'), 'Default title');
    assert.ok(capturedScript.includes('"OK"'), 'Default button');
    assert.ok(capturedScript.includes('note'), 'Default icon');
  });

  restore();
}

// ============================================================================
// PREVENT SLEEP TESTS
// ============================================================================

async function testPreventSleep() {
  console.log('\n── preventSleep ──');

  const cp = require('child_process');
  const originalSpawn = cp.spawn;

  let spawnCalls = [];

  await test('spawns caffeinate with idle prevention', async () => {
    spawnCalls = [];
    cp.spawn = (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      return { pid: 12345, unref: () => {} };
    };

    Object.keys(require.cache).forEach(k => {
      if (k.includes('applescript-bridge')) delete require.cache[k];
    });
    const bridge = require('../applescript-bridge');

    const handle = await bridge.preventSleep();
    assert.strictEqual(handle.pid, 12345);
    assert.strictEqual(typeof handle.stop, 'function');
    assert.strictEqual(spawnCalls[0].cmd, 'caffeinate');
    assert.ok(spawnCalls[0].args.includes('-i'));
  });

  await test('includes display sleep flag when requested', async () => {
    spawnCalls = [];
    cp.spawn = (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      return { pid: 12346, unref: () => {} };
    };

    Object.keys(require.cache).forEach(k => {
      if (k.includes('applescript-bridge')) delete require.cache[k];
    });
    const bridge = require('../applescript-bridge');

    await bridge.preventSleep({ displaySleep: true });
    assert.ok(spawnCalls[0].args.includes('-d'), 'Should include -d flag');
  });

  await test('includes duration flag when specified', async () => {
    spawnCalls = [];
    cp.spawn = (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      return { pid: 12347, unref: () => {} };
    };

    Object.keys(require.cache).forEach(k => {
      if (k.includes('applescript-bridge')) delete require.cache[k];
    });
    const bridge = require('../applescript-bridge');

    await bridge.preventSleep({ durationSeconds: 3600 });
    assert.ok(spawnCalls[0].args.includes('-t'), 'Should include -t flag');
    assert.ok(spawnCalls[0].args.includes('3600'), 'Should include duration');
  });

  cp.spawn = originalSpawn;
}

// ============================================================================
// IS AVAILABLE TESTS
// ============================================================================

async function testIsAvailable() {
  console.log('\n── isAvailable ──');

  const { bridge, restore } = setupMock();

  await test('returns true when osascript succeeds', async () => {
    mockExecFileHandler = () => 'Terminal';
    const result = await bridge.isAvailable();
    assert.strictEqual(result, true);
  });

  await test('returns false when osascript fails', async () => {
    mockExecFileHandler = () => { throw new Error('not allowed'); };
    const result = await bridge.isAvailable();
    assert.strictEqual(result, false);
  });

  restore();
}

// ============================================================================
// RETRY LOGIC TESTS
// ============================================================================

async function testRetryLogic() {
  console.log('\n── withRetry ──');

  const { bridge, restore } = setupMock();
  const { withRetry } = bridge._internals;

  await test('succeeds on first attempt', async () => {
    let attempts = 0;
    const result = await withRetry(() => { attempts++; return 'ok'; });
    assert.strictEqual(result, 'ok');
    assert.strictEqual(attempts, 1);
  });

  await test('retries on failure then succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(() => {
      attempts++;
      if (attempts < 3) throw new Error('fail');
      return 'ok';
    }, 3, 10);
    assert.strictEqual(result, 'ok');
    assert.strictEqual(attempts, 3);
  });

  await test('throws after max retries', async () => {
    let attempts = 0;
    await assert.rejects(
      () => withRetry(() => { attempts++; throw new Error('always fail'); }, 2, 10),
      /always fail/
    );
    assert.strictEqual(attempts, 3); // initial + 2 retries
  });

  restore();
}

// ============================================================================
// ESCAPE APPLESCRIPT TESTS
// ============================================================================

async function testEscapeAppleScript() {
  console.log('\n── escapeAppleScript ──');

  const { bridge, restore } = setupMock();
  const { escapeAppleScript } = bridge._internals;

  await test('escapes double quotes', () => {
    assert.strictEqual(escapeAppleScript('say "hello"'), 'say \\"hello\\"');
  });

  await test('escapes backslashes', () => {
    assert.strictEqual(escapeAppleScript('path\\to\\file'), 'path\\\\to\\\\file');
  });

  await test('handles empty/null input', () => {
    assert.strictEqual(escapeAppleScript(''), '');
    assert.strictEqual(escapeAppleScript(null), '');
    assert.strictEqual(escapeAppleScript(undefined), '');
  });

  await test('preserves normal text', () => {
    assert.strictEqual(escapeAppleScript('hello world'), 'hello world');
  });

  restore();
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================

async function runAll() {
  console.log('AppleScript Bridge Foundation — Phase 6.1 Tests\n');

  await testStripAnsi();
  await testParseTabId();
  await testOpenTab();
  await testSendToTab();
  await testReadTab();
  await testListTabs();
  await testCloseTab();
  await testDetectState();
  await testShowDialog();
  await testPreventSleep();
  await testIsAvailable();
  await testRetryLogic();
  await testEscapeAppleScript();

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
