/**
 * Context Gatherer — Infers checkpoint data without agent input
 *
 * Part of Phase 3.5 — Autonomous Context Window Management
 *
 * When auto-checkpoint triggers at pressure threshold, we can't ask
 * the agent to recall context. Instead, we infer it from:
 *   - Session state (claimed_task)
 *   - Git diff (modified files)
 *   - Session capsule (plan progress)
 *   - Recent commits (key decisions)
 *
 * Security: All shell commands are hardcoded constants — no user input
 * interpolation. Same pattern as post-tool-use.js and session-start.js.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SESSION_STATE_DIR = '.claude/pilot/state/sessions';

// =============================================================================
// GATHER CHECKPOINT CONTEXT
// =============================================================================

/**
 * Gather checkpoint data programmatically for auto-checkpoint.
 *
 * @param {string} sessionId
 * @returns {object} Checkpoint-compatible data object
 */
function gatherCheckpointContext(sessionId) {
  const data = {
    task_id: null,
    task_title: null,
    plan_step: null,
    total_steps: null,
    completed_steps: [],
    key_decisions: [],
    files_modified: [],
    current_context: '',
    important_findings: [],
    tool_call_count: 0,
    output_bytes: 0
  };

  // 1. Get task info from session state
  const taskInfo = getTaskFromSession(sessionId);
  if (taskInfo) {
    data.task_id = taskInfo.task_id;
    data.task_title = taskInfo.task_title;
  }

  // 2. Get modified files from git
  data.files_modified = getModifiedFiles();

  // 3. Get pressure stats
  const pressureStats = getPressureStats(sessionId);
  data.tool_call_count = pressureStats.calls;
  data.output_bytes = pressureStats.bytes;

  // 4. Get plan progress from session capsule
  const progress = getPlanProgress(data.task_id);
  if (progress) {
    data.plan_step = progress.current_step;
    data.total_steps = progress.total_steps;
    data.completed_steps = progress.completed_steps;
  }

  // 5. Get key decisions from recent commits
  data.key_decisions = getRecentCommitMessages(5);

  // 6. Build current context summary
  data.current_context = buildContextSummary(data);

  return data;
}

// =============================================================================
// TASK DISCOVERY
// =============================================================================

/**
 * Get claimed task info from session state file.
 */
function getTaskFromSession(sessionId) {
  try {
    const sessDir = path.join(process.cwd(), SESSION_STATE_DIR);
    if (!fs.existsSync(sessDir)) return null;

    // Try exact session file first
    const sessFile = path.join(sessDir, `${sessionId}.json`);
    if (fs.existsSync(sessFile)) {
      const data = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
      if (data.claimed_task) {
        return {
          task_id: data.claimed_task,
          task_title: data.claimed_task_title || null
        };
      }
    }

    // Fall back to scanning all session files for this session
    const files = fs.readdirSync(sessDir)
      .filter(f => f.startsWith('S-') && f.endsWith('.json') && !f.includes('.pressure'));

    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
        if (data.session_id === sessionId && data.claimed_task) {
          return {
            task_id: data.claimed_task,
            task_title: data.claimed_task_title || null
          };
        }
      } catch (e) {
        continue;
      }
    }

    // Last resort: ask bd for in_progress tasks (hardcoded command, no user input)
    try {
      const result = execFileSync('bd', ['list', '--status', 'in_progress', '--json'], {
        encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
      });
      const tasks = JSON.parse(result);
      if (tasks.length > 0) {
        return {
          task_id: tasks[0].id,
          task_title: tasks[0].title
        };
      }
    } catch (e) {
      // bd not available
    }
  } catch (e) {
    // Best effort
  }

  return null;
}

// =============================================================================
// FILE TRACKING
// =============================================================================

/**
 * Get modified files from git (staged + unstaged).
 * Uses execFileSync (no shell) for safety.
 */
