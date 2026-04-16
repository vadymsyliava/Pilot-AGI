/**
 * SSH Remote Provider (Phase 5.10)
 *
 * Execute agents on remote machines via SSH.
 * Uses Node.js child_process.spawn with the `ssh` command — no external deps.
 *
 * Config per host:
 *   { host, user, port, keyPath, remotePath, maxAgents }
 *
 * State at: .claude/pilot/state/remote-agents/<host>/
 */

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// ============================================================================
// CONSTANTS
// ============================================================================

const REMOTE_STATE_DIR = '.claude/pilot/state/remote-agents';
const SSH_TIMEOUT_MS = 10000;
const DEFAULT_SSH_PORT = 22;

// ============================================================================
// LAZY DEPS
// ============================================================================

let _policy = null;
function getPolicy() {
  if (!_policy) {
    try { _policy = require('../policy'); } catch (e) { _policy = null; }
  }
  return _policy;
}

// ============================================================================
// REMOTE PROCESS TRACKING
// ============================================================================

/** @type {Map<string, { host: string, remotePid: number, task: object, startedAt: string, sshProcess?: object }>} */
const _remoteProcesses = new Map();

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Load SSH config from policy.yaml.
 *
 * @param {string} [projectRoot]
 * @returns {{ hosts: Array<object> }}
 */
function loadSshConfig(projectRoot) {
  try {
    const pol = getPolicy();
    if (pol) {
      const policy = pol.loadPolicy(projectRoot);
      const execConfig = policy.execution || {};
      const providers = execConfig.providers || {};
      return providers.ssh || { hosts: [] };
    }
  } catch (e) { /* fallback */ }
  return { hosts: [] };
}

/**
 * Build SSH args from host config.
 *
 * @param {object} hostConfig
 * @returns {string[]}
 */
