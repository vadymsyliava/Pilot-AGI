/**
 * PM Daemon — persistent cron/watcher for fully autonomous multi-agent orchestration
 *
 * Part of Phase 3.14 (Pilot AGI-sms)
 *
 * Architecture:
 *   pm-daemon.js
 *     ├── PmWatcher (bus.jsonl monitoring)
 *     ├── PmLoop (event processing + periodic scans)
 *     ├── Agent Spawner (headless claude sessions)
 *     └── Task Flow Automator (review + reassign on completion)
 *
 * Startup modes:
 *   --watch   Long-running poll mode (default)
 *   --once    Single tick then exit (for cron)
 *
 * Usage:
 *   node pm-daemon.js --watch
 *   node pm-daemon.js --once
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PmWatcher } = require('./pm-watcher');
const { PmLoop } = require('./pm-loop');
const session = require('./session');
const { loadPolicy } = require('./policy');

// ============================================================================
// CONSTANTS
// ============================================================================

const DAEMON_PID_PATH = '.claude/pilot/state/orchestrator/pm-daemon.pid';
const DAEMON_STATE_PATH = '.claude/pilot/state/orchestrator/pm-daemon-state.json';
const DAEMON_LOG_DIR = '.claude/pilot/logs';
const DAEMON_LOG_FILE = 'pm-daemon.log';
const DEFAULT_TICK_INTERVAL_MS = 30000;  // 30s between ticks
const DEFAULT_MAX_AGENTS = 6;
const SPAWN_COOLDOWN_MS = 10000;         // 10s between spawning new agents
const AGENT_SPAWN_TIMEOUT_MS = 600000;   // 10min max per agent process

// ============================================================================
// PATH HELPERS
// ============================================================================

function resolvePath(projectRoot, relPath) {
  return path.join(projectRoot, relPath);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ============================================================================
// PID FILE MANAGEMENT
// ============================================================================

function writeDaemonPid(projectRoot) {
  const pidPath = resolvePath(projectRoot, DAEMON_PID_PATH);
  ensureDir(path.dirname(pidPath));
  fs.writeFileSync(pidPath, JSON.stringify({
    pid: process.pid,
    started_at: new Date().toISOString(),
    project_root: projectRoot
  }));
}

function removeDaemonPid(projectRoot) {
  const pidPath = resolvePath(projectRoot, DAEMON_PID_PATH);
  try {
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
  } catch (e) { /* best effort */ }
}

function readDaemonPid(projectRoot) {
  const pidPath = resolvePath(projectRoot, DAEMON_PID_PATH);
  try {
    if (fs.existsSync(pidPath)) {
      return JSON.parse(fs.readFileSync(pidPath, 'utf8'));
    }
  } catch (e) { /* corrupt */ }
  return null;
}

function isDaemonRunning(projectRoot) {
  const pidInfo = readDaemonPid(projectRoot);
  if (!pidInfo || !pidInfo.pid) return false;

  try {
    process.kill(pidInfo.pid, 0);
    return true;
  } catch (e) {
    removeDaemonPid(projectRoot);
    return false;
  }
}

// ============================================================================
// STRUCTURED LOGGING
// ============================================================================

function createLogger(projectRoot) {
  const logDir = resolvePath(projectRoot, DAEMON_LOG_DIR);
  ensureDir(logDir);
  const logPath = path.join(logDir, DAEMON_LOG_FILE);

  return {
    _write(level, msg, data) {
      const entry = {
        ts: new Date().toISOString(),
        level,
        msg,
        ...data
      };
      try {
        fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
      } catch (e) { /* best effort */ }
    },
    info(msg, data = {}) { this._write('info', msg, data); },
    warn(msg, data = {}) { this._write('warn', msg, data); },
    error(msg, data = {}) { this._write('error', msg, data); },
    debug(msg, data = {}) { this._write('debug', msg, data); },
    getLogPath() { return logPath; }
  };
}

// ============================================================================
// DAEMON STATE
// ============================================================================

function loadDaemonState(projectRoot) {
  const statePath = resolvePath(projectRoot, DAEMON_STATE_PATH);
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
  } catch (e) { /* corrupt */ }
  return null;
}

function saveDaemonState(projectRoot, state) {
  const statePath = resolvePath(projectRoot, DAEMON_STATE_PATH);
  ensureDir(path.dirname(statePath));
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}

