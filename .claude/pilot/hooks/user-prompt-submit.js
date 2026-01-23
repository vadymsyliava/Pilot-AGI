#!/usr/bin/env node

/**
 * Pilot AGI User Prompt Submit Hook
 *
 * Runs when user submits a prompt to Claude Code.
 *
 * Purpose:
 * - Detect new scope requests (features, bugs, etc.)
 * - Block direct implementation when no task is active
 * - Inject relevant context (active task, policy status)
 * - Route users to proper task creation workflow
 *
 * Security note: All execSync calls use hardcoded commands only.
 * No user input is ever interpolated into shell commands.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadPolicy } = require('./lib/policy');

// =============================================================================
// CONTEXT HELPERS
// =============================================================================

/**
 * Get active bd task (in_progress status)
 * Note: Command is hardcoded, no user input interpolation
 */
function getActiveTask() {
  if (!fs.existsSync(path.join(process.cwd(), '.beads'))) return null;

  try {
    // Safe: command is hardcoded, no user input
    const result = execSync('bd list --status in_progress --json 2>/dev/null || echo "[]"', {
      encoding: 'utf8',
      timeout: 5000
    });
    const tasks = JSON.parse(result);
    if (tasks.length > 0) {
      return {
        id: tasks[0].id,
        title: tasks[0].title
      };
    }
  } catch (e) {
    // bd not available or error
  }

  return null;
}

/**
 * Get count of ready tasks
 * Note: Command is hardcoded, no user input interpolation
 */
function getReadyTaskCount() {
  try {
    // Safe: command is hardcoded, no user input
    const result = execSync('bd ready --json 2>/dev/null || echo "[]"', {
      encoding: 'utf8',
      timeout: 5000
    });
    return JSON.parse(result).length;
  } catch (e) {
    return 0;
  }
}

/**
 * Check if we have a project (PROJECT_BRIEF or ROADMAP exists)
 */
function hasProject() {
  const paths = [
    path.join(process.cwd(), 'work', 'PROJECT_BRIEF.md'),
    path.join(process.cwd(), 'PROJECT_BRIEF.md'),
    path.join(process.cwd(), 'work', 'ROADMAP.md'),
    path.join(process.cwd(), 'ROADMAP.md')
  ];

  return paths.some(p => fs.existsSync(p));
}

// =============================================================================
// SCOPE DETECTION
// =============================================================================

/**
 * Detect if prompt contains new scope request
 * Returns { detected: boolean, keyword: string|null }
 */
function detectNewScope(prompt, policy) {
  const keywords = policy.enforcement?.new_scope_keywords || [];
  const promptLower = prompt.toLowerCase();

  for (const keyword of keywords) {
    if (promptLower.includes(keyword.toLowerCase())) {
      return { detected: true, keyword };
    }
  }

  return { detected: false, keyword: null };
}

/**
 * Check if prompt is a Pilot command (shouldn't be blocked)
 */
function isPilotCommand(prompt) {
  const trimmed = prompt.trim().toLowerCase();
  return trimmed.startsWith('/pilot') ||
         trimmed.startsWith('/gsd') ||
         trimmed === 'bd ready' ||
         trimmed === 'bd list';
}

/**
 * Check if prompt is a simple question (shouldn't be blocked)
 */
function isSimpleQuestion(prompt) {
  const trimmed = prompt.trim().toLowerCase();
  const questionStarters = [
    'what ', 'where ', 'when ', 'why ', 'how ', 'who ',
    'can you explain', 'tell me about', 'show me',
    'list ', 'describe ', 'summarize'
  ];

  return questionStarters.some(q => trimmed.startsWith(q)) ||
         trimmed.endsWith('?');
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  // Read stdin for hook input
  let hookInput = {};
  try {
    let inputData = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      inputData += chunk;
    }
    if (inputData.trim()) {
      hookInput = JSON.parse(inputData);
    }
  } catch (e) {
    // No stdin or invalid JSON
    process.exit(0);
  }

  const prompt = hookInput.prompt || '';

  // Skip if empty prompt
  if (!prompt.trim()) {
    process.exit(0);
  }

  // Load policy
  let policy;
  try {
    policy = loadPolicy();
  } catch (e) {
    // No policy, allow everything
    process.exit(0);
  }

  // Skip if detect_new_scope is disabled
  if (!policy.enforcement?.detect_new_scope) {
    process.exit(0);
  }

  // Skip Pilot commands - they handle their own workflow
  if (isPilotCommand(prompt)) {
    process.exit(0);
  }

  // Get context
  const activeTask = getActiveTask();
  const readyCount = getReadyTaskCount();
  const projectExists = hasProject();

  // Detect new scope
  const scope = detectNewScope(prompt, policy);

  // Decision logic
  let output;

  if (scope.detected && !activeTask) {
    // New scope detected but no active task - block and guide user
    if (isSimpleQuestion(prompt)) {
      // Don't block questions about features
      output = buildContextOutput(activeTask, readyCount, projectExists);
    } else {
      // Block implementation request
      output = {
        decision: 'block',
        reason: buildBlockMessage(scope.keyword, readyCount, projectExists),
        systemMessage: `Detected: "${scope.keyword}" - task creation required`
      };
    }
  } else if (scope.detected && activeTask) {
    // New scope while task is active - warn but allow
    // User might be clarifying or expanding current task
    const context = [
      `Active task: [${activeTask.id}] ${activeTask.title}`,
      `Note: New scope detected ("${scope.keyword}"). If this is a new feature, consider creating a separate task.`
    ];
    output = {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: context.join('\n')
      }
    };
  } else {
    // No new scope detected - inject helpful context
    output = buildContextOutput(activeTask, readyCount, projectExists);
  }

  if (output) {
    console.log(JSON.stringify(output));
  }

  process.exit(0);
}

/**
 * Build context injection output
 */
function buildContextOutput(activeTask, readyCount, projectExists) {
  const context = [];

  if (activeTask) {
    context.push(`Active task: [${activeTask.id}] ${activeTask.title}`);
  } else if (readyCount > 0) {
    context.push(`No active task. ${readyCount} task(s) ready. Use /pilot-next to start.`);
  } else if (!projectExists) {
    context.push('No project initialized. Use /pilot-start to begin.');
  }

  if (context.length === 0) {
    return null;
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context.join('\n')
    }
  };
}

/**
 * Build block message for new scope without task
 */
function buildBlockMessage(keyword, readyCount, projectExists) {
  const lines = [
    `New work detected: "${keyword}"`,
    '',
    'Pilot AGI requires tasks to be tracked before implementation.'
  ];

  if (readyCount > 0) {
    lines.push('');
    lines.push(`You have ${readyCount} task(s) ready. Try:`);
    lines.push('  /pilot-next  - Pick and start a task');
  } else if (projectExists) {
    lines.push('');
    lines.push('No tasks ready. Try:');
    lines.push('  /pilot-sprint  - Plan tasks from roadmap');
  } else {
    lines.push('');
    lines.push('No project initialized. Try:');
    lines.push('  /pilot-start  - Initialize your project');
  }

  return lines.join('\n');
}

main().catch(() => {
  // Fail gracefully - allow prompt through
  process.exit(0);
});
