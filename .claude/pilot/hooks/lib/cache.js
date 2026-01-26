/**
 * Cache Generator for Semantic Guardian
 *
 * Generates and manages cached context for the prompt guardian hook.
 * Keeps token overhead minimal by pre-computing project summary and task index.
 *
 * Security note: All execSync calls use hardcoded commands only.
 * No user input is ever interpolated into shell commands.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CACHE_DIR = '.claude/pilot/cache';
const PROJECT_SUMMARY_FILE = 'project-summary.txt';
const TASK_INDEX_FILE = 'task-index.json';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get cache directory path
 */
function getCacheDir() {
  return path.join(process.cwd(), CACHE_DIR);
}

/**
 * Ensure cache directory exists
 */
function ensureCacheDir() {
  const cacheDir = getCacheDir();
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return cacheDir;
}

/**
 * Check if cache is stale (older than max age)
 */
function isCacheStale(filePath) {
  if (!fs.existsSync(filePath)) {
    return true;
  }

  const stats = fs.statSync(filePath);
  const age = Date.now() - stats.mtimeMs;
  return age > CACHE_MAX_AGE_MS;
}

/**
 * Generate project summary from available sources
 * Tries: PROJECT_BRIEF.md, README.md, package.json
 * Returns a concise 1-2 line summary (~100 tokens max)
 */
function generateProjectSummary() {
  const sources = [
    { path: 'work/PROJECT_BRIEF.md', extractor: extractFromBrief },
    { path: 'PROJECT_BRIEF.md', extractor: extractFromBrief },
    { path: 'README.md', extractor: extractFromReadme },
    { path: 'package.json', extractor: extractFromPackage }
  ];

  for (const source of sources) {
    const fullPath = path.join(process.cwd(), source.path);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const summary = source.extractor(content);
        if (summary) {
          return summary;
        }
      } catch (e) {
        // Continue to next source
      }
    }
  }

  return 'Project summary not available. Consider running /pilot-init.';
}

/**
 * Extract summary from PROJECT_BRIEF.md
 */
function extractFromBrief(content) {
  // Look for Vision or first paragraph after title
  const lines = content.split('\n');
  let inVision = false;
  let summary = '';

  for (const line of lines) {
    if (line.toLowerCase().includes('## vision') || line.toLowerCase().includes('## overview')) {
      inVision = true;
      continue;
    }

    if (inVision && line.trim() && !line.startsWith('#')) {
      summary = line.trim();
      break;
    }

    // Fallback: first non-heading, non-empty line after title
    if (!inVision && !line.startsWith('#') && line.trim() && !summary) {
      summary = line.trim();
    }
  }

  return truncateSummary(summary);
}

/**
 * Extract summary from README.md
 */
function extractFromReadme(content) {
  const lines = content.split('\n');

  // Skip badges and title, find first real content
  let foundTitle = false;
  for (const line of lines) {
    if (line.startsWith('# ')) {
      foundTitle = true;
      continue;
    }

    if (foundTitle && line.trim() && !line.startsWith('[') && !line.startsWith('!')) {
      return truncateSummary(line.trim());
    }
  }

  return null;
}

/**
 * Extract summary from package.json
 */
function extractFromPackage(content) {
  try {
    const pkg = JSON.parse(content);
    if (pkg.description) {
      return truncateSummary(`${pkg.name}: ${pkg.description}`);
    }
  } catch (e) {
    // Invalid JSON
  }
  return null;
}

/**
 * Truncate summary to ~100 tokens (roughly 400 chars)
 */
function truncateSummary(text) {
  if (!text) return null;

  const maxLen = 400;
  if (text.length <= maxLen) {
    return text;
  }

  return text.slice(0, maxLen - 3) + '...';
}

/**
 * Generate task index from bd
 * Returns array of {id, title, status}
 * Note: Command is hardcoded, no user input interpolation
 */
