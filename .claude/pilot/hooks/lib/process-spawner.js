/**
 * Process Spawner v2 (Phase 4.2)
 *
 * Context-aware agent spawning with:
 * - Full context capsule injection (research, checkpoint, plan)
 * - Worktree-per-agent (auto-create before spawn, cleanup on exit)
 * - Resume detection (continue from step N vs start fresh)
 * - Structured task context via environment variables + prompt
 *
 * Replaces the inline _spawnAgent() in pm-daemon.js with a proper module.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { buildContextCapsule, buildSpawnPrompt, detectResume } = require('./spawn-context');

// Lazy-loaded to avoid circular requires
let _worktree = null;
let _agentLogger = null;
let _orchestrator = null;

function getWorktree() {
  if (!_worktree) _worktree = require('./worktree');
  return _worktree;
}

function getAgentLogger() {
  if (!_agentLogger) _agentLogger = require('./agent-logger');
  return _agentLogger;
}

function getOrchestrator() {
  if (!_orchestrator) _orchestrator = require('./orchestrator');
  return _orchestrator;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const CONTEXT_FILE_DIR = '.claude/pilot/state/spawn-context';
const MAX_PROMPT_LENGTH = 16000; // Keep prompts under 16KB

// ============================================================================
// PROCESS SPAWNER
// ============================================================================

/**
 * Spawn a Claude agent process with full context injection.
 *
 * @param {object} task - Task object { id, title, description, labels }
 * @param {object} options
 * @param {string} options.projectRoot - Project root
 * @param {string} [options.agentType] - Agent type (frontend, backend, etc.)
 * @param {number} [options.budgetUsd] - Max budget in USD
 * @param {boolean} [options.dryRun] - If true, don't actually spawn
 * @param {object} [options.logger] - Logger instance
 * @returns {{ success: boolean, pid?: number, worktree?: object, isResume?: boolean, error?: string }}
 */
function spawnAgent(task, options = {}) {
  const {
    projectRoot,
    agentType,
    budgetUsd,
    dryRun,
    logger
  } = options;

  const log = logger || { info() {}, warn() {}, error() {}, debug() {} };

  // 1. Detect if this is a resume spawn
  const resumeInfo = detectResume(task.id, projectRoot);
  log.info('Spawn context detection', {
    task_id: task.id,
    is_resume: resumeInfo.isResume,
    previous_session: resumeInfo.previousSessionId || null
  });

  // 2. Build context capsule
  const capsule = buildContextCapsule(task, {
    projectRoot,
    previousSessionId: resumeInfo.previousSessionId,
    agentType
  });

  // 3. Set up worktree (if enabled)
  let worktreeInfo = null;
  const wt = getWorktree();
  if (wt) {
    const config = wt.getConfig();
    if (config.enabled) {
      worktreeInfo = _setupWorktree(task.id, projectRoot, log);
    }
  }

  // 4. Write context file for agent to read
  const contextFilePath = _writeContextFile(task.id, capsule, projectRoot);

  // 5. Build spawn prompt
  const prompt = buildSpawnPrompt(capsule);
  const truncatedPrompt = prompt.length > MAX_PROMPT_LENGTH
    ? prompt.slice(0, MAX_PROMPT_LENGTH) + '\n\n[Context truncated for token budget]'
    : prompt;

  if (dryRun) {
    log.info('DRY RUN: Would spawn agent', {
      task_id: task.id,
      is_resume: resumeInfo.isResume,
      worktree: worktreeInfo?.path || null,
      prompt_length: truncatedPrompt.length,
      agent_type: agentType || 'general'
    });
    return {
      success: true,
      dry_run: true,
      isResume: resumeInfo.isResume,
      worktree: worktreeInfo
    };
  }

  // 6. Build spawn args
  const args = ['-p', truncatedPrompt, '--permission-mode', 'acceptEdits'];

  // Agent type
  if (agentType) {
    args.push('--agent', agentType);
    // Model from skill registry
    try {
      const registry = getOrchestrator().loadSkillRegistry();
      const roleConfig = registry?.roles?.[agentType];
      if (roleConfig?.model) {
        args.push('--model', roleConfig.model);
      }
    } catch (e) { /* use default model */ }
  }

  // Budget limit
  if (budgetUsd) {
    args.push('--max-budget-usd', String(budgetUsd));
  }

  // 7. Build environment
  const env = {
    ...process.env,
    PILOT_DAEMON_SPAWNED: '1',
    PILOT_TASK_HINT: task.id,
    PILOT_CONTEXT_FILE: contextFilePath,
    PILOT_IS_RESUME: resumeInfo.isResume ? '1' : '0'
  };

  if (resumeInfo.previousSessionId) {
    env.PILOT_RESUME_SESSION = resumeInfo.previousSessionId;
  }

  if (worktreeInfo && worktreeInfo.path) {
    env.PILOT_WORKTREE_PATH = worktreeInfo.path;
    env.PILOT_WORKTREE_BRANCH = worktreeInfo.branch || '';
  }

  // 8. Determine cwd (worktree path if available, else project root)
  const cwd = (worktreeInfo && worktreeInfo.path) ? worktreeInfo.path : projectRoot;

  // 9. Spawn the process
  try {
    const child = spawn('claude', args, {
      cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env
    });

    child.unref();

    // Attach logger
    let logInfo = null;
    try {
      const al = getAgentLogger();
      logInfo = al.attachLogger(projectRoot, task.id, child);
    } catch (e) {
      log.warn('Failed to attach agent logger', { task_id: task.id, error: e.message });
    }

    log.info('Agent spawned (v2)', {
      pid: child.pid,
      task_id: task.id,
      title: task.title,
      agent_type: agentType || 'general',
      is_resume: resumeInfo.isResume,
      worktree: worktreeInfo?.path || null,
      cwd,
      prompt_length: truncatedPrompt.length
    });

    return {
      success: true,
      pid: child.pid,
      process: child,
      isResume: resumeInfo.isResume,
      worktree: worktreeInfo,
      logPath: logInfo?.logPath || null,
      contextFile: contextFilePath
    };
  } catch (e) {
    log.error('Agent spawn failed', {
      task_id: task.id,
      error: e.message
    });
    return { success: false, error: e.message };
  }
}

