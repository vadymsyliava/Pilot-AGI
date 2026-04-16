/**
 * Docker Execution Provider (Phase 5.10)
 *
 * Execute agents in Docker containers.
 * Uses `docker` CLI commands via child_process — no dockerode dependency.
 *
 * Config:
 *   { image, volumes, env, network, cpuLimit, memLimit, maxContainers }
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ============================================================================
// CONSTANTS
// ============================================================================

const DOCKER_TIMEOUT_MS = 30000;
const DEFAULT_IMAGE = 'pilot-agi:latest';
const DEFAULT_NETWORK = 'pilot-net';

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
// CONTAINER TRACKING
// ============================================================================

/** @type {Map<string, { containerId: string, task: object, startedAt: string }>} */
const _containers = new Map();

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Load Docker config from policy.yaml.
 *
 * @param {string} [projectRoot]
 * @returns {object}
 */
function loadDockerConfig(projectRoot) {
  try {
    const pol = getPolicy();
    if (pol) {
      const policy = pol.loadPolicy(projectRoot);
      const execConfig = policy.execution || {};
      const providers = execConfig.providers || {};
      return providers.docker || {};
    }
  } catch (e) { /* fallback */ }
  return {};
}

/**
 * Run a docker command safely via spawnSync (no shell injection).
 *
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {{ stdout: string, stderr: string, status: number }}
 */
function dockerExec(args, opts = {}) {
  const result = spawnSync('docker', args, {
    timeout: opts.timeout || DOCKER_TIMEOUT_MS,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status || 0
  };
}

// ============================================================================
// PROVIDER INTERFACE
// ============================================================================

const dockerProvider = {
  name: 'docker',

  /**
   * Spawn an agent in a Docker container.
   *
   * @param {object} task — { id, title, description }
   * @param {object} options — { projectRoot, dockerConfig }
   * @returns {{ success: boolean, processId?: string, containerId?: string, error?: string }}
   */
  spawn(task, options = {}) {
    const { projectRoot } = options;
    const config = options.dockerConfig || loadDockerConfig(projectRoot);

    const image = config.image || DEFAULT_IMAGE;
    const network = config.network || DEFAULT_NETWORK;
    const cpuLimit = config.cpu_limit || '2';
    const memLimit = config.mem_limit || '4g';
    const maxContainers = config.max_containers != null ? config.max_containers : 8;

    if (_containers.size >= maxContainers) {
      return { success: false, error: `Max containers reached (${maxContainers})` };
    }

    const safeTaskId = task.id.replace(/[^a-zA-Z0-9_-]/g, '-');
    const containerName = `pilot-agent-${safeTaskId}-${Date.now()}`;
    const processId = `docker-${containerName}`;

    const args = [
      'run', '-d',
      '--name', containerName,
      '--cpus', cpuLimit,
      '--memory', memLimit
    ];

    if (network) {
      args.push('--network', network);
    }

    if (projectRoot) {
      args.push('-v', `${projectRoot}:/workspace`);
      args.push('-w', '/workspace');
    }

    args.push('-e', `PILOT_TASK_ID=${task.id}`);
    args.push('-e', 'PILOT_DAEMON_SPAWNED=1');

    if (config.env && typeof config.env === 'object') {
      for (const [key, value] of Object.entries(config.env)) {
        args.push('-e', `${key}=${value}`);
      }
    }

    args.push(image);
    args.push('claude', '-p', `Execute task ${task.id}: ${task.title || ''}`, '--permission-mode', 'acceptEdits');

    const result = dockerExec(args);
    if (result.status !== 0) {
      return { success: false, error: `Docker spawn failed: ${result.stderr}` };
    }

    const containerId = result.stdout.trim().slice(0, 12);

    _containers.set(processId, {
      containerId,
      containerName,
      task,
      startedAt: new Date().toISOString()
    });

    return {
      success: true,
      processId,
      containerId,
      containerName
    };
  },

  /**
   * Kill a Docker container.
   *
   * @param {string} processId
   * @returns {{ success: boolean, error?: string }}
   */
  kill(processId) {
    const info = _containers.get(processId);
    if (!info) {
      return { success: false, error: `Container ${processId} not found` };
    }

    dockerExec(['stop', info.containerName]);
    dockerExec(['rm', '-f', info.containerName]);

    _containers.delete(processId);
    return { success: true };
  },

  /**
   * Get status of a Docker container.
   *
   * @param {string} processId
   * @returns {{ running: boolean, containerId?: string, task?: object, startedAt?: string }}
   */
  getStatus(processId) {
    const info = _containers.get(processId);
    if (!info) {
      return { running: false };
    }

    const result = dockerExec(
      ['inspect', '--format', '{{.State.Running}}', info.containerName],
      { timeout: 5000 }
    );
    const running = result.stdout.trim() === 'true';

    if (!running) {
      _containers.delete(processId);
    }

    return {
      running,
      containerId: info.containerId,
      containerName: info.containerName,
      task: { id: info.task.id, title: info.task.title },
      startedAt: info.startedAt
    };
  },

  /**
   * Get logs from a Docker container.
   *
   * @param {string} processId
   * @param {object} [options] — { lines }
   * @returns {{ success: boolean, logs?: string[], error?: string }}
   */
  getLogs(processId, options = {}) {
    const info = _containers.get(processId);
    if (!info) {
      return { success: false, error: `Container ${processId} not found` };
    }

    const lines = options.lines || 50;
    const result = dockerExec(
      ['logs', '--tail', String(lines), info.containerName],
      { timeout: 10000 }
    );

    if (result.status !== 0) {
      return { success: false, error: `Failed to get container logs: ${result.stderr}` };
    }

    return { success: true, logs: result.stdout.split('\n') };
  },

  /**
   * Check if Docker is available.
   *
   * @returns {boolean}
   */
  isAvailable() {
    const result = dockerExec(['info'], { timeout: 5000 });
    return result.status === 0;
  },

  /**
   * Get all tracked containers (for status reporting).
   *
   * @returns {Array<{ processId: string, containerId: string, taskId: string, startedAt: string }>}
   */
  getTrackedContainers() {
    const result = [];
    for (const [processId, info] of _containers) {
      result.push({
        processId,
        containerId: info.containerId,
        containerName: info.containerName,
        taskId: info.task.id,
        startedAt: info.startedAt
      });
    }
    return result;
  },

  /**
   * Clear tracking (for tests).
   */
  clearTracking() {
    _containers.clear();
  }
};

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = dockerProvider;
module.exports.loadDockerConfig = loadDockerConfig;
module.exports.dockerExec = dockerExec;
module.exports.DOCKER_TIMEOUT_MS = DOCKER_TIMEOUT_MS;
module.exports.DEFAULT_IMAGE = DEFAULT_IMAGE;
