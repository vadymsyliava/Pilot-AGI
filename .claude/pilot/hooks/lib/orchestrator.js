/**
 * PM Orchestrator
 *
 * Coordinates multiple Claude Code sessions as a "team lead" agent.
 * Reads all session states, assigns tasks, detects drift, reviews work,
 * and manages merge approvals.
 *
 * Part of Phase 2.4 — PM Orchestrator Agent (Pilot AGI-rab)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadPolicy } = require('./policy');
const session = require('./session');
const messaging = require('./messaging');
const memory = require('./memory');
const worktree = require('./worktree');

// ============================================================================
// CONSTANTS
// ============================================================================

const PM_STATE_DIR = '.claude/pilot/state/orchestrator';
const PM_DECISIONS_CHANNEL = 'pm-decisions';
const PLAN_APPROVAL_DIR = '.claude/pilot/state';
const DEFAULT_DRIFT_THRESHOLD = 0.3; // 30% unplanned file edits = drift

// ============================================================================
// PATH HELPERS
// ============================================================================

function getPmStateDir() {
  return path.join(process.cwd(), PM_STATE_DIR);
}

function getPmStatePath() {
  return path.join(getPmStateDir(), 'pm-state.json');
}

function ensurePmStateDir() {
  const dir = getPmStateDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// PROJECT OVERVIEW
// ============================================================================

/**
 * Get a complete overview of the project state.
 * This is the PM's primary situational awareness function.
 */
function getProjectOverview() {
  const policy = loadPolicy();
  const activeSessions = session.getActiveSessions();
  const lockedAreas = session.getLockedAreas(activeSessions);
  const lockedFiles = session.getLockedFiles(activeSessions);

  // Get worktree status
  let worktrees = [];
  try {
    worktrees = worktree.listWorktrees();
  } catch (e) {
    // Worktree engine may not be available
  }

  // Get task list from bd
  let tasks = [];
  try {
    const output = execSync('bd list --json 2>/dev/null', {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 5000
    });
    tasks = JSON.parse(output);
  } catch (e) {
    // bd not available or no tasks
  }

  // Read recent events for context
  const recentEvents = getRecentEvents(20);

  // Check PM decisions channel
  let pmDecisions = null;
  try {
    pmDecisions = memory.read(PM_DECISIONS_CHANNEL);
  } catch (e) {
    // Channel may not exist yet
  }

  return {
    sessions: {
      active: activeSessions,
      count: activeSessions.length,
      max: policy.session?.max_concurrent_sessions || 6
    },
    tasks: {
      all: tasks,
      open: tasks.filter(t => t.status === 'open'),
      in_progress: tasks.filter(t =>
        activeSessions.some(s => s.claimed_task === t.id)
      ),
      blocked: tasks.filter(t => t.dependency_count > 0)
    },
    locks: {
      areas: lockedAreas,
      files: lockedFiles
    },
    worktrees,
    recent_events: recentEvents,
    pm_decisions: pmDecisions?.data || null
  };
}

/**
 * Read recent events from sessions.jsonl
 */
