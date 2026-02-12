/**
 * PM Auto-Processing Loop
 *
 * The autonomous brain that processes bus events and takes PM actions.
 * Receives classified events from PmWatcher and executes the appropriate
 * orchestrator functions.
 *
 * Part of Pilot AGI-v1k — Autonomous PM-Executor Loop
 *
 * Loop cycle:
 *   1. Process incoming bus events (from watcher)
 *   2. Health scan — detect stale/dead agents
 *   3. Task scan — find idle agents + ready tasks → assign
 *   4. Drift scan — check active agents for plan drift
 *   5. Queue drain — retry queued actions
 */

const fs = require('fs');
const path = require('path');
const { execFile: execFileCb } = require('child_process');
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
const orchestrator = require('./orchestrator');
const session = require('./session');
const messaging = require('./messaging');
const pmResearch = require('./pm-research');
const decomposition = require('./decomposition');
const pmDecisions = require('./pm-decisions');
const overnightMode = require('./overnight-mode');

// ============================================================================
// CONSTANTS
// ============================================================================

const HEALTH_SCAN_INTERVAL_MS = 30000;    // 30s between health scans
const TASK_SCAN_INTERVAL_MS = 10000;      // 10s between task assignment scans
const DRIFT_SCAN_INTERVAL_MS = 120000;    // 2min between drift scans
const PRESSURE_SCAN_INTERVAL_MS = 60000;  // 60s between pressure scans (Phase 3.5)
const COST_SCAN_INTERVAL_MS = 60000;      // 60s between cost/budget scans (Phase 3.11)
const ESCALATION_SCAN_INTERVAL_MS = 60000; // 60s between escalation scans (Phase 3.12)
const ANALYTICS_SCAN_INTERVAL_MS = 300000; // 5min between analytics aggregation (Phase 3.13)
const PROGRESS_SCAN_INTERVAL_MS = 60000;  // 60s between progress/artifact scans (Phase 4.7)
const OVERNIGHT_SCAN_INTERVAL_MS = 60000; // 60s between overnight run checks (Phase 4.8)
const APPROVAL_SCAN_INTERVAL_MS = 120000; // 2min between approval confidence scans (Phase 5.1)
const TELEGRAM_SCAN_INTERVAL_MS = 10000;  // 10s between telegram inbox scans (Phase 6.6)
const PRESSURE_NUDGE_THRESHOLD_PCT = 70;  // PM nudges agents above this if no auto-checkpoint
const MAX_ACTIONS_PER_CYCLE = 10;         // Prevent runaway action storms
const ACTION_LOG_PATH = '.claude/pilot/state/orchestrator/action-log.jsonl';

// ============================================================================
// PM LOOP CLASS
// ============================================================================

class PmLoop {
  constructor(projectRoot, opts = {}) {
    this.projectRoot = projectRoot;
    this.pmSessionId = opts.pmSessionId || null;
    this.running = false;
    this.actionCount = 0;
    this.lastHealthScan = 0;
    this.lastTaskScan = 0;
    this.lastDriftScan = 0;
    this.lastPressureScan = 0;
    this.lastCostScan = 0;
    this.lastRecoveryScan = 0;
    this.lastEscalationScan = 0;
    this.lastAnalyticsScan = 0;
    this.lastProgressScan = 0;
    this.lastOvernightScan = 0;
    this.lastApprovalScan = 0;
    this.lastTelegramScan = 0;
    this.lastNotificationDigestScan = 0;
    this._telegramConversations = null; // Lazy-initialized in _telegramScan
    this.actionQueue = [];  // Used by pm-queue.js for persistence
    this.opts = {
      healthScanIntervalMs: opts.healthScanIntervalMs || HEALTH_SCAN_INTERVAL_MS,
      taskScanIntervalMs: opts.taskScanIntervalMs || TASK_SCAN_INTERVAL_MS,
      driftScanIntervalMs: opts.driftScanIntervalMs || DRIFT_SCAN_INTERVAL_MS,
      pressureScanIntervalMs: opts.pressureScanIntervalMs || PRESSURE_SCAN_INTERVAL_MS,
      costScanIntervalMs: opts.costScanIntervalMs || COST_SCAN_INTERVAL_MS,
      escalationScanIntervalMs: opts.escalationScanIntervalMs || ESCALATION_SCAN_INTERVAL_MS,
      analyticsScanIntervalMs: opts.analyticsScanIntervalMs || ANALYTICS_SCAN_INTERVAL_MS,
      progressScanIntervalMs: opts.progressScanIntervalMs || PROGRESS_SCAN_INTERVAL_MS,
      overnightScanIntervalMs: opts.overnightScanIntervalMs || OVERNIGHT_SCAN_INTERVAL_MS,
      approvalScanIntervalMs: opts.approvalScanIntervalMs || APPROVAL_SCAN_INTERVAL_MS,
      telegramScanIntervalMs: opts.telegramScanIntervalMs || TELEGRAM_SCAN_INTERVAL_MS,
      maxActionsPerCycle: opts.maxActionsPerCycle || MAX_ACTIONS_PER_CYCLE,
      dryRun: opts.dryRun || false,
      ...opts
    };
  }

  /**
   * Initialize the PM loop with a session ID
   */
  initialize(pmSessionId) {
    this.pmSessionId = pmSessionId;
    this.running = true;

    // Ensure PM state is initialized
    if (!orchestrator.loadPmState()) {
      orchestrator.initializePm(pmSessionId);
    }

    this.logAction('pm_loop_started', { pm_session: pmSessionId });
  }

  /**
   * Process a batch of classified bus events.
   * Called by PmWatcher when new events arrive.
   * Async to support non-blocking bd commands in handlers.
   *
   * @param {Array<{event: object, classification: object}>} classifiedEvents
   * @returns {Promise<Array<{action: string, result: object}>>}
   */
  async processEvents(classifiedEvents) {
    if (!this.running || !this.pmSessionId) return [];

    const results = [];
    let actionsThisCycle = 0;

    for (const { event, classification } of classifiedEvents) {
      if (actionsThisCycle >= this.opts.maxActionsPerCycle) {
        this.logAction('throttled', {
          remaining: classifiedEvents.length - actionsThisCycle,
          reason: 'max_actions_per_cycle'
        });
        break;
      }

      const result = await this._handleEvent(event, classification);
      if (result) {
        results.push(result);
        actionsThisCycle++;
      }
    }

    return results;
  }