// ============================================================================
// WORKTREE SETUP
// ============================================================================

/**
 * Set up a worktree for an agent's task.
 *
 * @param {string} taskId
 * @param {string} projectRoot
 * @param {object} log
 * @returns {object|null} Worktree info { path, branch, reused }
 */
function _setupWorktree(taskId, projectRoot, log) {
  const wt = getWorktree();

  // Use a synthetic session ID for worktree creation
  // The real session ID will be set by the agent's session-start hook
  const tempSessionId = `spawn-${Date.now()}`;

  try {
    const result = wt.createWorktree(taskId, tempSessionId);
    if (result.success) {
      log.info('Worktree ready for agent', {
        task_id: taskId,
        path: result.path,
        branch: result.branch,
        reused: result.reused || false
      });
      return {
        path: result.path,
        branch: result.branch,
        reused: result.reused || false
      };
    } else {
      log.warn('Worktree creation failed', {
        task_id: taskId,
        error: result.error
      });
      return null;
    }
  } catch (e) {
    log.warn('Worktree setup error', {
      task_id: taskId,
      error: e.message
    });
    return null;
  }
}

// ============================================================================
// CONTEXT FILE
// ============================================================================

/**
 * Write a structured context file that the agent can read on startup.
 * Provides full context beyond what fits in the prompt.
 *
 * @param {string} taskId
 * @param {object} capsule
 * @param {string} projectRoot
 * @returns {string} Path to the context file
 */
function _writeContextFile(taskId, capsule, projectRoot) {
  const root = projectRoot || process.cwd();
  const dir = path.join(root, CONTEXT_FILE_DIR);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const filePath = path.join(dir, `${safeId}.json`);

  const contextData = {
    task: capsule.task,
    agent_type: capsule.agent_type,
    is_resume: !!capsule.resume,
    resume_session: capsule.resume?.from_session || null,
    has_plan: !!capsule.plan,
    has_research: !!capsule.research,
    related_agents: capsule.related_agents,
    related_decisions: capsule.related_decisions,
    created_at: new Date().toISOString()
  };

  // Write atomically
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(contextData, null, 2));
  fs.renameSync(tmpPath, filePath);

  return filePath;
}

/**
 * Clean up a spawn context file after agent exits.
 *
 * @param {string} taskId
 * @param {string} projectRoot
 */
function cleanupContextFile(taskId, projectRoot) {
  const root = projectRoot || process.cwd();
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const filePath = path.join(root, CONTEXT_FILE_DIR, `${safeId}.json`);

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (e) {
    // Best effort
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  spawnAgent,
  cleanupContextFile,
  CONTEXT_FILE_DIR,
  MAX_PROMPT_LENGTH,
  // Exposed for testing
  _setupWorktree,
  _writeContextFile
};
