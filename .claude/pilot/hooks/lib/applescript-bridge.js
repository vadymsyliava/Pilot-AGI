/**
 * AppleScript Bridge Foundation (Phase 6.1)
 *
 * Core OS-level terminal controller using osascript for Terminal.app.
 * Provides operations: openTab, sendToTab, readTab, listTabs,
 * closeTab, detectState, showDialog, preventSleep.
 *
 * Tab identification via custom titles set with ANSI escape sequences.
 * ANSI stripping for clean output. State detection regex for
 * Claude Code prompts. Race condition handling via retry + delay.
 *
 * Part of Phase 6.1 (Pilot AGI-xqn)
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// ============================================================================
// CONSTANTS
// ============================================================================

const OSASCRIPT = 'osascript';
const DEFAULT_TIMEOUT_MS = 10000;
const RETRY_DELAY_MS = 300;
const MAX_RETRIES = 3;
const TAB_TITLE_PREFIX = 'pilot-';

/**
 * Regex to strip ANSI escape sequences from terminal output.
 * Covers CSI sequences, OSC sequences, and other common escapes.
 */
const ANSI_REGEX = /\x1B(?:\[[0-9;]*[A-Za-z]|\].*?(?:\x07|\x1B\\)|\([A-Z0-9])/g;

/**
 * State detection patterns for Claude Code sessions.
 * Each pattern maps to a known state.
 */
const STATE_PATTERNS = {
  idle: /^>\s*$/m,
  waiting_input: /\?\s+(?:yes|no|approve|reject)/i,
  working: /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|Running|Executing/,
  error: /Error:|FATAL|panic|Traceback|ENOENT|EACCES/,
  checkpoint: /CHECKPOINT SAVED|Context pressure: [89]\d%|Context pressure: 100%/,
  plan_approval: /Waiting for plan approval|Approve this plan\?/,
  complete: /All plan steps complete|Task complete/,
};

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Run an AppleScript snippet via osascript.
 * @param {string} script - AppleScript code
 * @param {object} [opts]
 * @param {number} [opts.timeout] - Timeout in ms
 * @returns {Promise<string>} stdout
 */
async function runAppleScript(script, opts = {}) {
  const timeout = opts.timeout || DEFAULT_TIMEOUT_MS;
  const { stdout } = await execFileAsync(OSASCRIPT, ['-e', script], { timeout });
  return stdout.trim();
}

/**
 * Run a JXA (JavaScript for Automation) snippet via osascript.
 * @param {string} script - JXA code
 * @param {object} [opts]
 * @param {number} [opts.timeout] - Timeout in ms
 * @returns {Promise<string>} stdout
 */
async function runJXA(script, opts = {}) {
  const timeout = opts.timeout || DEFAULT_TIMEOUT_MS;
  const { stdout } = await execFileAsync(OSASCRIPT, ['-l', 'JavaScript', '-e', script], { timeout });
  return stdout.trim();
}

/**
 * Retry an async function with delay between attempts.
 * @param {Function} fn - Async function to retry
 * @param {number} [maxRetries] - Max retry count
 * @param {number} [delayMs] - Delay between retries
 * @returns {Promise<*>}
 */
async function withRetry(fn, maxRetries = MAX_RETRIES, delayMs = RETRY_DELAY_MS) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

/**
 * Strip ANSI escape sequences from a string.
 * @param {string} text
 * @returns {string}
 */
function stripAnsi(text) {
  if (!text) return '';
  return text.replace(ANSI_REGEX, '');
}

/**
 * Escape a string for use inside AppleScript double quotes.
 * @param {string} str
 * @returns {string}
 */
function escapeAppleScript(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build the ANSI escape to set a terminal tab title.
 * @param {string} title
 * @returns {string}
 */
function titleEscape(title) {
  return `printf '\\e]1;${title}\\a'`;
}

// ============================================================================
// CORE OPERATIONS
// ============================================================================

/**
 * Open a new tab in Terminal.app and run a command.
 *
 * Terminal.app's `make new tab` is unreliable, so we use
 * System Events Cmd+T keystroke as the primary method with
 * a direct `do script` fallback for new windows.
 *
 * @param {object} opts
 * @param {string} opts.command - Command to execute in the new tab
 * @param {string} [opts.title] - Tab title (set via ANSI escape)
 * @param {string} [opts.cwd] - Working directory
 * @param {object} [opts.env] - Environment variables to set
 * @returns {Promise<{tabId: string, title: string}>}
 */
async function openTab(opts = {}) {
  const { command, title, cwd, env } = opts;
  const tabTitle = title || `${TAB_TITLE_PREFIX}${Date.now()}`;

  // Build the full command: cd + env + title + actual command
  const parts = [];
  if (cwd) parts.push(`cd "${escapeAppleScript(cwd)}"`);
  if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env)) {
      parts.push(`export ${k}="${escapeAppleScript(String(v))}"`);
    }
  }
  parts.push(titleEscape(tabTitle));
  if (command) parts.push(command);

  const fullCommand = parts.join(' && ');

  const script = `
    tell application "Terminal"
      activate
      do script "${escapeAppleScript(fullCommand)}"
      set theTab to selected tab of front window
      return id of front window
    end tell
  `;

  const windowId = await withRetry(() => runAppleScript(script));

  return {
    tabId: `terminal:${windowId}:${tabTitle}`,
    title: tabTitle,
  };
}