  /**
   * Run periodic scans (health, tasks, drift).
   * Should be called on a timer by the watcher.
   * Async to avoid blocking event loop with bd commands.
   */
  async runPeriodicScans() {
    if (!this.running || !this.pmSessionId) return [];

    const now = Date.now();
    const results = [];

    // Health scan
    if (now - this.lastHealthScan >= this.opts.healthScanIntervalMs) {
      this.lastHealthScan = now;
      const healthResults = this._healthScan();
      results.push(...healthResults);
    }

    // Task assignment scan (async — uses bd commands)
    if (now - this.lastTaskScan >= this.opts.taskScanIntervalMs) {
      this.lastTaskScan = now;
      const taskResults = await this._taskScan();
      results.push(...taskResults);
    }

    // Drift scan
    if (now - this.lastDriftScan >= this.opts.driftScanIntervalMs) {
      this.lastDriftScan = now;
      const driftResults = this._driftScan();
      results.push(...driftResults);
    }

    // Pressure scan (Phase 3.5)
    if (now - this.lastPressureScan >= this.opts.pressureScanIntervalMs) {
      this.lastPressureScan = now;
      const pressureResults = this._pressureScan();
      results.push(...pressureResults);
    }

    // Cost/budget scan (Phase 3.11)
    if (now - this.lastCostScan >= this.opts.costScanIntervalMs) {
      this.lastCostScan = now;
      const costResults = this._costScan();
      results.push(...costResults);
    }

    // Recovery scan (Phase 3.8) — runs at health scan interval
    if (now - this.lastRecoveryScan >= this.opts.healthScanIntervalMs) {
      this.lastRecoveryScan = now;
      const recoveryResults = this._recoveryScan();
      results.push(...recoveryResults);
    }

    // Escalation scan (Phase 3.12) — progressive auto-escalation
    if (now - this.lastEscalationScan >= this.opts.escalationScanIntervalMs) {
      this.lastEscalationScan = now;
      const escalationResults = this._escalationScan();
      results.push(...escalationResults);
    }

    // Analytics scan (Phase 3.13) — aggregate performance metrics
    if (now - this.lastAnalyticsScan >= this.opts.analyticsScanIntervalMs) {
      this.lastAnalyticsScan = now;
      const analyticsResults = this._analyticsScan();
      results.push(...analyticsResults);
    }

    // Progress/artifact scan (Phase 4.7) — detect blocked tasks, aggregate progress
    if (now - this.lastProgressScan >= this.opts.progressScanIntervalMs) {
      this.lastProgressScan = now;
      const progressResults = await this._progressScan();
      results.push(...progressResults);
    }

    // Overnight run scan (Phase 4.8) — check error budgets, stop/report if needed
    if (now - this.lastOvernightScan >= this.opts.overnightScanIntervalMs) {
      this.lastOvernightScan = now;
      const overnightResults = this._overnightScan();
      results.push(...overnightResults);
    }

    // Approval confidence scan (Phase 5.1) — check threshold suggestions, log metrics
    if (now - this.lastApprovalScan >= this.opts.approvalScanIntervalMs) {
      this.lastApprovalScan = now;
      const approvalResults = this._approvalScan();
      results.push(...approvalResults);
    }

    // Notification digest flush (Phase 5.9) — batch info-level notifications
    if (now - this.lastNotificationDigestScan >= 60000) { // check every 60s
      this.lastNotificationDigestScan = now;
      const digestResults = this._notificationDigestScan();
      results.push(...digestResults);
    }

    // Telegram inbox scan (Phase 6.6) — process Telegram intents
    if (now - this.lastTelegramScan >= this.opts.telegramScanIntervalMs) {
      this.lastTelegramScan = now;
      const telegramResults = this._telegramScan();
      results.push(...telegramResults);
    }

    return results;
  }

  /**
   * Stop the loop
   */
  stop(reason = 'manual') {
    this.running = false;
    this.logAction('pm_loop_stopped', { reason });
  }

  // ==========================================================================
  // EVENT HANDLERS
  // ==========================================================================

  /**
   * Route a classified event to the appropriate handler (supports async handlers)
   */
  async _handleEvent(event, classification) {
    const handler = this._eventHandlers[classification.action];
    if (!handler) {
      this.logAction('unhandled_event', {
        action: classification.action,
        event_id: event.id,
        topic: event.topic
      });
      return null;
    }

    try {
      const result = await handler.call(this, event, classification);
      this.actionCount++;
      return { action: classification.action, result, event_id: event.id };
    } catch (e) {
      this.logAction('handler_error', {
        action: classification.action,
        event_id: event.id,
        error: e.message
      });
      return { action: classification.action, error: e.message, event_id: event.id };
    }
  }

