/**
 * Run Log Utilities
 *
 * Centralized utilities for managing session run logs.
 * Handles consistent formatting, timestamps, and file management for runs/YYYY-MM-DD.md files.
 */

const fs = require('fs');
const path = require('path');

const RUNS_DIR = 'runs';

/**
 * Get current date in YYYY-MM-DD format
 */
function getCurrentDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get current time in HH:MM format
 */
function getCurrentTime() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Get path to runs directory
 */
function getRunsDir() {
  return path.join(process.cwd(), RUNS_DIR);
}

/**
 * Ensure runs directory exists
 */
function ensureRunsDir() {
  const runsDir = getRunsDir();
  if (!fs.existsSync(runsDir)) {
    fs.mkdirSync(runsDir, { recursive: true });
  }
  return runsDir;
}

/**
 * Get path to today's run log file
 * @returns {string} Absolute path to YYYY-MM-DD.md
 */
function getCurrentRunLog() {
  const date = getCurrentDate();
  return path.join(getRunsDir(), `${date}.md`);
}

/**
 * Initialize run log file if it doesn't exist
 * Creates header with date and project name
 */
function initializeRunLog() {
  ensureRunsDir();
  const logPath = getCurrentRunLog();

  if (!fs.existsSync(logPath)) {
    const date = getCurrentDate();
    const time = getCurrentTime();
    const projectName = path.basename(process.cwd());

    const header = `## ${date} Session

Project: ${projectName}
Started: ${time}

`;

    fs.writeFileSync(logPath, header, 'utf8');
  }

  return logPath;
}

/**
 * Append entry to run log
 * @param {string} content - Content to append
 */
function appendToLog(content) {
  const logPath = initializeRunLog();
  fs.appendFileSync(logPath, content + '\n', 'utf8');
}

/**
 * Append task start entry
 * @param {string} taskId - Task ID (e.g., "bd-xxxx" or "T-001")
 * @param {string} title - Task title
 */
function appendTaskStart(taskId, title) {
  const time = getCurrentTime();

  const entry = `### Task: ${time}
- ID: ${taskId}
- Title: ${title}
- Status: in_progress
`;

  appendToLog(entry);
}

/**
 * Append plan created entry
 * @param {string} taskId - Task ID
 * @param {number} stepCount - Number of steps in plan
 */
function appendPlanCreated(taskId, stepCount) {
  const time = getCurrentTime();

  const entry = `### Plan: ${time}
- Task: ${taskId}
- Steps: ${stepCount}
- Status: Approved
- Next: /pilot-exec
`;

  appendToLog(entry);
}

/**
 * Append step execution entry
 * @param {string} taskId - Task ID
 * @param {number} stepNumber - Step number
 * @param {string} stepName - Description of step
 * @param {Array<string>} files - Files changed
 * @param {boolean} verified - Whether step was verified
 */
function appendStepExecution(taskId, stepNumber, stepName, files = [], verified = false) {
  const time = getCurrentTime();
  const filesList = files.length > 0 ? files.join(', ') : 'none';

  const entry = `### Step ${stepNumber}: ${time}
- Task: ${taskId}
- Step: ${stepName}
- Files: ${filesList}
- Verified: ${verified ? 'yes' : 'no'}
`;

  appendToLog(entry);
}

/**
 * Append progress checkpoint (generic progress entry)
 * @param {string} step - Step description
 * @param {string} status - Status (e.g., "completed", "in progress", "blocked")
 */
function appendProgress(step, status) {
  const time = getCurrentTime();

  const entry = `### Progress: ${time}
- Step: ${step}
- Status: ${status}
`;

  appendToLog(entry);
}

/**
 * Append commit entry
 * @param {string} hash - Git commit hash (short form)
 * @param {string} message - Commit message
 * @param {number} fileCount - Number of files changed
 */
function appendCommit(hash, message, fileCount = 0) {
  const time = getCurrentTime();

  const entry = `### Commit: ${time}
- Hash: ${hash}
- Message: ${message}
- Files: ${fileCount} changed
`;

  appendToLog(entry);
}

/**
 * Append task closed entry
 * @param {string} taskId - Task ID
 * @param {string} title - Task title
 * @param {number} commitCount - Number of commits made
 * @param {string} summary - Brief summary of what was accomplished
 * @param {string} duration - Duration string (e.g., "1h 25m")
 */