/**
 * Send a command to an existing Terminal.app tab identified by title.
 *
 * Finds the tab by scanning window names/tab titles for the pilot-prefixed title,
 * then executes the command in that tab via `do script ... in`.
 *
 * @param {string} tabId - Tab identifier (terminal:windowId:title)
 * @param {string} command - Command to send
 * @returns {Promise<void>}
 */
async function sendToTab(tabId, command) {
  const { title } = parseTabId(tabId);

  const script = `
    tell application "Terminal"
      repeat with w in windows
        repeat with t in tabs of w
          if custom title of t is "${escapeAppleScript(title)}" then
            do script "${escapeAppleScript(command)}" in t
            return "sent"
          end if
        end repeat
      end repeat
      return "not_found"
    end tell
  `;

  const result = await withRetry(() => runAppleScript(script));
  if (result === 'not_found') {
    throw new Error(`Tab not found: ${tabId}`);
  }
}

/**
 * Read the contents of a Terminal.app tab identified by title.
 *
 * Returns the last N lines with ANSI sequences stripped.
 *
 * @param {string} tabId - Tab identifier (terminal:windowId:title)
 * @param {object} [opts]
 * @param {number} [opts.lines] - Number of trailing lines (default 50)
 * @param {boolean} [opts.raw] - If true, don't strip ANSI (default false)
 * @returns {Promise<string>}
 */
async function readTab(tabId, opts = {}) {
  const { title } = parseTabId(tabId);
  const lines = opts.lines || 50;

  const script = `
    tell application "Terminal"
      repeat with w in windows
        repeat with t in tabs of w
          if custom title of t is "${escapeAppleScript(title)}" then
            return contents of t
          end if
        end repeat
      end repeat
      return ""
    end tell
  `;

  const raw = await withRetry(() => runAppleScript(script));

  if (!raw) return '';

  const cleaned = opts.raw ? raw : stripAnsi(raw);
  const allLines = cleaned.split('\n');
  return allLines.slice(-lines).join('\n');
}

/**
 * List all Terminal.app tabs managed by Pilot AGI.
 *
 * Scans all windows/tabs for the pilot- title prefix.
 *
 * @returns {Promise<Array<{tabId: string, title: string, windowId: string}>>}
 */
async function listTabs() {
  const script = `
    tell application "Terminal"
      set results to ""
      repeat with w in windows
        set wId to id of w
        repeat with t in tabs of w
          try
            set tTitle to custom title of t
            if tTitle starts with "${TAB_TITLE_PREFIX}" then
              set results to results & wId & ":" & tTitle & linefeed
            end if
          end try
        end repeat
      end repeat
      return results
    end tell
  `;

  const raw = await runAppleScript(script);
  if (!raw) return [];

  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const colonIdx = line.indexOf(':');
      const windowId = line.slice(0, colonIdx);
      const title = line.slice(colonIdx + 1);
      return {
        tabId: `terminal:${windowId}:${title}`,
        title,
        windowId,
      };
    });
}

/**
 * Close a Terminal.app tab identified by title.
 *
 * Sends Cmd+W to close the tab after selecting it. Uses System Events
 * because Terminal.app doesn't expose a direct close-tab command.
 *
 * @param {string} tabId - Tab identifier (terminal:windowId:title)
 * @returns {Promise<boolean>} true if closed, false if not found
 */
async function closeTab(tabId) {
  const { title } = parseTabId(tabId);

  // First find and select the tab, then close it
  const script = `
    tell application "Terminal"
      repeat with w in windows
        set tabIndex to 0
        repeat with t in tabs of w
          set tabIndex to tabIndex + 1
          if custom title of t is "${escapeAppleScript(title)}" then
            set selected tab of w to t
            tell application "System Events"
              tell process "Terminal"
                keystroke "w" using command down
              end tell
            end tell
            return "closed"
          end if
        end repeat
      end repeat
      return "not_found"
    end tell
  `;

  const result = await withRetry(() => runAppleScript(script));
  return result === 'closed';
}

