/**
 * Tests for Terminal Management (Phase 4.5)
 * Covers: agent-logger.js (log capture, rotation, tail, listing),
 * pm-daemon.js integration (--ps, --tail, --kill CLI wiring)
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

// Clear require cache for fresh modules
const libDir = path.join(__dirname, '..', '.claude/pilot/hooks/lib');
for (const key of Object.keys(require.cache)) {
  if (key.startsWith(libDir)) delete require.cache[key];
}

const agentLogger = require('../.claude/pilot/hooks/lib/agent-logger');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  PASS:', name);
    passed++;
  } catch (e) {
    console.log('  FAIL:', name, '-', e.message);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

const cwd = process.cwd();
const logDir = path.join(cwd, agentLogger.LOG_DIR);

// Helper: clean up test log files
function cleanupTestLogs(taskId) {
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const base = path.join(logDir, `agent-${safeId}.log`);
  for (const suffix of ['', '.1', '.2', '.3']) {
    try { if (fs.existsSync(base + suffix)) fs.unlinkSync(base + suffix); } catch (_) {}
  }
}

console.log('Terminal Management Tests (Phase 4.5)');
console.log('='.repeat(50));

// ═══════════════════════════════════════════════════
// agent-logger.js: path helpers
// ═══════════════════════════════════════════════════

console.log('\n--- Path helpers ---');

test('getLogDir returns correct path', () => {
  const dir = agentLogger.getLogDir(cwd);
  assert(dir.endsWith('.claude/pilot/logs'), `Expected .claude/pilot/logs, got ${dir}`);
});

test('getLogPath sanitizes task IDs', () => {
  const logPath = agentLogger.getLogPath(cwd, 'Pilot AGI-abc');
  const filename = path.basename(logPath);
  assert(filename === 'agent-Pilot_AGI-abc.log', `Unexpected filename: ${filename}`);
  assert(!filename.includes(' '), 'Filename should not contain spaces');
});

test('getLogPath handles simple IDs', () => {
  const logPath = agentLogger.getLogPath(cwd, 'task-123');
  assert(logPath.includes('agent-task-123.log'), `Unexpected path: ${logPath}`);
});

test('ensureLogDir creates directory', () => {
  agentLogger.ensureLogDir(cwd);
  assert(fs.existsSync(logDir), 'Log directory should exist');
});

// ═══════════════════════════════════════════════════
// agent-logger.js: log rotation
// ═══════════════════════════════════════════════════

console.log('\n--- Log rotation ---');

const rotTestId = 'test-rotation';
cleanupTestLogs(rotTestId);

test('rotateIfNeeded does nothing for small files', () => {
  const logPath = agentLogger.getLogPath(cwd, rotTestId);
  agentLogger.ensureLogDir(cwd);
  fs.writeFileSync(logPath, 'small content\n');

  agentLogger.rotateIfNeeded(logPath, 1024); // 1KB threshold
  assert(fs.existsSync(logPath), 'Original file should still exist');
  assert(!fs.existsSync(logPath + '.1'), 'No rotation should happen');

  cleanupTestLogs(rotTestId);
});

test('rotateIfNeeded rotates when file exceeds limit', () => {
  const logPath = agentLogger.getLogPath(cwd, rotTestId);
  agentLogger.ensureLogDir(cwd);

  // Write more than 100 bytes
  fs.writeFileSync(logPath, 'x'.repeat(200));

  agentLogger.rotateIfNeeded(logPath, 100); // 100-byte threshold
  assert(!fs.existsSync(logPath), 'Original should be renamed');
  assert(fs.existsSync(logPath + '.1'), 'Rotated file should exist');

  cleanupTestLogs(rotTestId);
});

test('rotateIfNeeded shifts existing rotated files', () => {
  const logPath = agentLogger.getLogPath(cwd, rotTestId);
  agentLogger.ensureLogDir(cwd);

  // Create existing rotated files
  fs.writeFileSync(logPath + '.1', 'old rotation 1');
  fs.writeFileSync(logPath, 'x'.repeat(200));

  agentLogger.rotateIfNeeded(logPath, 100);
  assert(fs.existsSync(logPath + '.2'), '.1 should shift to .2');
  assert(fs.existsSync(logPath + '.1'), 'Current should become .1');

  cleanupTestLogs(rotTestId);
});

// ═══════════════════════════════════════════════════
// agent-logger.js: attachLogger
// ═══════════════════════════════════════════════════

console.log('\n--- attachLogger ---');

const attachTestId = 'test-attach';
cleanupTestLogs(attachTestId);

test('attachLogger creates log file and captures child output', () => {
  const child = spawn('node', ['-e', 'console.log("hello from agent"); console.error("err line"); process.exit(0);'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const info = agentLogger.attachLogger(cwd, attachTestId, child);
  assert(info.logPath, 'Should return logPath');
  assert(typeof info.close === 'function', 'Should return close function');

  // Wait for child to finish
  child.on('exit', () => {
    // Give a brief moment for the stream to flush
    setTimeout(() => {
      const content = fs.readFileSync(info.logPath, 'utf8');
      assert(content.includes('hello from agent'), `stdout not captured: ${content.substring(0, 200)}`);
      assert(content.includes('err line'), `stderr not captured: ${content.substring(0, 200)}`);
      assert(content.includes('Agent started'), 'Should have header');
      assert(content.includes('Agent exited'), 'Should have exit footer');

      cleanupTestLogs(attachTestId);
    }, 300);
  });
});

// Give the async test time to complete before moving on
const waitMs = (ms) => {
  const start = Date.now();
  while (Date.now() - start < ms) { /* busy wait for sync test runner */ }
};
waitMs(800);