  _eventHandlers = {
    /**
     * Agent finished a task — find and assign next work
     */
    assign_next: async function(event) {
      const agentSession = event.from;
      const taskId = event.payload?.data?.task_id;

      this.logAction('task_completed_by_agent', {
        agent: agentSession,
        task_id: taskId
      });

      // Phase 4.8: Track completion in overnight run
      if (taskId) {
        try { overnightMode.recordTaskCompletion(taskId, this.projectRoot); } catch (e) { /* best effort */ }
      }

      // Find next ready task (async)
      const readyTask = await this._getNextReadyTask();
      if (!readyTask) {
        this.logAction('no_ready_tasks', { after_completion: taskId });
        return { assigned: false, reason: 'no_ready_tasks' };
      }

      // Phase 3.2: Auto-research before assignment
      let researchContext = null;
      const complexity = pmResearch.classifyTaskComplexity(readyTask);
      if (complexity !== 'S') {
        if (!pmResearch.checkResearchCache(readyTask.id)) {
          try { pmResearch.runAutoResearch(readyTask, this.projectRoot); } catch (e) { /* best effort */ }
        }
        researchContext = pmResearch.buildResearchContext(readyTask.id);
      }

      if (this.opts.dryRun) {
        return { dry_run: true, would_assign: readyTask.id, to: agentSession };
      }

      // Assign the task
      const result = orchestrator.assignTask(
        readyTask.id,
        agentSession,
        this.pmSessionId,
        {
          title: readyTask.title,
          description: readyTask.description,
          reason: 'auto_assigned_after_completion',
          research_context: researchContext
        }
      );

      return { assigned: result.success, task_id: readyTask.id, to: agentSession, researched: !!researchContext };
    },

    /**
     * Track task claims (informational)
     */
    track_claim: function(event) {
      this.logAction('task_claim_tracked', {
        agent: event.from,
        task_id: event.payload?.data?.task_id
      });
      return { tracked: true };
    },

    /**
     * Agent needs help — route to PM terminal
     */
    respond_to_agent: function(event) {
      const agentSession = event.from;
      const topic = event.topic;

      this.logAction('agent_needs_help', {
        agent: agentSession,
        topic,
        payload: event.payload
      });

      // Queue this for PM terminal processing via action queue
      this._queueForPm({
        type: 'agent_assistance',
        agent: agentSession,
        topic,
        message: event.payload?.data || event.payload,
        received_at: new Date().toISOString()
      });

      return { queued_for_pm: true, agent: agentSession, topic };
    },

    /**
     * Agent encountered an error — log and potentially reassign
     */
    handle_error: function(event) {
      const agentSession = event.from;
      const errorData = event.payload?.data || {};

      this.logAction('agent_error', {
        agent: agentSession,
        error_type: errorData.type,
        snippet: (errorData.snippet || '').substring(0, 200)
      });

      // Queue for PM review
      this._queueForPm({
        type: 'agent_error',
        agent: agentSession,
        error: errorData,
        received_at: new Date().toISOString()
      });

      return { logged: true, queued_for_review: true };
    },

    /**
     * Session ended — clean up and potentially reassign the task
     */
    cleanup_session: function(event) {
      const endedSession = event.from;
      const sessionData = event.payload?.data || {};

      this.logAction('session_cleanup', {
        session: endedSession,
        reason: sessionData.reason
      });

      // Check if the ended session had a claimed task
      const allSessions = session.getAllSessionStates();
      const ended = allSessions.find(s => s.session_id === endedSession);

      if (ended?.claimed_task) {
        // The task was abandoned — make it available again
        this.logAction('orphaned_task', {
          task_id: ended.claimed_task,
          from_session: endedSession
        });

        // Release it so other agents can pick it up
        try {
          session.releaseTask(endedSession);
        } catch (e) {
          // Best effort
        }
      }

      return { cleaned: true, orphaned_task: ended?.claimed_task || null };
    },

    /**
     * New agent joined — greet and optionally assign work
     */
    greet_agent: async function(event) {
      const newSession = event.from;

      this.logAction('new_agent', { session: newSession });

      // Check if there's ready work to assign (async)
      const readyTask = await this._getNextReadyTask();
      if (readyTask && !this.opts.dryRun) {
        // Phase 3.2: Auto-research before assignment
        let researchContext = null;
        const complexity = pmResearch.classifyTaskComplexity(readyTask);
        if (complexity !== 'S') {
          if (!pmResearch.checkResearchCache(readyTask.id)) {
            try { pmResearch.runAutoResearch(readyTask, this.projectRoot); } catch (e) { /* best effort */ }
          }
          researchContext = pmResearch.buildResearchContext(readyTask.id);
        }

        // Send a welcome + task assignment
        messaging.sendNotification(
          this.pmSessionId,
          newSession,
          'welcome',
          {
            message: `Welcome! Assigning task: ${readyTask.title}`,
            task_id: readyTask.id
          }
        );

        orchestrator.assignTask(
          readyTask.id,
          newSession,
          this.pmSessionId,
          {
            title: readyTask.title,
            description: readyTask.description,
            reason: 'auto_assigned_on_join',
            research_context: researchContext
          }
        );

        return { greeted: true, assigned: readyTask.id, researched: !!researchContext };
      }

      return { greeted: true, assigned: null };
    },

    /**
     * Merge requested — trigger review
     */
    review_merge: function(event) {
      const taskId = event.payload?.data?.task_id;
      if (!taskId) return { error: 'no_task_id' };

      this.logAction('merge_review_requested', { task_id: taskId });

      if (this.opts.dryRun) {
        return { dry_run: true, would_review: taskId };
      }

      const review = orchestrator.reviewWork(taskId);

      if (review.approved) {
        const mergeResult = orchestrator.approveMerge(taskId, this.pmSessionId);
        return { reviewed: true, approved: true, merged: mergeResult.success };
      } else {
        // Notify agent of issues
        orchestrator.rejectMerge(taskId, this.pmSessionId,
          `Auto-review failed: ${review.issues.join('; ')}`
        );
        return { reviewed: true, approved: false, issues: review.issues };
      }
    },

    /**
     * Track step progress (informational)
     */
    track_progress: function(event) {
      this.logAction('step_progress', {
        agent: event.from,
        commit_msg: event.payload?.data?.commit_msg
      });
      return { tracked: true };
    },

    /**
     * Process health report from agent
     */
    process_health: function(event) {
      this.logAction('health_report', {
        agent: event.from,
        data: event.payload?.data
      });
      return { processed: true };
    },

    /**
     * Log-only events (no action needed)
     */
    log_only: function(event) {
      this.logAction('logged', {
        event_id: event.id,
        type: event.type,
        topic: event.topic
      });
      return { logged: true };
    }
  };

  // ==========================================================================
  // PERIODIC SCANS
  // ==========================================================================

  /**
   * Health scan: detect dead/stale agents and clean up
   */
  _healthScan() {
    const results = [];

    try {
      const staleResults = orchestrator.handleStaleAgents(this.pmSessionId);
      if (staleResults.length > 0) {
        this.logAction('health_scan_findings', { agents: staleResults });
        results.push({ action: 'health_scan', findings: staleResults });
      }
    } catch (e) {
      this.logAction('health_scan_error', { error: e.message });
    }

    return results;
  }

