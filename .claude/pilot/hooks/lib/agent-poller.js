/**
 * Agent Inbox Poller (Phase 3.6)
 *
 * Continuous inbox polling with bus watcher for autonomous agents.
 * Listens for task delegations, plan approvals, and wake signals.
 *
 * Uses createBusWatcher from messaging.js as the primary mechanism,
 * with nudge file checking for immediate wake-up.
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_ACTIVE_POLL_MS = 5000;
const DEFAULT_IDLE_POLL_MS = 30000;

// Message topics that trigger agent activation
const ACTIVATION_TOPICS = [
  'task.assign',
  'task.delegate',
  'welcome',
  'task.completed'       // peer task done — may unblock deps
];

const APPROVAL_ACTIONS = ['plan_approval', 'ack'];
const REJECTION_ACTIONS = ['plan_rejection', 'nack'];

// ============================================================================
// AGENT POLLER CLASS
// ============================================================================

class AgentPoller {
  /**
   * @param {string} sessionId - This agent's session ID
   * @param {object} opts
   * @param {string} opts.role - Agent role (for role-addressed messages)
   * @param {string} opts.agentName - Agent name (for name-addressed messages)
   * @param {number} opts.activePollMs - Poll interval when active
   * @param {number} opts.idlePollMs - Poll interval when idle
   */
  constructor(sessionId, opts = {}) {
    this.sessionId = sessionId;
    this.role = opts.role || null;
    this.agentName = opts.agentName || null;
    this.activePollMs = opts.activePollMs || DEFAULT_ACTIVE_POLL_MS;
    this.idlePollMs = opts.idlePollMs || DEFAULT_IDLE_POLL_MS;

    this._running = false;
    this._idle = true;
    this._watcher = null;
    this._pollTimer = null;
    this._handlers = {
      task: [],
      approval: [],
      rejection: [],
      message: []
    };
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /**
   * Start polling the message bus.
   */
  start() {
    if (this._running) return;
    this._running = true;

    const messaging = require('./messaging');

    // Primary: bus watcher (fs.watch + fallback polling)
    this._watcher = messaging.createBusWatcher(
      this.sessionId,
      (messages, cursor) => this._handleMessages(messages, cursor),
      {
        pollingInterval: this._idle ? this.idlePollMs : this.activePollMs,
        role: this.role,
        agentName: this.agentName
      }
    );

    // Secondary: periodic nudge check
    this._pollTimer = setInterval(() => {
      if (!this._running) return;
      const nudged = messaging.checkNudge(this.sessionId);
      if (nudged) {
        this._checkBus();
      }
    }, Math.min(this.activePollMs, 5000));
  }

  /**
   * Stop polling.
   */
  stop() {
    this._running = false;

    if (this._watcher) {
      this._watcher.stop();
      this._watcher = null;
    }

    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Switch to active polling (shorter interval).
   */
  setActive() {
    this._idle = false;
    this._restartWatcher();
  }

  /**
   * Switch to idle polling (longer interval).
   */
  setIdle() {
    this._idle = true;
    this._restartWatcher();
  }

  // ==========================================================================
  // EVENT HANDLERS
  // ==========================================================================

  /**
   * Register handler for task delegation events.
   * @param {function} handler - Called with (taskData, message)
   */
  onTask(handler) {
    this._handlers.task.push(handler);
  }

  /**
   * Register handler for plan approval events.
   * @param {function} handler - Called with (approvalData, message)
   */
  onApproval(handler) {
    this._handlers.approval.push(handler);
  }

  /**
   * Register handler for plan rejection events.
   * @param {function} handler - Called with (rejectionData, message)
   */
  onRejection(handler) {
    this._handlers.rejection.push(handler);
  }

  /**
   * Register handler for any message (catch-all).
   * @param {function} handler - Called with (message)
   */
  onMessage(handler) {
    this._handlers.message.push(handler);
  }

  // ==========================================================================
  // INTERNAL
  // ==========================================================================

  /**
   * Process incoming messages from the bus watcher.
   */
  _handleMessages(messages, cursor) {
    const messaging = require('./messaging');
    const processedIds = [];

    for (const msg of messages) {
      // Skip our own messages
      if (msg.from === this.sessionId) continue;

      // Classify and route
      if (this._isTaskDelegation(msg)) {
        const taskData = msg.payload?.data || {};
        for (const h of this._handlers.task) {
          try { h(taskData, msg); } catch (e) { /* handler error */ }
        }
      } else if (this._isApproval(msg)) {
        const data = msg.payload?.data || {};
        for (const h of this._handlers.approval) {
          try { h(data, msg); } catch (e) { /* handler error */ }
        }
      } else if (this._isRejection(msg)) {
        const data = msg.payload?.data || {};
        for (const h of this._handlers.rejection) {
          try { h(data, msg); } catch (e) { /* handler error */ }
        }
      }

      // Always fire catch-all
      for (const h of this._handlers.message) {
        try { h(msg); } catch (e) { /* handler error */ }
      }

      processedIds.push(msg.id);
    }

    // Acknowledge processed messages
    if (processedIds.length > 0) {
      messaging.acknowledgeMessages(this.sessionId, cursor, processedIds);
    }
  }

  /**
   * Check if message is a task delegation.
   */
  _isTaskDelegation(msg) {
    if (msg.type === 'task_delegate') return true;
    if (msg.type === 'notify' && ACTIVATION_TOPICS.includes(msg.topic)) return true;
    if (msg.type === 'request' && ACTIVATION_TOPICS.includes(msg.topic)) return true;
    return false;
  }

  /**
   * Check if message is a plan approval.
   */
  _isApproval(msg) {
    if (msg.type !== 'response') return false;
    const action = msg.payload?.action;
    return APPROVAL_ACTIONS.includes(action);
  }

  /**
   * Check if message is a plan rejection.
   */
  _isRejection(msg) {
    if (msg.type !== 'response') return false;
    const action = msg.payload?.action;
    return REJECTION_ACTIONS.includes(action);
  }

  /**
   * Manually trigger a bus check.
   */
  _checkBus() {
    const messaging = require('./messaging');
    const { messages, cursor } = messaging.readMessages(this.sessionId, {
      role: this.role,
      agentName: this.agentName
    });
    if (messages.length > 0) {
      this._handleMessages(messages, cursor);
    }
  }

  /**
   * Restart the watcher with updated interval.
   */
  _restartWatcher() {
    if (!this._running) return;

    if (this._watcher) {
      this._watcher.stop();
    }

    const messaging = require('./messaging');
    this._watcher = messaging.createBusWatcher(
      this.sessionId,
      (messages, cursor) => this._handleMessages(messages, cursor),
      {
        pollingInterval: this._idle ? this.idlePollMs : this.activePollMs,
        role: this.role,
        agentName: this.agentName
      }
    );
  }

  /**
   * Get poller status.
   */
  getStatus() {
    return {
      running: this._running,
      idle: this._idle,
      session_id: this.sessionId,
      role: this.role,
      agent_name: this.agentName,
      poll_interval_ms: this._idle ? this.idlePollMs : this.activePollMs
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  AgentPoller,
  ACTIVATION_TOPICS,
  APPROVAL_ACTIONS,
  REJECTION_ACTIONS,
  DEFAULT_ACTIVE_POLL_MS,
  DEFAULT_IDLE_POLL_MS
};