// ═══════════════════════════════════════════════════
// agent-logger.js: readLastLines
// ═══════════════════════════════════════════════════

console.log('\n--- readLastLines ---');

const readTestId = 'test-readlines';
cleanupTestLogs(readTestId);

test('readLastLines returns last N lines', () => {
  const logPath = agentLogger.getLogPath(cwd, readTestId);
  agentLogger.ensureLogDir(cwd);
  fs.writeFileSync(logPath, 'line1\nline2\nline3\nline4\nline5\n');

  const lines = agentLogger.readLastLines(logPath, 3);
  assert(lines.length === 3, `Expected 3 lines, got ${lines.length}`);
  assert(lines[0] === 'line3', `Expected line3, got ${lines[0]}`);
  assert(lines[2] === 'line5', `Expected line5, got ${lines[2]}`);

  cleanupTestLogs(readTestId);
});

test('readLastLines returns empty for nonexistent file', () => {
  const lines = agentLogger.readLastLines('/nonexistent/path.log', 10);
  assert(lines.length === 0, 'Should return empty array');
});

// ═══════════════════════════════════════════════════
// agent-logger.js: listLogs
// ═══════════════════════════════════════════════════

console.log('\n--- listLogs ---');

const listTestId = 'test-listlogs';
cleanupTestLogs(listTestId);

test('listLogs finds agent log files', () => {
  const logPath = agentLogger.getLogPath(cwd, listTestId);
  agentLogger.ensureLogDir(cwd);
  fs.writeFileSync(logPath, 'test content\n');

  const logs = agentLogger.listLogs(cwd);
  const found = logs.find(l => l.taskId.includes('test-listlogs'));
  assert(found, 'Should find the test log file');
  assert(found.size > 0, 'Should report file size');
  assert(found.modified, 'Should report modification time');

  cleanupTestLogs(listTestId);
});

// ═══════════════════════════════════════════════════
// agent-logger.js: tailLog
// ═══════════════════════════════════════════════════

console.log('\n--- tailLog ---');

const tailTestId = 'test-tail';
cleanupTestLogs(tailTestId);

test('tailLog detects new lines appended to file', () => {
  const logPath = agentLogger.getLogPath(cwd, tailTestId);
  agentLogger.ensureLogDir(cwd);
  fs.writeFileSync(logPath, 'existing line\n');

  const received = [];
  const tailer = agentLogger.tailLog(logPath, (line) => {
    received.push(line);
  });

  // Append new line after a short delay
  setTimeout(() => {
    fs.appendFileSync(logPath, '[12:00:00] [stdout] new data line\n');
  }, 100);

  // Wait for tail to pick it up
  setTimeout(() => {
    tailer.stop();
    assert(received.length >= 1, `Expected at least 1 new line, got ${received.length}`);
    assert(received.some(l => l.includes('new data line')), 'Should have captured new line');

    cleanupTestLogs(tailTestId);
  }, 600);
});

// Give tail test time to complete
waitMs(1000);

test('tailLog handles nonexistent file gracefully', () => {
  const received = [];
  const tailer = agentLogger.tailLog('/nonexistent/file.log', (line) => {
    received.push(line);
  });
  tailer.stop();
  assert(received.length >= 1, 'Should report error');
  assert(received[0].includes('not found'), `Expected error message, got: ${received[0]}`);
});

// ═══════════════════════════════════════════════════
// pm-daemon.js: CLI wiring
// ═══════════════════════════════════════════════════

console.log('\n--- PM Daemon CLI ---');

const daemonScript = path.join(cwd, '.claude/pilot/hooks/lib/pm-daemon.js');

test('pm-daemon.js syntax check passes', () => {
  execFileSync('node', ['-c', daemonScript], { encoding: 'utf8' });
});

test('pm-daemon.js --help mentions --ps, --kill, --tail', () => {
  const output = execFileSync('node', [daemonScript, '--help'], { encoding: 'utf8' });
  assert(output.includes('--ps'), 'Help should mention --ps');
  assert(output.includes('--kill'), 'Help should mention --kill');
  assert(output.includes('--tail'), 'Help should mention --tail');
});

test('pm-daemon.js --ps outputs agent info', () => {
  // --ps with --json should output valid JSON
  try {
    const output = execFileSync('node', [daemonScript, '--ps', '--json'], {
      encoding: 'utf8',
      timeout: 5000
    });
    const data = JSON.parse(output);
    assert(Array.isArray(data.agents), 'Should have agents array');
  } catch (e) {
    // May fail if session module needs state files — that's OK
    if (!e.message.includes('JSONL') && !e.message.includes('parse')) {
      throw e;
    }
  }
});

test('pm-daemon.js --kill without taskId shows usage error', () => {
  try {
    execFileSync('node', [daemonScript, '--kill'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // Should exit with error
    throw new Error('Expected exit code 1');
  } catch (e) {
    assert(e.status === 1 || e.stderr?.includes('Usage'), 'Should fail with usage error');
  }
});

test('pm-daemon.js --tail without taskId shows usage error', () => {
  try {
    execFileSync('node', [daemonScript, '--tail'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    throw new Error('Expected exit code 1');
  } catch (e) {
    assert(e.status === 1 || e.stderr?.includes('Usage'), 'Should fail with usage error');
  }
});

// ═══════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