// ============================================================================
// PM DAEMON CLASS
// ============================================================================

class PmDaemon {
  constructor(projectRoot, opts = {}) {
    this.projectRoot = projectRoot;
    this.opts = {
      tickIntervalMs: opts.tickIntervalMs || DEFAULT_TICK_INTERVAL_MS,
      maxAgents: opts.maxAgents || DEFAULT_MAX_AGENTS,
      spawnCooldownMs: opts.spawnCooldownMs || SPAWN_COOLDOWN_MS,
      once: opts.once || false,
      dryRun: opts.dryRun || false,
      ...opts
    };

    this.log = opts.logger || createLogger(projectRoot);
    this.running = false;
    this.pmSessionId = null;
    this.watcher = null;
    this.loop = null;
    this.tickTimer = null;
    this.lastSpawnTime = 0;
    this.spawnedAgents = new Map();  // pid -> { taskId, spawnedAt, process }
    this.tickCount = 0;
    this.shuttingDown = false;

    this.state = {
      started_at: null,
      ticks: 0,
      events_processed: 0,
      agents_spawned: 0,
      tasks_auto_reviewed: 0,
      tasks_auto_closed: 0,
      errors: 0,
      last_tick_at: null,
      last_error: null
    };
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /**
   * Start the daemon.
   * @returns {{ success: boolean, error?: string }}
   */
  start() {
    if (this.running) return { success: false, error: 'Already running' };

    // Single-instance enforcement
    if (isDaemonRunning(this.projectRoot)) {
      const existing = readDaemonPid(this.projectRoot);
      return {
        success: false,
        error: `Another PM daemon is already running (PID: ${existing?.pid})`
      };
    }

    this.running = true;
    this.shuttingDown = false;
    this.state.started_at = new Date().toISOString();

    // Write PID file
    writeDaemonPid(this.projectRoot);

    // Create PM session
    this.pmSessionId = session.generateSessionId();
    this.log.info('PM Daemon starting', {
      pid: process.pid,
      pm_session: this.pmSessionId,
      mode: this.opts.once ? 'once' : 'watch',
      tick_interval_ms: this.opts.tickIntervalMs,
      max_agents: this.opts.maxAgents
    });

    // Initialize PmLoop
    this.loop = new PmLoop(this.projectRoot, {
      pmSessionId: this.pmSessionId,
      dryRun: this.opts.dryRun
    });
    this.loop.initialize(this.pmSessionId);

    // Initialize PmWatcher
    this.watcher = new PmWatcher(this.projectRoot, {
      pollIntervalMs: Math.min(this.opts.tickIntervalMs, 2000)
    });

    // Wire watcher events to loop
    this.watcher.on('bus_event', ({ event, classification }) => {
      try {
        const results = this.loop.processEvents([{ event, classification }]);
        this.state.events_processed += results.length;

        for (const result of results) {
          this.log.debug('Event processed', {
            action: result.action,
            event_id: result.event_id
          });

          // Handle task completion for auto-review
          if (classification.action === 'assign_next') {
            this._onTaskCompleted(event);
          }
        }
      } catch (e) {
        this.state.errors++;
        this.state.last_error = e.message;
        this.log.error('Event processing error', { error: e.message });
      }
    });

    this.watcher.on('error', (err) => {
      this.state.errors++;
      this.log.error('Watcher error', { error: err.message });
    });

    if (this.opts.once) {
      // Single tick mode — no watcher needed, just run one tick and stop
      this._tick();
      this.stop('once_complete');
      return { success: true, mode: 'once', pm_session: this.pmSessionId };
    }

    // Start watcher (watch mode only)
    try {
      this.watcher.start();
    } catch (e) {
      this.log.warn('Watcher start failed, continuing with tick-only mode', {
        error: e.message
      });
    }

    // Register signal handlers (only when running as standalone process)
    if (!this.opts.skipSignalHandlers) {
      this._registerSignalHandlers();
    }

    // Start tick timer for periodic work
    this.tickTimer = setInterval(() => {
      this._tick();
    }, this.opts.tickIntervalMs);

    // Run first tick immediately
    this._tick();

    return { success: true, mode: 'watch', pm_session: this.pmSessionId };
  }

  /**
   * Stop the daemon gracefully.
   * @param {string} reason
   */
  stop(reason = 'manual') {
    if (!this.running) return;
    if (this.shuttingDown) return;

    this.shuttingDown = true;
    this.running = false;

    this.log.info('PM Daemon stopping', { reason, ticks: this.tickCount });

    // Stop tick timer
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    // Stop watcher
    if (this.watcher) {
      try { this.watcher.stop(reason); } catch (e) { /* best effort */ }
      this.watcher = null;
    }

    // Stop loop
    if (this.loop) {
      try { this.loop.stop(reason); } catch (e) { /* best effort */ }
      this.loop = null;
    }

    // Save final state
    this.state.stopped_at = new Date().toISOString();
    this.state.stop_reason = reason;
    saveDaemonState(this.projectRoot, this.state);

    // Remove PID file
    removeDaemonPid(this.projectRoot);

    this.log.info('PM Daemon stopped', {
      reason,
      ticks: this.tickCount,
      events_processed: this.state.events_processed,
      agents_spawned: this.state.agents_spawned
    });
  }

  // ==========================================================================
  // TICK — periodic work
  // ==========================================================================

  /**
   * Run a single daemon tick.
   * Executes periodic scans and agent lifecycle management.
   */
  _tick() {
    if (!this.running) return;

    this.tickCount++;
    this.state.ticks = this.tickCount;
    this.state.last_tick_at = new Date().toISOString();

    try {
      // 1. Run PmLoop periodic scans (health, task, drift, pressure, cost, recovery)
      const scanResults = this.loop.runPeriodicScans();
      if (scanResults.length > 0) {
        this.log.debug('Periodic scan results', { count: scanResults.length });
      }

      // 2. Check for idle agents that need work
      this._manageAgentLifecycle();

      // 3. Clean up finished agent processes
      this._reapDeadAgents();

      // 4. Persist state
      saveDaemonState(this.projectRoot, this.state);
    } catch (e) {
      this.state.errors++;
      this.state.last_error = e.message;
      this.log.error('Tick error', { tick: this.tickCount, error: e.message });
    }
  }

  // ==========================================================================
  // AGENT LIFECYCLE MANAGEMENT
  // ==========================================================================

  /**
   * Check if we should spawn new agents based on available work and capacity.
   */
  _manageAgentLifecycle() {
    const policy = loadPolicy();
    const maxAgents = policy.session?.max_concurrent_sessions || this.opts.maxAgents;

    // Count currently active agent sessions
    const activeSessions = session.getActiveSessions();
    const activeAgentCount = activeSessions.filter(
      s => s.session_id !== this.pmSessionId
    ).length;

    // Count our spawned processes that are still running
    const aliveSpawned = this._countAliveSpawned();

    // Check for ready tasks
    const readyTasks = this._getReadyUnclaimedTasks();
    if (readyTasks.length === 0) return;

    // Check spawn cooldown
    const now = Date.now();
    if (now - this.lastSpawnTime < this.opts.spawnCooldownMs) return;

    // How many slots available?
    const totalActive = Math.max(activeAgentCount, aliveSpawned);
    const slotsAvailable = maxAgents - totalActive - 1; // -1 for PM itself
    if (slotsAvailable <= 0) {
      this.log.debug('No agent slots available', {
        active: totalActive,
        max: maxAgents,
        ready_tasks: readyTasks.length
      });
      return;
    }

    // Spawn agents for ready tasks (one per tick to be safe)
    const tasksToSpawn = Math.min(slotsAvailable, readyTasks.length, 1);

    for (let i = 0; i < tasksToSpawn; i++) {
      const task = readyTasks[i];
      this._spawnAgent(task);
    }
  }

  /**
   * Spawn a headless Claude agent process for a task.
   *
   * @param {object} task - { id, title }
   * @returns {{ success: boolean, pid?: number }}
   */
  _spawnAgent(task) {
    if (this.opts.dryRun) {
      this.log.info('DRY RUN: Would spawn agent', { task_id: task.id, title: task.title });
      return { success: true, dry_run: true };
    }

    // Determine agent type from skill registry
    const agentType = this._resolveAgentType(task);

    // Build spawn command — headless claude session
    const prompt = [
      `You are an autonomous agent spawned by the PM daemon.`,
      `Your assigned task is: ${task.id} — ${task.title || ''}`,
      `Run the full canonical loop: claim the task, plan, execute all steps, commit, and close.`,
      `Use /pilot-next if you need to pick up the task, then /pilot-plan, /pilot-exec, /pilot-commit, /pilot-close.`,
      `Work autonomously — do not ask questions. If blocked, log the issue and move on.`
    ].join('\n');

    const args = ['-p', prompt, '--permission-mode', 'acceptEdits'];

    // Set model from agent registry if available
    if (agentType) {
      args.push('--agent', agentType);
      try {
        const registry = require('./orchestrator').loadSkillRegistry();
        const roleConfig = registry?.roles?.[agentType];
        if (roleConfig?.model) {
          args.push('--model', roleConfig.model);
        }
      } catch (e) { /* use default model */ }
    }

    // Budget limit per agent if configured
    if (this.opts.budgetPerAgentUsd) {
      args.push('--max-budget-usd', String(this.opts.budgetPerAgentUsd));
    }

    try {
      const child = spawn('claude', args, {
        cwd: this.projectRoot,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PILOT_DAEMON_SPAWNED: '1',
          PILOT_TASK_HINT: task.id
        }
      });

      child.unref();

      // Track the spawned process
      this.spawnedAgents.set(child.pid, {
        taskId: task.id,
        taskTitle: task.title,
        agentType: agentType || 'general',
        spawnedAt: new Date().toISOString(),
        process: child,
        exitCode: null
      });

      // Collect stderr for error reporting
      let stderr = '';
      child.stderr.on('data', (data) => {
        stderr += data.toString().slice(0, 2048);
      });

      child.on('exit', (code, signal) => {
        const entry = this.spawnedAgents.get(child.pid);
        if (entry) {
          entry.exitCode = code;
          entry.exitSignal = signal;
          entry.exitedAt = new Date().toISOString();
          if (code !== 0) {
            entry.stderr = stderr.slice(0, 500);
          }
        }

        this.log.info('Agent process exited', {
          pid: child.pid,
          task_id: task.id,
          code,
          signal
        });
      });

      this.lastSpawnTime = Date.now();
      this.state.agents_spawned++;

      this.log.info('Agent spawned', {
        pid: child.pid,
        task_id: task.id,
        title: task.title,
        agent_type: agentType || 'general'
      });

      return { success: true, pid: child.pid };
    } catch (e) {
      this.log.error('Agent spawn failed', {
        task_id: task.id,
        error: e.message
      });
      return { success: false, error: e.message };
    }
  }