  /**
   * Task scan: find idle agents and assign ready tasks (async for non-blocking bd)
   */
  async _taskScan() {
    const results = [];

    try {
      // Get all ready tasks in one call (async)
      const readyTasks = await this._getAllReadyTasks();
      if (readyTasks.length === 0) return results;

      // Phase 3.2 + 3.3: Pre-process tasks (research + decomposition) before scheduling
      const schedulableTasks = [];
      for (const readyTask of readyTasks) {
        const complexity = pmResearch.classifyTaskComplexity(readyTask);

        // Auto-research non-trivial tasks
        if (complexity !== 'S') {
          const cached = pmResearch.checkResearchCache(readyTask.id);
          if (!cached) {
            try {
              pmResearch.runAutoResearch(readyTask, this.projectRoot);
              this.logAction('auto_research_completed', { task_id: readyTask.id, complexity });
            } catch (e) {
              this.logAction('auto_research_error', { task_id: readyTask.id, error: e.message });
            }
          }
        }

        // Auto-decompose large tasks
        if (complexity === 'L') {
          try {
            const decompResult = decomposition.decomposeTask(readyTask, this.projectRoot);
            if (decompResult.decomposed && decompResult.subtasks.length >= 3) {
              const bdResult = decomposition.createSubtasksInBd(
                readyTask.id, decompResult.subtasks, this.projectRoot
              );
              this.logAction('auto_decomposed', {
                task_id: readyTask.id,
                subtask_count: decompResult.subtasks.length,
                waves: decompResult.dag.waves.length,
                domain: decompResult.domain.domain,
                bd_created: bdResult.created,
                bd_errors: bdResult.errors.length
              });
              results.push({
                action: 'task_decomposed',
                task_id: readyTask.id,
                subtask_count: decompResult.subtasks.length,
                waves: decompResult.dag.waves.length,
                domain: decompResult.domain.domain
              });
              continue; // Subtasks picked up in next scan
            }
          } catch (e) {
            this.logAction('auto_decompose_error', { task_id: readyTask.id, error: e.message });
          }
        }

        schedulableTasks.push(readyTask);
      }

      if (schedulableTasks.length === 0) return results;

      // Phase 3.4: Intelligent batch scheduling
      const schedule = orchestrator.scheduleBatch(schedulableTasks, this.pmSessionId, this.projectRoot);

      for (const assignment of schedule.assignments) {
        const { task, agent, score, breakdown, context } = assignment;

        if (this.opts.dryRun) {
          results.push({
            action: 'task_scan',
            dry_run: true,
            would_assign: task.id,
            to: agent.session_id,
            match_reason: `scheduler: score ${score.toFixed(2)}`,
            confidence: score,
            breakdown,
            researched: !!context?.research
          });
          continue;
        }

        const assignResult = orchestrator.assignTask(
          task.id,
          agent.session_id,
          this.pmSessionId,
          {
            title: task.title,
            description: task.description,
            reason: `scheduler: ${agent.agent_name} (${agent.role}) scored ${score.toFixed(2)}`,
            research_context: context?.research,
            scheduler_context: context
          }
        );

        if (assignResult.success) {
          this.logAction('auto_assigned', {
            task_id: task.id,
            agent: agent.session_id,
            agent_name: agent.agent_name,
            role: agent.role,
            match_reason: `scheduler_score: ${score.toFixed(2)}`,
            confidence: score,
            breakdown,
            researched: !!context?.research
          });
          results.push({
            action: 'task_scan',
            assigned: task.id,
            to: agent.session_id,
            agent_name: agent.agent_name,
            match_reason: `scheduler: ${score.toFixed(2)}`,
            breakdown,
            researched: !!context?.research
          });
        }
      }

      // Log unassigned tasks for visibility
      for (const unassigned of schedule.unassigned_tasks) {
        this.logAction('task_unassigned', {
          task_id: unassigned.task?.id,
          reason: unassigned.reason,
          blocking: unassigned.blocking,
          best_score: unassigned.best_score
        });
      }
    } catch (e) {
      this.logAction('task_scan_error', { error: e.message });
    }

    return results;
  }

  /**
   * Drift scan: check all active agents for plan drift
   */
  _driftScan() {
    const results = [];

    try {
      const health = orchestrator.getAgentHealth();
      const activeWithTasks = health.filter(a =>
        a.status === 'healthy' && a.claimed_task
      );

      for (const agent of activeWithTasks) {
        const drift = orchestrator.detectDrift(agent.session_id);
        if (drift.drifted) {
          this.logAction('drift_detected', {
            agent: agent.session_id,
            task_id: agent.claimed_task,
            score: drift.score,
            unplanned: drift.unplanned
          });

          // Notify the agent
          if (!this.opts.dryRun) {
            messaging.sendNotification(
              this.pmSessionId,
              agent.session_id,
              'drift_alert',
              {
                task_id: agent.claimed_task,
                drift_score: drift.score,
                unplanned_files: drift.unplanned,
                message: `Drift detected (${Math.round(drift.score * 100)}%). Unplanned files: ${drift.unplanned.join(', ')}`
              }
            );
          }

          results.push({
            action: 'drift_scan',
            agent: agent.session_id,
            drifted: true,
            score: drift.score
          });
        }
      }
    } catch (e) {
      this.logAction('drift_scan_error', { error: e.message });
    }

    return results;
  }