function getRecentEvents(limit = 20) {
  const eventPath = path.join(process.cwd(), 'runs/sessions.jsonl');
  if (!fs.existsSync(eventPath)) return [];

  try {
    const lines = fs.readFileSync(eventPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);

    return lines
      .slice(-limit)
      .map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

// ============================================================================
// AGENT HEALTH MONITORING
// ============================================================================

/**
 * Get health status for all active agents.
 * Uses lockfile-based process detection as primary liveness signal,
 * with heartbeat as secondary fallback.
 */
function getAgentHealth() {
  const policy = loadPolicy();
  const activeSessions = session.getActiveSessions();
  const now = Date.now();
  const heartbeatInterval = (policy.session?.heartbeat_interval_sec || 60) * 1000;

  return activeSessions.map(s => {
    const lastHeartbeat = new Date(s.last_heartbeat).getTime();
    const heartbeatAge = now - lastHeartbeat;
    const leaseExpires = s.lease_expires_at
      ? new Date(s.lease_expires_at).getTime()
      : null;

    // Primary liveness: lockfile + process check
    const processAlive = session.isSessionAlive(s.session_id);

    let status = 'healthy';
    if (!processAlive) {
      // Process is dead — definitive signal, regardless of heartbeat
      status = 'dead';
    } else if (heartbeatAge > heartbeatInterval * 3) {
      status = 'unresponsive';
    } else if (heartbeatAge > heartbeatInterval * 2) {
      status = 'stale';
    } else if (leaseExpires && now >= leaseExpires) {
      status = 'lease_expired';
    }

    return {
      session_id: s.session_id,
      status,
      process_alive: processAlive,
      claimed_task: s.claimed_task,
      locked_areas: s.locked_areas || [],
      heartbeat_age_sec: Math.round(heartbeatAge / 1000),
      lease_remaining_sec: leaseExpires
        ? Math.max(0, Math.round((leaseExpires - now) / 1000))
        : null,
      worktree_path: s.worktree_path || null
    };
  });
}

/**
 * Get stale or dead agents.
 * Includes agents whose process has exited (dead) or heartbeat expired (stale/unresponsive).
 */
function getStaleAgents() {
  return getAgentHealth().filter(a =>
    a.status === 'dead' || a.status === 'stale' || a.status === 'unresponsive'
  );
}

// ============================================================================
// DRIFT DETECTION
// ============================================================================

/**
 * Detect if an agent has drifted from its approved plan.
 * Compares files actually modified in the worktree vs. files in the plan.
 *
 * @param {string} sessionId - Session to check
 * @returns {{ drifted: boolean, score: number, planned_files: string[], actual_files: string[], unplanned: string[] }}
 */
function detectDrift(sessionId) {
  const activeSessions = session.getActiveSessions();
  const allSessions = session.getAllSessionStates();
  const targetSession = activeSessions.find(s => s.session_id === sessionId)
    || allSessions.find(s => s.session_id === sessionId);

  if (!targetSession) {
    return { drifted: false, error: `Session ${sessionId} not found` };
  }

  const taskId = targetSession.claimed_task;
  if (!taskId) {
    return { drifted: false, error: 'No task claimed by this session' };
  }

  // Get planned files from the plan approval state
  const plannedFiles = getPlannedFiles(taskId);

  // Get actual modified files from worktree
  const actualFiles = getWorktreeModifiedFiles(taskId, targetSession);

  if (plannedFiles.length === 0 || actualFiles.length === 0) {
    return {
      drifted: false,
      score: 0,
      planned_files: plannedFiles,
      actual_files: actualFiles,
      unplanned: []
    };
  }

  // Find files modified that weren't in the plan
  const unplanned = actualFiles.filter(f =>
    !plannedFiles.some(p => f.endsWith(p) || p.endsWith(f))
  );

  const policy = loadPolicy();
  const threshold = policy.orchestrator?.drift_threshold || DEFAULT_DRIFT_THRESHOLD;
  const score = actualFiles.length > 0 ? unplanned.length / actualFiles.length : 0;

  return {
    drifted: score > threshold,
    score: Math.round(score * 100) / 100,
    threshold,
    planned_files: plannedFiles,
    actual_files: actualFiles,
    unplanned
  };
}

/**
 * Get the list of planned files from plan approval state or plan docs.
 */
function getPlannedFiles(taskId) {
  // Check plan approval state
  const approvalPath = path.join(process.cwd(), PLAN_APPROVAL_DIR, 'plan-approval.json');
  if (fs.existsSync(approvalPath)) {
    try {
      const approval = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
      if (approval.task_id === taskId && approval.planned_files) {
        return approval.planned_files;
      }
      // Try to read the plan file for file references
      if (approval.plan_file) {
        const planPath = path.join(process.cwd(), approval.plan_file);
        if (fs.existsSync(planPath)) {
          return extractFilesFromPlan(fs.readFileSync(planPath, 'utf8'));
        }
      }
    } catch (e) {
      // Fall through
    }
  }

  // Check work/plans/ for matching plan
  const plansDir = path.join(process.cwd(), 'work/plans');
  if (fs.existsSync(plansDir)) {
    try {
      const planFiles = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));
      for (const pf of planFiles) {
        const content = fs.readFileSync(path.join(plansDir, pf), 'utf8');
        if (content.includes(taskId)) {
          return extractFilesFromPlan(content);
        }
      }
    } catch (e) {
      // Fall through
    }
  }

  return [];
}

