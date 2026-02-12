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
const { spawn, execFile: execFileCb } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFileCb);

// Async bd command helper — avoids blocking event loop
async function bdAsync(args, projectRoot, timeout = 15000) {
  const { stdout } = await execFileAsync('bd', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout
  });
  return stdout;
}

// Timeout wrapper for promises
function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ]);
}
const { PmWatcher } = require('./pm-watcher');
const { PmLoop } = require('./pm-loop');
const session = require('./session');
const { loadPolicy } = require('./policy');
const pmDecisions = require('./pm-decisions');
const agentLogger = require('./agent-logger');
const processSpawner = require('./process-spawner');
const taskHandoff = require('./task-handoff');
const respawnTracker = require('./respawn-tracker');
const artifactRegistry = require('./artifact-registry');
const overnightMode = require('./overnight-mode');

// Phase 6.4: Lazy dep for terminal controller
let _TerminalController = null;
function getTerminalController() {
  if (!_TerminalController) {
    try { _TerminalController = require('./terminal-controller').TerminalController; } catch (e) { _TerminalController = null; }
  }
  return _TerminalController;
}

// Phase 5.0: Lazy deps for PM Hub + Brain
let _PmHub = null;
let _PmBrain = null;

function getPmHub() {
  if (!_PmHub) {
    try { _PmHub = require('./pm-hub').PmHub; } catch (e) { _PmHub = null; }
  }
  return _PmHub;
}

