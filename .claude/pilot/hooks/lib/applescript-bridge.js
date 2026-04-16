/**
 * AppleScript Bridge Foundation (Phase 6.1)
 *
 * Core OS-level terminal controller using osascript for Terminal.app and iTerm2.
 * Auto-detects running terminal app — prefers iTerm2 when available.
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
// TARGET APP DETECTION
// ============================================================================

/** @type {'iTerm2'|'Terminal'|null} Cached detected terminal app */
let _detectedApp = null;

/**
 * Detect the active terminal application.
 * Prefers iTerm2 if running, falls back to Terminal.app.
 * Result is cached for the process lifetime.
 *
 * @returns {Promise<'iTerm2'|'Terminal'>}
 */
async function detectTargetApp() {
  if (_detectedApp) return _detectedApp;

  // Check if iTerm2 is running
  try {
    const result = await runAppleScript(
      'tell application "System Events" to return (name of processes) contains "iTerm2"',
      { timeout: 5000 }
    );
    if (result === 'true') {
      _detectedApp = 'iTerm2';
      return _detectedApp;
    }
  } catch (e) {
    // System Events not available, fall through
  }

  _detectedApp = 'Terminal';
  return _detectedApp;
}

/**
 * Force a specific target app (for testing or policy override).
 * @param {'iTerm2'|'Terminal'|null} app
 */
function setTargetApp(app) {
  _detectedApp = app;
}

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
 * Open a new tab and run a command. Auto-detects iTerm2 or Terminal.app.
 *
 * @param {object} opts
 * @param {string} opts.command - Command to execute in the new tab
 * @param {string} [opts.title] - Tab title (set via ANSI escape)
 * @param {string} [opts.cwd] - Working directory
 * @param {object} [opts.env] - Environment variables to set
 * @returns {Promise<{tabId: string, title: string}>}
 */
async function openTab(opts = {}) {
  const app = await detectTargetApp();
  if (app === 'iTerm2') return _openTabITerm2(opts);
  return _openTabTerminal(opts);
}

function _buildFullCommand(opts) {
  const { command, title, cwd, env } = opts;
  const tabTitle = title || `${TAB_TITLE_PREFIX}${Date.now()}`;
  const parts = [];
  if (cwd) parts.push(`cd "${escapeAppleScript(cwd)}"`);
  if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env)) {
      parts.push(`export ${k}="${escapeAppleScript(String(v))}"`);
    }
  }
  parts.push(titleEscape(tabTitle));
  if (command) parts.push(command);
  return { fullCommand: parts.join(' && '), tabTitle };
}

async function _openTabTerminal(opts) {
  const { fullCommand, tabTitle } = _buildFullCommand(opts);

  const script = `
    tell application "Terminal"
      activate
      do script "${escapeAppleScript(fullCommand)}"
      set theTab to selected tab of front window
      return id of front window
    end tell
  `;

  const windowId = await withRetry(() => runAppleScript(script));
  return { tabId: `terminal:${windowId}:${tabTitle}`, title: tabTitle };
}

async function _openTabITerm2(opts) {
  const { fullCommand, tabTitle } = _buildFullCommand(opts);

  const script = `
    tell application "iTerm2"
      activate
      tell current window
        create tab with default profile
        tell current session of current tab
          write text "${escapeAppleScript(fullCommand)}"
        end tell
        return id
      end tell
    end tell
  `;

  const windowId = await withRetry(() => runAppleScript(script));
  return { tabId: `iterm2:${windowId}:${tabTitle}`, title: tabTitle };
}

/**
 * Send a command to an existing tab identified by title.
 *
 * @param {string} tabId - Tab identifier (provider:windowId:title)
 * @param {string} command - Command to send
 * @returns {Promise<void>}
 */
async function sendToTab(tabId, command) {
  const { provider, title } = parseTabId(tabId);

  if (provider === 'iterm2') {
    return _sendToTabITerm2(title, command);
  }
  return _sendToTabTerminal(title, command);
}

async function _sendToTabTerminal(title, command) {
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
  if (result === 'not_found') throw new Error(`Tab not found: ${title}`);
}

async function _sendToTabITerm2(title, command) {
  const script = `
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if name of s contains "${escapeAppleScript(title)}" then
              tell s to write text "${escapeAppleScript(command)}"
              return "sent"
            end if
          end repeat
        end repeat
      end repeat
      return "not_found"
    end tell
  `;
  const result = await withRetry(() => runAppleScript(script));
  if (result === 'not_found') throw new Error(`Tab not found: ${title}`);
}