function generateTaskIndex() {
  if (!fs.existsSync(path.join(process.cwd(), '.beads'))) {
    return [];
  }

  try {
    // Safe: command is hardcoded, no user input
    const result = execSync('bd list --json 2>/dev/null || echo "[]"', {
      encoding: 'utf8',
      timeout: 5000
    });

    const tasks = JSON.parse(result);

    // Return compact index
    return tasks.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status
    }));
  } catch (e) {
    return [];
  }
}

/**
 * Get active task (in_progress status)
 * Note: Command is hardcoded, no user input interpolation
 */
function getActiveTask() {
  if (!fs.existsSync(path.join(process.cwd(), '.beads'))) {
    return null;
  }

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
    // bd not available
  }

  return null;
}

/**
 * Get ready tasks (open, no blockers)
 * Note: Command is hardcoded, no user input interpolation
 */
function getReadyTasks() {
  try {
    // Safe: command is hardcoded, no user input
    const result = execSync('bd ready --json 2>/dev/null || echo "[]"', {
      encoding: 'utf8',
      timeout: 5000
    });

    const tasks = JSON.parse(result);
    return tasks.map(t => ({
      id: t.id,
      title: t.title
    }));
  } catch (e) {
    return [];
  }
}

/**
 * Get workflow state for active task
 * Returns: { state: string, suggestion: string }
 *
 * States:
 * - needs_plan: Task claimed but no plan file exists
 * - needs_approval: Plan exists but not approved
 * - ready_to_exec: Plan approved, work can proceed
 * - has_changes: Uncommitted changes exist
 * - no_task: No active task
 */
function getTaskState(activeTask) {
  if (!activeTask) {
    return { state: 'no_task', suggestion: '/pilot-next' };
  }

  const taskId = activeTask.id;
  const plansDir = path.join(process.cwd(), 'work', 'plans');

  // Check for plan file (various naming conventions)
  const planPatterns = [
    `${taskId}*.md`,
    `*${taskId}*.md`
  ];

  let planFile = null;
  if (fs.existsSync(plansDir)) {
    try {
      const files = fs.readdirSync(plansDir);
      for (const file of files) {
        if (file.includes(taskId.replace(/\s+/g, '-')) ||
            file.includes(taskId.replace(/\s+/g, '_'))) {
          planFile = path.join(plansDir, file);
          break;
        }
      }
    } catch (e) {
      // Ignore read errors
    }
  }

  // No plan file - needs planning
  if (!planFile) {
    return { state: 'needs_plan', suggestion: '/pilot-plan' };
  }

  // Check if plan is approved (look for approval marker in file)
  try {
    const planContent = fs.readFileSync(planFile, 'utf8');
    const isApproved = planContent.includes('Status: Approved') ||
                       planContent.includes('APPROVED') ||
                       planContent.includes('✅ Approved');

    if (!isApproved) {
      return { state: 'needs_approval', suggestion: 'Review and approve the plan' };
    }
  } catch (e) {
    // Can't read plan, assume needs approval
    return { state: 'needs_approval', suggestion: 'Review and approve the plan' };
  }

  // Plan approved - check for uncommitted changes
  try {
    // Safe: command is hardcoded
    const gitStatus = execSync('git status --porcelain 2>/dev/null || echo ""', {
      encoding: 'utf8',
      timeout: 5000
    });

    if (gitStatus.trim()) {
      return { state: 'has_changes', suggestion: '/pilot-commit' };
    }
  } catch (e) {
    // Git not available or error
  }

  // Plan approved, no uncommitted changes - ready to execute
  return { state: 'ready_to_exec', suggestion: '/pilot-exec' };
}

/**
 * Refresh all caches
 */
function refreshCache() {
  const cacheDir = ensureCacheDir();

  // Generate and save project summary
  const summary = generateProjectSummary();
  fs.writeFileSync(
    path.join(cacheDir, PROJECT_SUMMARY_FILE),
    summary,
    'utf8'
  );

  // Generate and save task index
  const taskIndex = generateTaskIndex();
  fs.writeFileSync(
    path.join(cacheDir, TASK_INDEX_FILE),
    JSON.stringify(taskIndex, null, 2),
    'utf8'
  );

  return {
    summary,
    taskCount: taskIndex.length,
    cacheDir
  };
}

