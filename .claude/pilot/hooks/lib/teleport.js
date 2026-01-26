/**
 * Teleport Integration for Pilot AGI
 *
 * Handles context preservation when using Claude Code's Teleport feature.
 * Teleport allows moving sessions between web and local CLI via Git.
 *
 * Key insight: Teleport transfers via Git, so state must be committed.
 * This module provides functions to save/restore Pilot AGI context.
 *
 * Security note: All execSync calls use hardcoded commands only.
 * No user input is ever interpolated into shell commands.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TELEPORT_CONTEXT_FILE = '.claude/pilot/teleport-context.json';

/**
 * Save current Pilot AGI context for teleport
 * This creates a JSON file that can be committed to git
 *
 * @param {Object} context - Context to save
 * @param {string} context.taskId - Current bd task ID
 * @param {string} context.taskTitle - Task title
 * @param {string} context.planState - Plan state (needs_plan, needs_approval, etc.)
 * @param {string} context.planFile - Path to plan file if exists
 * @param {Object} context.sessionState - Current session state
 * @returns {boolean} Success
 */
function saveTeleportContext(context) {
  const contextPath = path.join(process.cwd(), TELEPORT_CONTEXT_FILE);

  const teleportContext = {
    version: '1.0',
    savedAt: new Date().toISOString(),
    source: 'pilot-agi',

    // Task context
    task: {
      id: context.taskId || null,
      title: context.taskTitle || null,
      status: 'in_progress'
    },

    // Plan context
    plan: {
      state: context.planState || 'unknown',
      file: context.planFile || null,
      approved: context.planApproved || false
    },

    // Session context
    session: {
      id: context.sessionId || null,
      startedAt: context.sessionStartedAt || null,
      lockedAreas: context.lockedAreas || [],
      lockedFiles: context.lockedFiles || []
    },

    // Workflow state
    workflow: {
      currentStep: context.currentStep || null,
      totalSteps: context.totalSteps || null,
      lastAction: context.lastAction || null
    },

    // Resume instructions for Claude
    resumeInstructions: buildResumeInstructions(context)
  };

  try {
    // Ensure directory exists
    const dir = path.dirname(contextPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(contextPath, JSON.stringify(teleportContext, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Build resume instructions based on context
 */
function buildResumeInstructions(context) {
  const taskInfo = context.taskId
    ? `[${context.taskId}] ${context.taskTitle || 'Unknown'}`
    : 'None';

  let nextAction = 'Check task status';
  if (context.planState === 'ready_to_exec') {
    nextAction = 'Continue with /pilot-exec';
  } else if (context.planState === 'needs_plan') {
    nextAction = 'Create plan with /pilot-plan';
  } else if (context.planState === 'needs_approval') {
    nextAction = 'Review and approve the plan';
  } else if (!context.taskId) {
    nextAction = 'Run /pilot-next to pick a task';
  }

  return `This session was teleported from another environment.

Active task: ${taskInfo}
Plan state: ${context.planState || 'Unknown'}

To resume:
1. Run /pilot-status to see current state
2. ${nextAction}`;
}

/**
 * Load teleport context if it exists
 *
 * @returns {Object|null} Teleport context or null if not found
 */
function loadTeleportContext() {
  const contextPath = path.join(process.cwd(), TELEPORT_CONTEXT_FILE);

  if (!fs.existsSync(contextPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(contextPath, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

/**
 * Clear teleport context after successful restore
 *
 * @returns {boolean} Success
 */
function clearTeleportContext() {
  const contextPath = path.join(process.cwd(), TELEPORT_CONTEXT_FILE);

  if (!fs.existsSync(contextPath)) {
    return true;
  }

  try {
    fs.unlinkSync(contextPath);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Check if this session was resumed via teleport
 * Detects by checking for teleport context file that's newer than session start
 *
 * @returns {boolean} True if teleport resume detected
 */
function isTeleportResume() {
  const context = loadTeleportContext();
  if (!context) return false;

  // Check if context was saved recently (within last hour)
  const savedAt = new Date(context.savedAt);
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

  return savedAt > hourAgo;
}

/**
 * Build resume message for Claude after teleport
 *
 * @returns {string|null} Resume message or null if no teleport context
 */
function buildTeleportResumeMessage() {
  const context = loadTeleportContext();
  if (!context) return null;

  const lines = [
    '<teleport-resume>',
    'SESSION TELEPORTED - Pilot AGI context restored',
    ''
  ];

  if (context.task && context.task.id) {
    lines.push('Active task: [' + context.task.id + '] ' + (context.task.title || 'Unknown'));
  }

  if (context.plan && context.plan.state) {
    lines.push('Plan state: ' + context.plan.state);
  }

  if (context.workflow && context.workflow.currentStep) {
    lines.push('Progress: Step ' + context.workflow.currentStep + '/' + (context.workflow.totalSteps || '?'));
  }

  lines.push('');
  lines.push(context.resumeInstructions || 'Run /pilot-status to continue.');
  lines.push('</teleport-resume>');

  return lines.join('\n');
}

/**
 * Prepare for teleport by gathering and saving all context
 * Call this before running /teleport
 *
 * @returns {Object} Result with success flag and message
 */
function prepareForTeleport() {
  // Get current task from bd
  // Safe: command is hardcoded, no user input
  let activeTask = null;
  try {
    const result = execSync('bd list --status in_progress --json 2>/dev/null || echo "[]"', {
      encoding: 'utf8',
      timeout: 5000
    });
    const tasks = JSON.parse(result);
    if (tasks.length > 0) {
      activeTask = tasks[0];
    }
  } catch (e) {
    // bd not available
  }

  // Get plan state
  let planState = 'no_task';
  let planFile = null;
  let planApproved = false;

  if (activeTask) {
    const plansDir = path.join(process.cwd(), 'work', 'plans');
    if (fs.existsSync(plansDir)) {
      try {
        const files = fs.readdirSync(plansDir);
        for (const file of files) {
          const taskSlug = activeTask.id.replace(/\s+/g, '-');
          if (file.includes(taskSlug)) {
            planFile = path.join('work', 'plans', file);

            // Check if approved
            const content = fs.readFileSync(path.join(plansDir, file), 'utf8');
            planApproved = content.includes('Status: Approved') ||
                          content.includes('APPROVED');
            break;
          }
        }
      } catch (e) {
        // Ignore errors
      }
    }

    if (!planFile) {
      planState = 'needs_plan';
    } else if (!planApproved) {
      planState = 'needs_approval';
    } else {
      planState = 'ready_to_exec';
    }
  }

  // Load session state if exists
  let sessionState = {};
  const sessionDir = path.join(process.cwd(), '.claude', 'pilot', 'state', 'sessions');
  if (fs.existsSync(sessionDir)) {
    try {
      const files = fs.readdirSync(sessionDir).filter(function(f) {
        return f.endsWith('.json');
      });
      if (files.length > 0) {
        // Get most recent session
        const latest = files.sort().pop();
        sessionState = JSON.parse(fs.readFileSync(path.join(sessionDir, latest), 'utf8'));
      }
    } catch (e) {
      // Ignore errors
    }
  }

  // Save context
  const context = {
    taskId: activeTask ? activeTask.id : null,
    taskTitle: activeTask ? activeTask.title : null,
    planState: planState,
    planFile: planFile,
    planApproved: planApproved,
    sessionId: sessionState.session_id || null,
    sessionStartedAt: sessionState.started || null,
    lockedAreas: sessionState.locked_areas || [],
    lockedFiles: sessionState.locked_files || []
  };

  const saved = saveTeleportContext(context);

  if (saved) {
    return {
      success: true,
      contextFile: TELEPORT_CONTEXT_FILE,
      context: context
    };
  } else {
    return {
      success: false,
      message: 'Failed to save teleport context.'
    };
  }
}

module.exports = {
  saveTeleportContext,
  loadTeleportContext,
  clearTeleportContext,
  isTeleportResume,
  buildTeleportResumeMessage,
  prepareForTeleport,
  TELEPORT_CONTEXT_FILE
};
