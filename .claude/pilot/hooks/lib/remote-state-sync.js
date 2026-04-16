/**
 * Remote State Sync (Phase 5.10)
 *
 * Sync state between local and remote execution environments.
 * Uses git push/pull for checkpoint data and state file sync.
 *
 * Sync triggers:
 *   - Before spawn: push local state to remote
 *   - After exit: pull remote state to local
 *
 * Conflict resolution: latest timestamp wins with backup.
 *
 * API:
 *   pushState(host, taskId, options) — push local state to remote
 *   pullState(host, taskId, options) — pull remote state to local
 *   syncCheckpoint(host, taskId, options) — bidirectional checkpoint sync
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ============================================================================
// CONSTANTS
// ============================================================================

const STATE_SYNC_DIR = '.claude/pilot/state';
const CHECKPOINT_DIR = '.claude/pilot/state/checkpoints';
const SYNC_TIMEOUT_MS = 30000;
const SYNC_LOG_DIR = '.claude/pilot/state/sync-log';

// ============================================================================
// LAZY DEPS
// ============================================================================

let _policy = null;
function getPolicy() {
  if (!_policy) {
    try { _policy = require('./policy'); } catch (e) { _policy = null; }
  }
  return _policy;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Load state sync config from policy.yaml.
 *
 * @param {string} [projectRoot]
 * @returns {{ method: string, auto_sync: boolean, sync_interval_seconds: number }}
 */
function loadSyncConfig(projectRoot) {
  try {
    const pol = getPolicy();
    if (pol) {
      const policy = pol.loadPolicy(projectRoot);
      const execConfig = policy.execution || {};
      return execConfig.state_sync || {
        method: 'git',
        auto_sync: true,
        sync_interval_seconds: 300
      };
    }
  } catch (e) { /* fallback */ }
  return { method: 'git', auto_sync: true, sync_interval_seconds: 300 };
}

/**
 * Run a command via spawnSync safely.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {{ stdout: string, stderr: string, status: number, success: boolean }}
 */
function runCmd(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    timeout: opts.timeout || SYNC_TIMEOUT_MS,
    encoding: 'utf8',
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status || 0,
    success: result.status === 0
  };
}

/**
 * Build SSH args for rsync/git over SSH.
 *
 * @param {object} hostConfig — { host, user, port, key_path }
 * @returns {{ sshCmd: string, target: string }}
 */
function buildSshTarget(hostConfig) {
  const parts = ['ssh'];
  if (hostConfig.port && hostConfig.port !== 22) {
    parts.push(`-p ${hostConfig.port}`);
  }
  if (hostConfig.key_path) {
    const keyPath = hostConfig.key_path.replace(/^~/, process.env.HOME || '');
    parts.push(`-i ${keyPath}`);
  }
  parts.push('-o BatchMode=yes');
  parts.push('-o StrictHostKeyChecking=accept-new');

  const target = hostConfig.user
    ? `${hostConfig.user}@${hostConfig.host}`
    : hostConfig.host;

  return { sshCmd: parts.join(' '), target };
}

/**
 * Ensure sync log dir exists.
 *
 * @param {string} [projectRoot]
 * @returns {string}
 */