function buildSshArgs(hostConfig) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${Math.round(SSH_TIMEOUT_MS / 1000)}`
  ];
  if (hostConfig.port && hostConfig.port !== DEFAULT_SSH_PORT) {
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

/**
 * Ensure remote state dir exists.
 *
 * @param {string} host
 * @param {string} [projectRoot]
 * @returns {string}
 */
function ensureRemoteStateDir(host, projectRoot) {
  const safeHost = host.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const dir = path.join(projectRoot || process.cwd(), REMOTE_STATE_DIR, safeHost);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Write remote process state.
 *
 * @param {string} processId
 * @param {object} data
 * @param {string} [projectRoot]
 */
function writeRemoteState(processId, data, projectRoot) {
  const host = data.host || 'unknown';
  const dir = ensureRemoteStateDir(host, projectRoot);
  const filePath = path.join(dir, `${processId}.json`);
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

// ============================================================================
// PROVIDER INTERFACE
// ============================================================================

const sshProvider = {
  name: 'ssh',

  /**
   * Spawn an agent on a remote machine via SSH.
   *
   * @param {object} task — { id, title, description }
   * @param {object} options — { projectRoot, hostConfig, agentType }
   * @returns {{ success: boolean, processId?: string, error?: string }}
   */
  spawn(task, options = {}) {
    const { projectRoot } = options;
    const config = loadSshConfig(projectRoot);
    const hosts = config.hosts || [];

    // Select host: prefer specified, else first available with capacity
    let hostConfig = options.hostConfig;
    if (!hostConfig && hosts.length > 0) {
      let minCount = Infinity;
      for (const h of hosts) {
        const count = _countActiveOnHost(h.host);
        const max = h.max_agents || 4;
        if (count < max && count < minCount) {
          minCount = count;
          hostConfig = h;
        }
      }
    }

    if (!hostConfig) {
      return { success: false, error: 'No SSH host available or configured' };
    }

    const remotePath = hostConfig.remote_path || '/tmp/pilot-agi';
    const safeTaskId = task.id.replace(/[^a-zA-Z0-9_-]/g, '-');
    const processId = `ssh-${hostConfig.host}-${safeTaskId}-${Date.now()}`;

    // Build remote command
    const remoteCmd = [
      `cd ${remotePath}`,
      `git pull --rebase 2>/dev/null || true`,
      `claude -p "Execute task ${task.id}: ${(task.title || '').replace(/"/g, '\\"')}" --permission-mode acceptEdits`
    ].join(' && ');

    const sshArgs = buildSshArgs(hostConfig);
    sshArgs.push(remoteCmd);

    try {
      const child = spawn('ssh', sshArgs, {
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      child.unref();

      const info = {
        host: hostConfig.host,
        remotePid: null,
        task,
        startedAt: new Date().toISOString(),
        sshProcess: child,
        localPid: child.pid
      };

      _remoteProcesses.set(processId, info);

      writeRemoteState(processId, {
        host: hostConfig.host,
        taskId: task.id,
        localPid: child.pid,
        startedAt: info.startedAt,
        status: 'running'
      }, projectRoot);

      return {
        success: true,
        processId,
        localPid: child.pid,
        host: hostConfig.host
      };
    } catch (e) {
      return { success: false, error: `SSH spawn failed: ${e.message}` };
    }
  },

  /**
   * Kill a remote agent process.
   *
   * @param {string} processId
   * @returns {{ success: boolean, error?: string }}
   */
  kill(processId) {
    const info = _remoteProcesses.get(processId);
    if (!info) {
      return { success: false, error: `Process ${processId} not found` };
    }

    if (info.sshProcess) {
      try {
        info.sshProcess.kill('SIGTERM');
      } catch (e) { /* may already be gone */ }
    }

    _remoteProcesses.delete(processId);
    return { success: true };
  },

  /**
   * Get status of a remote process.
   *
   * @param {string} processId
   * @returns {{ running: boolean, host?: string, task?: object, startedAt?: string }}
   */
  getStatus(processId) {
    const info = _remoteProcesses.get(processId);
    if (!info) {
      return { running: false };
    }

    if (info.sshProcess) {
      try {
        process.kill(info.sshProcess.pid, 0);
        return {
          running: true,
          host: info.host,
          task: { id: info.task.id, title: info.task.title },
          startedAt: info.startedAt
        };
      } catch (e) {
        _remoteProcesses.delete(processId);
        return { running: false, host: info.host };
      }
    }

    return { running: false, host: info.host };
  },

  /**
   * Get logs from a remote agent via SSH tail.
   *
   * @param {string} processId
   * @param {object} [options] — { lines }
   * @returns {{ success: boolean, logs?: string[], error?: string }}
   */
  getLogs(processId, options = {}) {
    const info = _remoteProcesses.get(processId);
    if (!info) {
      return { success: false, error: `Process ${processId} not found` };
    }

    // Return empty logs for now — remote log streaming handled by remote-log-streamer
    return { success: true, logs: [] };
  },

  /**
   * Check SSH connectivity to at least one configured host.
   *
   * @param {string} [projectRoot]
   * @returns {boolean}
   */
  isAvailable(projectRoot) {
    const config = loadSshConfig(projectRoot);
    const hosts = config.hosts || [];
    if (hosts.length === 0) return false;

    const host = hosts[0];
    try {
      const sshArgs = buildSshArgs(host);
      sshArgs.push('echo ok');
      const output = execSync('ssh ' + sshArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' '), {
        timeout: SSH_TIMEOUT_MS,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return output.trim() === 'ok';
    } catch (e) {
      return false;
    }
  },

  /**
   * Clear tracking (for tests).
   */
  clearTracking() {
    _remoteProcesses.clear();
  }
};

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

function _countActiveOnHost(host) {
  let count = 0;
  for (const [, info] of _remoteProcesses) {
    if (info.host === host) count++;
  }
  return count;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = sshProvider;
module.exports.loadSshConfig = loadSshConfig;
module.exports.buildSshArgs = buildSshArgs;
module.exports.REMOTE_STATE_DIR = REMOTE_STATE_DIR;
module.exports.SSH_TIMEOUT_MS = SSH_TIMEOUT_MS;
