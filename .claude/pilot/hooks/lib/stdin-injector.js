/**
 * Stdin Injector — Bridges bus events to PM terminal prompts
 *
 * Part of Pilot AGI-v1k — Autonomous PM-Executor Loop
 *
 * Architecture:
 *   Bus events → PmLoop classifies → StdinInjector writes action file
 *   → PM terminal's UserPromptSubmit hook reads action file → injects prompt
 *
 * We do NOT directly write to stdin (unreliable across terminals).
 * Instead, we use a file-based action queue that the PM terminal polls.
 *
 * The PM terminal checks for pending actions on each prompt submission
 * and auto-processes them.
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const ACTION_QUEUE_PATH = '.claude/pilot/state/orchestrator/pm-action-queue.json';
const ACTION_HISTORY_PATH = '.claude/pilot/state/orchestrator/pm-action-history.jsonl';
const MAX_QUEUE_SIZE = 50;
const MAX_HISTORY_ENTRIES = 200;

// ============================================================================
// ACTION QUEUE
// ============================================================================

/**
 * Write an action to the PM action queue.
 * The PM terminal will pick this up on its next prompt cycle.
 *
 * @param {string} projectRoot
 * @param {object} action - { type, priority, data, source_event_id }
 */
function enqueueAction(projectRoot, action) {
  const queuePath = path.join(projectRoot, ACTION_QUEUE_PATH);
  const dir = path.dirname(queuePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let queue = readQueue(projectRoot);

  const entry = {
    id: `A-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    ts: new Date().toISOString(),
    ...action,
    status: 'pending'
  };

  queue.push(entry);

  // Trim if needed
  if (queue.length > MAX_QUEUE_SIZE) {
    // Move overflow to history
    const overflow = queue.splice(0, queue.length - MAX_QUEUE_SIZE);
    appendToHistory(projectRoot, overflow.map(a => ({ ...a, status: 'dropped' })));
  }

  // Atomic write
  const tmpPath = queuePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(queue, null, 2));
  fs.renameSync(tmpPath, queuePath);

  return entry;
}

/**
 * Read the current action queue
 */
function readQueue(projectRoot) {
  const queuePath = path.join(projectRoot, ACTION_QUEUE_PATH);
  try {
    if (fs.existsSync(queuePath)) {
      return JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    }
  } catch (e) {
    // Corrupt file — start fresh
  }
  return [];
}

/**
 * Dequeue and return the next pending action.
 * Marks it as 'processing'.
 */
function dequeueAction(projectRoot) {
  const queue = readQueue(projectRoot);
  const pending = queue.find(a => a.status === 'pending');

  if (!pending) return null;

  pending.status = 'processing';
  pending.dequeued_at = new Date().toISOString();

  writeQueue(projectRoot, queue);
  return pending;
}

/**
 * Mark an action as completed and move to history
 */
function completeAction(projectRoot, actionId, result = {}) {
  const queue = readQueue(projectRoot);
  const idx = queue.findIndex(a => a.id === actionId);

  if (idx === -1) return false;

  const completed = {
    ...queue[idx],
    status: 'completed',
    completed_at: new Date().toISOString(),
    result
  };

  // Remove from queue
  queue.splice(idx, 1);
  writeQueue(projectRoot, queue);

  // Add to history
  appendToHistory(projectRoot, [completed]);
  return true;
}

/**
 * Mark an action as failed
 */
function failAction(projectRoot, actionId, error) {
  const queue = readQueue(projectRoot);
  const idx = queue.findIndex(a => a.id === actionId);

  if (idx === -1) return false;

  const failed = {
    ...queue[idx],
    status: 'failed',
    failed_at: new Date().toISOString(),
    error
  };

  queue.splice(idx, 1);
  writeQueue(projectRoot, queue);
  appendToHistory(projectRoot, [failed]);
  return true;
}

/**
 * Get queue statistics
 */
function getQueueStats(projectRoot) {
  const queue = readQueue(projectRoot);
  return {
    total: queue.length,
    pending: queue.filter(a => a.status === 'pending').length,
    processing: queue.filter(a => a.status === 'processing').length,
    oldest_pending: queue.find(a => a.status === 'pending')?.ts || null
  };
}

// ============================================================================
// PROMPT GENERATION
// ============================================================================

/**
 * Convert a queued action into a natural language prompt
 * that the PM terminal can process.
 *
 * @param {object} action - Dequeued action
 * @returns {string} Prompt text for the PM
 */
function actionToPrompt(action) {
  const type = action.type || 'unknown';
  const data = action.data || {};

  switch (type) {
    case 'assign_task':
      return `Assign task ${data.task_id} to agent ${data.target_session}. Reason: ${data.reason || 'auto-assignment'}`;

    case 'agent_assistance':
      return `Agent ${data.agent} needs help with topic "${data.topic}". Their message: ${JSON.stringify(data.message).substring(0, 500)}`;

    case 'agent_error':
      return `Agent ${data.agent} encountered an error (${data.error?.type || 'unknown'}). Snippet: ${(data.error?.snippet || '').substring(0, 300)}. Please investigate and decide next action.`;

    case 'review_merge':
      return `Review merge request for task ${data.task_id}. Run /pilot-pm-review ${data.task_id}`;

    case 'session_cleanup':
      return `Session ${data.session} ended. ${data.orphaned_task ? `Orphaned task: ${data.orphaned_task} — reassign.` : 'No orphaned tasks.'}`;

    case 'drift_alert':
      return `Drift detected for agent ${data.agent} on task ${data.task_id}. Score: ${Math.round((data.score || 0) * 100)}%. Unplanned files: ${(data.unplanned || []).join(', ')}. Investigate or allow.`;

    case 'health_alert':
      return `Health issue: ${data.agents?.length || 0} stale/dead agents detected. Details: ${JSON.stringify(data.agents || []).substring(0, 500)}`;

    case 'compact_request':
      return `Agent ${data.session_id} auto-checkpointed at ${data.pressure_pct}% context pressure. Run /compact to free context window. The agent will auto-resume from checkpoint on restart.`;

    default:
      return `PM action required: ${type}. Data: ${JSON.stringify(data).substring(0, 500)}`;
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function writeQueue(projectRoot, queue) {
  const queuePath = path.join(projectRoot, ACTION_QUEUE_PATH);
  const dir = path.dirname(queuePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = queuePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(queue, null, 2));
  fs.renameSync(tmpPath, queuePath);
}

function appendToHistory(projectRoot, entries) {
  try {
    const historyPath = path.join(projectRoot, ACTION_HISTORY_PATH);
    const dir = path.dirname(historyPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(historyPath, lines);

    // Trim history if too large (check file line count periodically)
    const stats = fs.statSync(historyPath);
    if (stats.size > 1024 * 512) { // 512KB
      const content = fs.readFileSync(historyPath, 'utf8');
      const allLines = content.trim().split('\n');
      if (allLines.length > MAX_HISTORY_ENTRIES) {
        const trimmed = allLines.slice(-MAX_HISTORY_ENTRIES).join('\n') + '\n';
        fs.writeFileSync(historyPath, trimmed);
      }
    }
  } catch (e) {
    // Best effort
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  enqueueAction,
  readQueue,
  dequeueAction,
  completeAction,
  failAction,
  getQueueStats,
  actionToPrompt
};
