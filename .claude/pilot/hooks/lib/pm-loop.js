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
const { execFileSync } = require('child_process');
const orchestrator = require('./orchestrator');
const session = require('./session');
const messaging = require('./messaging');

// ============================================================================
// CONSTANTS
// ============================================================================

const HEALTH_SCAN_INTERVAL_MS = 30000;    // 30s between health scans
const TASK_SCAN_INTERVAL_MS = 10000;      // 10s between task assignment scans
const DRIFT_SCAN_INTERVAL_MS = 120000;    // 2min between drift scans
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
    this.actionQueue = [];  // Used by pm-queue.js for persistence
    this.opts = {
      healthScanIntervalMs: opts.healthScanIntervalMs || HEALTH_SCAN_INTERVAL_MS,
      taskScanIntervalMs: opts.taskScanIntervalMs || TASK_SCAN_INTERVAL_MS,
      driftScanIntervalMs: opts.driftScanIntervalMs || DRIFT_SCAN_INTERVAL_MS,
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
   *
   * @param {Array<{event: object, classification: object}>} classifiedEvents
   * @returns {Array<{action: string, result: object}>}
   */
  processEvents(classifiedEvents) {
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

      const result = this._handleEvent(event, classification);
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
   */
  runPeriodicScans() {
    if (!this.running || !this.pmSessionId) return [];

    const now = Date.now();
    const results = [];

    // Health scan
    if (now - this.lastHealthScan >= this.opts.healthScanIntervalMs) {
      this.lastHealthScan = now;
      const healthResults = this._healthScan();
      results.push(...healthResults);
    }

    // Task assignment scan
    if (now - this.lastTaskScan >= this.opts.taskScanIntervalMs) {
      this.lastTaskScan = now;
      const taskResults = this._taskScan();
      results.push(...taskResults);
    }

    // Drift scan
    if (now - this.lastDriftScan >= this.opts.driftScanIntervalMs) {
      this.lastDriftScan = now;
      const driftResults = this._driftScan();
      results.push(...driftResults);
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
   * Route a classified event to the appropriate handler
   */
  _handleEvent(event, classification) {
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
      const result = handler.call(this, event, classification);
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
    assign_next: function(event) {
      const agentSession = event.from;
      const taskId = event.payload?.data?.task_id;

      this.logAction('task_completed_by_agent', {
        agent: agentSession,
        task_id: taskId
      });

      // Find next ready task
      const readyTask = this._getNextReadyTask();
      if (!readyTask) {
        this.logAction('no_ready_tasks', { after_completion: taskId });
        return { assigned: false, reason: 'no_ready_tasks' };
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
          reason: 'auto_assigned_after_completion'
        }
      );

      return { assigned: result.success, task_id: readyTask.id, to: agentSession };
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
    greet_agent: function(event) {
      const newSession = event.from;

      this.logAction('new_agent', { session: newSession });

      // Check if there's ready work to assign
      const readyTask = this._getNextReadyTask();
      if (readyTask && !this.opts.dryRun) {
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
            reason: 'auto_assigned_on_join'
          }
        );

        return { greeted: true, assigned: readyTask.id };
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
   * Task scan: find idle agents and assign ready tasks
   */
  _taskScan() {
    const results = [];

    try {
      const activeSessions = session.getActiveSessions();
      const idleAgents = activeSessions.filter(s =>
        !s.claimed_task && s.status === 'active'
      );

      if (idleAgents.length === 0) return results;

      for (const agent of idleAgents) {
        const readyTask = this._getNextReadyTask();
        if (!readyTask) break;

        if (this.opts.dryRun) {
          results.push({
            action: 'task_scan',
            dry_run: true,
            would_assign: readyTask.id,
            to: agent.session_id
          });
          continue;
        }

        const assignResult = orchestrator.assignTask(
          readyTask.id,
          agent.session_id,
          this.pmSessionId,
          {
            title: readyTask.title,
            description: readyTask.description,
            reason: 'auto_assigned_idle_agent'
          }
        );

        if (assignResult.success) {
          this.logAction('auto_assigned', {
            task_id: readyTask.id,
            agent: agent.session_id
          });
          results.push({
            action: 'task_scan',
            assigned: readyTask.id,
            to: agent.session_id
          });
        }
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

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  /**
   * Get next ready task from bd (using execFileSync for safety)
   */
  _getNextReadyTask() {
    try {
      const output = execFileSync('bd', ['ready', '--json'], {
        cwd: this.projectRoot,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const tasks = JSON.parse(output);
      return tasks.length > 0 ? tasks[0] : null;
    } catch (e) {
      return null;
    }
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
   * Log an action for audit trail
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
      last_drift_scan: this.lastDriftScan ? new Date(this.lastDriftScan).toISOString() : null
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = { PmLoop };