  /**
   * Pressure scan (Phase 3.5): check all agents' context pressure.
   * If any agent is above PRESSURE_NUDGE_THRESHOLD_PCT and hasn't
   * auto-checkpointed, send a nudge message via the bus.
   */
  _pressureScan() {
    const results = [];

    try {
      const pressure = require('./pressure');
      const activeSessions = session.getActiveSessions();

      for (const agent of activeSessions) {
        const sid = agent.session_id;
        if (!sid) continue;

        const stats = pressure.getPressure(sid);
        if (stats.pct_estimate >= PRESSURE_NUDGE_THRESHOLD_PCT) {
          // Check if this is the PM itself
          const isPmSelf = sid === this.pmSessionId;

          this.logAction('pressure_alert', {
            agent: sid,
            pct: stats.pct_estimate,
            calls: stats.calls,
            bytes: stats.bytes,
            is_pm: isPmSelf
          });

          if (isPmSelf) {
            // PM self-management: checkpoint own state before compact
            if (!this.opts.dryRun) {
              const cpResult = orchestrator.pmCheckpointSelf(this.pmSessionId);
              this.logAction('pm_self_checkpoint', {
                success: cpResult.success,
                version: cpResult.version
              });
            }

            results.push({
              action: 'pressure_scan',
              agent: sid,
              pressure_pct: stats.pct_estimate,
              pm_self_checkpoint: true
            });
          } else {
            // Send nudge message to the agent
            if (!this.opts.dryRun) {
              messaging.sendNotification(
                this.pmSessionId,
                sid,
                'pressure_alert',
                {
                  pressure_pct: stats.pct_estimate,
                  message: `Context pressure at ${stats.pct_estimate}%. Save checkpoint and compact to avoid context loss.`
                }
              );
            }

            results.push({
              action: 'pressure_scan',
              agent: sid,
              pressure_pct: stats.pct_estimate,
              nudged: !this.opts.dryRun
            });
          }
        }
      }
    } catch (e) {
      this.logAction('pressure_scan_error', { error: e.message });
    }

    return results;
  }

  /**
   * Cost/budget scan (Phase 3.11): check all active agents' token budgets.
   * Sends warnings or escalations when thresholds are approached/exceeded.
   * Also publishes cost data to shared memory channel.
   */
  _costScan() {
    const results = [];

    try {
      const costTracker = require('./cost-tracker');
      const activeSessions = session.getActiveSessions();

      for (const agent of activeSessions) {
        const sid = agent.session_id;
        const taskId = agent.claimed_task;
        if (!sid || !taskId || sid === this.pmSessionId) continue;

        const budget = costTracker.checkBudget(sid, taskId);

        if (budget.status === 'exceeded') {
          this.logAction('cost_exceeded', {
            agent: sid,
            task_id: taskId,
            task_tokens: budget.task_tokens,
            details: budget.details
          });

          if (!this.opts.dryRun) {
            messaging.sendNotification(
              this.pmSessionId,
              sid,
              'cost_exceeded',
              {
                task_id: taskId,
                task_tokens: budget.task_tokens,
                agent_today_tokens: budget.agent_today_tokens,
                details: budget.details,
                message: `Budget exceeded on task ${taskId} (${budget.task_tokens.toLocaleString()} tokens). Consider wrapping up or splitting the task.`
              }
            );
          }

          results.push({
            action: 'cost_scan',
            agent: sid,
            task_id: taskId,
            status: 'exceeded',
            task_tokens: budget.task_tokens
          });
        } else if (budget.status === 'warning') {
          this.logAction('cost_warning', {
            agent: sid,
            task_id: taskId,
            task_tokens: budget.task_tokens,
            details: budget.details
          });

          if (!this.opts.dryRun) {
            messaging.sendNotification(
              this.pmSessionId,
              sid,
              'cost_warning',
              {
                task_id: taskId,
                task_tokens: budget.task_tokens,
                message: `Approaching budget limit on task ${taskId} (${budget.task_tokens.toLocaleString()} tokens).`
              }
            );
          }

          results.push({
            action: 'cost_scan',
            agent: sid,
            task_id: taskId,
            status: 'warning',
            task_tokens: budget.task_tokens
          });
        }
      }

      // Publish cost data to shared memory (best-effort)
      if (!this.opts.dryRun) {
        try { costTracker.publishCostChannel(); } catch (e) { /* best effort */ }
      }
    } catch (e) {
      this.logAction('cost_scan_error', { error: e.message });
    }

    return results;
  }

  /**
   * Recovery scan (Phase 3.8): check for recoverable tasks and delegate
   * them to idle agents with checkpoint context.
   */
  _recoveryScan() {
    const results = [];

    try {
      const recoverableTasks = orchestrator.getRecoverableTasks();
      if (recoverableTasks.length === 0) return results;

      const recovery = require('./recovery');
      const activeSessions = session.getActiveSessions();

      for (const rt of recoverableTasks) {
        // Find an idle agent for this task
        const idleAgent = activeSessions.find(s =>
          !s.claimed_task && s.status === 'active' && s.session_id !== this.pmSessionId
        );

        if (!idleAgent) {
          this.logAction('recovery_no_idle_agent', { task_id: rt.task_id });
          break; // No more idle agents
        }

        // Build checkpoint context for the agent
        let checkpointContext = null;
        try {
          checkpointContext = recovery.recoverFromCheckpoint(rt.checkpoint_session);
        } catch (e) { /* no checkpoint data */ }

        if (this.opts.dryRun) {
          results.push({
            action: 'recovery_scan',
            dry_run: true,
            would_assign: rt.task_id,
            to: idleAgent.session_id,
            has_checkpoint: !!checkpointContext
          });
          continue;
        }

        // Delegate the task with checkpoint context
        try {
          const assignResult = orchestrator.assignTask(
            rt.task_id,
            idleAgent.session_id,
            this.pmSessionId
          );

          if (assignResult.success) {
            // Send checkpoint context as a follow-up message
            if (checkpointContext) {
              messaging.sendMessage({
                from: this.pmSessionId,
                to: idleAgent.session_id,
                type: 'notify',
                topic: 'recovery.checkpoint_context',
                priority: 'normal',
                payload: {
                  task_id: rt.task_id,
                  restoration: checkpointContext.restoration,
                  resume_from_step: checkpointContext.plan_step,
                  total_steps: checkpointContext.total_steps
                }
              });
            }

            // Remove from recoverable queue
            orchestrator.removeRecoverableTask(rt.task_id);

            this.logAction('recovery_task_assigned', {
              task_id: rt.task_id,
              assigned_to: idleAgent.session_id,
              has_checkpoint: !!checkpointContext,
              resume_step: checkpointContext?.plan_step
            });

            results.push({
              action: 'recovery_scan',
              task_id: rt.task_id,
              assigned_to: idleAgent.session_id,
              has_checkpoint: !!checkpointContext
            });
          }
        } catch (e) {
          this.logAction('recovery_assign_error', {
            task_id: rt.task_id,
            error: e.message
          });
        }
      }
    } catch (e) {
      this.logAction('recovery_scan_error', { error: e.message });
    }

    return results;
  }

