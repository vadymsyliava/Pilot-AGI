/**
 * Agent Self-Activation Loop (Phase 3.6)
 *
 * State machine that drives autonomous agent workflow:
 *   IDLE → CLAIMING → PLANNING → WAITING_APPROVAL → EXECUTING → DONE → IDLE
 *
 * Mirrors pm-loop.js pattern but for worker agents.
 * Uses agent-poller.js for inbox monitoring and agent-actions.js
 * for programmatic skill invocation.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ============================================================================
// CONSTANTS
// ============================================================================

const STATES = {
  IDLE: 'idle',
  CLAIMING: 'claiming',
  PLANNING: 'planning',
  WAITING_APPROVAL: 'waiting_approval',
  EXECUTING: 'executing',
  CHECKPOINTING: 'checkpointing',
  DONE: 'done'
};

const AUTONOMOUS_CONFIG_PATH = '.claude/pilot/state/autonomous.json';
const LOOP_STATE_DIR = '.claude/pilot/state/agent-loops';
const MAX_ERRORS = 3;

// ============================================================================
// CONFIG HELPERS
// ============================================================================

/**
 * Load the self-activation config.
 * Merges role-specific overrides with defaults.
 *
 * @param {string} [role] - Agent role to load config for
 * @returns {object} Merged config
 */
function loadAutonomousConfig(role) {
  const configPath = path.join(process.cwd(), AUTONOMOUS_CONFIG_PATH);
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const sa = raw.selfActivation || {};
    const defaults = sa.defaults || {};
    const roleConfig = (sa.roles && sa.roles[role]) || {};

    return {
      ...defaults,
      ...roleConfig,
      _source: 'autonomous.json'
    };
  } catch (e) {
    return {
      enabled: false,
      auto_claim: false,
      auto_plan: false,
      auto_exec: false,
      idle_poll_interval_ms: 30000,
      active_poll_interval_ms: 5000,
      wake_on_delegation: true,
      checkpoint_at_pressure_pct: 60,
      plan_approval_timeout_ms: 300000,
      max_consecutive_exec_steps: 50,
      _source: 'defaults'
    };
  }
}

/**
 * Check if self-activation is enabled for a role.
 */
function isAutonomousEnabled(role) {
  const config = loadAutonomousConfig(role);
  return !!config.enabled;
}

// ============================================================================
// LOOP STATE PERSISTENCE
// ============================================================================

function getLoopStatePath(sessionId) {
  return path.join(process.cwd(), LOOP_STATE_DIR, `${sessionId}.loop.json`);
}

function saveLoopState(sessionId, state) {
  const dir = path.join(process.cwd(), LOOP_STATE_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = getLoopStatePath(sessionId) + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, getLoopStatePath(sessionId));
}

function loadLoopState(sessionId) {
  const statePath = getLoopStatePath(sessionId);
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
  } catch (e) { /* corrupt */ }
  return null;
}

function removeLoopState(sessionId) {
  const statePath = getLoopStatePath(sessionId);
  try {
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }
  } catch (e) { /* best effort */ }
}

// ============================================================================
// AGENT LOOP CLASS
// ============================================================================