/**
 * Load cached project summary
 */
function loadProjectSummary() {
  const summaryPath = path.join(getCacheDir(), PROJECT_SUMMARY_FILE);

  if (!fs.existsSync(summaryPath)) {
    // Generate on demand if missing
    refreshCache();
  }

  try {
    return fs.readFileSync(summaryPath, 'utf8');
  } catch (e) {
    return generateProjectSummary();
  }
}

/**
 * Load cached task index
 */
function loadTaskIndex() {
  const indexPath = path.join(getCacheDir(), TASK_INDEX_FILE);

  if (!fs.existsSync(indexPath)) {
    refreshCache();
  }

  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (e) {
    return generateTaskIndex();
  }
}

/**
 * Check if cache needs refresh
 */
function needsRefresh() {
  const summaryPath = path.join(getCacheDir(), PROJECT_SUMMARY_FILE);
  const indexPath = path.join(getCacheDir(), TASK_INDEX_FILE);

  return isCacheStale(summaryPath) || isCacheStale(indexPath);
}

/**
 * Find tasks that semantically match keywords from a prompt
 * Returns array of matching tasks with relevance score
 */
function findMatchingTasks(prompt, tasks) {
  if (!prompt || !tasks.length) return [];

  // Extract keywords from prompt (simple tokenization)
  const keywords = prompt.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .filter(w => !['this', 'that', 'with', 'from', 'have', 'will', 'would', 'could', 'should'].includes(w));

  // Score each task by keyword matches
  const scored = tasks.map(task => {
    const titleLower = task.title.toLowerCase();
    const matches = keywords.filter(kw => titleLower.includes(kw));
    return {
      ...task,
      score: matches.length
    };
  }).filter(t => t.score > 0);

  // Return top 3 matches sorted by score
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

/**
 * Build context for injection into Claude (Semantic Guardian)
 *
 * UNIQUE DIFFERENTIATOR: This is Pilot AGI's value-add over Claude Code.
 * While Claude Code provides raw AI coding power, Pilot AGI's semantic
 * guardian ensures governance through:
 *
 * 1. Workflow bypass detection - catches attempts to do work outside tasks
 * 2. Task suggestion - shows relevant existing tasks
 * 3. State-aware guidance - knows what step is next
 * 4. Audit preparation - ensures work is tracked
 *
 * Returns formatted string ready for injection (~300 tokens)
 */
function buildGuardianContext(prompt) {
  const summary = loadProjectSummary();
  const activeTask = getActiveTask();
  const readyTasks = getReadyTasks();
  const taskState = getTaskState(activeTask);

  const lines = ['<pilot-context>'];

  // Project summary
  lines.push(`Project: ${summary}`);
  lines.push('');

  // Active task with state
  if (activeTask) {
    lines.push(`Active task: [${activeTask.id}] ${activeTask.title}`);
    lines.push(`Workflow state: ${taskState.state}`);
    lines.push(`Suggested action: ${taskState.suggestion}`);
  } else {
    lines.push('Active task: none');
  }

  // Ready tasks (max 5 to keep tokens low)
  if (readyTasks.length > 0) {
    const shown = readyTasks.slice(0, 5);
    const taskList = shown.map(t => `[${t.id}] ${t.title}`).join(', ');
    lines.push(`Ready tasks: ${taskList}`);
    if (readyTasks.length > 5) {
      lines.push(`  (+${readyTasks.length - 5} more)`);
    }
  } else if (!activeTask) {
    lines.push('Ready tasks: none');
  }

  // Find matching tasks if prompt provided (smart suggestion)
  if (prompt && readyTasks.length > 0) {
    const matches = findMatchingTasks(prompt, readyTasks);
    if (matches.length > 0 && !activeTask) {
      lines.push('');
      lines.push('Possibly related tasks:');
      matches.forEach(m => {
        lines.push(`  → [${m.id}] ${m.title}`);
      });
    }
  }

  lines.push('');
  lines.push('SEMANTIC GUARDIAN EVALUATION:');
  lines.push('');

  if (activeTask) {
    // State-aware guidance
    switch (taskState.state) {
      case 'needs_plan':
        lines.push('- Active task needs a plan → suggest creating implementation plan');
        break;
      case 'needs_approval':
        lines.push('- Plan exists but needs approval → ask user to review and approve');
        break;
      case 'ready_to_exec':
        lines.push('- Plan approved → proceed with implementation');
        break;
      case 'has_changes':
        lines.push('- Uncommitted changes detected → suggest committing first');
        break;
    }
    lines.push('- If prompt is about the active task → proceed with work');
    lines.push('- If requesting DIFFERENT/UNRELATED work → guide to /pilot-new-task');
    lines.push('- GOVERNANCE: All work should be tracked. Shadow work is not compliant.');
  } else {
    lines.push('- If requesting NEW work not matching any task → guide user to /pilot-new-task');
    lines.push('- If matches an existing ready task → suggest /pilot-next or claim that task');
    lines.push('- GOVERNANCE: Creating a task first ensures audit trail and approval workflow');
  }
  lines.push('- If question/clarification → proceed normally');
  lines.push('');
  lines.push('Pilot AGI ensures governance over Claude Code for compliance.');
  lines.push('</pilot-context>');

  return lines.join('\n');
}

/**
 * Build task list summary for session start
 * Returns formatted string showing bd tasks for Claude's context
 * Optimized for token efficiency (~150-200 tokens max)
 *
 * @param {Object} options - Formatting options
 * @param {number} options.maxReadyTasks - Max ready tasks to show (default: 5)
 * @param {boolean} options.showPriority - Include priority in output (default: true)
 * @returns {Object} - { summary: string, activeTask: object|null, readyCount: number }
 */
function buildTaskListSummary(options = {}) {
  const { maxReadyTasks = 5, showPriority = true } = options;

  const activeTask = getActiveTask();
  const readyTasks = getReadyTasks();
  const taskState = activeTask ? getTaskState(activeTask) : null;

  const lines = [];
  let hasContent = false;

  // Active task section
  if (activeTask) {
    hasContent = true;
    lines.push(`ACTIVE: [${activeTask.id}] ${activeTask.title}`);
    if (taskState) {
      const stateEmoji = {
        'needs_plan': '📝',
        'needs_approval': '⏳',
        'ready_to_exec': '▶️',
        'has_changes': '💾',
        'no_task': ''
      };
      lines.push(`  State: ${stateEmoji[taskState.state] || ''} ${taskState.state.replace(/_/g, ' ')}`);
      lines.push(`  Next: ${taskState.suggestion}`);
    }
  }

  // Ready tasks section
  if (readyTasks.length > 0) {
    hasContent = true;
    if (activeTask) lines.push(''); // Spacing
    lines.push(`READY (${readyTasks.length}):`);

    const shown = readyTasks.slice(0, maxReadyTasks);
    for (const task of shown) {
      const priorityStr = showPriority && task.priority !== undefined
        ? ` [P${task.priority}]`
        : '';
      lines.push(`  • [${task.id}] ${task.title}${priorityStr}`);
    }

    if (readyTasks.length > maxReadyTasks) {
      lines.push(`  ... +${readyTasks.length - maxReadyTasks} more (run /pilot-status)`);
    }
  }

  // No tasks message
  if (!hasContent) {
    lines.push('No active or ready tasks. Run /pilot-next to start.');
  }

  return {
    summary: lines.join('\n'),
    activeTask,
    readyCount: readyTasks.length,
    state: taskState?.state || 'no_task'
  };
}

module.exports = {
  refreshCache,
  loadProjectSummary,
  loadTaskIndex,
  getActiveTask,
  getReadyTasks,
  getTaskState,
  needsRefresh,
  buildGuardianContext,
  buildTaskListSummary,
  findMatchingTasks,
  ensureCacheDir,
  getCacheDir
};