  // ==========================================================================
  // ESCALATION SCAN (Phase 3.12)
  // ==========================================================================

  /**
   * Escalation scan: check active agents for conditions that warrant
   * progressive escalation (drift, test failure, budget, health).
   *
   * This scan aggregates signals from other scans and feeds them into
   * the escalation engine for progressive response.
   */
  _escalationScan() {
    const results = [];

    try {
      const escalation = require('./escalation');
      const policy = escalation.loadEscalationPolicy();
      if (!policy.enabled) return results;

      const activeSessions = session.getActiveSessions();
      const health = orchestrator.getAgentHealth();

      for (const agent of activeSessions) {
        const sid = agent.session_id;
        if (!sid || sid === this.pmSessionId) continue;

        const taskId = agent.claimed_task;
        const agentHealth = health.find(h => h.session_id === sid);

        // --- Check drift ---
        if (taskId) {
          try {
            const drift = orchestrator.detectDrift(sid);
            if (drift.drifted) {
              const esc = escalation.triggerEscalation(
                escalation.EVENT_TYPES.DRIFT, sid, taskId,
                { drift_score: drift.score, unplanned: drift.unplanned }
              );
              if (esc.action !== 'noop') {
                const actionResult = escalation.executeAction(esc.action, {
                  eventType: escalation.EVENT_TYPES.DRIFT,
                  sessionId: sid, taskId, pmSessionId: this.pmSessionId,
                  context: { drift_score: drift.score, unplanned: drift.unplanned },
                  dryRun: this.opts.dryRun
                });
                this.logAction('escalation_drift', {
                  agent: sid, task_id: taskId, level: esc.level,
                  escalated: esc.escalated, first_time: esc.first_time,
                  action_result: actionResult
                });
                results.push({ action: 'escalation_scan', type: 'drift', agent: sid, level: esc.level });
              }
            }
          } catch (e) { /* best effort */ }
        }

        // --- Check budget ---
        if (taskId) {
          try {
            const costTracker = require('./cost-tracker');
            const budget = costTracker.checkBudget(sid, taskId);
            if (budget.status === 'exceeded') {
              const esc = escalation.triggerEscalation(
                escalation.EVENT_TYPES.BUDGET_EXCEEDED, sid, taskId,
                { task_tokens: budget.task_tokens, details: budget.details }
              );
              if (esc.action !== 'noop') {
                const actionResult = escalation.executeAction(esc.action, {
                  eventType: escalation.EVENT_TYPES.BUDGET_EXCEEDED,
                  sessionId: sid, taskId, pmSessionId: this.pmSessionId,
                  context: { task_tokens: budget.task_tokens, details: budget.details },
                  dryRun: this.opts.dryRun
                });
                this.logAction('escalation_budget', {
                  agent: sid, task_id: taskId, level: esc.level,
                  escalated: esc.escalated, tokens: budget.task_tokens
                });
                results.push({ action: 'escalation_scan', type: 'budget', agent: sid, level: esc.level });
              }
            }
          } catch (e) { /* best effort */ }
        }

        // --- Check agent unresponsive ---
        if (agentHealth && (agentHealth.status === 'stale' || agentHealth.status === 'dead')) {
          const esc = escalation.triggerEscalation(
            escalation.EVENT_TYPES.AGENT_UNRESPONSIVE, sid, taskId,
            { health_status: agentHealth.status }
          );
          if (esc.action !== 'noop') {
            const actionResult = escalation.executeAction(esc.action, {
              eventType: escalation.EVENT_TYPES.AGENT_UNRESPONSIVE,
              sessionId: sid, taskId, pmSessionId: this.pmSessionId,
              context: { health_status: agentHealth.status },
              dryRun: this.opts.dryRun
            });
            this.logAction('escalation_unresponsive', {
              agent: sid, task_id: taskId, level: esc.level,
              health_status: agentHealth.status
            });
            results.push({ action: 'escalation_scan', type: 'unresponsive', agent: sid, level: esc.level });
          }
        }
      }

      // --- Auto-de-escalation check ---
      try {
        const deescalated = escalation.checkAutoDeescalation((eventType, sid, taskId) => {
          if (eventType === escalation.EVENT_TYPES.DRIFT) {
            try {
              const drift = orchestrator.detectDrift(sid);
              return drift.drifted;
            } catch (e) { return false; }
          }
          if (eventType === escalation.EVENT_TYPES.TEST_FAILURE) {
            // Test failures are resolved by the agent running tests — can't check from PM
            return true; // Keep escalation active until agent reports
          }
          if (eventType === escalation.EVENT_TYPES.MERGE_CONFLICT) {
            // Check if agent still has conflict by looking at health
            const h = health.find(a => a.session_id === sid);
            return h && h.status !== 'healthy';
          }
          return true; // Default: keep escalation active
        });

        if (deescalated.length > 0) {
          this.logAction('auto_deescalated', { count: deescalated.length, keys: deescalated });
          results.push({ action: 'escalation_scan', type: 'deescalation', deescalated });
        }
      } catch (e) { /* best effort */ }

    } catch (e) {
      this.logAction('escalation_scan_error', { error: e.message });
    }

    return results;
  }

  /**
   * Analytics scan: aggregate performance metrics, detect bottlenecks,
   * and publish to shared memory channel.
   * Phase 3.13 — Performance Analytics
   */
  _analyticsScan() {
    const results = [];

    try {
      const analytics = require('./analytics');

      // Aggregate daily metrics and write snapshot
      const snapshot = analytics.aggregateDaily();

      this.logAction('analytics_aggregated', {
        date: snapshot.date,
        tasks_completed: snapshot.tasks_completed,
        success_rate: snapshot.success_rate,
        queue_depth: snapshot.queue_depth,
        bottleneck_assessment: snapshot.bottleneck_assessment
      });

      results.push({
        action: 'analytics_scan',
        date: snapshot.date,
        tasks_completed: snapshot.tasks_completed,
        bottleneck_assessment: snapshot.bottleneck_assessment
      });

      // Publish to memory channel for cross-agent visibility
      if (!this.opts.dryRun) {
        try { analytics.publishAnalyticsChannel(); } catch (e) { /* best effort */ }
      }

      // Check for degraded/critical bottleneck state
      if (snapshot.bottleneck_assessment === 'critical' || snapshot.bottleneck_assessment === 'degraded') {
        this.logAction('analytics_bottleneck_alert', {
          assessment: snapshot.bottleneck_assessment,
          queue_depth: snapshot.queue_depth,
          blocking_tasks: snapshot.blocking_task_count
        });
      }
    } catch (e) {
      this.logAction('analytics_scan_error', { error: e.message });
    }

    return results;
  }

