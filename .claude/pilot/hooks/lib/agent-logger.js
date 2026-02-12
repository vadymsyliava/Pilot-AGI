/**
 * Agent Logger — log capture, streaming, and rotation for spawned agents
 *
 * Phase 4.5: Terminal Management (Pilot AGI-031)
 *
 * Provides:
 *   - Per-task log files at .claude/pilot/logs/agent-<taskId>.log
 *   - Pipe stdout/stderr from child processes to log files with timestamps
 *   - Tail streaming (like `tail -f`) for live monitoring
 *   - Log rotation at configurable size limit
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const LOG_DIR = '.claude/pilot/logs';
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const LOG_PREFIX_FORMAT = 'HH:MM:SS';

/**
 * Get the log directory path for the project.
 * @param {string} projectRoot
 * @returns {string}
 */
function getLogDir(projectRoot) {
  return path.join(projectRoot, LOG_DIR);
}

/**
 * Get the log file path for a specific task.
 * @param {string} projectRoot
 * @param {string} taskId
 * @returns {string}
 */
function getLogPath(projectRoot, taskId) {
  // Sanitize taskId for filesystem (replace spaces and special chars)
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getLogDir(projectRoot), `agent-${safeId}.log`);
}

/**
 * Ensure the log directory exists.
 * @param {string} projectRoot
 */
function ensureLogDir(projectRoot) {
  const dir = getLogDir(projectRoot);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Format a timestamp for log lines.
 * @returns {string} HH:MM:SS format
 */
function formatTime() {
  const now = new Date();
  return [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join(':');
}

/**
 * Rotate a log file if it exceeds the size limit.
 * Renames current log to .1.log, shifts existing rotations.
 *
 * @param {string} logPath
 * @param {number} [maxSize] - Max size in bytes before rotation
 */
function rotateIfNeeded(logPath, maxSize = MAX_LOG_SIZE_BYTES) {
  try {
    if (!fs.existsSync(logPath)) return;
    const stats = fs.statSync(logPath);
    if (stats.size < maxSize) return;

    // Shift existing rotated logs (keep max 3)
    for (let i = 2; i >= 1; i--) {
      const from = `${logPath}.${i}`;
      const to = `${logPath}.${i + 1}`;
      if (fs.existsSync(from)) {
        if (i === 2) {
          fs.unlinkSync(from); // Delete oldest
        } else {
          fs.renameSync(from, to);
        }
      }
    }

    // Rotate current → .1
    fs.renameSync(logPath, `${logPath}.1`);
  } catch (e) {
    // Best effort rotation
  }
}

/**
 * Attach log capture to a spawned child process.
 * Pipes stdout and stderr to a timestamped log file.
 *
 * @param {string} projectRoot
 * @param {string} taskId
 * @param {import('child_process').ChildProcess} child
 * @returns {{ logPath: string, close: () => void }}
 */
function attachLogger(projectRoot, taskId, child) {
  ensureLogDir(projectRoot);
  const logPath = getLogPath(projectRoot, taskId);

  // Rotate if needed before starting
  rotateIfNeeded(logPath);

  const stream = fs.createWriteStream(logPath, { flags: 'a' });

  // Write header
  stream.write(`\n${'='.repeat(60)}\n`);
  stream.write(`[${formatTime()}] Agent started for task: ${taskId}\n`);
  stream.write(`[${formatTime()}] PID: ${child.pid}\n`);
  stream.write(`${'='.repeat(60)}\n\n`);

  // Pipe stdout with prefix
  if (child.stdout) {
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      rotateIfNeeded(logPath);
      stream.write(`[${formatTime()}] [stdout] ${line}\n`);
    });
  }

  // Pipe stderr with prefix
  if (child.stderr) {
    const rl = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    rl.on('line', (line) => {
      rotateIfNeeded(logPath);
      stream.write(`[${formatTime()}] [stderr] ${line}\n`);
    });
  }

  // Handle child exit
  child.on('exit', (code, signal) => {
    stream.write(`\n[${formatTime()}] Agent exited (code=${code}, signal=${signal})\n`);
    stream.end();
  });

  return {
    logPath,
    close: () => {
      try { stream.end(); } catch (_) {}
    }
  };
}

/**
 * Tail a log file, streaming new lines to a callback.
 * Returns a function to stop tailing.
 *
 * @param {string} logPath - Path to the log file
 * @param {function} onLine - Callback for each new line
 * @returns {{ stop: () => void }}
 */
function tailLog(logPath, onLine) {
  if (!fs.existsSync(logPath)) {
    onLine(`[error] Log file not found: ${logPath}`);
    return { stop: () => {} };
  }

  // Start from end of file
  const stats = fs.statSync(logPath);
  let position = stats.size;
  let buffer = '';

  const interval = setInterval(() => {
    try {
      if (!fs.existsSync(logPath)) {
        onLine('[info] Log file removed — agent may have exited');
        clearInterval(interval);
        return;
      }

      const currentStats = fs.statSync(logPath);
      if (currentStats.size < position) {
        // File was rotated — start from beginning of new file
        position = 0;
      }
      if (currentStats.size === position) return; // No new data

      const fd = fs.openSync(logPath, 'r');
      const chunk = Buffer.alloc(currentStats.size - position);
      fs.readSync(fd, chunk, 0, chunk.length, position);
      fs.closeSync(fd);

      position = currentStats.size;
      buffer += chunk.toString('utf8');

      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete last line in buffer
      for (const line of lines) {
        if (line.trim()) onLine(line);
      }
    } catch (e) {
      // Ignore transient read errors
    }
  }, 250); // Poll every 250ms

  return {
    stop: () => clearInterval(interval)
  };
}

/**
 * Read the last N lines from a log file.
 *
 * @param {string} logPath
 * @param {number} [n=50]
 * @returns {string[]}
 */
function readLastLines(logPath, n = 50) {
  if (!fs.existsSync(logPath)) return [];
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    return lines.slice(-n);
  } catch (e) {
    return [];
  }
}

/**
 * List all agent log files with metadata.
 *
 * @param {string} projectRoot
 * @returns {Array<{ taskId: string, path: string, size: number, modified: string }>}
 */
function listLogs(projectRoot) {
  const dir = getLogDir(projectRoot);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('agent-') && f.endsWith('.log'));

  return files.map(f => {
    const filePath = path.join(dir, f);
    const stats = fs.statSync(filePath);
    // Extract taskId from filename: agent-<taskId>.log
    const taskId = f.replace(/^agent-/, '').replace(/\.log$/, '');
    return {
      taskId,
      path: filePath,
      size: stats.size,
      modified: stats.mtime.toISOString()
    };
  });
}

module.exports = {
  getLogDir,
  getLogPath,
  ensureLogDir,
  attachLogger,
  tailLog,
  readLastLines,
  listLogs,
  rotateIfNeeded,
  MAX_LOG_SIZE_BYTES,
  LOG_DIR
};