/**
 * Extract file paths from a plan document.
 * Looks for patterns like "File: path/to/file" or "Files: path1, path2"
 */
function extractFilesFromPlan(planContent) {
  const files = new Set();

  // Match "File: " or "Files: " lines
  const filePatterns = [
    /Files?:\s*(.+)/gi,
    /(?:create|modify|edit|touch)\s+(?:file\s+)?[`"']?([^\s`"',]+\.\w+)/gi,
    /[`"']([^\s`"']+\.\w{1,5})[`"']/g
  ];

  for (const pattern of filePatterns) {
    let match;
    while ((match = pattern.exec(planContent)) !== null) {
      const captured = match[1];
      // Split on commas for multi-file references
      captured.split(/[,\s]+/).forEach(f => {
        const trimmed = f.trim().replace(/^[`"']+|[`"']+$/g, '');
        if (trimmed && trimmed.includes('.') && !trimmed.startsWith('#')) {
          files.add(trimmed);
        }
      });
    }
  }

  return [...files];
}

/**
 * Get files modified in an agent's worktree.
 */
function getWorktreeModifiedFiles(taskId, sessionState) {
  const wtPath = sessionState.worktree_path;
  const branch = sessionState.worktree_branch;

  if (!wtPath && !branch) return [];

  try {
    // If we have a branch, compare against base
    const baseBranch = loadPolicy().worktree?.base_branch || 'main';
    const diffCmd = branch
      ? `git diff --name-only ${baseBranch}...${branch} 2>/dev/null`
      : `git -C "${wtPath}" diff --name-only HEAD~1 2>/dev/null`;

    const output = execSync(diffCmd, {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 5000
    }).trim();

    return output ? output.split('\n').filter(Boolean) : [];
  } catch (e) {
    return [];
  }
}

// ============================================================================
// TASK ASSIGNMENT
// ============================================================================

const SKILL_REGISTRY_PATH = '.claude/pilot/config/skill-registry.json';

/**
 * Load the skill registry for task-to-agent scoring.
 */
function loadSkillRegistry() {
  try {
    const regPath = path.join(process.cwd(), SKILL_REGISTRY_PATH);
    return JSON.parse(fs.readFileSync(regPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Score how well an agent matches a task based on skill registry.
 *
 * @param {string} role - Agent role (e.g., 'frontend')
 * @param {object} task - Task with title, description, labels, files
 * @param {object} registry - Skill registry data
 * @returns {number} Score between 0 and 1
 */
function scoreAgentForTask(role, task, registry) {
  if (!registry || !registry.roles || !registry.roles[role]) return 0;

  const roleData = registry.roles[role];
  const weights = registry.scoring?.weights || {
    keyword_match: 0.35,
    file_pattern_match: 0.30,
    area_match: 0.20,
    affinity_bonus: 0.15
  };

  const text = `${task.title || ''} ${task.description || ''} ${(task.labels || []).join(' ')}`.toLowerCase();
  const files = task.files || [];

  // Keyword match score
  const keywords = roleData.task_keywords || [];
  const keywordHits = keywords.filter(kw => text.includes(kw.toLowerCase())).length;
  const keywordScore = keywords.length > 0 ? Math.min(keywordHits / 3, 1) : 0;

  // File pattern match score
  const filePatterns = roleData.file_patterns || [];
  let fileScore = 0;
  if (files.length > 0 && filePatterns.length > 0) {
    const fileHits = files.filter(f =>
      filePatterns.some(p => {
        const regex = new RegExp('^' + p.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
        return regex.test(f);
      })
    ).length;
    fileScore = Math.min(fileHits / files.length, 1);
  }

  // Area match score
  const areas = roleData.areas || [];
  const areaHits = areas.filter(a => text.includes(a.toLowerCase())).length;
  const areaScore = areas.length > 0 ? Math.min(areaHits / 2, 1) : 0;

  return (
    keywordScore * weights.keyword_match +
    fileScore * weights.file_pattern_match +
    areaScore * weights.area_match
  );
}

/**
 * Route a task to the best available agent based on skills.
 *
 * @param {object} task - Task object with title, description, labels, files
 * @param {string} [excludeSessionId] - Session to exclude (e.g., PM itself)
 * @returns {{ agent: object|null, scores: Array, confidence: number, reason: string }}
 */
function routeTaskToAgent(task, excludeSessionId = null) {
  const registry = loadSkillRegistry();
  if (!registry) {
    return { agent: null, scores: [], confidence: 0, reason: 'No skill registry found' };
  }

  const available = session.getAvailableAgents(excludeSessionId);
  if (available.length === 0) {
    return { agent: null, scores: [], confidence: 0, reason: 'No available agents' };
  }

  const threshold = registry.scoring?.confidence_threshold || 0.3;

  const scores = available.map(agent => ({
    ...agent,
    score: scoreAgentForTask(agent.role, task, registry)
  })).sort((a, b) => b.score - a.score);

  const best = scores[0];
  if (best.score < threshold) {
    return {
      agent: null,
      scores,
      confidence: best.score,
      reason: `Best match ${best.agent_name} (${best.role}) scored ${best.score.toFixed(2)}, below threshold ${threshold}`
    };
  }

  return {
    agent: best,
    scores,
    confidence: best.score,
    reason: `Best match: ${best.agent_name} (${best.role}) scored ${best.score.toFixed(2)}`
  };
}

/**
 * Assign a task to a specific agent session.
 * Sends a task_delegate message and optionally updates bd.
 *
 * @param {string} taskId - bd task ID
 * @param {string} targetSessionId - Session to assign to
 * @param {string} pmSessionId - PM's session ID (sender)
 * @param {object} opts - Additional options
 */
function assignTask(taskId, targetSessionId, pmSessionId, opts = {}) {
  // Send task delegation message
  const msgResult = messaging.sendTaskDelegate(
    pmSessionId,
    targetSessionId,
    {
      task_id: taskId,
      title: opts.title || taskId,
      description: opts.description || '',
      priority: opts.priority || 'normal'
    },
    { priority: 'normal' }
  );

  if (!msgResult.success) {
    return { success: false, error: `Failed to send delegation: ${msgResult.error}` };
  }

  // Publish decision to shared memory
  publishDecision('task_assigned', {
    task_id: taskId,
    assigned_to: targetSessionId,
    assigned_by: pmSessionId,
    reason: opts.reason || 'PM assignment'
  });

  // Log event
  session.logEvent({
    type: 'pm_task_assigned',
    pm_session: pmSessionId,
    target_session: targetSessionId,
    task_id: taskId
  });

  return {
    success: true,
    message_id: msgResult.id,
    task_id: taskId,
    assigned_to: targetSessionId
  };
}

/**
 * Reassign a task from one agent to another.
 */
function reassignTask(taskId, fromSessionId, toSessionId, pmSessionId, reason) {
  // Notify the current owner
  messaging.sendNotification(
    pmSessionId,
    fromSessionId,
    'task_reassigned',
    {
      task_id: taskId,
      reassigned_to: toSessionId,
      reason: reason || 'PM reassignment'
    }
  );

  // Delegate to new owner
  const result = assignTask(taskId, toSessionId, pmSessionId, { reason });

  // Log event
  session.logEvent({
    type: 'pm_task_reassigned',
    pm_session: pmSessionId,
    from_session: fromSessionId,
    to_session: toSessionId,
    task_id: taskId,
    reason
  });

  return result;
}

// ============================================================================
// AGENT BLOCKING
// ============================================================================

/**
 * Send a blocking message to halt an agent's work.
 *
 * @param {string} targetSessionId - Session to block
 * @param {string} pmSessionId - PM's session ID
 * @param {string} reason - Why the agent is being blocked
 */
function blockAgent(targetSessionId, pmSessionId, reason) {
  const msgResult = messaging.sendRequest(
    pmSessionId,
    targetSessionId,
    'agent_blocked',
    {
      action: 'stop_work',
      reason,
      blocked_by: pmSessionId
    },
    { priority: 'blocking' }
  );

  // Publish decision
  publishDecision('agent_blocked', {
    session_id: targetSessionId,
    blocked_by: pmSessionId,
    reason
  });

  session.logEvent({
    type: 'pm_agent_blocked',
    pm_session: pmSessionId,
    target_session: targetSessionId,
    reason
  });

  return {
    success: msgResult.success,
    message_id: msgResult.id,
    target_session: targetSessionId
  };
}

/**
 * Unblock a previously blocked agent.
 */
function unblockAgent(targetSessionId, pmSessionId) {
  const msgResult = messaging.sendNotification(
    pmSessionId,
    targetSessionId,
    'agent_unblocked',
    {
      action: 'resume_work',
      unblocked_by: pmSessionId
    }
  );

  publishDecision('agent_unblocked', {
    session_id: targetSessionId,
    unblocked_by: pmSessionId
  });

  return { success: msgResult.success };
}

// ============================================================================
// WORK REVIEW & MERGE APPROVAL
// ============================================================================

/**
 * Review completed work for a task before approving merge.
 *
 * @param {string} taskId - The task to review
 * @returns {{ approved: boolean, checks: object, issues: string[] }}
 */
function reviewWork(taskId) {
  const issues = [];
  const checks = {
    plan_complete: false,
    drift_check: false,
    worktree_clean: false,
    tests_pass: null  // null = not checked
  };

  // Find the session that owns this task
  const allSessions = session.getAllSessionStates();
  const ownerSession = allSessions.find(s => s.claimed_task === taskId);

  if (!ownerSession) {
    issues.push(`No session found with task ${taskId} claimed`);
    return { approved: false, checks, issues };
  }

  // Check 1: Drift detection
  const drift = detectDrift(ownerSession.session_id);
  if (drift.drifted) {
    issues.push(`Drift detected: ${drift.unplanned.length} unplanned files modified (score: ${drift.score})`);
    checks.drift_check = false;
  } else {
    checks.drift_check = true;
  }

  // Check 2: Plan completion (check if plan approval has all steps marked)
  const approvalPath = path.join(process.cwd(), PLAN_APPROVAL_DIR, 'plan-approval.json');
  if (fs.existsSync(approvalPath)) {
    try {
      const approval = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
      if (approval.task_id === taskId) {
        checks.plan_complete = approval.current_step >= approval.total_steps;
        if (!checks.plan_complete) {
          issues.push(`Plan incomplete: step ${approval.current_step} of ${approval.total_steps}`);
        }
      }
    } catch (e) {
      issues.push('Could not read plan approval state');
    }
  }

  // Check 3: Worktree clean (no uncommitted changes)
  if (ownerSession.worktree_path) {
    const wtStatus = worktree.getWorktreeStatus(taskId);
    if (wtStatus.exists) {
      checks.worktree_clean = !wtStatus.dirty;
      if (wtStatus.dirty) {
        issues.push('Worktree has uncommitted changes');
      }
    }
  } else {
    checks.worktree_clean = true; // No worktree = nothing to check
  }

  // Check 4: Run tests (optional, based on policy)
  const policy = loadPolicy();
  if (policy.orchestrator?.require_tests_pass) {
    try {
      execSync('npm test 2>/dev/null', {
        cwd: ownerSession.worktree_path || process.cwd(),
        timeout: 60000,
        encoding: 'utf8'
      });
      checks.tests_pass = true;
    } catch (e) {
      checks.tests_pass = false;
      issues.push('Tests failed');
    }
  }

  const approved = issues.length === 0;

  return { approved, checks, issues, session_id: ownerSession.session_id };
}

/**
 * Approve a merge for a completed task.
 *
 * @param {string} taskId - The task whose work to merge
 * @param {string} pmSessionId - PM's session ID
 */
function approveMerge(taskId, pmSessionId) {
  const review = reviewWork(taskId);

  if (!review.approved) {
    return {
      success: false,
      error: 'Work review failed',
      issues: review.issues,
      checks: review.checks
    };
  }

  // Attempt merge via worktree engine
  const mergeResult = worktree.mergeWorktree(taskId);

  // Publish decision
  publishDecision('merge_approved', {
    task_id: taskId,
    approved_by: pmSessionId,
    merge_result: mergeResult.success ? 'merged' : 'failed'
  });

  session.logEvent({
    type: 'pm_merge_approved',
    pm_session: pmSessionId,
    task_id: taskId,
    merge_success: mergeResult.success
  });

  // Notify the agent
  if (review.session_id) {
    messaging.sendNotification(
      pmSessionId,
      review.session_id,
      'merge_approved',
      {
        task_id: taskId,
        merged: mergeResult.success,
        conflicts: mergeResult.conflicts || false
      }
    );
  }

  return {
    success: mergeResult.success,
    merge_result: mergeResult,
    checks: review.checks
  };
}

/**
 * Reject a merge with feedback.
 */
function rejectMerge(taskId, pmSessionId, feedback) {
  const allSessions = session.getAllSessionStates();
  const ownerSession = allSessions.find(s => s.claimed_task === taskId);

  publishDecision('merge_rejected', {
    task_id: taskId,
    rejected_by: pmSessionId,
    feedback
  });

  if (ownerSession) {
    messaging.sendRequest(
      pmSessionId,
      ownerSession.session_id,
      'merge_rejected',
      {
        task_id: taskId,
        feedback,
        action_required: 'fix_issues'
      },
      { priority: 'normal' }
    );
  }

  session.logEvent({
    type: 'pm_merge_rejected',
    pm_session: pmSessionId,
    task_id: taskId,
    feedback
  });

  return { success: true, task_id: taskId, feedback };
}

// ============================================================================
// PM DECISIONS (SHARED MEMORY)
// ============================================================================

/**
 * Publish a PM decision to shared memory so all agents can see it.
 */
function publishDecision(type, data) {
  try {
    // Read current decisions
    let current = { decisions: [] };
    try {
      const existing = memory.read(PM_DECISIONS_CHANNEL);
      if (existing && existing.data) {
        current = existing.data;
      }
    } catch (e) {
      // Channel may not exist yet
    }

    // Add new decision
    current.decisions.push({
      type,
      ts: new Date().toISOString(),
      ...data
    });

    // Keep only last 50 decisions
    if (current.decisions.length > 50) {
      current.decisions = current.decisions.slice(-50);
    }

    memory.publish(PM_DECISIONS_CHANNEL, current, {
      agent: 'pm',
      summary: `PM decision: ${type}`
    });
  } catch (e) {
    // Best effort — don't break operations if memory publish fails
  }
}

// ============================================================================
// STALE AGENT MANAGEMENT
// ============================================================================

/**
 * Handle stale agents: reassign their tasks or clean up.
 *
 * @param {string} pmSessionId - PM's session ID
 */
function handleStaleAgents(pmSessionId) {
  const policy = loadPolicy();
  const staleAgents = getStaleAgents();
  const results = [];

  for (const agent of staleAgents) {
    // Dead agents (process exited) are always cleaned up immediately
    if (agent.status === 'dead') {
      session.releaseTask(agent.session_id);
      session.endSession(agent.session_id, 'process_dead');
      session.removeSessionLock(agent.session_id);

      session.logEvent({
        type: 'pm_dead_agent_cleanup',
        pm_session: pmSessionId,
        dead_session: agent.session_id,
        task_id: agent.claimed_task,
        action: 'cleaned_up'
      });

      results.push({
        session_id: agent.session_id,
        task_id: agent.claimed_task,
        status: 'dead',
        action: 'cleaned_up'
      });
      continue;
    }

    if (!agent.claimed_task) continue;

    if (policy.orchestrator?.auto_reassign_stale) {
      // Release the stale session's task
      session.releaseTask(agent.session_id);
      session.endSession(agent.session_id, 'stale');

      session.logEvent({
        type: 'pm_stale_cleanup',
        pm_session: pmSessionId,
        stale_session: agent.session_id,
        task_id: agent.claimed_task,
        action: 'released'
      });

      results.push({
        session_id: agent.session_id,
        task_id: agent.claimed_task,
        status: agent.status,
        action: 'released_and_ended'
      });
    } else {
      // Just flag it
      publishDecision('stale_agent_detected', {
        session_id: agent.session_id,
        task_id: agent.claimed_task,
        heartbeat_age_sec: agent.heartbeat_age_sec,
        process_alive: agent.process_alive
      });

      results.push({
        session_id: agent.session_id,
        task_id: agent.claimed_task,
        status: agent.status,
        action: 'flagged'
      });
    }
  }

  return results;
}

// ============================================================================
// PM STATE MANAGEMENT
// ============================================================================

/**
 * Initialize PM state for a new PM session.
 */
function initializePm(pmSessionId) {
  ensurePmStateDir();

  const state = {
    pm_session_id: pmSessionId,
    started_at: new Date().toISOString(),
    last_scan: null,
    decisions_count: 0,
    agents_blocked: [],
    merges_approved: 0,
    merges_rejected: 0
  };

  fs.writeFileSync(getPmStatePath(), JSON.stringify(state, null, 2));

  session.logEvent({
    type: 'pm_initialized',
    pm_session: pmSessionId
  });

  return state;
}

/**
 * Load PM state.
 */
function loadPmState() {
  const statePath = getPmStatePath();
  if (!fs.existsSync(statePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Update PM state.
 */
function updatePmState(updates) {
  const state = loadPmState();
  if (!state) return null;

  Object.assign(state, updates, { last_scan: new Date().toISOString() });
  fs.writeFileSync(getPmStatePath(), JSON.stringify(state, null, 2));
  return state;
}

// ============================================================================
// PM SELF-CHECKPOINT (Phase 3.5)
// ============================================================================

/**
 * PM saves its own orchestrator state before context pressure gets critical.
 * This allows the PM to resume its coordination role after compaction.
 *
 * Captures: active agents, pending decisions, task assignments, queue state.
 *
 * @param {string} pmSessionId - PM's session ID
 * @returns {{ success: boolean, version?: number }}
 */
function pmCheckpointSelf(pmSessionId) {
  try {
    const checkpoint = require('./checkpoint');

    // Gather PM state
    const pmState = loadPmState();
    const activeSessions = session.getActiveSessions(pmSessionId);
    const agentHealth = getAgentHealth();

    // Get recent PM decisions
    let recentDecisions = [];
    try {
      const pmChannel = memory.read(PM_DECISIONS_CHANNEL);
      if (pmChannel?.data?.decisions) {
        recentDecisions = pmChannel.data.decisions.slice(-10);
      }
    } catch (e) {
      // No decisions yet
    }

    // Build PM-specific checkpoint data
    const result = checkpoint.saveCheckpoint(pmSessionId, {
      task_id: 'PM-orchestrator',
      task_title: 'PM Orchestrator — Autonomous Coordination',
      current_context: JSON.stringify({
        pm_state: pmState,
        active_agents: activeSessions.map(s => ({
          session_id: s.session_id,
          claimed_task: s.claimed_task,
          locked_areas: s.locked_areas
        })),
        agent_health: agentHealth.map(a => ({
          session_id: a.session_id,
          status: a.status,
          claimed_task: a.claimed_task
        })),
        recent_decisions: recentDecisions
      }),
      key_decisions: recentDecisions.map(d =>
        `[${d.type}] ${d.task_id || ''}: ${d.reason || d.message || ''}`
      ).slice(0, 10),
      important_findings: [
        `Active agents: ${activeSessions.length}`,
        `Agent health: ${agentHealth.filter(a => a.status === 'healthy').length} healthy`
      ]
    });

    return { success: result.success, version: result.version };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Project overview
  getProjectOverview,
  getRecentEvents,

  // Agent health
  getAgentHealth,
  getStaleAgents,

  // Drift detection
  detectDrift,
  getPlannedFiles,
  extractFilesFromPlan,

  // Task routing & assignment
  loadSkillRegistry,
  scoreAgentForTask,
  routeTaskToAgent,
  assignTask,
  reassignTask,

  // Agent control
  blockAgent,
  unblockAgent,

  // Work review & merge
  reviewWork,
  approveMerge,
  rejectMerge,

  // Stale management
  handleStaleAgents,

  // PM state
  initializePm,
  loadPmState,
  updatePmState,
  pmCheckpointSelf,

  // Shared memory
  publishDecision,

  // Constants
  PM_DECISIONS_CHANNEL,
  DEFAULT_DRIFT_THRESHOLD
};