  /**
   * Notification digest scan (Phase 5.9)
   * Flushes batched info-level notifications when interval elapses.
   */
  _notificationDigestScan() {
    const results = [];
    try {
      const { getRouter } = require('./notification-router');
      const router = getRouter(this.projectRoot);
      if (router.shouldFlushDigest()) {
        router.flushDigest().then(({ sent }) => {
          if (sent > 0) {
            this.logAction('notification_digest_flushed', { sent });
          }
        }).catch(() => { /* best effort */ });
        results.push({ action: 'notification_digest_flush', result: { triggered: true } });
      }
    } catch {
      // notification-router not available — no-op
    }
    return results;
  }

  /**
   * Progress/artifact scan (Phase 4.7)
   * Detects tasks blocked on missing artifacts and aggregates progress.
   */
  async _progressScan() {
    const results = [];

    try {
      const artifactRegistry = require('./artifact-registry');
      const activeSessions = session.getActiveSessions();

      // Check each active agent's task for artifact blocking
      for (const sess of activeSessions) {
        if (!sess.claimed_task) continue;
        const taskId = sess.claimed_task;

        // Check progress
        const progress = artifactRegistry.getProgress(taskId, this.projectRoot);
        if (progress.length > 0) {
          const latest = progress[progress.length - 1];
          this.logAction('task_progress', {
            task_id: taskId,
            session_id: sess.session_id,
            latest_step: latest.step,
            latest_status: latest.status,
            total_entries: progress.length
          });
        }
      }

      // Check ready tasks for artifact blocking (async)
      const readyTasks = await this._getAllReadyTasks();
      for (const task of readyTasks) {
        const blocking = artifactRegistry.getBlockingArtifacts(task.id, this.projectRoot);
        if (blocking.length > 0) {
          this.logAction('task_artifact_blocked', {
            task_id: task.id,
            blocking: blocking.map(a => `${a.taskId}:${a.name}`)
          });
          results.push({
            action: 'artifact_blocked',
            task_id: task.id,
            blocking_count: blocking.length
          });
        }
      }
    } catch (e) {
      this.logAction('progress_scan_error', { error: e.message });
    }

    return results;
  }

  /**
   * Phase 4.8: Overnight run monitoring scan.
   * Checks error budgets, detects completed/failed tasks, triggers report.
   */
  _overnightScan() {
    const results = [];

    try {
      const run = overnightMode.getActiveRun(this.projectRoot);
      if (!run) return results;

      // Check total error budget
      const totalBudget = overnightMode.checkTotalErrorBudget(this.projectRoot);
      if (totalBudget.exceeded) {
        this.logAction('overnight_budget_exhausted', {
          run_id: run.run_id,
          total_errors: totalBudget.total_errors,
          max: totalBudget.max_total
        });

        // End run and generate report
        overnightMode.endRun(this.projectRoot, run.run_id);
        this._generateOvernightReport(run.run_id);

        results.push({
          action: 'overnight_stopped',
          reason: 'budget_exhausted',
          total_errors: totalBudget.total_errors
        });
        return results;
      }

      // Check per-task budgets and skip over-budget tasks
      const overBudget = overnightMode.getOverBudgetTasks(this.projectRoot);
      for (const taskId of overBudget) {
        if (!run.tasks_failed.includes(taskId)) {
          overnightMode.recordTaskFailure(taskId, this.projectRoot);
          this.logAction('overnight_task_over_budget', {
            run_id: run.run_id,
            task_id: taskId
          });
          results.push({ action: 'task_over_budget', task_id: taskId });
        }
      }

      // Check if all tasks are done (completed + failed + no in_progress)
      const allDone = (run.tasks_completed || []).length +
        (run.tasks_failed || []).length;
      const totalTasks = (run.task_ids || []).length;
      const inProgress = (run.tasks_in_progress || []).length;

      if (allDone >= totalTasks && inProgress === 0 && totalTasks > 0) {
        this.logAction('overnight_run_complete', {
          run_id: run.run_id,
          completed: (run.tasks_completed || []).length,
          failed: (run.tasks_failed || []).length
        });

        overnightMode.endRun(this.projectRoot, run.run_id);
        this._generateOvernightReport(run.run_id);

        results.push({
          action: 'overnight_completed',
          completed: (run.tasks_completed || []).length,
          failed: (run.tasks_failed || []).length
        });
      }
    } catch (e) {
      this.logAction('overnight_scan_error', { error: e.message });
    }

    return results;
  }

  /**
   * Generate and save overnight report.
   */
  _generateOvernightReport(runId) {
    try {
      const result = overnightMode.generateReport({
        projectRoot: this.projectRoot,
        runId
      });
      if (result.success && result.formatted) {
        // Write markdown report to reports dir
        const reportDir = path.join(this.projectRoot, overnightMode.REPORT_DIR);
        if (!fs.existsSync(reportDir)) {
          fs.mkdirSync(reportDir, { recursive: true });
        }
        const mdPath = path.join(reportDir, `${runId}.md`);
        fs.writeFileSync(mdPath, result.formatted);
        this.logAction('overnight_report_generated', { path: mdPath });
      }
    } catch (e) {
      this.logAction('overnight_report_error', { error: e.message });
    }
  }

  // ==========================================================================
  // APPROVAL CONFIDENCE SCAN (Phase 5.1)
  // ==========================================================================

