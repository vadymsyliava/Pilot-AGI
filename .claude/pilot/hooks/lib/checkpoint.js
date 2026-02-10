/**
 * Context Checkpoint & Recovery (Phase 2.2.1)
 *
 * Saves and restores agent working state across context compactions.
 * Uses the shared memory layer for persistent storage.
 *
 * Checkpoint data is stored per-session at:
 *   .claude/pilot/memory/agents/<session-id>/checkpoint.json
 *
 * This is the memory layer's first self-consumption use case —
 * agent-to-self continuity across context windows.
 */

const fs = require('fs');
const path = require('path');
const { atomicWrite, AGENTS_DIR } = require('./memory');
const { logEvent } = require('./session');

const MAX_CHECKPOINTS_DEFAULT = 5;

// =============================================================================
// PATH HELPERS
// =============================================================================

function getCheckpointDir(sessionId) {
  return path.join(process.cwd(), AGENTS_DIR, sessionId);
}

function getCheckpointPath(sessionId) {
  return path.join(getCheckpointDir(sessionId), 'checkpoint.json');
}

function getCheckpointHistoryDir(sessionId) {
  return path.join(getCheckpointDir(sessionId), 'history');
}

// =============================================================================
// SAVE CHECKPOINT
// =============================================================================

/**
 * Save a checkpoint of the agent's working state.
 *
 * @param {string} sessionId - Session identifier
 * @param {object} data - Checkpoint data:
 *   - task_id: Current bd task ID
 *   - task_title: Task title for quick context
 *   - plan_step: Current step number in the plan
 *   - total_steps: Total steps in the plan
 *   - completed_steps: Array of { step, description, result }
 *   - key_decisions: Array of strings (decisions made during work)
 *   - files_modified: Array of file paths touched
 *   - current_context: Free-form string describing current state
 *   - important_findings: Array of strings (things discovered)
 *   - tool_call_count: Number of tool calls in this session
 *   - output_bytes: Estimated output bytes consumed
 * @param {object} options - { maxCheckpoints }
 * @returns {{ success: boolean, version: number, path: string }}
 */
function saveCheckpoint(sessionId, data, options = {}) {
  if (!sessionId) {
    return { success: false, error: 'sessionId is required' };
  }

  const maxCheckpoints = options.maxCheckpoints || MAX_CHECKPOINTS_DEFAULT;

  // Read existing checkpoint to get version
  const existing = loadCheckpoint(sessionId);
  const version = existing ? (existing.version || 0) + 1 : 1;

  const checkpoint = {
    version,
    session_id: sessionId,
    saved_at: new Date().toISOString(),
    task_id: data.task_id || null,
    task_title: data.task_title || null,
    plan_step: data.plan_step || null,
    total_steps: data.total_steps || null,
    completed_steps: data.completed_steps || [],
    key_decisions: data.key_decisions || [],
    files_modified: data.files_modified || [],
    current_context: data.current_context || '',
    important_findings: data.important_findings || [],
    tool_call_count: data.tool_call_count || 0,
    output_bytes: data.output_bytes || 0
  };

  const checkpointPath = getCheckpointPath(sessionId);

  // Archive previous checkpoint if it exists
  if (existing) {
    archiveCheckpoint(sessionId, existing, maxCheckpoints);
  }

  // Write new checkpoint atomically
  atomicWrite(checkpointPath, checkpoint);

  // Log event
  try {
    logEvent({
      type: 'checkpoint_saved',
      session_id: sessionId,
      task_id: checkpoint.task_id,
      version,
      plan_step: checkpoint.plan_step
    });
  } catch (e) {
    // Best effort
  }

  return { success: true, version, path: checkpointPath };
}

// =============================================================================
// LOAD CHECKPOINT
// =============================================================================

/**
 * Load the latest checkpoint for a session.
 * Returns the checkpoint object or null if none exists.
 */
