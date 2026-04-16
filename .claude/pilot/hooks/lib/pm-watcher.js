/**
 * PM Watcher — External process that monitors bus.jsonl for events
 * and triggers autonomous PM actions.
 *
 * Part of Pilot AGI-v1k — Autonomous PM-Executor Loop
 *
 * Architecture:
 *   bus.jsonl ──fs.watch──▶ PM Watcher ──▶ PM Loop (process events)
 *                                         ──▶ Action Queue (when PM offline)
 *
 * The watcher is a standalone Node.js process (not a hook).
 * It runs in the background and bridges the gap between executor
 * agents and the PM terminal.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');

// ============================================================================
// CONSTANTS
// ============================================================================

const WATCHER_ID = 'pm-watcher';
const BUS_PATH = '.claude/pilot/messages/bus.jsonl';
const WATCHER_STATE_PATH = '.claude/pilot/state/orchestrator/watcher-state.json';
const WATCHER_PID_PATH = '.claude/pilot/state/orchestrator/watcher.pid';
const POLL_INTERVAL_MS = 2000;   // Fallback polling interval
const DEBOUNCE_MS = 500;         // Debounce fs.watch events
const MAX_BATCH_SIZE = 50;       // Max messages per processing batch

// Event types the watcher cares about (from agents)
const WATCHED_TOPICS = [
  'task_complete',
  'task_claimed',
  'task_released',
  'step_complete',
  'blocked',
  'question',
  'error',
  'session_ended',
  'session_announced',
  'merge_request',
  'health_report'
];

// ============================================================================
// PATH HELPERS
// ============================================================================

function resolveFromRoot(projectRoot, relPath) {
  return path.join(projectRoot, relPath);
}

// ============================================================================
// WATCHER STATE
// ============================================================================

/**
 * Load watcher state (cursor position, stats)
 */
function loadWatcherState(projectRoot) {
  const statePath = resolveFromRoot(projectRoot, WATCHER_STATE_PATH);
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
  } catch (e) {
    // Corrupt state — start fresh
  }
  return createInitialState();
}

/**
 * Save watcher state atomically
 */
function saveWatcherState(projectRoot, state) {
  const statePath = resolveFromRoot(projectRoot, WATCHER_STATE_PATH);
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = statePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, statePath);
}

function createInitialState() {
  return {
    byte_offset: 0,
    processed_count: 0,
    last_processed_at: null,
    started_at: new Date().toISOString(),
    errors: [],
    stats: {
      events_processed: 0,
      actions_triggered: 0,
      errors_count: 0,
      uptime_start: new Date().toISOString()
    }
  };
}

// ============================================================================
// PID FILE MANAGEMENT
// ============================================================================