class AgentLoop {
  /**
   * @param {string} sessionId
   * @param {object} opts
   * @param {string} opts.role - Agent role
   * @param {string} opts.agentName - Agent name
   * @param {object} opts.config - Override autonomous config
   */
  constructor(sessionId, opts = {}) {
    this.sessionId = sessionId;
    this.role = opts.role || null;
    this.agentName = opts.agentName || null;
    this.config = opts.config || loadAutonomousConfig(this.role);

    this.state = STATES.IDLE;
    this.currentTaskId = null;
    this.currentTaskTitle = null;
    this.planRequestId = null;
    this.execStep = 0;
    this.totalSteps = 0;
    this.errors = [];
    this.consecutiveErrors = 0;

    this._running = false;
    this._poller = null;
    this._approvalTimer = null;
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /**
   * Start the agent loop.
   * Initializes the poller and begins watching for work.
   * Phase 3.8: Attempts self-recovery from checkpoint on crash restart.
   */
  start() {
    if (this._running) return { success: false, error: 'Already running' };
    if (!this.config.enabled) return { success: false, error: 'Autonomous mode disabled' };

    this._running = true;
    this.state = STATES.IDLE;

    // Phase 3.8: Attempt self-recovery from crashed state
    const recoveryResult = this._attemptSelfRecovery();

    // Restore state from crash (if no recovery happened)
    if (!recoveryResult.recovered) {
      const saved = loadLoopState(this.sessionId);
      if (saved && saved.state !== STATES.IDLE && saved.state !== STATES.DONE) {
        this.state = saved.state;
        this.currentTaskId = saved.currentTaskId;
        this.currentTaskTitle = saved.currentTaskTitle;
        this.planRequestId = saved.planRequestId;
        this.execStep = saved.execStep || 0;
        this.totalSteps = saved.totalSteps || 0;
      }
    }

    // Start poller
    const { AgentPoller } = require('./agent-poller');
    this._poller = new AgentPoller(this.sessionId, {
      role: this.role,
      agentName: this.agentName,
      activePollMs: this.config.active_poll_interval_ms,
      idlePollMs: this.config.idle_poll_interval_ms
    });

    // Wire up poller events
    this._poller.onTask((taskData, msg) => this._onTaskDelegated(taskData, msg));
    this._poller.onApproval((data, msg) => this._onPlanApproved(data, msg));
    this._poller.onRejection((data, msg) => this._onPlanRejected(data, msg));

    this._poller.start();

    this._persistState();
    return {
      success: true,
      state: this.state,
      recovery: recoveryResult.recovered ? recoveryResult : undefined
    };
  }

  /**
   * Stop the agent loop.
   */
  stop(reason = 'manual') {
    this._running = false;

    if (this._poller) {
      this._poller.stop();
      this._poller = null;
    }

    if (this._approvalTimer) {
      clearTimeout(this._approvalTimer);
      this._approvalTimer = null;
    }

    this._persistState();
    return { success: true, reason };
  }

  // ==========================================================================
  // STATE TRANSITIONS
  // ==========================================================================

  /**
   * Transition to a new state.
   */
  _transition(newState) {
    const prevState = this.state;
    this.state = newState;

    // Adjust poller speed
    if (this._poller) {
      if (newState === STATES.IDLE) {
        this._poller.setIdle();
      } else {
        this._poller.setActive();
      }
    }

    // Publish status
    try {
      const agentContext = require('./agent-context');
      agentContext.publishProgress(this.sessionId, {
        taskId: this.currentTaskId,
        taskTitle: this.currentTaskTitle,
        step: this.execStep,
        totalSteps: this.totalSteps,
        status: newState === STATES.IDLE ? 'idle' : 'working'
      });
    } catch (e) { /* non-critical */ }

    this._persistState();
    return { from: prevState, to: newState };
  }

  /**
   * Attempt to claim a task. Called when a delegation arrives or on startup scan.
   *
   * @param {string} taskId - bd task ID to claim
   * @param {string} [taskTitle] - Task title
   * @returns {{ success: boolean, error?: string }}
   */
  claimTask(taskId, taskTitle) {
    if (this.state !== STATES.IDLE) {
      return { success: false, error: `Cannot claim in state: ${this.state}` };
    }

    if (!this.config.auto_claim) {
      return { success: false, error: 'auto_claim disabled' };
    }

    this._transition(STATES.CLAIMING);

    const session = require('./session');
    const result = session.claimTask(this.sessionId, taskId);

    if (!result.success) {
      this._transition(STATES.IDLE);
      return { success: false, error: result.error };
    }

    // Update bd status
    try {
      execFileSync('bd', ['update', taskId, '--status', 'in_progress'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (e) { /* bd not available */ }

    this.currentTaskId = taskId;
    this.currentTaskTitle = taskTitle || taskId;
    this.execStep = 0;
    this.totalSteps = 0;

    // Auto-plan if enabled
    if (this.config.auto_plan) {
      return this.requestPlan();
    }

    this._transition(STATES.IDLE);
    return { success: true, task_id: taskId };
  }

  /**
   * Request plan creation by enqueuing a /pilot-plan action.
   * Sends a plan request to the PM for approval.
   */
  requestPlan() {
    if (this.state !== STATES.CLAIMING && this.state !== STATES.PLANNING) {
      if (this.state === STATES.IDLE && this.currentTaskId) {
        // Allow re-plan from idle if we have a task
      } else {
        return { success: false, error: `Cannot plan in state: ${this.state}` };
      }
    }

    this._transition(STATES.PLANNING);

    // Enqueue plan action for the agent terminal
    const agentActions = require('./agent-actions');
    const action = agentActions.enqueueAgentAction(this.sessionId, {
      type: 'invoke_plan',
      data: {
        task_id: this.currentTaskId,
        task_title: this.currentTaskTitle
      }
    });

    // Send plan request to PM on bus
    const messaging = require('./messaging');
    const planReq = messaging.sendRequest(
      this.sessionId,
      null, // to — will be picked up by PM role
      'plan.approval_request',
      {
        task_id: this.currentTaskId,
        task_title: this.currentTaskTitle,
        agent: this.agentName,
        role: this.role
      },
      { priority: 'normal' }
    );

    // Note: sendRequest with to=null won't pass validation
    // Use sendToRole instead for role-addressed messaging
    const roleReq = messaging.sendToRole(
      this.sessionId,
      'pm',
      'plan.approval_request',
      {
        task_id: this.currentTaskId,
        task_title: this.currentTaskTitle,
        agent: this.agentName,
        role: this.role
      },
      { priority: 'normal', ack: { required: true, deadline_ms: this.config.plan_approval_timeout_ms } }
    );

    this.planRequestId = roleReq.id;
    this._transition(STATES.WAITING_APPROVAL);

    // Start approval timeout
    this._startApprovalTimeout();

    return { success: true, action_id: action?.id, plan_request_id: roleReq.id };
  }

  /**
   * Execute the next step in the plan.
   * Checks context pressure before each step.
   */
  executeStep() {
    if (this.state !== STATES.EXECUTING) {
      return { success: false, error: `Cannot execute in state: ${this.state}` };
    }

    if (!this.config.auto_exec) {
      return { success: false, error: 'auto_exec disabled' };
    }

    // Check pressure before executing
    if (this._shouldCheckpoint()) {
      return this.checkpoint();
    }

    // Check max consecutive steps
    if (this.execStep >= this.config.max_consecutive_exec_steps) {
      this._transition(STATES.DONE);
      return { success: false, error: 'Max consecutive steps reached' };
    }

    this.execStep++;

    // Enqueue exec action
    const agentActions = require('./agent-actions');
    agentActions.enqueueAgentAction(this.sessionId, {
      type: 'invoke_exec',
      data: {
        task_id: this.currentTaskId,
        step: this.execStep,
        total_steps: this.totalSteps
      }
    });

    this._persistState();
    return { success: true, step: this.execStep };
  }

  /**
   * Save checkpoint and prepare for context compaction.
   */
  checkpoint() {
    this._transition(STATES.CHECKPOINTING);

    try {
      const checkpoint = require('./checkpoint');
      checkpoint.saveCheckpoint(this.sessionId, {
        task_id: this.currentTaskId,
        task_title: this.currentTaskTitle,
        plan_step: this.execStep,
        total_steps: this.totalSteps,
        loop_state: this.state,
        agent_role: this.role,
        agent_name: this.agentName
      });
    } catch (e) {
      // Checkpoint failed — continue anyway
    }

    this._transition(STATES.EXECUTING);
    return { success: true, checkpointed: true, step: this.execStep };
  }

  /**
   * Mark task as done and return to idle.
   */
  completeTask() {
    const taskId = this.currentTaskId;

    // Close bd task
    try {
      execFileSync('bd', ['close', taskId], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (e) { /* best effort */ }

    // Release task claim
    try {
      const session = require('./session');
      session.releaseTask(this.sessionId);
    } catch (e) { /* best effort */ }

    // Notify bus that task is done
    try {
      const messaging = require('./messaging');
      messaging.notifyTaskComplete(this.sessionId, taskId, {
        agent: this.agentName,
        role: this.role,
        steps_completed: this.execStep
      });
    } catch (e) { /* best effort */ }

    // Phase 7.2: Trigger post-mortem if task had errors
    if (this.errors.length > 0 && this.role) {
      try {
        const postMortem = require('./post-mortem');
        postMortem.triggerPostMortem(this.role, taskId, {
          errors: this.errors,
          steps_completed: this.execStep,
          total_steps: this.totalSteps,
          exit_reason: null
        });
      } catch (e) { /* best effort */ }
    }

    this.currentTaskId = null;
    this.currentTaskTitle = null;
    this.planRequestId = null;
    this.execStep = 0;
    this.totalSteps = 0;
    this.consecutiveErrors = 0;

    this._transition(STATES.IDLE);

    // Look for more work
    if (this._running) {
      this._scanForWork();
    }

    return { success: true, completed_task: taskId };
  }

  /**
   * Handle an error during execution.
   * Phase 3.8: Uses recovery module to diagnose test failures and
   * include fix suggestions in escalation messages.
   */
  handleError(error) {
    this.consecutiveErrors++;
    const errorMsg = typeof error === 'string' ? error : error.message;
    this.errors.push({
      ts: new Date().toISOString(),
      state: this.state,
      error: errorMsg
    });

    if (this.consecutiveErrors >= MAX_ERRORS) {
      // Phase 3.8: Try to diagnose before escalating
      let diagnosis = null;
      try {
        const recovery = require('./recovery');
        diagnosis = recovery.handleTestFailure(this.sessionId, errorMsg);
      } catch (e) { /* best effort */ }

      if (diagnosis && diagnosis.known_pattern && diagnosis.suggestion) {
        // Known pattern — include fix suggestion, don't stop yet
        this.consecutiveErrors = 0; // Reset — we have a potential fix
        this._persistState();
        return {
          success: true,
          known_pattern: true,
          suggestion: diagnosis.suggestion,
          consecutive_errors: 0
        };
      }

      // Unknown pattern or no diagnosis — escalate and stop
      const messaging = require('./messaging');
      messaging.sendBlockingRequest(
        this.sessionId,
        'pm',
        `Agent ${this.agentName} hit ${MAX_ERRORS} consecutive errors on task ${this.currentTaskId}`,
        {
          context: {
            errors: this.errors.slice(-MAX_ERRORS),
            diagnosis: diagnosis || null
          }
        }
      );

      // Record in agent memory for future pattern matching
      if (this.role) {
        try {
          const memory = require('./memory');
          memory.recordError(this.role, {
            error_type: 'max_errors_reached',
            context: `${MAX_ERRORS} consecutive errors on task ${this.currentTaskId}`,
            resolution: 'escalated_to_pm',
            task_id: this.currentTaskId
          });
        } catch (e) { /* best effort */ }

        // Phase 7.2: Trigger post-mortem for max errors
        try {
          const postMortem = require('./post-mortem');
          postMortem.triggerPostMortem(this.role, this.currentTaskId, {
            errors: this.errors,
            steps_completed: this.execStep,
            total_steps: this.totalSteps,
            exit_reason: 'max_errors'
          });
        } catch (e) { /* best effort */ }
      }

      this.stop('max_errors');
      return { success: false, stopped: true, reason: 'max_errors' };
    }

    this._persistState();
    return { success: true, consecutive_errors: this.consecutiveErrors };
  }

  // ==========================================================================
  // EVENT HANDLERS (from poller)
  // ==========================================================================

  /**
   * Handle task delegation event.
   */
  _onTaskDelegated(taskData, msg) {
    if (this.state !== STATES.IDLE) return;

    const taskId = taskData.bd_task_id || taskData.task_id;
    const taskTitle = taskData.title || taskId;

    if (taskId) {
      // Auto-ACK the delegation
      try {
        const messaging = require('./messaging');
        messaging.sendAck(this.sessionId, msg.id, msg.from);
      } catch (e) { /* best effort */ }

      this.claimTask(taskId, taskTitle);
    }
  }

  /**
   * Handle plan approval event.
   */
  _onPlanApproved(data, msg) {
    if (this.state !== STATES.WAITING_APPROVAL) return;

    // Verify correlation
    if (msg.correlation_id && msg.correlation_id !== this.planRequestId) return;

    if (this._approvalTimer) {
      clearTimeout(this._approvalTimer);
      this._approvalTimer = null;
    }

    this.totalSteps = data.total_steps || data.steps || 0;
    this._transition(STATES.EXECUTING);

    // Start executing
    this.executeStep();
  }

  /**
   * Handle plan rejection event.
   */
  _onPlanRejected(data, msg) {
    if (this.state !== STATES.WAITING_APPROVAL) return;

    if (msg.correlation_id && msg.correlation_id !== this.planRequestId) return;

    if (this._approvalTimer) {
      clearTimeout(this._approvalTimer);
      this._approvalTimer = null;
    }

    // Re-plan with feedback
    this._transition(STATES.PLANNING);
    this.requestPlan();
  }

  // ==========================================================================
  // INTERNAL HELPERS
  // ==========================================================================

  /**
   * Check if context pressure requires checkpoint.
   */
  _shouldCheckpoint() {
    try {
      const pressure = require('./pressure');
      return pressure.isNearLimit(
        this.sessionId,
        this.config.checkpoint_at_pressure_pct
      );
    } catch (e) {
      return false;
    }
  }

  /**
   * Start the approval timeout. Escalates to PM if no response.
   */
  _startApprovalTimeout() {
    if (this._approvalTimer) {
      clearTimeout(this._approvalTimer);
    }

    this._approvalTimer = setTimeout(() => {
      if (this.state !== STATES.WAITING_APPROVAL) return;

      // Escalate
      try {
        const messaging = require('./messaging');
        messaging.sendBlockingRequest(
          this.sessionId,
          'pm',
          `Plan approval timeout for task ${this.currentTaskId} (agent: ${this.agentName})`,
          { context: { task_id: this.currentTaskId, waited_ms: this.config.plan_approval_timeout_ms } }
        );
      } catch (e) { /* best effort */ }

      // Auto-approve if config allows
      if (this.config.auto_plan) {
        this._transition(STATES.EXECUTING);
        this.executeStep();
      }
    }, this.config.plan_approval_timeout_ms);
  }

  /**
   * Scan bd for ready tasks that this agent can pick up.
   */
  _scanForWork() {
    if (this.state !== STATES.IDLE) return;

    try {
      const output = execFileSync('bd', ['ready', '--json'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const tasks = JSON.parse(output);
      if (tasks.length === 0) return;

      // Check if task is already claimed by another session
      const session = require('./session');
      for (const task of tasks) {
        const claimed = session.isTaskClaimed(task.id);
        if (!claimed) {
          this.claimTask(task.id, task.title);
          return;
        }
      }
    } catch (e) {
      // bd not available or no tasks
    }
  }

  /**
   * Phase 3.8: Attempt self-recovery from a previous crash.
   * Checks for checkpoint from current or dead session, restores state.
   *
   * @returns {{ recovered: boolean, task_id?: string, plan_step?: number }}
   */
  _attemptSelfRecovery() {
    try {
      const recovery = require('./recovery');

      // Check if there's a crashed loop state for this session
      const saved = loadLoopState(this.sessionId);
      if (!saved || saved.state === STATES.IDLE || saved.state === STATES.DONE) {
        return { recovered: false };
      }

      // Attempt checkpoint-based recovery
      const ctx = recovery.recoverFromCheckpoint(this.sessionId);
      if (ctx && ctx.task_id) {
        this.state = STATES.EXECUTING;
        this.currentTaskId = ctx.task_id;
        this.currentTaskTitle = ctx.task_title || ctx.task_id;
        this.execStep = ctx.plan_step || 0;
        this.totalSteps = ctx.total_steps || 0;
        this.consecutiveErrors = 0;

        recovery.logRecoveryEvent(this.sessionId, 'self_recovery_success', {
          task_id: ctx.task_id,
          resumed_from_step: ctx.plan_step
        });

        return {
          recovered: true,
          task_id: ctx.task_id,
          plan_step: ctx.plan_step,
          restoration: ctx.restoration
        };
      }

      // No checkpoint — can't resume, fall back to IDLE
      if (saved.currentTaskId) {
        // Release the task claim gracefully
        try {
          const session = require('./session');
          session.releaseTask(this.sessionId);
        } catch (e) { /* best effort */ }

        recovery.logRecoveryEvent(this.sessionId, 'self_recovery_fallback_idle', {
          task_id: saved.currentTaskId,
          reason: 'no_checkpoint'
        });
      }

      return { recovered: false };
    } catch (e) {
      // Recovery module not available or error — proceed normally
      return { recovered: false };
    }
  }

  /**
   * Persist loop state to disk for crash recovery.
   */
  _persistState() {
    try {
      saveLoopState(this.sessionId, {
        session_id: this.sessionId,
        state: this.state,
        currentTaskId: this.currentTaskId,
        currentTaskTitle: this.currentTaskTitle,
        planRequestId: this.planRequestId,
        execStep: this.execStep,
        totalSteps: this.totalSteps,
        consecutiveErrors: this.consecutiveErrors,
        role: this.role,
        agentName: this.agentName,
        updated_at: new Date().toISOString()
      });
    } catch (e) { /* best effort */ }
  }

  /**
   * Get loop status summary.
   */
  getStatus() {
    return {
      running: this._running,
      state: this.state,
      session_id: this.sessionId,
      role: this.role,
      agent_name: this.agentName,
      current_task: this.currentTaskId,
      exec_step: this.execStep,
      total_steps: this.totalSteps,
      consecutive_errors: this.consecutiveErrors,
      poller: this._poller ? this._poller.getStatus() : null
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  AgentLoop,
  STATES,
  loadAutonomousConfig,
  isAutonomousEnabled,
  loadLoopState,
  saveLoopState,
  removeLoopState,
  AUTONOMOUS_CONFIG_PATH,
  LOOP_STATE_DIR,
  MAX_ERRORS
};
