/**
 * Agent Action Queue (Phase 3.6)
 *
 * File-based action queue for programmatic skill invocation in agent terminals.
 * Mirrors stdin-injector.js pattern but generalized for any agent (not just PM).
 *
 * The user-prompt-submit.js hook checks for pending actions and injects them
 * as agent prompts.
 *
 * Action types:
 *   invoke_plan  — trigger /pilot-plan for a task
 *   invoke_exec  — trigger /pilot-exec for a step
 *   invoke_commit — trigger /pilot-commit
 *   invoke_close — trigger /pilot-close
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const ACTION_QUEUE_DIR = '.claude/pilot/state/agent-actions';
const MAX_QUEUE_SIZE = 50;

// ============================================================================
// PATH HELPERS
// ============================================================================

function getQueuePath(sessionId) {
  return path.join(process.cwd(), ACTION_QUEUE_DIR, `${sessionId}.actions.json`);
}

function ensureDir() {
  const dir = path.join(process.cwd(), ACTION_QUEUE_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// QUEUE OPERATIONS
// ============================================================================

/**
 * Enqueue an action for an agent session.
 *
 * @param {string} sessionId
 * @param {object} action - { type, data }
 * @returns {object} The enqueued action entry
 */
function enqueueAgentAction(sessionId, action) {
  ensureDir();

  const queue = readQueue(sessionId);

  const entry = {
    id: `AA-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    ts: new Date().toISOString(),
    type: action.type,
    data: action.data || {},
    status: 'pending'
  };

  queue.push(entry);

  // Trim oldest if over limit
  if (queue.length > MAX_QUEUE_SIZE) {
    queue.splice(0, queue.length - MAX_QUEUE_SIZE);
  }

  writeQueue(sessionId, queue);
  return entry;
}

/**
 * Read the action queue for a session.
 */
function readQueue(sessionId) {
  const queuePath = getQueuePath(sessionId);
  try {
    if (fs.existsSync(queuePath)) {
      return JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    }
  } catch (e) { /* corrupt — start fresh */ }
  return [];
}

/**
 * Dequeue the next pending action.
 * Marks it as 'processing'.
 *
 * @param {string} sessionId
 * @returns {object|null} The dequeued action or null
 */
function dequeueAgentAction(sessionId) {
  const queue = readQueue(sessionId);
  const pending = queue.find(a => a.status === 'pending');

  if (!pending) return null;

  pending.status = 'processing';
  pending.dequeued_at = new Date().toISOString();

  writeQueue(sessionId, queue);
  return pending;
}

/**
 * Mark an action as completed and remove from queue.
 */
function completeAction(sessionId, actionId) {
  const queue = readQueue(sessionId);
  const idx = queue.findIndex(a => a.id === actionId);
  if (idx === -1) return false;

  queue.splice(idx, 1);
  writeQueue(sessionId, queue);
  return true;
}

/**
 * Mark an action as failed and remove from queue.
 */
function failAction(sessionId, actionId, error) {
  const queue = readQueue(sessionId);
  const idx = queue.findIndex(a => a.id === actionId);
  if (idx === -1) return false;

  queue.splice(idx, 1);
  writeQueue(sessionId, queue);
  return true;
}

/**
 * Check if a session has pending actions.
 */
function hasPendingActions(sessionId) {
  const queue = readQueue(sessionId);
  return queue.some(a => a.status === 'pending');
}

/**
 * Get queue statistics.
 */
function getQueueStats(sessionId) {
  const queue = readQueue(sessionId);
  return {
    total: queue.length,
    pending: queue.filter(a => a.status === 'pending').length,
    processing: queue.filter(a => a.status === 'processing').length
  };
}

/**
 * Clear all actions for a session (cleanup).
 */
function clearQueue(sessionId) {
  const queuePath = getQueuePath(sessionId);
  try {
    if (fs.existsSync(queuePath)) {
      fs.unlinkSync(queuePath);
    }
  } catch (e) { /* best effort */ }
}

// ============================================================================
// PROMPT GENERATION
// ============================================================================

/**
 * Convert an action to a natural language prompt for the agent.
 * This is what gets injected via user-prompt-submit.
 *
 * @param {object} action - Dequeued action
 * @returns {string} Prompt text
 */
function actionToPrompt(action) {
  const type = action.type || 'unknown';
  const data = action.data || {};

  switch (type) {
    case 'invoke_plan':
      return `Create an implementation plan for task ${data.task_id} (${data.task_title || ''}).` +
        ` Use /pilot-plan to create the plan. Wait for approval before executing.`;

    case 'invoke_exec':
      return `Execute step ${data.step || 'next'}${data.total_steps ? ` of ${data.total_steps}` : ''}` +
        ` for task ${data.task_id}. Use /pilot-exec to execute the step.`;

    case 'invoke_commit':
      return `Create a commit for the current work on task ${data.task_id}.` +
        ` Use /pilot-commit to create the commit.`;

    case 'invoke_close':
      return `Validate and close task ${data.task_id}.` +
        ` Use /pilot-close to validate the Definition of Done and close the task.`;

    case 'invoke_checkpoint':
      return `Context pressure is high. Save a checkpoint using /pilot-checkpoint` +
        ` and then run /compact to free context window.`;

    default:
      return `Agent action: ${type}. Data: ${JSON.stringify(data).substring(0, 500)}`;
  }
}

// ============================================================================
// INTERNAL
// ============================================================================

function writeQueue(sessionId, queue) {
  ensureDir();
  const queuePath = getQueuePath(sessionId);
  const tmpPath = queuePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(queue, null, 2));
  fs.renameSync(tmpPath, queuePath);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  enqueueAgentAction,
  readQueue,
  dequeueAgentAction,
  completeAction,
  failAction,
  hasPendingActions,
  getQueueStats,
  clearQueue,
  actionToPrompt,
  ACTION_QUEUE_DIR,
  MAX_QUEUE_SIZE
};