function writePidFile(projectRoot) {
  const pidPath = resolveFromRoot(projectRoot, WATCHER_PID_PATH);
  const dir = path.dirname(pidPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(pidPath, JSON.stringify({
    pid: process.pid,
    started_at: new Date().toISOString(),
    project_root: projectRoot
  }));
}

function removePidFile(projectRoot) {
  const pidPath = resolveFromRoot(projectRoot, WATCHER_PID_PATH);
  try {
    if (fs.existsSync(pidPath)) {
      fs.unlinkSync(pidPath);
    }
  } catch (e) {
    // Best effort
  }
}

function readPidFile(projectRoot) {
  const pidPath = resolveFromRoot(projectRoot, WATCHER_PID_PATH);
  try {
    if (fs.existsSync(pidPath)) {
      return JSON.parse(fs.readFileSync(pidPath, 'utf8'));
    }
  } catch (e) {
    // Corrupt or missing
  }
  return null;
}

/**
 * Check if a watcher process is already running
 */
function isWatcherRunning(projectRoot) {
  const pidInfo = readPidFile(projectRoot);
  if (!pidInfo || !pidInfo.pid) return false;

  try {
    process.kill(pidInfo.pid, 0); // Signal 0 = existence check
    return true;
  } catch (e) {
    // Process doesn't exist — stale PID file
    removePidFile(projectRoot);
    return false;
  }
}

// ============================================================================
// BUS READER (cursor-based, independent of session messaging)
// ============================================================================

/**
 * Read new lines from bus.jsonl since last byte offset.
 * Returns parsed messages relevant to PM.
 * Async to avoid blocking the event loop on large files.
 */
async function readNewBusEvents(projectRoot, state) {
  const busPath = resolveFromRoot(projectRoot, BUS_PATH);

  let stats;
  try {
    stats = await fsp.stat(busPath);
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { events: [], newOffset: state.byte_offset };
    }
    throw e;
  }

  // Bus was truncated or compacted — reset offset
  if (stats.size < state.byte_offset) {
    state.byte_offset = 0;
  }

  if (stats.size <= state.byte_offset) {
    return { events: [], newOffset: state.byte_offset };
  }

  // Read new bytes (async to avoid blocking event loop)
  const bufferSize = Math.min(stats.size - state.byte_offset, 1024 * 256); // Max 256KB batch
  const buffer = Buffer.alloc(bufferSize);
  const fh = await fsp.open(busPath, 'r');
  try {
    await fh.read(buffer, 0, bufferSize, state.byte_offset);
  } finally {
    await fh.close();
  }

  const content = buffer.toString('utf8');
  const lines = content.split('\n').filter(l => l.trim());

  const events = [];
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      // Filter to events relevant for PM processing
      if (isRelevantForPm(msg)) {
        events.push(msg);
      }
    } catch (e) {
      // Skip malformed lines
    }
  }

  // Only take up to batch size
  const batch = events.slice(0, MAX_BATCH_SIZE);

  return {
    events: batch,
    newOffset: state.byte_offset + bufferSize
  };
}

/**
 * Determine if a bus message is relevant for PM auto-processing
 */
function isRelevantForPm(msg) {
  // Broadcasts are always relevant
  if (msg.type === 'broadcast') return true;

  // Messages addressed to PM or watcher
  if (msg.to === 'PM' || msg.to === WATCHER_ID || msg.to === '*') return true;

  // Task-related notifications
  if (msg.topic && WATCHED_TOPICS.includes(msg.topic)) return true;

  // Requests from agents (questions, help)
  if (msg.type === 'request') return true;

  // Responses to PM's messages
  if (msg.type === 'response' && msg.correlation_id) return true;

  return false;
}

// ============================================================================
// PM WATCHER CLASS
// ============================================================================

class PmWatcher extends EventEmitter {
  constructor(projectRoot, opts = {}) {
    super();
    this.projectRoot = projectRoot;
    this.state = loadWatcherState(projectRoot);
    this.running = false;
    this.fsWatcher = null;
    this.pollTimer = null;
    this.debounceTimer = null;
    this.opts = {
      pollIntervalMs: opts.pollIntervalMs || POLL_INTERVAL_MS,
      debounceMs: opts.debounceMs || DEBOUNCE_MS,
      ...opts
    };
  }

  /**
   * Start watching bus.jsonl for new events
   */
  start() {
    if (this.running) return;

    if (isWatcherRunning(this.projectRoot)) {
      throw new Error('Another PM watcher is already running');
    }

    this.running = true;
    writePidFile(this.projectRoot);

    const busPath = resolveFromRoot(this.projectRoot, BUS_PATH);
    const busDir = path.dirname(busPath);

    // Ensure bus directory exists
    if (!fs.existsSync(busDir)) {
      fs.mkdirSync(busDir, { recursive: true });
    }

    // Primary: fs.watch for instant event detection
    try {
      this.fsWatcher = fs.watch(busDir, { persistent: true }, (eventType, filename) => {
        if (filename === 'bus.jsonl' && eventType === 'change') {
          this._debouncedProcess();
        }
      });

      this.fsWatcher.on('error', (err) => {
        this.emit('watch_error', err);
        // Fall back to polling only
        this.fsWatcher = null;
      });
    } catch (e) {
      // fs.watch not available — polling only
      this.emit('watch_error', e);
    }

    // Secondary: polling fallback (catches events fs.watch might miss)
    this.pollTimer = setInterval(() => {
      this._processNewEvents().catch(e => this.emit('error', e));
    }, this.opts.pollIntervalMs);

    // Process any pending events immediately
    this._processNewEvents().catch(e => this.emit('error', e));

    this.emit('started', { pid: process.pid, projectRoot: this.projectRoot });
  }