/**
 * Detect the state of a Claude Code session in a terminal tab.
 *
 * Reads the last N lines and matches against known state patterns.
 * Returns the most specific match found.
 *
 * @param {string} tabId - Tab identifier
 * @param {object} [opts]
 * @param {number} [opts.lines] - Lines to read for detection (default 20)
 * @returns {Promise<{state: string, match: string|null}>}
 */
async function detectState(tabId, opts = {}) {
  const content = await readTab(tabId, { lines: opts.lines || 20 });

  if (!content) {
    return { state: 'unknown', match: null };
  }

  // Check patterns in priority order (most specific first)
  const priorityOrder = [
    'error',
    'checkpoint',
    'plan_approval',
    'complete',
    'waiting_input',
    'working',
    'idle',
  ];

  for (const state of priorityOrder) {
    const pattern = STATE_PATTERNS[state];
    const match = content.match(pattern);
    if (match) {
      return { state, match: match[0] };
    }
  }

  return { state: 'unknown', match: null };
}

/**
 * Show a macOS dialog via osascript.
 *
 * Useful for local notifications when Telegram is not configured.
 *
 * @param {object} opts
 * @param {string} opts.message - Dialog message
 * @param {string} [opts.title] - Dialog title (default "Pilot AGI")
 * @param {string[]} [opts.buttons] - Button labels (default ["OK"])
 * @param {string} [opts.icon] - Icon: stop | note | caution (default "note")
 * @returns {Promise<string>} The button the user clicked
 */
async function showDialog(opts = {}) {
  const { message, title = 'Pilot AGI', buttons = ['OK'], icon = 'note' } = opts;

  const buttonList = buttons.map(b => `"${escapeAppleScript(b)}"`).join(', ');

  const script = `
    display dialog "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}" buttons {${buttonList}} default button 1 with icon ${icon}
    return button returned of result
  `;

  return runAppleScript(script, { timeout: 300000 }); // 5min timeout for user response
}

/**
 * Prevent macOS from sleeping using caffeinate.
 *
 * Spawns a caffeinate process that keeps the system awake.
 * Returns a handle to stop the prevention.
 *
 * @param {object} [opts]
 * @param {number} [opts.durationSeconds] - Duration in seconds (0 = indefinite)
 * @param {boolean} [opts.displaySleep] - Prevent display sleep too (default false)
 * @returns {Promise<{pid: number, stop: Function}>}
 */
async function preventSleep(opts = {}) {
  const { durationSeconds = 0, displaySleep = false } = opts;
  const { spawn } = require('child_process');

  const args = ['-i']; // Prevent idle sleep
  if (displaySleep) args.push('-d'); // Prevent display sleep
  if (durationSeconds > 0) args.push('-t', String(durationSeconds));

  const proc = spawn('caffeinate', args, {
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();

  return {
    pid: proc.pid,
    stop: () => {
      try { process.kill(proc.pid, 'SIGTERM'); } catch (e) { /* already stopped */ }
    },
  };
}

// ============================================================================
// TAB ID HELPERS
// ============================================================================

/**
 * Parse a tab identifier string.
 * Format: terminal:windowId:title
 *
 * @param {string} tabId
 * @returns {{provider: string, windowId: string, title: string}}
 */
function parseTabId(tabId) {
  const parts = tabId.split(':');
  if (parts.length < 3) {
    throw new Error(`Invalid tabId format: ${tabId}. Expected terminal:windowId:title`);
  }
  return {
    provider: parts[0],
    windowId: parts[1],
    title: parts.slice(2).join(':'), // title may contain colons
  };
}

/**
 * Build a tab identifier string.
 * @param {string} windowId
 * @param {string} title
 * @returns {string}
 */
function buildTabId(windowId, title) {
  return `terminal:${windowId}:${title}`;
}

// ============================================================================
// AVAILABILITY CHECK
// ============================================================================

/**
 * Check if AppleScript automation is available for Terminal.app.
 * Tests by running a simple osascript command.
 *
 * @returns {Promise<boolean>}
 */
async function isAvailable() {
  try {
    await runAppleScript('tell application "Terminal" to return name', { timeout: 5000 });
    return true;
  } catch (err) {
    // Permission denied or Terminal not available
    return false;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Core operations
  openTab,
  sendToTab,
  readTab,
  listTabs,
  closeTab,
  detectState,
  showDialog,
  preventSleep,

  // Utilities
  stripAnsi,
  isAvailable,
  parseTabId,
  buildTabId,

  // Exposed for testing
  _internals: {
    runAppleScript,
    runJXA,
    withRetry,
    escapeAppleScript,
    titleEscape,
    STATE_PATTERNS,
    ANSI_REGEX,
    TAB_TITLE_PREFIX,
  },
};