/**
 * Read the contents of a terminal tab identified by title.
 *
 * @param {string} tabId - Tab identifier (provider:windowId:title)
 * @param {object} [opts]
 * @param {number} [opts.lines] - Number of trailing lines (default 50)
 * @param {boolean} [opts.raw] - If true, don't strip ANSI (default false)
 * @returns {Promise<string>}
 */
async function readTab(tabId, opts = {}) {
  const { provider, title } = parseTabId(tabId);
  const lines = opts.lines || 50;

  let raw;
  if (provider === 'iterm2') {
    raw = await _readTabITerm2(title);
  } else {
    raw = await _readTabTerminal(title);
  }

  if (!raw) return '';
  const cleaned = opts.raw ? raw : stripAnsi(raw);
  const allLines = cleaned.split('\n');
  return allLines.slice(-lines).join('\n');
}

async function _readTabTerminal(title) {
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
  return withRetry(() => runAppleScript(script));
}

async function _readTabITerm2(title) {
  const script = `
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if name of s contains "${escapeAppleScript(title)}" then
              return contents of s
            end if
          end repeat
        end repeat
      end repeat
      return ""
    end tell
  `;
  return withRetry(() => runAppleScript(script));
}

/**
 * List all terminal tabs managed by Pilot AGI.
 *
 * @returns {Promise<Array<{tabId: string, title: string, windowId: string}>>}
 */
async function listTabs() {
  const app = await detectTargetApp();
  if (app === 'iTerm2') return _listTabsITerm2();
  return _listTabsTerminal();
}

async function _listTabsTerminal() {
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
  return raw.split('\n').filter(Boolean).map(line => {
    const colonIdx = line.indexOf(':');
    const windowId = line.slice(0, colonIdx);
    const title = line.slice(colonIdx + 1);
    return { tabId: `terminal:${windowId}:${title}`, title, windowId };
  });
}

async function _listTabsITerm2() {
  const script = `
    tell application "iTerm2"
      set results to ""
      repeat with w in windows
        set wId to id of w
        repeat with t in tabs of w
          repeat with s in sessions of t
            try
              set sName to name of s
              if sName contains "${TAB_TITLE_PREFIX}" then
                set results to results & wId & ":" & sName & linefeed
              end if
            end try
          end repeat
        end repeat
      end repeat
      return results
    end tell
  `;
  const raw = await runAppleScript(script);
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(line => {
    const colonIdx = line.indexOf(':');
    const windowId = line.slice(0, colonIdx);
    const title = line.slice(colonIdx + 1);
    return { tabId: `iterm2:${windowId}:${title}`, title, windowId };
  });
}

/**
 * Close a terminal tab identified by title.
 *
 * @param {string} tabId - Tab identifier (provider:windowId:title)
 * @returns {Promise<boolean>} true if closed, false if not found
 */
async function closeTab(tabId) {
  const { provider, title } = parseTabId(tabId);
  if (provider === 'iterm2') return _closeTabITerm2(title);
  return _closeTabTerminal(title);
}

async function _closeTabTerminal(title) {
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

async function _closeTabITerm2(title) {
  const script = `
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if name of s contains "${escapeAppleScript(title)}" then
              tell s to close
              return "closed"
            end if
          end repeat
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
 * Format: provider:windowId:title
 *
 * @param {string} tabId
 * @returns {{provider: string, windowId: string, title: string}}
 */
function parseTabId(tabId) {
  const parts = tabId.split(':');
  if (parts.length < 3) {
    throw new Error(`Invalid tabId format: ${tabId}. Expected provider:windowId:title`);
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
 * Check if AppleScript automation is available.
 * Tests iTerm2 first, falls back to Terminal.app.
 *
 * @returns {Promise<boolean>}
 */
async function isAvailable() {
  try {
    // Try iTerm2 first
    await runAppleScript('tell application "iTerm2" to return name', { timeout: 5000 });
    _detectedApp = 'iTerm2';
    return true;
  } catch (err) {
    // Fall through to Terminal.app
  }
  try {
    await runAppleScript('tell application "Terminal" to return name', { timeout: 5000 });
    _detectedApp = 'Terminal';
    return true;
  } catch (err) {
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
  detectTargetApp,
  setTargetApp,

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
    _openTabTerminal,
    _openTabITerm2,
  },
};