  /**
   * Determine the best agent type for a task based on skill registry.
   *
   * @param {object} task
   * @returns {string|null} Agent type name or null for general
   */
  _resolveAgentType(task) {
    try {
      const orchestrator = require('./orchestrator');
      const registry = orchestrator.loadSkillRegistry();
      if (!registry || !registry.roles) return null;

      // Score each role
      let bestRole = null;
      let bestScore = 0;
      const threshold = registry.scoring?.confidence_threshold || 0.3;

      for (const role of Object.keys(registry.roles)) {
        const score = orchestrator.scoreAgentForTask(role, task, registry);
        if (score > bestScore) {
          bestScore = score;
          bestRole = role;
        }
      }

      return bestScore >= threshold ? bestRole : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get ready tasks that are not claimed by any session.
   *
   * @returns {Array<{ id, title }>}
   */
  _getReadyUnclaimedTasks() {
    try {
      const { execFileSync } = require('child_process');
      const output = execFileSync('bd', ['ready', '--json'], {
        cwd: this.projectRoot,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const tasks = JSON.parse(output);
      if (tasks.length === 0) return [];

      // Filter out tasks already claimed
      const activeSessions = session.getActiveSessions();
      const claimedTaskIds = new Set(
        activeSessions
          .filter(s => s.claimed_task)
          .map(s => s.claimed_task)
      );

      return tasks.filter(t => !claimedTaskIds.has(t.id));
    } catch (e) {
      return [];
    }
  }

  /**
   * Count spawned agent processes that are still alive.
   */
  _countAliveSpawned() {
    let alive = 0;
    for (const [pid, entry] of this.spawnedAgents) {
      if (entry.exitCode === null) {
        // Check if still running
        try {
          process.kill(pid, 0);
          alive++;
        } catch (e) {
          entry.exitCode = -1;
          entry.exitedAt = new Date().toISOString();
        }
      }
    }
    return alive;
  }

  /**
   * Clean up finished agent processes from the tracking map.
   */
  _reapDeadAgents() {
    const now = Date.now();
    const toRemove = [];

    for (const [pid, entry] of this.spawnedAgents) {
      if (entry.exitCode !== null) {
        // Already exited — remove after a short grace period
        const exitTime = entry.exitedAt ? new Date(entry.exitedAt).getTime() : now;
        if (now - exitTime > 30000) {
          toRemove.push(pid);
        }
      } else {
        // Check for timeout
        const spawnTime = new Date(entry.spawnedAt).getTime();
        if (now - spawnTime > AGENT_SPAWN_TIMEOUT_MS) {
          this.log.warn('Agent process timed out, killing', {
            pid,
            task_id: entry.taskId,
            runtime_ms: now - spawnTime
          });

          try { process.kill(pid, 'SIGTERM'); } catch (e) { /* already dead */ }
          entry.exitCode = -2;
          entry.exitedAt = new Date().toISOString();
        }
      }
    }

    for (const pid of toRemove) {
      this.spawnedAgents.delete(pid);
    }
  }

  // ==========================================================================
  // TASK FLOW AUTOMATION
  // ==========================================================================

  /**
   * Handle task completion by an agent.
   * Auto-reviews and either auto-closes or flags for human review.
   *
   * @param {object} event - Bus event
   */
  _onTaskCompleted(event) {
    const taskId = event.payload?.data?.task_id;
    if (!taskId) return;

    this.state.tasks_auto_reviewed++;

    try {
      const orchestrator = require('./orchestrator');
      const review = orchestrator.reviewWork(taskId);

      if (review.approved) {
        this.log.info('Auto-review passed', { task_id: taskId, checks: review.checks });

        // Auto-close the task
        if (!this.opts.dryRun) {
          try {
            const { execFileSync } = require('child_process');
            execFileSync('bd', ['close', taskId], {
              cwd: this.projectRoot,
              encoding: 'utf8',
              timeout: 5000,
              stdio: ['pipe', 'pipe', 'pipe']
            });
            this.state.tasks_auto_closed++;
            this.log.info('Task auto-closed', { task_id: taskId });
          } catch (e) {
            this.log.warn('bd close failed', { task_id: taskId, error: e.message });
          }
        }
      } else {
        this.log.warn('Auto-review failed', {
          task_id: taskId,
          issues: review.issues
        });

        // Queue for human escalation
        this._escalateToHuman({
          type: 'review_failed',
          task_id: taskId,
          issues: review.issues,
          checks: review.checks,
          ts: new Date().toISOString()
        });
      }
    } catch (e) {
      this.log.error('Auto-review error', {
        task_id: taskId,
        error: e.message
      });
    }
  }

  /**
   * Escalate an issue to human review.
   * Writes to human-escalations.jsonl for the user to review.
   *
   * @param {object} escalation
   */
  _escalateToHuman(escalation) {
    const escalationPath = resolvePath(
      this.projectRoot,
      '.claude/pilot/state/orchestrator/human-escalations.jsonl'
    );
    ensureDir(path.dirname(escalationPath));

    try {
      fs.appendFileSync(escalationPath, JSON.stringify(escalation) + '\n');
    } catch (e) {
      this.log.error('Failed to write escalation', { error: e.message });
    }
  }

  // ==========================================================================
  // SIGNAL HANDLING
  // ==========================================================================

  _registerSignalHandlers() {
    const shutdown = (signal) => {
      this.log.info('Received signal', { signal });
      this.stop(signal);
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGHUP', () => shutdown('SIGHUP'));

    process.on('uncaughtException', (err) => {
      this.log.error('Uncaught exception', { error: err.message, stack: err.stack });
      this.stop('uncaught_exception');
      process.exit(1);
    });
  }

  // ==========================================================================
  // STATUS & DIAGNOSTICS
  // ==========================================================================

  /**
   * Get daemon status summary.
   */
  getStatus() {
    return {
      running: this.running,
      pid: process.pid,
      pm_session: this.pmSessionId,
      mode: this.opts.once ? 'once' : 'watch',
      uptime_ms: this.state.started_at
        ? Date.now() - new Date(this.state.started_at).getTime()
        : 0,
      ...this.state,
      spawned_agents: Array.from(this.spawnedAgents.entries()).map(([pid, e]) => ({
        pid,
        task_id: e.taskId,
        agent_type: e.agentType,
        spawned_at: e.spawnedAt,
        exit_code: e.exitCode,
        exited_at: e.exitedAt
      })),
      watcher: this.watcher ? this.watcher.getStatus() : null,
      loop: this.loop ? this.loop.getStats() : null
    };
  }
}

// ============================================================================
// STANDALONE ENTRY POINT
// ============================================================================

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`PM Daemon — autonomous multi-agent orchestrator

Usage:
  node pm-daemon.js [options]

Options:
  --watch             Long-running poll mode (default)
  --once              Single tick then exit (for cron)
  --agents <N>        Max concurrent agents (default: ${DEFAULT_MAX_AGENTS})
  --budget <USD>      Budget per agent in USD (passed as --max-budget-usd)
  --tick <ms>         Tick interval in ms (default: ${DEFAULT_TICK_INTERVAL_MS})
  --dry-run           Log actions without executing
  --root <path>       Project root (default: cwd)
  --status            Show daemon status and exit
  --stop              Stop running daemon and exit
  -h, --help          Show this help`);
    process.exit(0);
  }

  const once = args.includes('--once');
  const dryRun = args.includes('--dry-run');
  const projectRoot = args.find(a => a.startsWith('--root='))?.split('=')[1]
    || args[args.indexOf('--root') + 1]
    || process.cwd();

  // --status: show daemon status and exit
  if (args.includes('--status')) {
    const state = loadDaemonState(projectRoot);
    const running = isDaemonRunning(projectRoot);
    const pidInfo = readDaemonPid(projectRoot);
    console.log(JSON.stringify({ running, pid: pidInfo?.pid, ...state }, null, 2));
    process.exit(0);
  }

  // --stop: stop running daemon and exit
  if (args.includes('--stop')) {
    const pidInfo = readDaemonPid(projectRoot);
    if (!pidInfo || !isDaemonRunning(projectRoot)) {
      console.log('No PM daemon running.');
      process.exit(0);
    }
    try {
      process.kill(pidInfo.pid, 'SIGTERM');
      console.log(`Sent SIGTERM to PM daemon (PID: ${pidInfo.pid})`);
    } catch (e) {
      console.error(`Failed to stop daemon: ${e.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // Parse optional numeric args
  const maxAgentsIdx = args.indexOf('--agents');
  const maxAgents = maxAgentsIdx >= 0 ? parseInt(args[maxAgentsIdx + 1], 10) : undefined;

  const budgetIdx = args.indexOf('--budget');
  const budgetPerAgentUsd = budgetIdx >= 0 ? parseFloat(args[budgetIdx + 1]) : undefined;

  const tickIdx = args.indexOf('--tick');
  const tickIntervalMs = tickIdx >= 0 ? parseInt(args[tickIdx + 1], 10) : undefined;

  const opts = { once, dryRun };
  if (maxAgents) opts.maxAgents = maxAgents;
  if (budgetPerAgentUsd) opts.budgetPerAgentUsd = budgetPerAgentUsd;
  if (tickIntervalMs) opts.tickIntervalMs = tickIntervalMs;

  const daemon = new PmDaemon(projectRoot, opts);
  const result = daemon.start();

  if (!result.success) {
    console.error(`PM Daemon failed to start: ${result.error}`);
    process.exit(1);
  }

  console.log(`PM Daemon started (PID: ${process.pid}, mode: ${once ? 'once' : 'watch'}, agents: ${maxAgents || DEFAULT_MAX_AGENTS})`);

  if (once) {
    // Exit cleanly after single tick
    process.exit(0);
  } else {
    // Keep process alive for watch mode
    process.stdin.resume();
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  PmDaemon,
  isDaemonRunning,
  readDaemonPid,
  loadDaemonState,
  DAEMON_PID_PATH,
  DAEMON_STATE_PATH,
  DAEMON_LOG_DIR,
  DAEMON_LOG_FILE,
  DEFAULT_TICK_INTERVAL_MS,
  DEFAULT_MAX_AGENTS,
  SPAWN_COOLDOWN_MS
};
