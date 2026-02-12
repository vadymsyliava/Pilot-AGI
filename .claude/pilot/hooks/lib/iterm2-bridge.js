/**
 * iTerm2 Bridge — Node.js Wrapper (Phase 6.2)
 *
 * Spawns and communicates with the Python iTerm2 bridge process.
 * Provides the same API surface as applescript-bridge.js but using
 * iTerm2's Python API for richer features: split panes, line-range
 * reading, session badges, stable UUIDs.
 *
 * Protocol: JSON-line over stdin/stdout with request IDs.
 *
 * Part of Phase 6.2 (Pilot AGI-3du)
 */

const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const readline = require('readline');

const execFileAsync = promisify(execFile);

// ============================================================================
// CONSTANTS
// ============================================================================

const BRIDGE_SCRIPT = path.resolve(__dirname, '../../scripts/iterm2-bridge.py');
const BRIDGE_READY_TIMEOUT_MS = 10000;
const REQUEST_TIMEOUT_MS = 15000;

// ============================================================================
// BRIDGE PROCESS MANAGER
// ============================================================================

/**
 * Manages the lifecycle of the Python iTerm2 bridge process.
 */
class ITerm2Bridge {
  constructor(opts = {}) {
    this.bridgeScript = opts.bridgeScript || BRIDGE_SCRIPT;
    this.standalone = opts.standalone || false;
    this.process = null;
    this.rl = null;
    this._pendingRequests = new Map(); // id -> { resolve, reject, timer }
    this._requestCounter = 0;
    this._ready = false;
    this._readyPromise = null;
    this._onExit = null;
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /**
   * Start the Python bridge process.
   * Waits for the "ready" signal before resolving.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this.process) return;

    const args = [this.bridgeScript];
    if (this.standalone) args.push('--standalone');

    this.process = spawn('python3', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Set up line-based JSON reader on stdout
    this.rl = readline.createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });

    this.rl.on('line', (line) => this._handleLine(line));

    this.process.on('exit', (code, signal) => {
      this._ready = false;
      // Reject all pending requests
      for (const [id, pending] of this._pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Bridge process exited (code=${code}, signal=${signal})`));
      }
      this._pendingRequests.clear();
      this.process = null;
      this.rl = null;
      if (this._onExit) this._onExit(code, signal);
    });

    // Collect stderr for debugging
    this.process.stderr.on('data', (data) => {
      // Silently consume stderr — could add logging here
    });

    // Wait for ready signal
    await this._waitForReady();
  }

  /**
   * Stop the bridge process gracefully.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.process) return;

    return new Promise((resolve) => {
      this._onExit = () => {
        this._onExit = null;
        resolve();
      };

      // Close stdin to signal the bridge to exit
      if (this.process.stdin.writable) {
        this.process.stdin.end();
      }

      // Force kill after timeout
      const timer = setTimeout(() => {
        if (this.process) {
          try { this.process.kill('SIGTERM'); } catch (e) { /* already dead */ }
        }
      }, 3000);

      // Clear timeout if process exits cleanly
      const origOnExit = this._onExit;
      this._onExit = (code, signal) => {
        clearTimeout(timer);
        origOnExit(code, signal);
      };
    });
  }

  /**
   * Check if the bridge process is running and ready.
   *
   * @returns {boolean}
   */
  isRunning() {
    return this._ready && this.process !== null;
  }

  /**
   * Register an exit handler.
   *
   * @param {Function} handler - Called with (code, signal)
   */
  onExit(handler) {
    this._onExit = handler;
  }

  // ==========================================================================
  // OPERATIONS (matching applescript-bridge.js API)
  // ==========================================================================

  /**
   * Open a new terminal window/tab in iTerm2.
   *
   * @param {object} opts
   * @param {string} [opts.command] - Command to run
   * @param {string} [opts.title] - Tab/window title
   * @param {string} [opts.cwd] - Working directory
   * @param {object} [opts.env] - Environment variables
   * @param {'window'|'tab'|'split'} [opts.target] - Where to open
   * @param {string} [opts.badge] - Badge text for the session
   * @returns {Promise<{terminalId: string, title: string}>}
   */
  async openTab(opts = {}) {
    const result = await this._send({
      action: 'open',
      command: opts.command,
      title: opts.title,
      cwd: opts.cwd,
      env: opts.env,
      target: opts.target || 'tab',
      badge: opts.badge,
    });
    return {
      tabId: result.terminalId,
      title: result.title,
    };
  }

  /**
   * Send a command to an existing iTerm2 session.
   *
   * @param {string} tabId - iTerm2 session ID
   * @param {string} command - Command to send
   * @returns {Promise<void>}
   */
  async sendToTab(tabId, command) {
    await this._send({
      action: 'send',
      terminalId: tabId,
      command,
    });
  }

  /**
   * Read output from an iTerm2 session.
   *
   * @param {string} tabId - iTerm2 session ID
   * @param {object} [opts]
   * @param {number} [opts.lines] - Number of lines to read (default 50)
   * @param {boolean} [opts.raw] - If true, include ANSI sequences
   * @returns {Promise<string>}
   */
  async readTab(tabId, opts = {}) {
    const result = await this._send({
      action: 'read',
      terminalId: tabId,
      lines: opts.lines || 50,
      raw: opts.raw || false,
    });
    return result.output || '';
  }

  /**
   * List all tracked iTerm2 sessions.
   *
   * @returns {Promise<Array<{tabId: string, title: string, alive: boolean}>>}
   */
  async listTabs() {
    const result = await this._send({ action: 'list' });
    return (result.sessions || []).map(s => ({
      tabId: s.terminalId,
      title: s.title,
      alive: s.alive !== false,
    }));
  }

  /**
   * Close an iTerm2 session.
   *
   * @param {string} tabId - iTerm2 session ID
   * @returns {Promise<boolean>}
   */
  async closeTab(tabId) {
    const result = await this._send({
      action: 'close',
      terminalId: tabId,
    });
    return result.ok === true;
  }

  /**
   * Detect the state of a Claude Code session.
   *
   * @param {string} tabId - iTerm2 session ID
   * @param {object} [opts]
   * @param {number} [opts.lines] - Lines to read for detection
   * @returns {Promise<{state: string, match: string|null}>}
   */
  async detectState(tabId, opts = {}) {
    const result = await this._send({
      action: 'detect',
      terminalId: tabId,
      lines: opts.lines || 20,
    });
    return {
      state: result.state || 'unknown',
      match: result.match || null,
    };
  }

  /**
   * Set badge text on an iTerm2 session.
   *
   * @param {string} tabId - iTerm2 session ID
   * @param {string} text - Badge text
   * @returns {Promise<void>}
   */
  async setBadge(tabId, text) {
    await this._send({
      action: 'badge',
      terminalId: tabId,
      text,
    });
  }

  /**
   * Ping the bridge process to check connectivity.
   *
   * @returns {Promise<boolean>}
   */
  async ping() {
    try {
      const result = await this._send({ action: 'ping' });
      return result.pong === true;
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // INTERNAL
  // ==========================================================================

  /**
   * Send a JSON command to the bridge and await the response.
   *
   * @param {object} cmd - Command object (action + params)
   * @returns {Promise<object>} Response object
   */
  _send(cmd) {
    if (!this.process || !this.process.stdin.writable) {
      return Promise.reject(new Error('Bridge process not running'));
    }

    const id = `req-${++this._requestCounter}`;
    cmd.id = id;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${cmd.action} (${id})`));
      }, REQUEST_TIMEOUT_MS);

      this._pendingRequests.set(id, { resolve, reject, timer });

      const line = JSON.stringify(cmd) + '\n';
      this.process.stdin.write(line);
    });
  }

  /**
   * Handle a line of JSON from the bridge's stdout.
   *
   * @param {string} line - Raw line from stdout
   */
  _handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Ignore non-JSON output
    }

    // Ready signal (no request ID)
    if (msg.ready) {
      this._ready = true;
      if (this._readyResolve) {
        this._readyResolve();
        this._readyResolve = null;
      }
      return;
    }

    // Match response to pending request
    const id = msg.id;
    if (id && this._pendingRequests.has(id)) {
      const pending = this._pendingRequests.get(id);
      this._pendingRequests.delete(id);
      clearTimeout(pending.timer);

      if (msg.ok === false) {
        pending.reject(new Error(msg.error || 'Bridge returned error'));
      } else {
        pending.resolve(msg);
      }
    }
  }

  /**
   * Wait for the bridge to send its "ready" signal.
   *
   * @returns {Promise<void>}
   */
  _waitForReady() {
    if (this._ready) return Promise.resolve();

    return new Promise((resolve, reject) => {
      this._readyResolve = resolve;

      const timer = setTimeout(() => {
        this._readyResolve = null;
        reject(new Error('Bridge did not become ready within timeout'));
      }, BRIDGE_READY_TIMEOUT_MS);

      // Clear timeout when ready
      const origResolve = this._readyResolve;
      this._readyResolve = () => {
        clearTimeout(timer);
        origResolve();
      };
    });
  }
}

// ============================================================================
// AVAILABILITY CHECK
// ============================================================================

/**
 * Check if iTerm2 is installed on the system.
 *
 * @returns {Promise<boolean>}
 */
async function isITerm2Installed() {
  try {
    const { stdout } = await execFileAsync('mdfind', [
      'kMDItemBundleIdentifier == "com.googlecode.iterm2"'
    ], { timeout: 5000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if iTerm2 is currently running.
 *
 * @returns {Promise<boolean>}
 */
async function isITerm2Running() {
  try {
    const { stdout } = await execFileAsync('osascript', [
      '-e', 'application "iTerm2" is running'
    ], { timeout: 5000 });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Check if the iTerm2 Python API package is installed.
 *
 * @returns {Promise<boolean>}
 */
async function isPythonAPIAvailable() {
  try {
    await execFileAsync('python3', ['-c', 'import iterm2'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Full availability check: iTerm2 installed + Python API available.
 *
 * @returns {Promise<{available: boolean, installed: boolean, running: boolean, pythonAPI: boolean}>}
 */
async function checkAvailability() {
  const [installed, running, pythonAPI] = await Promise.all([
    isITerm2Installed(),
    isITerm2Running(),
    isPythonAPIAvailable(),
  ]);

  return {
    available: installed && pythonAPI,
    installed,
    running,
    pythonAPI,
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  ITerm2Bridge,
  isITerm2Installed,
  isITerm2Running,
  isPythonAPIAvailable,
  checkAvailability,
};
