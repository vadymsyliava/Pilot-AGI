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
 * Build context for injection into Claude
 * Returns formatted string ready for injection
 */
function buildGuardianContext() {
  const summary = loadProjectSummary();
  const activeTask = getActiveTask();
  const readyTasks = getReadyTasks();

  const lines = ['<pilot-context>'];

  // Project summary
  lines.push(`Project: ${summary}`);
  lines.push('');

  // Active task
  if (activeTask) {
    lines.push(`Active task: [${activeTask.id}] ${activeTask.title}`);
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
  } else {
    lines.push('Ready tasks: none');
  }

  lines.push('');
  lines.push('Evaluate this prompt:');
  lines.push('- If requesting NEW work not matching any task → guide user to /pilot-new-task');
  lines.push('- If matches an existing ready task → suggest /pilot-next');
  lines.push('- If question/clarification → proceed normally');
  lines.push('</pilot-context>');

  return lines.join('\n');
}

module.exports = {
  refreshCache,
  loadProjectSummary,
  loadTaskIndex,
  getActiveTask,
  getReadyTasks,
  needsRefresh,
  buildGuardianContext,
  ensureCacheDir,
  getCacheDir
};