function loadCheckpoint(sessionId) {
  if (!sessionId) return null;

  const checkpointPath = getCheckpointPath(sessionId);

  if (!fs.existsSync(checkpointPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

// =============================================================================
// CHECKPOINT HISTORY
// =============================================================================

/**
 * Archive a checkpoint to history (rotation with max limit).
 */
function archiveCheckpoint(sessionId, checkpoint, maxCheckpoints) {
  const historyDir = getCheckpointHistoryDir(sessionId);

  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }

  // Save with version in filename
  const filename = `checkpoint-v${checkpoint.version}.json`;
  const filePath = path.join(historyDir, filename);
  atomicWrite(filePath, checkpoint);

  // Rotate: remove oldest if over limit
  try {
    const files = fs.readdirSync(historyDir)
      .filter(f => f.startsWith('checkpoint-v') && f.endsWith('.json'))
      .sort();

    while (files.length > maxCheckpoints) {
      const oldest = files.shift();
      fs.unlinkSync(path.join(historyDir, oldest));
    }
  } catch (e) {
    // Best effort rotation
  }
}

/**
 * List checkpoint history for a session.
 * Returns array of { version, saved_at, task_id, plan_step }.
 */
function listCheckpointHistory(sessionId) {
  const historyDir = getCheckpointHistoryDir(sessionId);

  if (!fs.existsSync(historyDir)) {
    return [];
  }

  try {
    return fs.readdirSync(historyDir)
      .filter(f => f.startsWith('checkpoint-v') && f.endsWith('.json'))
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(historyDir, f), 'utf8'));
          return {
            version: data.version,
            saved_at: data.saved_at,
            task_id: data.task_id,
            plan_step: data.plan_step
          };
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.version - b.version);
  } catch (e) {
    return [];
  }
}

// =============================================================================
// COMPACT INTEGRATION
// =============================================================================

/**
 * Generate a context restoration prompt from a checkpoint.
 * Used to inject context after context compaction.
 *
 * Returns a formatted string that gives the agent full context to resume work.
 */
function buildRestorationPrompt(checkpoint) {
  if (!checkpoint) return null;

  const lines = [];
  lines.push('## Context Checkpoint Recovery');
  lines.push('');
  lines.push(`**Session**: ${checkpoint.session_id}`);
  lines.push(`**Saved**: ${checkpoint.saved_at}`);

  if (checkpoint.task_id) {
    lines.push(`**Task**: [${checkpoint.task_id}] ${checkpoint.task_title || ''}`);
  }

  if (checkpoint.plan_step !== null && checkpoint.total_steps !== null) {
    lines.push(`**Progress**: Step ${checkpoint.plan_step} of ${checkpoint.total_steps}`);
  }

  if (checkpoint.completed_steps.length > 0) {
    lines.push('');
    lines.push('### Completed Steps');
    for (const step of checkpoint.completed_steps) {
      const result = step.result ? ` (${step.result})` : '';
      lines.push(`- Step ${step.step}: ${step.description}${result}`);
    }
  }

  if (checkpoint.key_decisions.length > 0) {
    lines.push('');
    lines.push('### Key Decisions');
    for (const decision of checkpoint.key_decisions) {
      lines.push(`- ${decision}`);
    }
  }

  if (checkpoint.files_modified.length > 0) {
    lines.push('');
    lines.push('### Files Modified');
    for (const file of checkpoint.files_modified) {
      lines.push(`- ${file}`);
    }
  }

  if (checkpoint.important_findings.length > 0) {
    lines.push('');
    lines.push('### Important Findings');
    for (const finding of checkpoint.important_findings) {
      lines.push(`- ${finding}`);
    }
  }

  if (checkpoint.current_context) {
    lines.push('');
    lines.push('### Current Context');
    lines.push(checkpoint.current_context);
  }

  lines.push('');
  lines.push('---');
  lines.push('*Resume work from this checkpoint. Re-read modified files before continuing.*');

  return lines.join('\n');
}

/**
 * Delete checkpoint for a session (cleanup after task completion).
 */
function deleteCheckpoint(sessionId) {
  if (!sessionId) return;

  const checkpointPath = getCheckpointPath(sessionId);
  const historyDir = getCheckpointHistoryDir(sessionId);

  try {
    if (fs.existsSync(checkpointPath)) {
      fs.unlinkSync(checkpointPath);
    }
  } catch (e) {
    // Best effort
  }

  try {
    if (fs.existsSync(historyDir)) {
      const files = fs.readdirSync(historyDir);
      for (const f of files) {
        fs.unlinkSync(path.join(historyDir, f));
      }
      fs.rmdirSync(historyDir);
    }
  } catch (e) {
    // Best effort
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  saveCheckpoint,
  loadCheckpoint,
  listCheckpointHistory,
  buildRestorationPrompt,
  deleteCheckpoint,
  // Constants (for testing)
  getCheckpointPath,
  getCheckpointDir,
  MAX_CHECKPOINTS_DEFAULT
};
