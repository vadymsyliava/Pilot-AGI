/**
 * Local Execution Provider (Phase 5.10)
 *
 * Default local execution — wraps existing process-spawner.js.
 * Implements the execution provider interface.
 *
 * Always available on the local machine.
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// LAZY DEPS
// ============================================================================

let _processSpawner = null;
function getProcessSpawner() {
  if (!_processSpawner) {
    try { _processSpawner = require('../process-spawner'); } catch (e) { _processSpawner = null; }
  }
  return _processSpawner;
}

let _agentLogger = null;
function getAgentLogger() {
  if (!_agentLogger) {
    try { _agentLogger = require('../agent-logger'); } catch (e) { _agentLogger = null; }
  }
  return _agentLogger;
}

// ============================================================================
// LOCAL PROCESSES TRACKING
// ============================================================================

/** @type {Map<string, { pid: number, task: object, startedAt: string, process?: object }>} */
const _localProcesses = new Map();

// ============================================================================
// PROVIDER INTERFACE
// ============================================================================

const localProvider = {
  name: 'local',

  /**
   * Spawn an agent process locally.
   *
   * @param {object} task — { id, title, description, labels }
   * @param {object} options — { projectRoot, agentType, budgetUsd, dryRun, logger, adapter, modelId }
   * @returns {{ success: boolean, processId?: string, pid?: number, error?: string }}
   */
  spawn(task, options = {}) {
    const spawner = getProcessSpawner();
    if (!spawner) {
      return { success: false, error: 'process-spawner module not available' };
    }

    const result = spawner.spawnAgent(task, options);
    if (result.success) {
      const processId = `local-${result.pid}`;
      _localProcesses.set(processId, {
        pid: result.pid,
        task,
        startedAt: new Date().toISOString(),
        process: result.process || null,
        worktree: result.worktree,
        logPath: result.logPath,
        contextFile: result.contextFile
      });
      return {
        success: true,
        processId,
        pid: result.pid,
        isResume: result.isResume,
        worktree: result.worktree,
        logPath: result.logPath
      };
    }
    return { success: false, error: result.error };
  },

  /**
   * Kill a local process.
   *
   * @param {string} processId
   * @returns {{ success: boolean, error?: string }}
   */
  kill(processId) {
    const info = _localProcesses.get(processId);
    if (!info) {
      return { success: false, error: `Process ${processId} not found` };
    }

    try {
      process.kill(info.pid, 'SIGTERM');
      _localProcesses.delete(processId);
      return { success: true };
    } catch (e) {
      if (e.code === 'ESRCH') {
        // Process already gone
        _localProcesses.delete(processId);
        return { success: true };
      }
      return { success: false, error: e.message };
    }
  },

  /**
   * Get status of a local process.
   *
   * @param {string} processId
   * @returns {{ running: boolean, pid?: number, task?: object, startedAt?: string }}
   */
  getStatus(processId) {
    const info = _localProcesses.get(processId);
    if (!info) {
      return { running: false };
    }

    // Check if process is still running
    try {
      process.kill(info.pid, 0); // Signal 0 = test existence
      return {
        running: true,
        pid: info.pid,
        task: { id: info.task.id, title: info.task.title },
        startedAt: info.startedAt
      };
    } catch (e) {
      _localProcesses.delete(processId);
      return { running: false, pid: info.pid };
    }
  },

  /**
   * Get logs for a local process.
   *
   * @param {string} processId
   * @param {object} [options] — { lines, follow }
   * @returns {{ success: boolean, logs?: string[], error?: string }}
   */
  getLogs(processId, options = {}) {
    const info = _localProcesses.get(processId);
    if (!info) {
      return { success: false, error: `Process ${processId} not found` };
    }

    const logPath = info.logPath;
    if (!logPath || !fs.existsSync(logPath)) {
      return { success: true, logs: [] };
    }

    try {
      const content = fs.readFileSync(logPath, 'utf8');
      const allLines = content.split('\n');
      const lines = options.lines || 50;
      return { success: true, logs: allLines.slice(-lines) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  /**
   * Local provider is always available.
   *
   * @returns {boolean}
   */
  isAvailable() {
    return true;
  },

  /**
   * Get all tracked local processes (for status reporting).
   *
   * @returns {Array<{ processId: string, pid: number, taskId: string, startedAt: string, running: boolean }>}
   */
  getTrackedProcesses() {
    const result = [];
    for (const [processId, info] of _localProcesses) {
      let running = false;
      try {
        process.kill(info.pid, 0);
        running = true;
      } catch (e) { /* not running */ }
      result.push({
        processId,
        pid: info.pid,
        taskId: info.task.id,
        startedAt: info.startedAt,
        running
      });
    }
    return result;
  },

  /**
   * Clear tracking (for tests).
   */
  clearTracking() {
    _localProcesses.clear();
  }
};

module.exports = localProvider;