function getModifiedFiles() {
  try {
    const unstaged = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
    });
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
      encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
    });

    const files = new Set();
    unstaged.trim().split('\n').filter(Boolean).forEach(f => files.add(f));
    staged.trim().split('\n').filter(Boolean).forEach(f => files.add(f));

    return Array.from(files).slice(0, 20); // Cap at 20 files
  } catch (e) {
    return [];
  }
}

// =============================================================================
// PRESSURE STATS
// =============================================================================

/**
 * Get current pressure stats for the session.
 */
function getPressureStats(sessionId) {
  try {
    const pressure = require('./pressure');
    return pressure.getPressure(sessionId);
  } catch (e) {
    return { calls: 0, bytes: 0 };
  }
}

// =============================================================================
// PLAN PROGRESS
// =============================================================================

/**
 * Infer plan progress from session capsule (runs/*.md).
 */
function getPlanProgress(taskId) {
  try {
    const runsDir = path.join(process.cwd(), 'runs');
    if (!fs.existsSync(runsDir)) return null;

    const today = new Date().toISOString().split('T')[0];
    const capsulePath = path.join(runsDir, `${today}.md`);
    if (!fs.existsSync(capsulePath)) return null;

    const content = fs.readFileSync(capsulePath, 'utf8');

    // Look for step progress markers like "Step 3 of 7" or "Step 3/7"
    const stepMatch = content.match(/Step\s+(\d+)\s+(?:of|\/)\s+(\d+)/i);
    if (stepMatch) {
      return {
        current_step: parseInt(stepMatch[1], 10),
        total_steps: parseInt(stepMatch[2], 10),
        completed_steps: extractCompletedSteps(content)
      };
    }

    // Look for checkbox-style progress
    const checkboxes = content.match(/- \[x\]\s+.+/gi) || [];
    const totalBoxes = content.match(/- \[[ x]\]\s+.+/gi) || [];
    if (totalBoxes.length > 0) {
      return {
        current_step: checkboxes.length,
        total_steps: totalBoxes.length,
        completed_steps: checkboxes.map((line, i) => ({
          step: i + 1,
          description: line.replace(/- \[x\]\s+/i, '').trim(),
          result: 'done'
        }))
      };
    }

    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Extract completed step descriptions from capsule content.
 */
function extractCompletedSteps(content) {
  const steps = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const match = line.match(/(?:completed|done|finished)\s*:?\s*(.+)/i);
    if (match) {
      steps.push({
        step: steps.length + 1,
        description: match[1].trim().substring(0, 200),
        result: 'done'
      });
    }
  }

  return steps.slice(0, 20);
}

// =============================================================================
// COMMIT HISTORY
// =============================================================================

/**
 * Get recent commit messages as key decisions.
 * Uses execFileSync (no shell) for safety.
 */
function getRecentCommitMessages(count) {
  try {
    const result = execFileSync('git', ['log', '--oneline', `-${count}`], {
      encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.trim().split('\n')
      .filter(Boolean)
      .map(line => line.replace(/^[a-f0-9]+\s+/, '').substring(0, 200));
  } catch (e) {
    return [];
  }
}

// =============================================================================
// CONTEXT SUMMARY
// =============================================================================

/**
 * Build a human-readable context summary from gathered data.
 */
function buildContextSummary(data) {
  const parts = [];

  if (data.task_id) {
    parts.push(`Working on task ${data.task_id}`);
    if (data.task_title) parts[0] += `: ${data.task_title}`;
  }

  if (data.plan_step && data.total_steps) {
    parts.push(`Progress: step ${data.plan_step} of ${data.total_steps}`);
  }

  if (data.files_modified.length > 0) {
    parts.push(`Modified ${data.files_modified.length} file(s): ${data.files_modified.slice(0, 5).join(', ')}`);
  }

  parts.push(`Auto-checkpoint at ${data.tool_call_count} tool calls, ~${Math.round(data.output_bytes / 1024)}KB output`);

  return parts.join('. ') + '.';
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  gatherCheckpointContext,
  getTaskFromSession,
  getModifiedFiles,
  getPlanProgress,
  getRecentCommitMessages,
  buildContextSummary
};
