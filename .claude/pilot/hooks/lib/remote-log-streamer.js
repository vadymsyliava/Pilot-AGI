/**
 * Remote Log Streamer (Phase 5.10)
 *
 * Stream logs from remote agents via SSH tail or Docker logs.
 * Provides SSE-compatible readable streams and WS broadcast integration.
 *
 * API:
 *   startStreaming(agentId, options) → { stream: Readable, stop: Function }
 *   stopStreaming(agentId)
 *   getRecentLogs(agentId, lines) → string[]
 *   getActiveStreams() → string[]
 */

const { spawn } = require('child_process');
const { Readable } = require('stream');
const EventEmitter = require('events');

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_LOG_BUFFER = 1000; // Max lines kept in memory per agent
const DEFAULT_TAIL_LINES = 50;
const STREAM_RECONNECT_MS = 5000;

// ============================================================================
// LOG STREAMER
// ============================================================================

class RemoteLogStreamer extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, { process: object, buffer: string[], stream: Readable, type: string }>} */
    this._streams = new Map();
  }

  /**
   * Start streaming logs for an agent.
   *
   * @param {string} agentId — process ID from execution provider (e.g., 'ssh-host-taskid-123')
   * @param {object} options
   * @param {string} options.type — 'ssh' | 'docker' | 'local'
   * @param {object} [options.hostConfig] — for SSH: { host, user, port, key_path, remote_path }
   * @param {string} [options.containerName] — for Docker
   * @param {string} [options.logPath] — for local: path to log file
   * @param {number} [options.tailLines] — initial lines to fetch (default 50)
   * @returns {{ success: boolean, stream?: Readable, error?: string }}
   */
  startStreaming(agentId, options = {}) {
    if (this._streams.has(agentId)) {
      return { success: false, error: `Already streaming ${agentId}` };
    }

    const type = options.type || 'local';
    const tailLines = options.tailLines || DEFAULT_TAIL_LINES;
    const buffer = [];

    // Create a readable stream that consumers can pipe from
    const readable = new Readable({
      read() {} // Push-based, no pull needed
    });

    let child;

    try {
      if (type === 'ssh') {
        child = this._startSshStream(agentId, options, tailLines);
      } else if (type === 'docker') {
        child = this._startDockerStream(agentId, options, tailLines);
      } else {
        child = this._startLocalStream(agentId, options, tailLines);
      }
    } catch (e) {
      return { success: false, error: `Failed to start stream: ${e.message}` };
    }

    if (!child) {
      return { success: false, error: 'Failed to create log stream process' };
    }

    // Pipe stdout to readable stream and buffer
    child.stdout.on('data', (data) => {
      const text = data.toString('utf8');
      const lines = text.split('\n').filter(l => l);

      for (const line of lines) {
        buffer.push(line);
        if (buffer.length > MAX_LOG_BUFFER) {
          buffer.shift();
        }
      }

      // Push to readable stream (SSE-compatible)
      readable.push(text);

      // Emit for WS broadcast
      this.emit('log', agentId, text);
    });

    child.stderr.on('data', (data) => {
      this.emit('error', agentId, data.toString('utf8'));
    });

    child.on('close', (code) => {
      this.emit('stream_ended', agentId, code);
      this._streams.delete(agentId);
      readable.push(null); // End the readable stream
    });

    child.on('error', (err) => {
      this.emit('error', agentId, err.message);
    });

    this._streams.set(agentId, {
      process: child,
      buffer,
      stream: readable,
      type
    });

    return { success: true, stream: readable };
  }

  /**
   * Stop streaming logs for an agent.
   *
   * @param {string} agentId
   * @returns {{ success: boolean }}
   */
  stopStreaming(agentId) {
    const entry = this._streams.get(agentId);
    if (!entry) {
      return { success: false };
    }

    try {
      entry.process.kill('SIGTERM');
    } catch (e) { /* already dead */ }

    entry.stream.push(null);
    this._streams.delete(agentId);
    return { success: true };
  }

  /**
   * Get recent log lines for an agent (from buffer).
   *
   * @param {string} agentId
   * @param {number} [lines=50]
   * @returns {string[]}
   */
  getRecentLogs(agentId, lines) {
    const count = lines || DEFAULT_TAIL_LINES;
    const entry = this._streams.get(agentId);
    if (!entry) {
      return [];
    }
    return entry.buffer.slice(-count);
  }

  /**
   * Get list of active stream IDs.
   *
   * @returns {string[]}
   */
  getActiveStreams() {
    return Array.from(this._streams.keys());
  }

  /**
   * Stop all active streams (for cleanup).
   */
  stopAll() {
    for (const agentId of this._streams.keys()) {
      this.stopStreaming(agentId);
    }
  }

  // ==========================================================================
  // STREAM STARTERS
  // ==========================================================================

  _startSshStream(agentId, options, tailLines) {
    const hostConfig = options.hostConfig;
    if (!hostConfig) {
      throw new Error('hostConfig required for SSH log streaming');
    }

    const remotePath = hostConfig.remote_path || '/tmp/pilot-agi';
    const taskId = options.taskId || agentId;
    const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, '-');
    const logFile = `${remotePath}/.claude/pilot/state/logs/${safeTaskId}.log`;

    const sshArgs = _buildSshArgs(hostConfig);
    sshArgs.push(`tail -n ${tailLines} -f ${logFile} 2>/dev/null`);

    return spawn('ssh', sshArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }

  _startDockerStream(agentId, options, tailLines) {
    const containerName = options.containerName;
    if (!containerName) {
      throw new Error('containerName required for Docker log streaming');
    }

    return spawn('docker', [
      'logs', '--follow', '--tail', String(tailLines), containerName
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }

  _startLocalStream(agentId, options, tailLines) {
    const logPath = options.logPath;
    if (!logPath) {
      throw new Error('logPath required for local log streaming');
    }

    return spawn('tail', [
      '-n', String(tailLines), '-f', logPath
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function _buildSshArgs(hostConfig) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10'
  ];
  if (hostConfig.port && hostConfig.port !== 22) {
    args.push('-p', String(hostConfig.port));
  }
  if (hostConfig.key_path) {
    const keyPath = hostConfig.key_path.replace(/^~/, process.env.HOME || '');
    args.push('-i', keyPath);
  }
  const target = hostConfig.user
    ? `${hostConfig.user}@${hostConfig.host}`
    : hostConfig.host;
  args.push(target);
  return args;
}

// ============================================================================
// SINGLETON + EXPORTS
// ============================================================================

const _defaultStreamer = new RemoteLogStreamer();

module.exports = {
  RemoteLogStreamer,
  startStreaming: (agentId, options) => _defaultStreamer.startStreaming(agentId, options),
  stopStreaming: (agentId) => _defaultStreamer.stopStreaming(agentId),
  getRecentLogs: (agentId, lines) => _defaultStreamer.getRecentLogs(agentId, lines),
  getActiveStreams: () => _defaultStreamer.getActiveStreams(),
  stopAll: () => _defaultStreamer.stopAll(),
  // Constants
  MAX_LOG_BUFFER,
  DEFAULT_TAIL_LINES,
  STREAM_RECONNECT_MS
};
