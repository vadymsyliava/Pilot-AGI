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
const pmDecisions = require('./pm-decisions');
const agentLogger = require('./agent-logger');
const processSpawner = require('./process-spawner');
const taskHandoff = require('./task-handoff');
const respawnTracker = require('./respawn-tracker');

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
        decision_type: data.decision_type || 'mechanical',
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
   * Phase 4.2: Uses ProcessSpawner v2 for context-aware spawning.
   *
   * @param {object} task - { id, title, description, labels }
   * @returns {{ success: boolean, pid?: number }}
   */
  _spawnAgent(task) {
    // Determine agent type from skill registry
    const agentType = this._resolveAgentType(task);

    // Phase 4.2: Use ProcessSpawner v2 for context-aware spawning
    const result = processSpawner.spawnAgent(task, {
      projectRoot: this.projectRoot,
      agentType: agentType || undefined,
      budgetUsd: this.opts.budgetPerAgentUsd,
      dryRun: this.opts.dryRun,
      logger: this.log
    });

    if (!result.success) {
      return result;
    }

    if (this.opts.dryRun) {
      return result;
    }

    const child = result.process;

    // Track the spawned process
    this.spawnedAgents.set(child.pid, {
      taskId: task.id,
      taskTitle: task.title,
      agentType: agentType || 'general',
      spawnedAt: new Date().toISOString(),
      process: child,
      exitCode: null,
      logPath: result.logPath || null,
      isResume: result.isResume || false,
      worktreePath: result.worktree?.path || null,
      contextFile: result.contextFile || null
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

      // Clean up spawn context file
      processSpawner.cleanupContextFile(task.id, this.projectRoot);

      // Phase 4.1: Mark the agent's session as ended
      this._onAgentExit(child.pid, task.id, code, signal);
    });

    this.lastSpawnTime = Date.now();
    this.state.agents_spawned++;

    return { success: true, pid: child.pid };
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
  // SESSION LIFECYCLE (Phase 4.1)
  // ==========================================================================

  /**
   * Handle agent process exit — mark the agent's session as ended,
   * run post-exit validation (Phase 4.6), and handle checkpoint-respawn (Phase 4.3).
   *
   * @param {number} pid - The exited process PID
   * @param {string} taskId - The task the agent was working on
   * @param {number|null} code - Exit code
   * @param {string|null} signal - Signal that killed the process
   */
  _onAgentExit(pid, taskId, code, signal) {
    let agentSessionId = null;

    try {
      const allSessions = session.getAllSessionStates();
      // Find the session owned by this PID (check parent_pid since session hooks
      // store the parent claude PID, which is the PID we spawned)
      const agentSession = allSessions.find(s =>
        s.status === 'active' && (s.parent_pid === pid || s.pid === pid)
      );

      if (agentSession) {
        agentSessionId = agentSession.session_id;
        const reason = signal ? `signal_${signal}` : (code === 0 ? 'completed' : `exit_code_${code}`);
        session.endSession(agentSession.session_id, reason);
        this.log.info('Agent session ended on process exit', {
          session_id: agentSession.session_id,
          pid,
          task_id: taskId,
          reason
        });
      } else {
        // No session found — agent may not have registered yet (very fast exit)
        this.log.warn('No session found for exited agent process', {
          pid,
          task_id: taskId,
          code,
          signal
        });
      }

      // Phase 4.6: Post-exit validation
      try {
        const validation = taskHandoff.postExitValidation(taskId, this.projectRoot);
        if (!validation.valid) {
          this.log.warn('Post-exit validation issues', {
            task_id: taskId,
            issues: validation.issues
          });
        } else {
          this.log.info('Post-exit validation passed', { task_id: taskId });
        }
      } catch (e) {
        this.log.debug('Post-exit validation skipped', {
          task_id: taskId,
          error: e.message
        });
      }

      // Phase 4.3: Checkpoint-Respawn detection
      // If this was a clean exit (code 0) and there's a handoff state with
      // exit_reason "checkpoint_respawn", trigger automatic respawn.
      if (code === 0 && !signal) {
        this._handleCheckpointRespawn(taskId, agentSessionId);
      }
    } catch (e) {
      this.log.error('Failed to end agent session on exit', {
        pid,
        task_id: taskId,
        error: e.message
      });
    }
  }

  /**
   * Phase 4.3: Handle checkpoint-respawn for an agent that exited cleanly.
   * Checks handoff state to determine if this was a checkpoint exit,
   * verifies respawn limits, and spawns a fresh process.
   *
   * @param {string} taskId
   * @param {string|null} exitedSessionId
   */
  _handleCheckpointRespawn(taskId, exitedSessionId) {
    if (!respawnTracker.isRespawnEnabled(this.projectRoot)) return;

    // Check handoff state for checkpoint_respawn reason
    const handoffPath = path.join(
      this.projectRoot,
      taskHandoff.HANDOFF_STATE_DIR,
      taskId.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() + '.json'
    );

    let handoff = null;
    try {
      if (fs.existsSync(handoffPath)) {
        handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
      }
    } catch (e) {
      // No handoff state — not a checkpoint exit
      return;
    }

    if (!handoff || handoff.exit_reason !== 'checkpoint_respawn') {
      return; // Not a checkpoint exit
    }

    this.log.info('Checkpoint-respawn detected', {
      task_id: taskId,
      exited_session: exitedSessionId
    });

    // Check respawn limits
    const check = respawnTracker.canRespawn(taskId, {
      projectRoot: this.projectRoot
    });

    if (!check.allowed) {
      this.log.warn('Respawn limit reached, escalating', {
        task_id: taskId,
        respawn_count: check.respawn_count,
        max: check.max,
        reason: check.reason
      });

      this._escalateToHuman({
        type: 'respawn_limit_reached',
        task_id: taskId,
        respawn_count: check.respawn_count,
        max_limit: check.max,
        reason: check.reason,
        ts: new Date().toISOString()
      });

      return;
    }

    // Record the respawn
    respawnTracker.recordRespawn(taskId, {
      sessionId: exitedSessionId,
      exitReason: 'checkpoint_respawn',
      pressurePct: handoff.checkpoint_version ? null : null
    }, this.projectRoot);

    // Get task info for respawn
    let task = { id: taskId, title: taskId };
    try {
      const { execFileSync } = require('child_process');
      const output = execFileSync('bd', ['show', taskId, '--json'], {
        cwd: this.projectRoot,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      task = JSON.parse(output);
    } catch (e) {
      // Use minimal task info
    }

    this.log.info('Respawning agent for checkpoint-resume', {
      task_id: taskId,
      respawn_count: check.respawn_count + 1,
      max: check.max
    });

    // Spawn fresh agent with resume context
    this._spawnAgent(task);
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
  --status            Show full daemon state as JSON
  --ps                Show process table of spawned agents
  --kill <taskId>     Gracefully stop an agent working on <taskId>
  --tail <taskId>     Stream agent log (delegates to agent-logger)
  --stop              Stop running daemon and exit
  -h, --help          Show this help`);
    process.exit(0);
  }

  const once = args.includes('--once');
  const dryRun = args.includes('--dry-run');
  const projectRoot = args.find(a => a.startsWith('--root='))?.split('=')[1]
    || args[args.indexOf('--root') + 1]
    || process.cwd();

  // --status: show full daemon state (replaces /pilot-pm session need)
  if (args.includes('--status')) {
    const state = loadDaemonState(projectRoot);
    const running = isDaemonRunning(projectRoot);
    const pidInfo = readDaemonPid(projectRoot);

    // Gather active sessions for a complete picture
    let sessions = [];
    try {
      const sessionMod = require('./session');
      sessions = sessionMod.getActiveSessions().map(s => ({
        session_id: s.session_id,
        claimed_task: s.claimed_task || null,
        status: s.status || 'unknown',
        last_heartbeat: s.last_heartbeat || null
      }));
    } catch (e) { /* session module may not be available */ }

    // Read recent action log
    let recentActions = [];
    try {
      const logPath = path.join(projectRoot, '.claude/pilot/state/orchestrator/action-log.jsonl');
      if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
        recentActions = lines.slice(-10).map(l => {
          try { return JSON.parse(l); } catch (e) { return null; }
        }).filter(Boolean);
      }
    } catch (e) { /* best effort */ }

    const fullStatus = {
      running,
      pid: pidInfo?.pid || null,
      started_at: pidInfo?.started_at || state?.started_at || null,
      uptime_ms: running && state?.started_at
        ? Date.now() - new Date(state.started_at).getTime()
        : 0,
      ...state,
      sessions,
      recent_actions: recentActions
    };

    console.log(JSON.stringify(fullStatus, null, 2));
    process.exit(0);
  }

  // --ps: process table of spawned agents
  if (args.includes('--ps')) {
    const asJson = args.includes('--json');
    const state = loadDaemonState(projectRoot);

    // Read session states to find active agents
    let agents = [];
    try {
      const sessionMod = require('./session');
      const sessions = sessionMod.getActiveSessions();
      agents = sessions.map(s => ({
        session_id: s.session_id,
        task_id: s.claimed_task || '-',
        status: s.status || 'unknown',
        last_heartbeat: s.last_heartbeat || null
      }));
    } catch (e) { /* session module may not be available */ }

    if (asJson) {
      console.log(JSON.stringify({ agents, daemon_state: state }, null, 2));
    } else {
      // Table format
      console.log('PID        TASK              STATUS     DURATION');
      console.log('-'.repeat(60));
      for (const a of agents) {
        const duration = a.last_heartbeat
          ? Math.round((Date.now() - new Date(a.last_heartbeat).getTime()) / 1000) + 's ago'
          : '-';
        console.log(
          `${(a.session_id || '-').padEnd(10)} ` +
          `${(a.task_id || '-').padEnd(17)} ` +
          `${(a.status || '-').padEnd(10)} ` +
          `${duration}`
        );
      }
      if (agents.length === 0) {
        console.log('  No active agents.');
      }
    }
    process.exit(0);
  }

  // --kill <taskId>: gracefully stop an agent working on a task
  const killIdx = args.indexOf('--kill');
  if (killIdx >= 0) {
    const taskId = args[killIdx + 1];
    if (!taskId) {
      console.error('Usage: --kill <taskId>');
      process.exit(1);
    }

    // Find the agent session working on this task
    let targetSession = null;
    try {
      const sessionMod = require('./session');
      const sessions = sessionMod.getAllSessionStates();
      targetSession = sessions.find(s => s.claimed_task === taskId);
    } catch (e) { /* session module may not be available */ }

    if (!targetSession) {
      console.error(`No agent found working on task: ${taskId}`);
      process.exit(1);
    }

    // Find PID from session state
    const pid = targetSession.pid;
    if (!pid) {
      console.error(`No PID found for agent on task: ${taskId}`);
      process.exit(1);
    }

    // Graceful kill: SIGTERM first, then SIGKILL after 5s
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Sent SIGTERM to agent (PID: ${pid}, task: ${taskId})`);
      console.log('Waiting 5s for graceful shutdown...');

      // Check if still alive after 5s
      setTimeout(() => {
        try {
          process.kill(pid, 0); // Test if alive
          console.log('Agent still alive, sending SIGKILL...');
          try {
            process.kill(pid, 'SIGKILL');
            console.log('SIGKILL sent.');
          } catch (e2) { /* already dead */ }
        } catch (e2) {
          console.log('Agent exited gracefully.');
        }

        // Release task claim
        try {
          const sessionMod = require('./session');
          sessionMod.releaseTask(targetSession.session_id);
          console.log(`Released task claim for ${taskId}`);
        } catch (e2) { /* best effort */ }

        // Update bd status back to open
        try {
          const { execFileSync: execBd } = require('child_process');
          execBd('bd', ['update', taskId, '--status', 'open'], {
            cwd: projectRoot,
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'pipe']
          });
          console.log(`Reset task ${taskId} status to open`);
        } catch (e2) { /* best effort */ }

        process.exit(0);
      }, 5000);

      // Keep process alive for the timeout
      setTimeout(() => {}, 6000);
    } catch (e) {
      console.error(`Failed to kill agent: ${e.message}`);
      process.exit(1);
    }
    return; // Don't fall through to daemon start
  }

  // --tail <taskId>: stream agent log
  const tailIdx = args.indexOf('--tail');
  if (tailIdx >= 0) {
    const taskId = args[tailIdx + 1];
    if (!taskId) {
      console.error('Usage: --tail <taskId>');
      process.exit(1);
    }

    const logFilePath = agentLogger.getLogPath(projectRoot, taskId);
    if (!fs.existsSync(logFilePath)) {
      console.error(`No agent log found at: ${logFilePath}`);
      console.error('Tip: Agent logs are created when agents are spawned by the PM daemon.');
      process.exit(1);
    }

    // Show last 50 lines of existing content, then stream new lines
    const existing = agentLogger.readLastLines(logFilePath, 50);
    if (existing.length > 0) {
      console.log(existing.join('\n'));
    }

    console.log(`\n--- Tailing ${logFilePath} (Ctrl+C to stop) ---\n`);
    const tailer = agentLogger.tailLog(logFilePath, (line) => {
      console.log(line);
    });

    process.on('SIGINT', () => {
      tailer.stop();
      process.exit(0);
    });

    return; // Don't fall through to daemon start
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