  /**
   * Stop the watcher gracefully
   */
  stop(reason = 'manual') {
    if (!this.running) return;

    this.running = false;

    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Save final state
    this.state.stopped_at = new Date().toISOString();
    this.state.stop_reason = reason;
    saveWatcherState(this.projectRoot, this.state);
    removePidFile(this.projectRoot);

    this.emit('stopped', { reason });
  }

  /**
   * Debounced event processing (coalesces rapid fs.watch triggers)
   */
  _debouncedProcess() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this._processNewEvents().catch(e => this.emit('error', e));
    }, this.opts.debounceMs);
  }

  /**
   * Read and process new bus events (async to avoid blocking event loop)
   */
  async _processNewEvents() {
    if (!this.running) return;

    try {
      const { events, newOffset } = await readNewBusEvents(this.projectRoot, this.state);

      if (events.length > 0) {
        this.state.byte_offset = newOffset;
        this.state.last_processed_at = new Date().toISOString();
        this.state.stats.events_processed += events.length;

        // Classify and emit events for the PM loop to handle
        for (const event of events) {
          const classified = this._classifyEvent(event);
          this.emit('bus_event', { event, classification: classified });
        }

        // Persist cursor position
        saveWatcherState(this.projectRoot, this.state);
      }
    } catch (e) {
      this.state.stats.errors_count++;
      this.state.errors.push({
        ts: new Date().toISOString(),
        error: e.message
      });

      // Keep only last 20 errors
      if (this.state.errors.length > 20) {
        this.state.errors = this.state.errors.slice(-20);
      }

      this.emit('error', e);
    }
  }

  /**
   * Classify a bus event into an actionable category for the PM loop
   */
  _classifyEvent(event) {
    const topic = event.topic || '';
    const type = event.type || '';

    // Task lifecycle
    if (topic === 'task_complete' || topic === 'task_released') {
      return { action: 'assign_next', priority: 'high', detail: 'Agent finished task, assign next' };
    }

    if (topic === 'task_claimed') {
      return { action: 'track_claim', priority: 'low', detail: 'Agent claimed task' };
    }

    // Agent needs help
    if (topic === 'blocked' || topic === 'question') {
      return { action: 'respond_to_agent', priority: 'high', detail: 'Agent needs assistance' };
    }

    if (topic === 'error') {
      return { action: 'handle_error', priority: 'high', detail: 'Agent encountered error' };
    }

    // Session lifecycle
    if (topic === 'session_ended') {
      return { action: 'cleanup_session', priority: 'medium', detail: 'Session ended' };
    }

    if (topic === 'session_announced') {
      return { action: 'greet_agent', priority: 'low', detail: 'New agent joined' };
    }

    // Merge workflow
    if (topic === 'merge_request') {
      return { action: 'review_merge', priority: 'high', detail: 'Merge requested' };
    }

    // Step progress
    if (topic === 'step_complete') {
      return { action: 'track_progress', priority: 'low', detail: 'Step completed' };
    }

    // Requests from agents
    if (type === 'request') {
      return { action: 'respond_to_agent', priority: 'medium', detail: 'Agent request' };
    }

    // Health reports
    if (topic === 'health_report') {
      return { action: 'process_health', priority: 'low', detail: 'Health report received' };
    }

    // Default: log and skip
    return { action: 'log_only', priority: 'low', detail: `Unclassified: ${type}/${topic}` };
  }

  /**
   * Get watcher status
   */
  getStatus() {
    return {
      running: this.running,
      pid: process.pid,
      projectRoot: this.projectRoot,
      ...this.state.stats,
      last_processed_at: this.state.last_processed_at,
      byte_offset: this.state.byte_offset,
      uptime_ms: Date.now() - new Date(this.state.stats.uptime_start).getTime()
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  PmWatcher,
  loadWatcherState,
  saveWatcherState,
  readNewBusEvents,
  isWatcherRunning,
  readPidFile,
  removePidFile,
  WATCHER_ID,
  WATCHED_TOPICS
};