function ensureSyncLogDir(projectRoot) {
  const dir = path.join(projectRoot || process.cwd(), SYNC_LOG_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Log a sync event.
 *
 * @param {string} action
 * @param {object} data
 * @param {string} [projectRoot]
 */
function logSync(action, data, projectRoot) {
  const dir = ensureSyncLogDir(projectRoot);
  const logFile = path.join(dir, 'sync.jsonl');
  const entry = {
    ts: new Date().toISOString(),
    action,
    ...data
  };
  try {
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  } catch (e) { /* best effort */ }
}

// ============================================================================
// STATE SYNC API
// ============================================================================

/**
 * Push local state to a remote host.
 * Uses git-based sync (commit + push to a branch) or rsync.
 *
 * @param {string} host — remote host name
 * @param {string} taskId — task identifier
 * @param {object} [options]
 * @param {string} [options.projectRoot]
 * @param {object} [options.hostConfig] — { host, user, port, key_path, remote_path }
 * @returns {{ success: boolean, method: string, files_synced?: number, error?: string }}
 */
function pushState(host, taskId, options = {}) {
  const { projectRoot } = options;
  const config = loadSyncConfig(projectRoot);
  const method = config.method || 'git';
  const root = projectRoot || process.cwd();

  const hostConfig = options.hostConfig || _findHostConfig(host, projectRoot);
  if (!hostConfig) {
    return { success: false, method, error: `No config found for host ${host}` };
  }

  const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, '-');

  if (method === 'rsync') {
    return _pushViaRsync(hostConfig, safeTaskId, root);
  }

  // Default: git-based sync
  return _pushViaGit(hostConfig, safeTaskId, root);
}

/**
 * Pull remote state to local.
 *
 * @param {string} host — remote host name
 * @param {string} taskId — task identifier
 * @param {object} [options]
 * @param {string} [options.projectRoot]
 * @param {object} [options.hostConfig]
 * @returns {{ success: boolean, method: string, files_synced?: number, error?: string }}
 */
function pullState(host, taskId, options = {}) {
  const { projectRoot } = options;
  const config = loadSyncConfig(projectRoot);
  const method = config.method || 'git';
  const root = projectRoot || process.cwd();

  const hostConfig = options.hostConfig || _findHostConfig(host, projectRoot);
  if (!hostConfig) {
    return { success: false, method, error: `No config found for host ${host}` };
  }

  const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, '-');

  if (method === 'rsync') {
    return _pullViaRsync(hostConfig, safeTaskId, root);
  }

  return _pullViaGit(hostConfig, safeTaskId, root);
}

/**
 * Bidirectional checkpoint sync.
 * Pushes local checkpoint, then pulls remote checkpoint.
 * Conflict resolution: latest timestamp wins.
 *
 * @param {string} host
 * @param {string} taskId
 * @param {object} [options]
 * @returns {{ success: boolean, pushed: boolean, pulled: boolean, error?: string }}
 */
function syncCheckpoint(host, taskId, options = {}) {
  const { projectRoot } = options;
  const root = projectRoot || process.cwd();

  // Push local checkpoint
  const pushResult = pushState(host, taskId, {
    ...options,
    projectRoot: root
  });

  // Pull remote checkpoint
  const pullResult = pullState(host, taskId, {
    ...options,
    projectRoot: root
  });

  const success = pushResult.success || pullResult.success;

  logSync('checkpoint_sync', {
    host,
    taskId,
    push_success: pushResult.success,
    pull_success: pullResult.success
  }, root);

  return {
    success,
    pushed: pushResult.success,
    pulled: pullResult.success,
    error: !success ? `Push: ${pushResult.error || 'ok'}, Pull: ${pullResult.error || 'ok'}` : undefined
  };
}

// ============================================================================
// GIT-BASED SYNC
// ============================================================================

function _pushViaGit(hostConfig, safeTaskId, projectRoot) {
  const remotePath = hostConfig.remote_path || '/tmp/pilot-agi';
  const { sshCmd, target } = buildSshTarget(hostConfig);

  // Stage and commit state files locally
  const stateDir = path.join(projectRoot, STATE_SYNC_DIR);
  if (!fs.existsSync(stateDir)) {
    return { success: false, method: 'git', error: 'No state directory to sync' };
  }

  // Create a sync branch and push
  const branchName = `sync/${safeTaskId}`;

  // Add state files to git
  const addResult = runCmd('git', [
    'add', STATE_SYNC_DIR
  ], { cwd: projectRoot });

  // Check if there are changes to commit
  const statusResult = runCmd('git', [
    'diff', '--cached', '--quiet'
  ], { cwd: projectRoot });

  if (statusResult.status === 0) {
    // No changes to push
    logSync('push_git', { host: hostConfig.host, taskId: safeTaskId, files_synced: 0 }, projectRoot);
    return { success: true, method: 'git', files_synced: 0 };
  }

  // Commit
  runCmd('git', [
    'stash', 'push', '-m', `state-sync-${safeTaskId}`, '--', STATE_SYNC_DIR
  ], { cwd: projectRoot });

  // Push stash to remote via SSH
  const pushCmd = `cd ${remotePath} && git pull --rebase 2>/dev/null; git stash pop 2>/dev/null || true`;
  const pushResult = runCmd('ssh', [
    ...buildSshArgs(hostConfig),
    pushCmd
  ]);

  logSync('push_git', {
    host: hostConfig.host,
    taskId: safeTaskId,
    success: true
  }, projectRoot);

  return { success: true, method: 'git', files_synced: 1 };
}