function appendTaskClosed(taskId, title, commitCount = 0, summary = '', duration = '') {
  const time = getCurrentTime();

  let entry = `### Task closed: ${time}
- Task: ${taskId}
- Title: ${title}
- Commits: ${commitCount}`;

  if (duration) {
    entry += `\n- Duration: ${duration}`;
  }

  entry += '\n';

  if (summary) {
    entry += `\n### Summary\n${summary}\n`;
  }

  appendToLog(entry);
}

/**
 * Append session end / resume context
 * @param {Object} context - Resume context object
 * @param {string} context.currentTask - Current task ID or "none"
 * @param {string} context.lastAction - What was just done
 * @param {string} context.nextAction - What should happen next
 * @param {string} context.blockers - Any blockers (optional)
 * @param {Array<Object>} context.filesInProgress - Files being worked on (optional)
 * @param {string} context.notes - Additional notes (optional)
 */
function appendResume(context) {
  const time = getCurrentTime();

  let entry = `---

### Session End: ${time}

**Resume context:**
- Current task: ${context.currentTask || 'none'}
- Last action: ${context.lastAction || 'unknown'}
- Next action: ${context.nextAction || 'run /pilot-next'}`;

  if (context.blockers) {
    entry += `\n- Blockers: ${context.blockers}`;
  }

  if (context.filesInProgress && context.filesInProgress.length > 0) {
    entry += '\n\n**Files in progress:**';
    for (const file of context.filesInProgress) {
      entry += `\n- ${file.path} - ${file.status}`;
    }
  }

  if (context.notes) {
    entry += `\n\n**Notes:**\n${context.notes}`;
  }

  entry += '\n';

  appendToLog(entry);
}

/**
 * Get most recent run log path
 * @returns {string|null} Path to most recent run log or null if none exist
 */
function getMostRecentRunLog() {
  const runsDir = getRunsDir();

  if (!fs.existsSync(runsDir)) {
    return null;
  }

  try {
    const files = fs.readdirSync(runsDir)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
      .sort()
      .reverse();

    if (files.length === 0) {
      return null;
    }

    return path.join(runsDir, files[0]);
  } catch (e) {
    return null;
  }
}

/**
 * Read last resume context from most recent run log
 * @returns {Object|null} Resume context object or null if not found
 */
function readLastResumeContext() {
  const logPath = getMostRecentRunLog();

  if (!logPath || !fs.existsSync(logPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');

    // Find last "Resume context:" section
    let resumeIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('**Resume context:**')) {
        resumeIndex = i;
        break;
      }
    }

    if (resumeIndex === -1) {
      return null;
    }

    // Parse resume context
    const context = {};
    for (let i = resumeIndex + 1; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('- Current task:')) {
        context.currentTask = line.replace('- Current task:', '').trim();
      } else if (line.startsWith('- Last action:')) {
        context.lastAction = line.replace('- Last action:', '').trim();
      } else if (line.startsWith('- Next action:')) {
        context.nextAction = line.replace('- Next action:', '').trim();
      } else if (line.startsWith('- Blockers:')) {
        context.blockers = line.replace('- Blockers:', '').trim();
      }
    }

    return Object.keys(context).length > 0 ? context : null;
  } catch (e) {
    return null;
  }
}

/**
 * Calculate duration between two time strings (HH:MM)
 * @param {string} startTime - Start time (HH:MM)
 * @param {string} endTime - End time (HH:MM) - defaults to current time
 * @returns {string} Duration string (e.g., "1h 25m")
 */
function calculateDuration(startTime, endTime = null) {
  if (!endTime) {
    endTime = getCurrentTime();
  }

  const [startHours, startMinutes] = startTime.split(':').map(Number);
  const [endHours, endMinutes] = endTime.split(':').map(Number);

  let totalMinutes = (endHours * 60 + endMinutes) - (startHours * 60 + startMinutes);

  // Handle next day case (negative duration)
  if (totalMinutes < 0) {
    totalMinutes += 24 * 60;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes}m`;
  }

  return `${hours}h ${minutes}m`;
}

module.exports = {
  getCurrentRunLog,
  appendTaskStart,
  appendPlanCreated,
  appendStepExecution,
  appendProgress,
  appendCommit,
  appendTaskClosed,
  appendResume,
  getMostRecentRunLog,
  readLastResumeContext,
  calculateDuration,
  getCurrentTime,
  getCurrentDate
};