function getPmBrain() {
  if (!_PmBrain) {
    try { _PmBrain = require('./pm-brain').PmBrain; } catch (e) { _PmBrain = null; }
  }
  return _PmBrain;
}

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
    this.terminalController = null;  // Phase 6.4: Terminal controller instance
    this.tickCount = 0;
    this.shuttingDown = false;
    this._tickInProgress = false;    // Guard against overlapping async ticks
    this.lastTerminalScan = 0;       // Phase 6.4: Terminal scan timestamp
    this.lastScaleCheck = 0;         // Phase 6.4: Scale check timestamp

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

    // Phase 5.0: Initialize PM Brain + Hub
    try {
      const BrainClass = getPmBrain();
      if (BrainClass) {
        this.brain = new BrainClass(this.projectRoot);
        this.log.info('PM Brain initialized');
      }
    } catch (e) {
      this.log.warn('PM Brain init failed, continuing without', { error: e.message });
    }

    try {
      const HubClass = getPmHub();
      if (HubClass) {
        // Port from policy.yaml > opts > default
        let hubPort = this.opts.hubPort || 3847;
        try {
          const policy = loadPolicy(this.projectRoot);
          if (policy.pm_hub && policy.pm_hub.port) {
            hubPort = policy.pm_hub.port;
          }
        } catch (e) { /* use default */ }

        this.hub = new HubClass(this.projectRoot, {
          port: hubPort,
          brain: this.brain || null
        });

        // Wire up hub events
        this.hub.on('agent_registered', (sessionId, data) => {
          this.log.info('Agent registered via hub', { sessionId, role: data.role });
        });

        this.hub.on('agent_disconnected', (sessionId) => {
          this.log.info('Agent disconnected (WS close)', { sessionId });
          // Instant crash detection — check if agent had a claimed task
          const agentInfo = this.hub.agents.get(sessionId);
          if (agentInfo && agentInfo.taskId) {
            this.log.warn('Agent disconnected with active task', {
              sessionId,
              taskId: agentInfo.taskId
            });
            // Trigger recovery scan immediately
            if (this.loop && typeof this.loop._recoveryScan === 'function') {
              try { this.loop._recoveryScan(); } catch (e) { /* best effort */ }
            }
          }
        });

        this.hub.on('agent_heartbeat', (sessionId, data) => {
          // Real-time health update — logged at debug level
          this.log.debug('Agent heartbeat via hub', {
            sessionId,
            pressure: data.pressure,
            taskId: data.taskId
          });
        });

        this.hub.on('task_complete', (sessionId, taskId, result) => {
          this.log.info('Task completed via hub', { sessionId, taskId });
          this._onTaskCompleted({ task_id: taskId, session_id: sessionId });
        });

        this.hub.on('task_claimed', (sessionId, taskId) => {
          this.log.info('Task claimed via hub', { sessionId, taskId });
        });

        this.hub.on('report', (sessionId, data) => {
          this.log.info('Agent report via hub', { sessionId, type: data.type || 'unknown' });
        });

        this.hub.on('agent_reaped', (sessionId) => {
          this.log.info('Stale agent reaped from hub', { sessionId });
        });

        this.hub.start().then((hubResult) => {
          if (hubResult.success) {
            this.log.info('PM Hub started', { port: hubResult.port });
          } else {
            this.log.warn('PM Hub start failed', { error: hubResult.error });
          }
        }).catch((e) => {
          this.log.warn('PM Hub start error', { error: e.message });
        });
      }
    } catch (e) {
      this.log.warn('PM Hub init failed, continuing without', { error: e.message });
    }

    // Phase 6.4: Initialize terminal controller if enabled
    try {
      const policy = loadPolicy(this.projectRoot);
      const termPolicy = policy.terminal_orchestration;
      if (termPolicy && termPolicy.enabled) {
        const TC = getTerminalController();
        if (TC) {
          this.terminalController = new TC({
            policy: termPolicy,
            logger: this.log
          });
          this.terminalController.start().then((result) => {
            this.log.info('Terminal controller started', { provider: result.provider });
          }).catch((e) => {
            this.log.warn('Terminal controller start failed, continuing without', { error: e.message });
            this.terminalController = null;
          });
        }
      }
    } catch (e) {
      this.log.debug('Terminal orchestration not configured', { error: e.message });
    }

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

    // Wire watcher events to loop (async handler for non-blocking processing)
    this.watcher.on('bus_event', ({ event, classification }) => {
      this.loop.processEvents([{ event, classification }]).then(results => {
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
      }).catch(e => {
        this.state.errors++;
        this.state.last_error = e.message;
        this.log.error('Event processing error', { error: e.message });
      });
    });

    this.watcher.on('error', (err) => {
      this.state.errors++;
      this.log.error('Watcher error', { error: err.message });
    });

    if (this.opts.once) {
      // Single tick mode — no watcher needed, just run one tick and stop
      // Note: _tick is now async; for --once mode we fire-and-forget
      // and stop when the tick completes
      this._tick().then(() => {
        this.stop('once_complete');
      }).catch(e => {
        this.log.error('Once tick error', { error: e.message });
        this.stop('once_error');
      });
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

    // Start tick timer for periodic work (async ticks don't block event loop)
    this.tickTimer = setInterval(() => {
      this._tick().catch(e => {
        this.state.errors++;
        this.log.error('Async tick error', { error: e.message });
      });
    }, this.opts.tickIntervalMs);

    // Run first tick immediately
    this._tick().catch(e => {
      this.state.errors++;
      this.log.error('First tick error', { error: e.message });
    });

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

    // Phase 6.4: Stop terminal controller
    if (this.terminalController) {
      try { this.terminalController.stop(); } catch (e) { /* best effort */ }
      this.terminalController = null;
    }

    // Phase 5.0: Stop hub + clear brain
    if (this.hub) {
      try { this.hub.stop(); } catch (e) { /* best effort */ }
      this.hub = null;
    }
    if (this.brain) {
      try { this.brain.clearAllThreads(); } catch (e) { /* best effort */ }
      this.brain = null;
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
   * Run a single daemon tick (async to avoid blocking event loop).
   * Executes periodic scans and agent lifecycle management.
   * Uses _tickInProgress guard to prevent overlapping ticks.
   */
  async _tick() {
    if (!this.running) return;
    if (this._tickInProgress) return; // Prevent overlapping async ticks
    this._tickInProgress = true;

    this.tickCount++;
    this.state.ticks = this.tickCount;
    this.state.last_tick_at = new Date().toISOString();

    try {
      // 1. Run PmLoop periodic scans (health, task, drift, pressure, cost, recovery)
      const scanResults = await this.loop.runPeriodicScans();
      if (scanResults.length > 0) {
        this.log.debug('Periodic scan results', { count: scanResults.length });
      }

      // 2. Check for idle agents that need work
      await this._manageAgentLifecycle();

      // 3. Clean up finished agent processes
      this._reapDeadAgents();

      // 4. Phase 6.4: Terminal scan loop (ground truth, stall detection, auto-approve)
      await this._terminalScanLoop();

      // 5. Persist state
      saveDaemonState(this.projectRoot, this.state);
    } catch (e) {
      this.state.errors++;
      this.state.last_error = e.message;
      this.log.error('Tick error', { tick: this.tickCount, error: e.message });
    } finally {
      this._tickInProgress = false;
    }
  }

  // ==========================================================================
  // AGENT LIFECYCLE MANAGEMENT
  // ==========================================================================

  /**
   * Check if we should spawn new agents based on available work and capacity.
   */
  async _manageAgentLifecycle() {
    const policy = loadPolicy();
    const maxAgents = policy.session?.max_concurrent_sessions || this.opts.maxAgents;

    // Phase 4.8: Respect drain mode — don't spawn new agents
    if (overnightMode.isDraining(this.projectRoot)) {
      const aliveSpawned = this._countAliveSpawned();
      if (aliveSpawned === 0) {
        // All agents finished — end overnight run
        const run = overnightMode.getActiveRun(this.projectRoot);
        if (run) {
          overnightMode.endRun(this.projectRoot, run.run_id);
          this.log.info('Overnight run completed (drain mode, all agents finished)', {
            run_id: run.run_id
          });
        }
      } else if (overnightMode.isDrainTimedOut(this.projectRoot)) {
        this.log.warn('Drain timeout reached, agents still running', { alive: aliveSpawned });
      }
      return;
    }

    // Count currently active agent sessions
    const activeSessions = session.getActiveSessions();
    const activeAgentCount = activeSessions.filter(
      s => s.session_id !== this.pmSessionId
    ).length;

    // Count our spawned processes that are still running
    const aliveSpawned = this._countAliveSpawned();

    // Check for ready tasks
    let readyTasks = await this._getReadyUnclaimedTasks();
    if (readyTasks.length === 0) return;

    // Phase 4.8: Filter out tasks that exceeded error budget
    readyTasks = readyTasks.filter(task => {
      const check = overnightMode.checkErrorBudget(task.id, this.projectRoot);
      if (check.exceeded) {
        this.log.info('Skipping over-budget task', { task_id: task.id, reason: check.reason });
        return false;
      }
      return true;
    });
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
    // Phase 4.7: Check artifact dependencies before spawning
    try {
      const blockingArtifacts = artifactRegistry.getBlockingArtifacts(task.id, this.projectRoot);
      if (blockingArtifacts.length > 0) {
        this.log.info('Spawn blocked by missing artifacts', {
          task_id: task.id,
          blocking: blockingArtifacts.map(a => `${a.taskId}:${a.name}`)
        });
        return { success: false, reason: 'artifact_blocked', blocking_artifacts: blockingArtifacts };
      }
    } catch (e) {
      // Don't block spawn on artifact registry errors
      this.log.warn('Artifact check failed, proceeding with spawn', { task_id: task.id, error: e.message });
    }

    // Phase 6.4: Use terminal-based spawning if enabled
    if (this.terminalController && this.terminalController._started) {
      // Fire-and-forget async terminal spawn — track result via registry
      this._spawnAgentViaTerminal(task).catch(e => {
        this.log.error('Terminal spawn failed, falling back to headless', {
          task_id: task.id, error: e.message
        });
        // Fallback to headless spawn on terminal failure
        this._spawnAgentHeadless(task);
      });
      return { success: true, terminal: true };
    }

    return this._spawnAgentHeadless(task);
  }

  /**
   * Spawn a headless Claude agent process for a task (original behavior).
   * Phase 4.2: Uses ProcessSpawner v2 for context-aware spawning.
   *
   * @param {object} task - { id, title, description, labels }
   * @returns {{ success: boolean, pid?: number }}
   */
  _spawnAgentHeadless(task) {
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
   * Async to avoid blocking the event loop with bd commands.
   *
   * @returns {Promise<Array<{ id, title }>>}
   */
  async _getReadyUnclaimedTasks() {
    try {
      const output = await bdAsync(['ready', '--json'], this.projectRoot);
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

      // Phase 4.8: Track errors and successes for overnight error budget
      if (code !== 0 && code !== null) {
        overnightMode.trackError(taskId, {
          type: signal ? 'signal' : 'exit_error',
          message: `Exit code ${code}${signal ? `, signal ${signal}` : ''}`,
          sessionId: agentSessionId
        }, this.projectRoot);
      } else if (code === 0 && !signal) {
        overnightMode.recordTaskStarted(taskId, this.projectRoot);
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

    // Get task info for respawn (async to avoid blocking)
    this.log.info('Respawning agent for checkpoint-resume', {
      task_id: taskId,
      respawn_count: check.respawn_count + 1,
      max: check.max
    });

    bdAsync(['show', taskId, '--json'], this.projectRoot).then(output => {
      const task = JSON.parse(output);
      this._spawnAgent(task);
    }).catch(() => {
      // Use minimal task info on failure
      this._spawnAgent({ id: taskId, title: taskId });
    });
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

        // Auto-close the task (async to avoid blocking)
        if (!this.opts.dryRun) {
          bdAsync(['close', taskId], this.projectRoot).then(() => {
            this.state.tasks_auto_closed++;
            this.log.info('Task auto-closed', { task_id: taskId });

            // Phase 4.8: Record task completion in overnight run
            overnightMode.recordTaskCompletion(taskId, this.projectRoot);
          }).catch(e => {
            this.log.warn('bd close failed', { task_id: taskId, error: e.message });
          });
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

        // Phase 4.8: Record task failure in overnight run
        overnightMode.recordTaskFailure(taskId, this.projectRoot);
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
  // TERMINAL ORCHESTRATION (Phase 6.4)
  // ==========================================================================

  /**
   * Terminal scan loop: reconcile terminal state, detect stalls,
   * auto-approve permission prompts, and handle dynamic scaling.
   *
   * Runs as part of each daemon tick when terminal orchestration is enabled.
   */
  async _terminalScanLoop() {
    if (!this.terminalController || !this.terminalController._started) return;

    const policy = loadPolicy(this.projectRoot);
    const termPolicy = policy.terminal_orchestration || {};
    const scanInterval = termPolicy.scan_interval_ms || 10000;
    const now = Date.now();

    if (now - this.lastTerminalScan < scanInterval) return;
    this.lastTerminalScan = now;

    try {
      // 1. Sync registry with actual terminal state (with timeout protection)
      try {
        const syncResult = await withTimeout(
          this.terminalController.sync(), 10000, 'terminal sync'
        );
        if (syncResult.updated > 0 || syncResult.removed > 0) {
          this.log.debug('Terminal sync', syncResult);
        }
      } catch (e) {
        this.log.error('Terminal sync error', { error: e.message });
      }

      // 2. Ground truth reconciliation — compare tracked agents with real tabs
      this._reconcileTerminalState();

      // 3. Stall detection and auto-recovery
      await this._detectAndHandleStalls(termPolicy);

      // 4. Auto-approve permission prompts (with timeout protection)
      await this._autoApproveTerminals(termPolicy);

      // 5. Dynamic scaling
      await this._dynamicScaleAgents(termPolicy);

    } catch (e) {
      this.log.error('Terminal scan loop error', { error: e.message });
    }
  }

  /**
   * Ground truth reconciliation: compare internal tracking with actual terminal tabs.
   * Detects missing tabs (crashed) and orphaned tabs (unknown).
   */
  _reconcileTerminalState() {
    const groundTruthTabs = this.terminalController.getAllTabs();
    const groundTruthTabIds = new Set(groundTruthTabs.map(t => t.tabId));

    // Check for agents tracked as terminal-based but whose tab no longer exists
    for (const [pid, entry] of this.spawnedAgents) {
      if (entry.isTerminal && entry.tabId && !groundTruthTabIds.has(entry.tabId)) {
        // Tab disappeared — mark as exited
        if (entry.exitCode === null) {
          this.log.warn('Terminal tab disappeared (likely crashed)', {
            tabId: entry.tabId,
            taskId: entry.taskId
          });
          entry.exitCode = -1;
          entry.exitedAt = new Date().toISOString();

          // Trigger exit handling for recovery
          this._onAgentExit(pid, entry.taskId, -1, 'tab_closed');
        }
      }
    }

    // Check for tabs in registry that we don't track — orphaned tabs
    const trackedTabIds = new Set();
    for (const [, entry] of this.spawnedAgents) {
      if (entry.isTerminal && entry.tabId) {
        trackedTabIds.add(entry.tabId);
      }
    }

    for (const tab of groundTruthTabs) {
      if (!trackedTabIds.has(tab.tabId)) {
        this.log.debug('Orphaned terminal tab (not spawned by this daemon)', {
          tabId: tab.tabId,
          taskId: tab.taskId,
          role: tab.role
        });
      }
    }
  }

  /**
   * Detect stalled terminal tabs and handle recovery (restart or escalate).
   *
   * @param {object} termPolicy - terminal_orchestration policy section
   */
  async _detectAndHandleStalls(termPolicy) {
    const thresholdMs = termPolicy.stall_threshold_ms || 300000;
    const recovery = termPolicy.recovery || {};
    const stalled = this.terminalController.detectStalled(thresholdMs);

    for (const tab of stalled) {
      if (!recovery.enabled) continue;

      const maxRestarts = recovery.max_restarts_per_task || 3;
      const restartCount = respawnTracker.getRespawnCount(tab.taskId, this.projectRoot);

      if (recovery.restart_on_stall && restartCount < maxRestarts) {
        this.log.info('Restarting stalled terminal agent', {
          tabId: tab.tabId,
          taskId: tab.taskId,
          restart_count: restartCount + 1,
          max: maxRestarts
        });

        // Record the restart
        respawnTracker.recordRespawn(tab.taskId, {
          sessionId: null,
          exitReason: 'terminal_stall',
          pressurePct: null
        }, this.projectRoot);

        // Close stalled tab and respawn (async, no blocking bd call)
        try {
          await withTimeout(
            this.terminalController.closeTab(tab.tabId), 10000, 'close stalled tab'
          );

          // Get task info and respawn (async)
          let task = { id: tab.taskId, title: tab.taskId };
          try {
            const output = await bdAsync(['show', tab.taskId, '--json'], this.projectRoot);
            task = JSON.parse(output);
          } catch (e) { /* use minimal task info */ }

          this._spawnAgent(task);
        } catch (e) {
          this.log.error('Failed to restart stalled agent', {
            tabId: tab.tabId, error: e.message
          });
        }
      } else if (recovery.escalate_on_exceed) {
        this.log.warn('Stalled agent exceeded restart limit', {
          taskId: tab.taskId,
          restarts: restartCount,
          max: maxRestarts
        });

        this._escalateToHuman({
          type: 'terminal_stall_limit',
          task_id: tab.taskId,
          restarts: restartCount,
          max_limit: maxRestarts,
          ts: new Date().toISOString()
        });
      }
    }
  }

  /**
   * Auto-approve permission and plan approval prompts in terminal tabs.
   *
   * @param {object} termPolicy - terminal_orchestration policy section
   */
  async _autoApproveTerminals(termPolicy) {
    const autoApprove = termPolicy.auto_approve || {};
    if (!autoApprove.enabled) return;

    for (const tab of this.terminalController.getAllTabs()) {
      if (tab.state === 'plan_approval' && autoApprove.plan_approval) {
        try {
          await withTimeout(
            this.terminalController.autoApprove(tab.tabId), 5000, 'auto-approve plan'
          );
          this.log.info('Auto-approved plan in terminal', {
            tabId: tab.tabId,
            taskId: tab.taskId
          });
        } catch (e) {
          this.log.warn('Auto-approve failed', { tabId: tab.tabId, error: e.message });
        }
      }

      if (tab.state === 'waiting_input' && autoApprove.permission) {
        try {
          await withTimeout(
            this.terminalController.autoApprove(tab.tabId), 5000, 'auto-approve permission'
          );
          this.log.info('Auto-approved permission in terminal', {
            tabId: tab.tabId,
            taskId: tab.taskId
          });
        } catch (e) {
          this.log.warn('Permission auto-approve failed', { tabId: tab.tabId, error: e.message });
        }
      }
    }
  }

  /**
   * Dynamic scaling: adjust number of terminal agents based on queue depth.
   *
   * @param {object} termPolicy - terminal_orchestration policy section
   */
  async _dynamicScaleAgents(termPolicy) {
    const scaling = termPolicy.scaling || {};
    if (!scaling.enabled) return;

    const cooldownMs = scaling.cooldown_ms || 10000;
    const now = Date.now();
    if (now - this.lastScaleCheck < cooldownMs) return;
    this.lastScaleCheck = now;

    const maxAgents = scaling.max_agents || this.opts.maxAgents;
    const minAgents = scaling.min_agents || 1;
    const queueTarget = scaling.queue_depth_target || 3;

    // Count current terminal agents
    const currentTerminalTabs = this.terminalController.getAllTabs()
      .filter(t => t.role !== 'pm');
    const currentCount = currentTerminalTabs.length;

    // Count ready unclaimed tasks
    const readyTasks = await this._getReadyUnclaimedTasks();
    const readyCount = readyTasks.length;

    // Scale up if queue depth exceeds target and we have capacity
    if (readyCount > queueTarget && currentCount < maxAgents) {
      const toSpawn = Math.min(readyCount - queueTarget, maxAgents - currentCount, 1);
      for (let i = 0; i < toSpawn; i++) {
        const task = readyTasks[i];
        if (task) {
          this.log.info('Dynamic scale-up: spawning terminal agent', {
            task_id: task.id,
            current_agents: currentCount,
            ready_tasks: readyCount,
            target_queue: queueTarget
          });
          this._spawnAgent(task);
        }
      }
    }

    // Scale down if we have more agents than min and no ready tasks
    if (readyCount === 0 && currentCount > minAgents) {
      // Don't scale down actively working agents — only idle ones
      const idleTabs = currentTerminalTabs.filter(t => t.state === 'idle' || t.state === 'complete');
      if (idleTabs.length > 0 && currentCount > minAgents) {
        const toClose = Math.min(idleTabs.length, currentCount - minAgents);
        for (let i = 0; i < toClose; i++) {
          this.log.info('Dynamic scale-down: closing idle terminal', {
            tabId: idleTabs[i].tabId,
            taskId: idleTabs[i].taskId
          });
          this.terminalController.closeTab(idleTabs[i].tabId).catch(e => {
            this.log.warn('Scale-down close failed', { error: e.message });
          });
        }
      }
    }
  }

  /**
   * Spawn an agent in a physical terminal tab.
   * Phase 6.10: Supports multi-adapter spawning (Claude, Aider, OpenCode, Ollama, Codex).
   *
   * @param {object} task - Task object { id, title, description, labels }
   * @param {object} [assignment] - Model assignment from scheduler
   * @param {string} [assignment.modelId] - Model ID (e.g., 'gpt-4.5')
   * @param {string} [assignment.adapterId] - Adapter name (e.g., 'aider')
   * @returns {Promise<{success: boolean, tabId?: string}>}
   */
  async _spawnAgentViaTerminal(task, assignment) {
    const agentType = this._resolveAgentType(task);

    // Build command string from process spawner context
    const { buildContextCapsule, buildSpawnPrompt } = require('./spawn-context');
    const capsule = buildContextCapsule(task, {
      projectRoot: this.projectRoot,
      agentType
    });
    const prompt = buildSpawnPrompt(capsule);
    const truncatedPrompt = prompt.length > 16000
      ? prompt.slice(0, 16000) + '\n\n[Context truncated]'
      : prompt;

    // Phase 6.10: Adapter-aware command building
    let command;
    let adapterName = 'claude';
    let isClaudeNative = true;
    const modelId = assignment?.modelId || null;

    if (assignment && (assignment.modelId || assignment.adapterId)) {
      try {
        const { TerminalLayout } = require('../../../../lib/terminal-layout');
        const layout = new TerminalLayout({
          adapterRegistry: this._adapterRegistry || null,
          projectRoot: this.projectRoot,
          logger: this.log
        });

        const result = layout.buildSpawnCommand({
          modelId: assignment.modelId,
          adapterName: assignment.adapterId,
          prompt: truncatedPrompt,
          cwd: this.projectRoot,
          maxTokens: this.opts.budgetPerAgentUsd
            ? Math.round(this.opts.budgetPerAgentUsd * 100000)
            : undefined
        });

        command = result.command;
        adapterName = result.adapterName;
        isClaudeNative = result.isClaudeNative;
      } catch (e) {
        this.log.warn('TerminalLayout unavailable, falling back to claude', { error: e.message });
      }
    }

    // Fallback: Build default claude command
    // Write prompt to file to avoid escaping issues with AppleScript + shell
    if (!command) {
      const promptDir = path.join(this.projectRoot, '.claude/pilot/state/spawn-context');
      if (!fs.existsSync(promptDir)) fs.mkdirSync(promptDir, { recursive: true });
      const promptFile = path.join(promptDir, `${task.id}.prompt`);
      fs.writeFileSync(promptFile, truncatedPrompt, 'utf8');

      const args = ['--agent'];
      if (this.opts.budgetPerAgentUsd) {
        args.push('--max-budget-usd', String(this.opts.budgetPerAgentUsd));
      }
      const escapedPath = promptFile.replace(/'/g, "'\\''");
      command = `claude ${args.join(' ')} -p "$(cat '${escapedPath}')"`;
    }

    // Set up environment
    const env = {
      PILOT_DAEMON_SPAWNED: '1',
      PILOT_TASK_ID: task.id,
      PILOT_AGENT_TYPE: agentType || 'general',
    };

    if (modelId) env.PILOT_MODEL = modelId;
    if (adapterName !== 'claude') env.PILOT_ADAPTER = adapterName;

    // Get respawn count if applicable
    const respawnCount = respawnTracker.getRespawnCount(task.id, this.projectRoot);
    if (respawnCount > 0) {
      env.PILOT_RESPAWN_COUNT = String(respawnCount);
    }

    // Phase 6.10: Format tab title with model name
    let tabTitle = `pilot-${task.id}`;
    if (modelId) {
      try {
        const { TerminalLayout } = require('../../../../lib/terminal-layout');
        const layout = new TerminalLayout({
          adapterRegistry: this._adapterRegistry || null,
          projectRoot: this.projectRoot
        });
        tabTitle = layout.formatTabTitle(modelId, task.id, task.title);
      } catch (e) { /* use default title */ }
    }

    try {
      const tabEntry = await this.terminalController.openTab({
        command,
        taskId: task.id,
        role: agentType || 'agent',
        title: tabTitle,
        cwd: this.projectRoot,
        env
      });

      // Track the terminal agent with a synthetic PID
      const syntheticPid = `tab-${tabEntry.tabId}`;
      this.spawnedAgents.set(syntheticPid, {
        taskId: task.id,
        taskTitle: task.title,
        agentType: agentType || 'general',
        adapterName,
        modelId: modelId || null,
        spawnedAt: new Date().toISOString(),
        process: null,
        isTerminal: true,
        tabId: tabEntry.tabId,
        exitCode: null,
        logPath: null,
        isResume: false,
        worktreePath: null,
        contextFile: null
      });

      this.lastSpawnTime = Date.now();
      this.state.agents_spawned++;

      // Phase 6.10: Start enforcement for non-Claude agents
      if (!isClaudeNative) {
        try {
          const { TerminalLayout } = require('../../../../lib/terminal-layout');
          const layout = new TerminalLayout({
            adapterRegistry: this._adapterRegistry || null,
            projectRoot: this.projectRoot,
            logger: this.log
          });
          layout.startEnforcement({
            taskId: task.id,
            sessionId: syntheticPid,
            adapterName,
            cwd: this.projectRoot
          });
        } catch (e) {
          this.log.warn('Failed to start enforcement for non-Claude agent', {
            adapter: adapterName, error: e.message
          });
        }
      }

      this.log.info('Agent spawned in terminal tab', {
        tabId: tabEntry.tabId,
        task_id: task.id,
        agent_type: agentType || 'general',
        adapter: adapterName,
        model: modelId || 'default'
      });

      return { success: true, tabId: tabEntry.tabId };
    } catch (e) {
      this.log.error('Terminal spawn failed', { task_id: task.id, error: e.message });
      return { success: false, error: e.message };
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
      loop: this.loop ? this.loop.getStats() : null,
      hub: this.hub ? this.hub.getStatus() : null,
      terminal: this.terminalController ? {
        started: this.terminalController._started,
        provider: this.terminalController.activeProvider,
        ...this.terminalController.getTabMetrics()
      } : null
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
  --plan <desc>       Auto-decompose description into tasks, then start watch mode
  --report            Generate morning report for most recent overnight run
  --drain             Enter drain mode (stop spawning, finish active agents)
  -h, --help          Show this help`);
    process.exit(0);
  }

  const once = args.includes('--once');
  const dryRun = args.includes('--dry-run');
  const rootIdx = args.indexOf('--root');
  const projectRoot = args.find(a => a.startsWith('--root='))?.split('=')[1]
    || (rootIdx >= 0 ? args[rootIdx + 1] : null)
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

  // --plan <description>: auto-decompose and queue tasks, then start watch mode
  const planIdx = args.indexOf('--plan');
  if (planIdx >= 0) {
    const description = args[planIdx + 1];
    if (!description) {
      console.error('Usage: --plan <description>');
      process.exit(1);
    }

    const dryRun = args.includes('--dry-run');
    console.log(`Overnight Mode: Decomposing "${description}"...`);

    const result = overnightMode.planAndQueue(description, {
      projectRoot,
      dryRun,
      logger: {
        info: (msg, data) => console.log(`  [INFO] ${msg}`, data ? JSON.stringify(data) : ''),
        warn: (msg, data) => console.log(`  [WARN] ${msg}`, data ? JSON.stringify(data) : ''),
        error: (msg, data) => console.error(`  [ERROR] ${msg}`, data ? JSON.stringify(data) : '')
      }
    });

    if (!result.success) {
      console.error(`Failed: ${result.error}`);
      process.exit(1);
    }

    console.log(`\nOvernight run created:`);
    console.log(`  Run ID:     ${result.runId}`);
    console.log(`  Parent:     ${result.parentTaskId}`);
    console.log(`  Subtasks:   ${result.subtaskCount}`);
    console.log(`  Total:      ${result.taskIds.length} tasks`);

    if (dryRun) {
      console.log('\n[DRY RUN] No tasks created. Exiting.');
      process.exit(0);
    }

    console.log('\nStarting daemon in watch mode...\n');
    // Fall through to daemon start
  }

  // --report: generate morning report
  if (args.includes('--report')) {
    const sinceIdx = args.indexOf('--since');
    const since = sinceIdx >= 0 ? args[sinceIdx + 1] : null;
    const asJson = args.includes('--json');

    const result = overnightMode.generateReport({
      projectRoot,
      since,
      format: asJson ? 'json' : 'both'
    });

    if (!result.success) {
      console.error(`No report available: ${result.error}`);
      process.exit(1);
    }

    if (asJson) {
      console.log(JSON.stringify(result.report, null, 2));
    } else {
      console.log(result.formatted);
    }
    process.exit(0);
  }

  // --drain: enter drain mode
  if (args.includes('--drain')) {
    const result = overnightMode.requestDrain(projectRoot);
    if (!result.success) {
      console.error(`Drain failed: ${result.error}`);
      process.exit(1);
    }
    console.log(`Drain mode activated for run: ${result.runId}`);
    console.log('PM daemon will stop spawning new agents and wait for active ones to finish.');
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