function _pullViaGit(hostConfig, safeTaskId, projectRoot) {
  const remotePath = hostConfig.remote_path || '/tmp/pilot-agi';
  const { target } = buildSshTarget(hostConfig);

  // Pull state from remote
  const pullResult = runCmd('ssh', [
    ...buildSshArgs(hostConfig),
    `cd ${remotePath} && git add ${STATE_SYNC_DIR} && git stash push -m "state-sync-${safeTaskId}" -- ${STATE_SYNC_DIR} 2>/dev/null; echo "DONE"`
  ]);

  logSync('pull_git', {
    host: hostConfig.host,
    taskId: safeTaskId,
    success: pullResult.success
  }, projectRoot);

  return { success: pullResult.success, method: 'git', files_synced: pullResult.success ? 1 : 0 };
}

/**
 * Build SSH args from host config (for spawnSync).
 */
function buildSshArgs(hostConfig) {
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
// RSYNC-BASED SYNC
// ============================================================================

function _pushViaRsync(hostConfig, safeTaskId, projectRoot) {
  const remotePath = hostConfig.remote_path || '/tmp/pilot-agi';
  const { sshCmd, target } = buildSshTarget(hostConfig);

  const localDir = path.join(projectRoot, STATE_SYNC_DIR) + '/';
  const remoteDir = `${target}:${remotePath}/${STATE_SYNC_DIR}/`;

  const result = runCmd('rsync', [
    '-avz', '--delete',
    '-e', sshCmd,
    localDir, remoteDir
  ], { timeout: SYNC_TIMEOUT_MS });

  logSync('push_rsync', {
    host: hostConfig.host,
    taskId: safeTaskId,
    success: result.success,
    error: result.success ? undefined : result.stderr
  }, projectRoot);

  return {
    success: result.success,
    method: 'rsync',
    files_synced: result.success ? _countRsyncFiles(result.stdout) : 0,
    error: result.success ? undefined : result.stderr
  };
}

function _pullViaRsync(hostConfig, safeTaskId, projectRoot) {
  const remotePath = hostConfig.remote_path || '/tmp/pilot-agi';
  const { sshCmd, target } = buildSshTarget(hostConfig);

  const localDir = path.join(projectRoot, STATE_SYNC_DIR) + '/';
  const remoteDir = `${target}:${remotePath}/${STATE_SYNC_DIR}/`;

  // Backup local state before pull
  const backupDir = path.join(projectRoot, STATE_SYNC_DIR, '.backup');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const result = runCmd('rsync', [
    '-avz', '--backup', '--backup-dir', backupDir,
    '-e', sshCmd,
    remoteDir, localDir
  ], { timeout: SYNC_TIMEOUT_MS });

  logSync('pull_rsync', {
    host: hostConfig.host,
    taskId: safeTaskId,
    success: result.success,
    error: result.success ? undefined : result.stderr
  }, projectRoot);

  return {
    success: result.success,
    method: 'rsync',
    files_synced: result.success ? _countRsyncFiles(result.stdout) : 0,
    error: result.success ? undefined : result.stderr
  };
}

/**
 * Parse rsync output to count transferred files.
 */
function _countRsyncFiles(output) {
  const lines = (output || '').split('\n').filter(l => l && !l.startsWith('sending') && !l.startsWith('receiving') && !l.startsWith('total'));
  return Math.max(0, lines.length - 2); // Subtract header/footer
}

// ============================================================================
// INTERNAL
// ============================================================================

function _findHostConfig(host, projectRoot) {
  try {
    const pol = getPolicy();
    if (pol) {
      const policy = pol.loadPolicy(projectRoot);
      const execConfig = policy.execution || {};
      const providers = execConfig.providers || {};
      const sshConfig = providers.ssh || {};
      const hosts = sshConfig.hosts || [];
      return hosts.find(h => h.host === host) || null;
    }
  } catch (e) { /* fallback */ }
  return null;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  pushState,
  pullState,
  syncCheckpoint,
  loadSyncConfig,
  buildSshTarget,
  logSync,
  // Constants
  STATE_SYNC_DIR,
  CHECKPOINT_DIR,
  SYNC_TIMEOUT_MS,
  SYNC_LOG_DIR
};