  /**
   * Phase 5.1: Periodic approval confidence scan.
   * - Checks accuracy metrics and suggests threshold adjustments
   * - Logs confidence scoring health to action log
   * - Records outcomes for completed tasks
   */
  _approvalScan() {
    const results = [];

    try {
      const scorer = require('./confidence-scorer');

      // Check accuracy metrics
      const metrics = scorer.getAccuracyMetrics();
      if (metrics.total >= 5) {
        this.logAction('approval_metrics', {
          total: metrics.total,
          correct_auto: metrics.correct_auto,
          false_auto: metrics.false_auto,
          accuracy: metrics.accuracy
        });

        // Check if threshold adjustment is suggested
        const adjustment = scorer.suggestThresholdAdjustment();
        if (adjustment) {
          this.logAction('approval_threshold_suggestion', {
            adjust_auto_approve: adjustment.adjust_auto_approve,
            reason: adjustment.reason
          });

          results.push({
            action: 'approval_threshold_suggestion',
            ...adjustment
          });
        }
      }

      // Record outcomes for recently completed tasks that have confidence scores
      const completedSessions = session.getAllSessionStates()
        .filter(s => s.status === 'ended' && s.claimed_task);

      for (const s of completedSessions) {
        const score = scorer.loadScore(s.claimed_task);
        if (score && !score.outcome_recorded) {
          // Check if task was closed successfully
          const success = s.exit_reason !== 'error' && s.exit_reason !== 'crashed';
          scorer.recordOutcome(s.claimed_task, success, {
            labels: score.risk_tags || []
          });

          // Mark outcome as recorded to avoid double-recording
          const scoreState = { ...score, outcome_recorded: true };
          const scorePath = require('path').join(
            process.cwd(), scorer.HISTORY_DIR,
            `${s.claimed_task.replace(/\s+/g, '_')}.json`
          );
          try {
            const tmpPath = scorePath + '.tmp.' + process.pid;
            fs.writeFileSync(tmpPath, JSON.stringify(scoreState, null, 2));
            fs.renameSync(tmpPath, scorePath);
          } catch (e) { /* best effort */ }

          results.push({
            action: 'outcome_recorded',
            task_id: s.claimed_task,
            success
          });
        }
      }
    } catch (e) {
      this.logAction('approval_scan_error', { error: e.message });
    }

    return results;
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  /**
   * Get all ready tasks from bd (async to avoid blocking event loop)
   */
  async _getAllReadyTasks() {
    try {
      const output = await bdAsync(['ready', '--json'], this.projectRoot);
      return JSON.parse(output);
    } catch (e) {
      return [];
    }
  }

  /**
   * Get next ready task from bd (convenience wrapper, async)
   */
  async _getNextReadyTask() {
    const tasks = await this._getAllReadyTasks();
    return tasks.length > 0 ? tasks[0] : null;
  }

  /**
   * Queue an action for the PM terminal to process
   */
  _queueForPm(action) {
    this.actionQueue.push(action);

    // Also persist to the queue file (for pm-queue.js)
    try {
      const queuePath = path.join(this.projectRoot, '.claude/pilot/state/pm-queue.json');
      let queue = [];
      try {
        if (fs.existsSync(queuePath)) {
          queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        }
      } catch (e) {
        // Start fresh
      }

      queue.push(action);

      // Keep queue bounded
      if (queue.length > 100) {
        queue = queue.slice(-100);
      }

      const dir = path.dirname(queuePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
    } catch (e) {
      // Best effort
    }
  }

  /**
   * Log an action for audit trail.
   * Includes decision_type classification (mechanical/judgment) per Phase 4.4.
   */
  logAction(type, data = {}) {
    try {
      const logPath = path.join(this.projectRoot, ACTION_LOG_PATH);
      const dir = path.dirname(logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const entry = {
        ts: new Date().toISOString(),
        type,
        decision_type: data.decision_type || pmDecisions.classifyDecision(type),
        pm_session: this.pmSessionId,
        ...data
      };

      fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
    } catch (e) {
      // Best effort — never throw from logging
    }
  }

  /**
   * Get loop statistics
   */
  getStats() {
    return {
      running: this.running,
      pm_session: this.pmSessionId,
      action_count: this.actionCount,
      queue_size: this.actionQueue.length,
      last_health_scan: this.lastHealthScan ? new Date(this.lastHealthScan).toISOString() : null,
      last_task_scan: this.lastTaskScan ? new Date(this.lastTaskScan).toISOString() : null,
      last_drift_scan: this.lastDriftScan ? new Date(this.lastDriftScan).toISOString() : null,
      last_pressure_scan: this.lastPressureScan ? new Date(this.lastPressureScan).toISOString() : null,
      last_cost_scan: this.lastCostScan ? new Date(this.lastCostScan).toISOString() : null,
      last_telegram_scan: this.lastTelegramScan ? new Date(this.lastTelegramScan).toISOString() : null
    };
  }

  // ==========================================================================
  // TELEGRAM SCAN (Phase 6.6)
  // ==========================================================================

  /**
   * Telegram inbox scan: read pending intents from Telegram bridge inbox,
   * dispatch to handlers, write responses to outbox.
   *
   * Lazy-initializes TelegramConversations on first call (only if telegram
   * is enabled in policy).
   */
  _telegramScan() {
    const results = [];

    try {
      // Check if telegram is enabled in policy
      const { loadPolicy } = require('./policy');
      const policy = loadPolicy(this.projectRoot);
      if (!policy.telegram || !policy.telegram.enabled) return results;

      // Lazy-initialize
      if (!this._telegramConversations) {
        const { TelegramConversations } = require('./telegram-conversations');
        this._telegramConversations = new TelegramConversations(this.projectRoot, {
          policy: policy.telegram,
          pmSessionId: this.pmSessionId,
        });
      }

      // Process pending messages
      const telegramResults = this._telegramConversations.processPendingMessages();
      for (const r of telegramResults) {
        this.logAction('telegram_intent', {
          action: r.action,
          chatId: r.chatId,
          result: r.result || r.taskId,
        });
        results.push(r);
      }
    } catch (e) {
      this.logAction('telegram_scan_error', { error: e.message });
    }

    return results;
  }

  /**
   * Get the TelegramConversations instance (for external registration).
   * @returns {TelegramConversations|null}
   */
  get telegramConversations() {
    return this._telegramConversations;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = { PmLoop };
