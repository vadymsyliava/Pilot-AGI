/**
 * Context Traceability
 *
 * Manages bidirectional links between tasks, files, and commits.
 * Enables AI agents to trace the story behind code changes.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_LINKS_PATH = 'work/context/links.json';

/**
 * Get full path to links file
 */
function getLinksPath() {
  return path.join(process.cwd(), DEFAULT_LINKS_PATH);
}

/**
 * Load links from storage
 */
function loadLinks() {
  const linksPath = getLinksPath();

  if (!fs.existsSync(linksPath)) {
    return { tasks: {}, files: {} };
  }

  try {
    return JSON.parse(fs.readFileSync(linksPath, 'utf8'));
  } catch (e) {
    return { tasks: {}, files: {} };
  }
}

/**
 * Save links to storage
 */
function saveLinks(links) {
  const linksPath = getLinksPath();
  const dir = path.dirname(linksPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(linksPath, JSON.stringify(links, null, 2));
}

/**
 * Record a link between task, files, and commit
 */
function recordLink(taskId, files, commitHash = null) {
  if (!taskId || !files || files.length === 0) {
    return;
  }

  const links = loadLinks();
  const timestamp = new Date().toISOString();

  // Initialize task entry if needed
  if (!links.tasks[taskId]) {
    links.tasks[taskId] = {
      files: [],
      commits: [],
      created: timestamp
    };
  }

  // Add files to task (deduplicated)
  const taskEntry = links.tasks[taskId];
  for (const file of files) {
    if (!taskEntry.files.includes(file)) {
      taskEntry.files.push(file);
    }
  }

  // Add commit if provided
  if (commitHash && !taskEntry.commits.includes(commitHash)) {
    taskEntry.commits.push(commitHash);
  }

  taskEntry.updated = timestamp;

  // Add backlinks from files to task
  for (const file of files) {
    if (!links.files[file]) {
      links.files[file] = {
        tasks: [],
        created: timestamp
      };
    }

    const fileEntry = links.files[file];
    if (!fileEntry.tasks.includes(taskId)) {
      fileEntry.tasks.push(taskId);
    }
    fileEntry.last_task = taskId;
    fileEntry.updated = timestamp;
  }

  saveLinks(links);
}

/**
 * Get files associated with a task
 */
function getTaskFiles(taskId) {
  const links = loadLinks();
  const task = links.tasks[taskId];

  if (!task) {
    return { files: [], commits: [] };
  }

  return {
    files: task.files || [],
    commits: task.commits || []
  };
}

/**
 * Get tasks associated with a file
 */
function getFileTasks(filePath) {
  const links = loadLinks();

  // Normalize path
  const normalizedPath = filePath.startsWith('/')
    ? path.relative(process.cwd(), filePath)
    : filePath;

  const file = links.files[normalizedPath];

  if (!file) {
    return { tasks: [], last_task: null };
  }

  return {
    tasks: file.tasks || [],
    last_task: file.last_task || null
  };
}

/**
 * Get related tasks for a given task (tasks that share files)
 */
function getRelatedTasks(taskId) {
  const links = loadLinks();
  const task = links.tasks[taskId];

  if (!task || !task.files) {
    return [];
  }

  const related = new Set();

  for (const file of task.files) {
    const fileEntry = links.files[file];
    if (fileEntry && fileEntry.tasks) {
      for (const relatedTaskId of fileEntry.tasks) {
        if (relatedTaskId !== taskId) {
          related.add(relatedTaskId);
        }
      }
    }
  }

  return Array.from(related);
}

/**
 * Get context summary for a task (for AI agent loading)
 */
function getTaskContext(taskId) {
  const links = loadLinks();
  const task = links.tasks[taskId];

  if (!task) {
    return null;
  }

  const relatedTasks = getRelatedTasks(taskId);

  return {
    task_id: taskId,
    files: task.files || [],
    commits: task.commits || [],
    related_tasks: relatedTasks,
    file_count: (task.files || []).length,
    commit_count: (task.commits || []).length
  };
}

/**
 * Get context for a file (for understanding why code exists)
 */
function getFileContext(filePath) {
  const { tasks, last_task } = getFileTasks(filePath);

  if (tasks.length === 0) {
    return null;
  }

  return {
    file: filePath,
    tasks,
    last_task,
    task_count: tasks.length
  };
}

/**
 * Format context as readable summary
 */
function formatContext(context) {
  if (!context) {
    return 'No context available';
  }

  const lines = [];

  if (context.task_id) {
    lines.push(`Task: ${context.task_id}`);
    lines.push(`Files modified: ${context.file_count}`);
    lines.push(`Commits: ${context.commit_count}`);
    if (context.related_tasks.length > 0) {
      lines.push(`Related tasks: ${context.related_tasks.join(', ')}`);
    }
  } else if (context.file) {
    lines.push(`File: ${context.file}`);
    lines.push(`Modified by ${context.task_count} task(s): ${context.tasks.join(', ')}`);
    lines.push(`Last task: ${context.last_task}`);
  }

  return lines.join('\n');
}

module.exports = {
  recordLink,
  getTaskFiles,
  getFileTasks,
  getRelatedTasks,
  getTaskContext,
  getFileContext,
  formatContext,
  loadLinks,
  saveLinks
};
