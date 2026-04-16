/**
 * Agent File Watcher — Phase 6.7 (Pilot AGI-mkn)
 *
 * Real-time file change monitoring for non-Claude agents (Aider, Codex, Ollama, OpenCode).
 * Claude Code uses native hooks (pre-tool-use.js) so it does not need this.
 *
 * Responsibilities:
 *   - Monitor file system changes in agent's working directory
 *   - Detect area lock violations (editing outside assigned area)
 *   - Detect protected file edits (never_edit patterns)
 *   - Track change metrics (files touched, lines changed)
 *   - Report violations to shared state for PM daemon to pick up
 *
 * The file watcher is started by process-spawner when spawning non-Claude agents
 * and stopped when the agent process exits.
 *
 * Violations are written to .claude/pilot/state/violations.jsonl as JSONL entries.
 * The PM daemon reads this file during its enforcement scan to take action.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// =============================================================================
// CONSTANTS
// =============================================================================

const VIOLATIONS_FILE = '.claude/pilot/state/violations.jsonl';

const IGNORED_PREFIXES = [
  '.git/',
  'node_modules/',
  '.claude/pilot/state/',
  '.beads/',
  '.worktrees/'
];

const IGNORED_EXTENSIONS = [
  '.swp', '.swo', '.tmp', '.bak', '.orig',
  '.DS_Store'
];

// =============================================================================
// FILE WATCHER
// =============================================================================

class AgentFileWatcher {
  /**
   * @param {object} opts
   * @param {string} opts.watchPath - Directory to watch (worktree or cwd)
   * @param {string} opts.sessionId - Agent's session ID
   * @param {object} opts.policy - Loaded policy object
   * @param {string} [opts.projectRoot] - Main project root (for state files)
   * @param {string} [opts.taskId] - Current task ID
   * @param {function} [opts.onViolation] - Callback for violations (type, detail)
   */
  constructor(opts) {
    this.watchPath = opts.watchPath;
    this.sessionId = opts.sessionId;
    this.policy = opts.policy;
    this.projectRoot = opts.projectRoot || opts.watchPath;
    this.taskId = opts.taskId || null;
    this.onViolation = opts.onViolation || null;

    this._watcher = null;
    this._running = false;

    // Change tracking metrics
    this.metrics = {
      filesChanged: new Set(),
      totalEvents: 0,
      violations: [],
      startedAt: null,
      stoppedAt: null
    };

    // Load shared modules
    this._loadModules();
  }

  /**
   * Load policy/session modules from hooks/lib.
   */
  _loadModules() {
    const hooksLib = path.join(this.projectRoot, '.claude', 'pilot', 'hooks', 'lib');

    try {
      this._matchesPattern = require(path.join(hooksLib, 'policy')).matchesPattern;
    } catch (e) {
      this._matchesPattern = (fp, patterns) => {
        if (!patterns || !Array.isArray(patterns)) return false;
        for (const p of patterns) {
          const re = p.replace(/\./g, '\\.').replace(/\*\*/g, '\x00').replace(/\*/g, '[^/]*').replace(/\x00/g, '.*');
          if (new RegExp(`^${re}$`).test(fp)) return true;
        }
        return false;
      };
    }

    try {
      this._session = require(path.join(hooksLib, 'session'));
    } catch (e) {
      this._session = null;
    }
  }

  /**
   * Start watching for file changes.
   * @returns {boolean} Whether the watcher started successfully
   */
  start() {
    if (this._running) return false;

    try {
      this._watcher = fs.watch(this.watchPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        this._handleChange(eventType, filename);
      });

      this._watcher.on('error', (err) => {
        // Log error but don't crash — watcher is advisory
        this._recordViolation('watcher_error', null, { error: err.message });
      });

      this._running = true;
      this.metrics.startedAt = new Date().toISOString();
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Stop watching.
   * @returns {{ metrics: object }} Final metrics
   */
  stop() {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
    this._running = false;
    this.metrics.stoppedAt = new Date().toISOString();

    return {
      metrics: {
        filesChanged: this.metrics.filesChanged.size,
        totalEvents: this.metrics.totalEvents,
        violationCount: this.metrics.violations.length,
        violations: this.metrics.violations,
        duration: this.metrics.startedAt
          ? Date.now() - new Date(this.metrics.startedAt).getTime()
          : 0
      }
    };
  }

  /**
   * Check if the watcher is currently running.
   */
  get running() {
    return this._running;
  }

  /**
   * Handle a file change event.
   */
  _handleChange(eventType, filename) {
    this.metrics.totalEvents++;

    // Normalize path separators
    const normalized = filename.replace(/\\/g, '/');

    // Skip ignored files
    if (this._shouldIgnore(normalized)) return;

    // Track the change
    this.metrics.filesChanged.add(normalized);

    // Check 1: Protected file edit
    const neverEdit = this.policy.exceptions?.never_edit || [];
    if (this._matchesPattern(normalized, neverEdit)) {
      this._recordViolation('protected_file', normalized, {
        reason: 'File is in never_edit list (security policy)'
      });
      return;
    }

    // Check 2: Area lock violation
    if (this.policy.enforcement?.area_locking !== false && this._session) {
      const area = this._session.getAreaForPath(normalized);
      if (area) {
        const lock = this._session.isAreaLocked(area, this.sessionId);
        if (lock) {
          this._recordViolation('area_lock', normalized, {
            area,
            locked_by: lock.session_id,
            locked_task: lock.task_id
          });
        }
      }
    }
  }

  /**
   * Check if a filename should be ignored.
   */
  _shouldIgnore(filename) {
    for (const prefix of IGNORED_PREFIXES) {
      if (filename.startsWith(prefix)) return true;
    }
    for (const ext of IGNORED_EXTENSIONS) {
      if (filename.endsWith(ext)) return true;
    }
    return false;
  }

  /**
   * Record a violation to shared state and call callback.
   */
  _recordViolation(type, filename, detail = {}) {
    const violation = {
      type,
      filename,
      session_id: this.sessionId,
      task_id: this.taskId,
      timestamp: new Date().toISOString(),
      ...detail
    };

    this.metrics.violations.push(violation);

    // Write to shared violations file
    try {
      const violationsPath = path.join(this.projectRoot, VIOLATIONS_FILE);
      const dir = path.dirname(violationsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(violationsPath, JSON.stringify(violation) + '\n');
    } catch (e) {
      // Best effort — don't crash on write failure
    }

    // Call violation callback if provided
    if (this.onViolation) {
      try {
        this.onViolation(type, violation);
      } catch (e) {
        // Don't crash on callback failure
      }
    }
  }
}

// =============================================================================
// CONVENIENCE FACTORY
// =============================================================================

/**
 * Create and start a file watcher for an agent.
 *
 * @param {object} opts - Same as AgentFileWatcher constructor
 * @returns {AgentFileWatcher} Started watcher instance
 */
function createWatcher(opts) {
  const watcher = new AgentFileWatcher(opts);
  watcher.start();
  return watcher;
}

/**
 * Read all violations from the violations JSONL file.
 *
 * @param {string} projectRoot - Project root path
 * @param {object} [filter] - Optional filter
 * @param {string} [filter.sessionId] - Filter by session ID
 * @param {string} [filter.type] - Filter by violation type
 * @param {number} [filter.since] - Filter by timestamp (ms since epoch)
 * @returns {object[]} Array of violation entries
 */
function readViolations(projectRoot, filter = {}) {
  const violationsPath = path.join(projectRoot, VIOLATIONS_FILE);

  if (!fs.existsSync(violationsPath)) return [];

  try {
    const lines = fs.readFileSync(violationsPath, 'utf8').trim().split('\n').filter(Boolean);
    let violations = lines.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    if (filter.sessionId) {
      violations = violations.filter(v => v.session_id === filter.sessionId);
    }
    if (filter.type) {
      violations = violations.filter(v => v.type === filter.type);
    }
    if (filter.since) {
      violations = violations.filter(v => new Date(v.timestamp).getTime() >= filter.since);
    }

    return violations;
  } catch (e) {
    return [];
  }
}

module.exports = { AgentFileWatcher, createWatcher, readViolations };
