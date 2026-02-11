#!/usr/bin/env node

/**
 * Pilot AGI Session Start Hook (v2.1 - Governance Focus)
 *
 * GOVERNANCE HOOK: Provides session context and coordination.
 *
 * This hook is part of Pilot AGI's governance layer, NOT workflow automation.
 * It focuses on policy enforcement and multi-agent coordination.
 *
 * Governance features:
 * - Session ID generation and registration
 * - Multi-session coordination (detect other active sessions)
 * - Locked file/area awareness (prevents conflicts)
 * - Policy loading and enforcement context
 * - bd task context injection (governance state)
 *
 * Non-governance features (removed or delegated):
 * - Version update checking → Removed (use npm/CLI)
 * - Workflow hints → Kept minimal (context only, not commands)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Import session, policy, cache, teleport, and worktree utilities
const session = require('./lib/session');
const { loadPolicy } = require('./lib/policy');
const cache = require('./lib/cache');
const teleport = require('./lib/teleport');
const worktreeEngine = require('./lib/worktree');

// =============================================================================
// VERSION CHECK (REMOVED - handled by npm/CLI)
// =============================================================================
// Version update checking has been removed from this hook.
// Reason: This duplicates Claude Code's built-in update notification
// and npm's standard package update mechanisms.
//
// To check for updates manually: npm outdated -g pilot-agi
// =============================================================================

// =============================================================================
// BEADS CONTEXT (enhanced in v2.1 with task list summary)
// Note: Uses execSync with hardcoded command - no user input interpolation
// =============================================================================

function getBeadsContext(policy) {
  if (!fs.existsSync(path.join(process.cwd(), '.beads'))) return null;

  // Get task list display settings from policy
  const displaySettings = policy?.session?.task_list_display || {
    max_ready_tasks: 5,
    show_priority: true,
    enabled: true
  };

  // Skip task list summary if disabled in policy
  if (!displaySettings.enabled) {
    return { hasTask: false, readyCount: 0 };
  }

  try {
    // Use the enhanced buildTaskListSummary from cache module
    const taskSummary = cache.buildTaskListSummary({
      maxReadyTasks: displaySettings.max_ready_tasks,
      showPriority: displaySettings.show_priority
    });

    return {
      currentTask: taskSummary.activeTask,
      hasTask: !!taskSummary.activeTask,
      readyCount: taskSummary.readyCount,
      state: taskSummary.state,
      taskListSummary: taskSummary.summary
    };
  } catch (e) {
    // Fallback to basic check (hardcoded commands - no user input)
    try {
      const result = execSync('bd list --status in_progress --json 2>/dev/null || echo "[]"', {
        encoding: 'utf8', timeout: 5000
      });
      const tasks = JSON.parse(result);
      if (tasks.length > 0) {
        return {
          currentTask: { id: tasks[0].id, title: tasks[0].title },
          hasTask: true
        };
      }

      const ready = JSON.parse(execSync('bd ready --json 2>/dev/null || echo "[]"', {
        encoding: 'utf8', timeout: 5000
      }));
      return { readyCount: ready.length, hasTask: false };
    } catch (e2) {
      return null;
    }
  }
}

// =============================================================================
// SESSION CAPSULE (preserved from v1)
// =============================================================================

function getSessionCapsule() {
  const runsDir = path.join(process.cwd(), 'runs');
  if (!fs.existsSync(runsDir)) return null;

  try {
    const files = fs.readdirSync(runsDir).filter(f => f.endsWith('.md')).sort().reverse();
    if (files.length === 0) return null;

    const content = fs.readFileSync(path.join(runsDir, files[0]), 'utf8');
    const nextActionMatch = content.match(/Next action:\s*(.+)/);
    const resumeMatch = content.match(/Resume:\s*(.+)/);

    return {
      file: files[0],
      nextAction: nextActionMatch ? nextActionMatch[1].trim() : null,
      resumeHint: resumeMatch ? resumeMatch[1].trim() : null
    };
  } catch (e) {
    return null;
  }
}

// =============================================================================
// PROJECT CONTEXT (new in v2)
// =============================================================================

function getProjectContext() {
  const context = {
    hasProject: false,
    hasBrief: false,
    hasRoadmap: false
  };

  // Check for PROJECT_BRIEF.md
  const briefPaths = [
    path.join(process.cwd(), 'work', 'PROJECT_BRIEF.md'),
    path.join(process.cwd(), 'PROJECT_BRIEF.md')
  ];

  for (const p of briefPaths) {
    if (fs.existsSync(p)) {
      context.hasProject = true;
      context.hasBrief = true;
      break;
    }
  }

  // Check for ROADMAP.md
  const roadmapPaths = [
    path.join(process.cwd(), 'work', 'ROADMAP.md'),
    path.join(process.cwd(), 'ROADMAP.md')
  ];

  for (const p of roadmapPaths) {
    if (fs.existsSync(p)) {
      context.hasRoadmap = true;
      break;
    }
  }

  return context;
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  // Read stdin for hook input (contains session_id from Claude Code)
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
    // No stdin or invalid JSON, proceed without
  }

  const output = {
    continue: true,
    systemMessage: ''
  };

  const messages = [];
  const context = {};

  // -------------------------------------------------------------------------
  // 1. Session Management (new in v2)
  // -------------------------------------------------------------------------

  // Clean up stale sessions first
  try {
    session.cleanupStaleSessions();
  } catch (e) {
    // Best effort cleanup
  }

  // Generate and register new session
  const sessionId = session.generateSessionId();
  try {
    session.registerSession(sessionId, {
      hook_session_id: hookInput.session_id // Claude's session ID
    });
    context.session_id = sessionId;

    // Announce new session to event stream + message bus
    try {
      const { execFileSync } = require('child_process');

      // Gather task context for the announcement
      let readyCount = 0;
      let topTaskId = null;
      let topTaskTitle = null;
      try {
        const readyJson = execFileSync('bd', ['ready', '--json'], {
          encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
        });
        const readyTasks = JSON.parse(readyJson);
        readyCount = readyTasks.length;
        if (readyTasks.length > 0) {
          topTaskId = readyTasks[0].id;
          topTaskTitle = readyTasks[0].title;
        }
      } catch (bdErr) {
        // bd not available — skip task context
      }

      // Count live peers (excluding self)
      const peerCount = session.getActiveSessions(sessionId).filter(s =>
        session.isSessionAlive(s.session_id)
      ).length;

      session.logEvent({
        type: 'session_announced',
        session_id: sessionId,
        pid: process.pid,
        peers: peerCount,
        ready_tasks: readyCount,
        top_task: topTaskId
      });

      const messaging = require('./lib/messaging');
      messaging.sendBroadcast(sessionId, 'session_announced', {
        session_id: sessionId,
        message: `New agent joined: ${sessionId}`,
        peers: peerCount,
        ready_tasks: readyCount,
        top_task: topTaskId ? { id: topTaskId, title: topTaskTitle } : null
      });
    } catch (announceErr) {
      // Best effort — don't block startup
    }
  } catch (e) {
    // Continue without registration
  }

  // Check for other active sessions
  const activeSessions = session.getActiveSessions(sessionId);
  if (activeSessions.length > 0) {
    context.active_sessions = activeSessions.length;

    // Build rich agent awareness status
    const maxSessions = policy?.session?.max_concurrent_sessions || 6;
    const agentLines = activeSessions.map(s => {
      const task = s.claimed_task
        ? `working on [${s.claimed_task}]`
        : 'idle';
      const areas = (s.locked_areas || []).length > 0
        ? ` (locked: ${s.locked_areas.join(', ')})`
        : '';
      return `  ${s.session_id}: ${task}${areas}`;
    });

    // Gather ready task count for the welcome summary
    let announcedReadyCount = 0;
    let announcedTopTask = null;
    try {
      const { execFileSync } = require('child_process');
      const readyJson = execFileSync('bd', ['ready', '--json'], {
        encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
      });
      const readyTasks = JSON.parse(readyJson);
      announcedReadyCount = readyTasks.length;
      if (readyTasks.length > 0) {
        announcedTopTask = `[${readyTasks[0].id}] ${readyTasks[0].title}`;
      }
    } catch (bdErr) {
      // bd not available
    }

    messages.push(
      `You are Agent ${activeSessions.length + 1} of ${maxSessions} max\n` +
      `Active peers (${activeSessions.length}):\n` +
      agentLines.join('\n') +
      (announcedReadyCount > 0
        ? `\n${announcedReadyCount} tasks available` +
          (announcedTopTask ? `, top: ${announcedTopTask}` : '')
        : '')
    );

    // Get locked files and areas
    const lockedFiles = session.getLockedFiles(activeSessions);
    const lockedAreas = session.getLockedAreas(activeSessions);

    if (lockedFiles.length > 0) {
      context.locked_files = lockedFiles;
    }
    if (lockedAreas.length > 0) {
      context.locked_areas = lockedAreas;
      messages.push(`Locked areas: ${lockedAreas.join(', ')}`);
    }
  }

  // -------------------------------------------------------------------------
  // 1b. Teleport Resume Detection (new in v2.1)
  // -------------------------------------------------------------------------

  // Check if this session was resumed via teleport
  if (teleport.isTeleportResume()) {
    const teleportContext = teleport.loadTeleportContext();
    if (teleportContext) {
      context.teleport_resume = true;
      context.teleport_context = teleportContext;
      messages.push('TELEPORTED: Context restored');

      // Add resume instructions
      const resumeMsg = teleport.buildTeleportResumeMessage();
      if (resumeMsg) {
        context.teleport_resume_message = resumeMsg;
      }

      // Clear teleport context after loading (one-time use)
      teleport.clearTeleportContext();
    }
  }

  // -------------------------------------------------------------------------
  // 2. Policy Loading (new in v2)
  // -------------------------------------------------------------------------

  let policy = null;
  try {
    policy = loadPolicy();
    context.policy_version = policy.version;
    context.enforcement = {
      require_active_task: policy.enforcement?.require_active_task,
      require_plan_approval: policy.enforcement?.require_plan_approval
    };
  } catch (e) {
    // Continue without policy
  }

  // -------------------------------------------------------------------------
  // 3. Project Context (new in v2)
  // -------------------------------------------------------------------------

  const project = getProjectContext();
  if (project.hasProject) {
    context.has_project = true;
  } else {
    context.has_project = false;
    // Only mention if no tasks exist (likely new project)
  }

  // -------------------------------------------------------------------------
  // 4. Version Check - REMOVED (handled by npm/CLI)
  // -------------------------------------------------------------------------
  // Version checking removed to reduce hook complexity.
  // Users can check updates via: npm outdated -g pilot-agi

  // -------------------------------------------------------------------------
  // 5. Beads Context (enhanced in v2.1 with task list summary)
  // -------------------------------------------------------------------------

  const bd = getBeadsContext(policy);
  if (bd) {
    // Include task list summary in context for Claude visibility
    if (bd.taskListSummary) {
      context.task_list = bd.taskListSummary;
    }

    if (bd.currentTask) {
      messages.push(`Active: [${bd.currentTask.id}] ${bd.currentTask.title}`);
      context.active_task = bd.currentTask;
      context.workflow_state = bd.state;
    } else if (bd.readyCount > 0) {
      messages.push(`${bd.readyCount} tasks ready`);
      context.ready_tasks = bd.readyCount;
    }
  }

  // -------------------------------------------------------------------------
  // 6. Session Capsule (preserved from v1)
  // -------------------------------------------------------------------------

  const capsule = getSessionCapsule();
  if (capsule) {
    const hint = capsule.resumeHint || capsule.nextAction;
    if (hint) {
      messages.push(`Resume: ${hint}`);
      context.resume_hint = hint;
    }
  }

  // -------------------------------------------------------------------------
  // 7. Guardian Cache (new in v2.1)
  // -------------------------------------------------------------------------

  try {
    if (cache.needsRefresh()) {
      const cacheResult = cache.refreshCache();
      context.cache_refreshed = true;
      context.task_count = cacheResult.taskCount;
    }
  } catch (e) {
    // Cache refresh failed, continue without
  }

  // -------------------------------------------------------------------------
  // 7b. Worktree Context (Phase 2.1)
  // -------------------------------------------------------------------------

  try {
    var wtConfig = worktreeEngine.getConfig();
    if (wtConfig.enabled) {
      var activeWorktrees = worktreeEngine.listWorktrees();
      if (activeWorktrees.length > 0) {
        context.worktrees = activeWorktrees.map(function(wt) {
          return {
            branch: wt.branch,
            locked: !!wt.locked
          };
        });
        messages.push(activeWorktrees.length + ' worktree(s) active');
      }
    }
  } catch (e) {
    // Worktree context failed, continue without
  }

  // -------------------------------------------------------------------------
  // 8. Shared Memory Context (Phase 2.2)
  // -------------------------------------------------------------------------

  try {
    const memory = require('./lib/memory');
    const channels = memory.listChannels();
    const summaries = [];

    for (const channel of channels) {
      const summary = memory.readSummary(channel);
      if (summary && summary.summary) {
        summaries.push(`${channel} (v${summary.version}): ${summary.summary}`);
      }
    }

    if (summaries.length > 0) {
      context.shared_memory = summaries;
      messages.push(`Memory: ${summaries.length} channel(s)`);
    }
  } catch (e) {
    // Shared memory not available, continue without
  }

  // -------------------------------------------------------------------------
  // 8b. Inter-Agent Messaging Context (Phase 2.3)
  // -------------------------------------------------------------------------

  try {
    const messaging = require('./lib/messaging');

    // Initialize cursor for this session (starts at bus EOF)
    messaging.initializeCursor(sessionId);

    // Check for pending messages
    const { messages: pendingMsgs } = messaging.readMessages(sessionId);
    if (pendingMsgs.length > 0) {
      const blocking = pendingMsgs.filter(m => m.priority === 'blocking');
      const normal = pendingMsgs.filter(m => m.priority === 'normal');

      context.pending_messages = pendingMsgs.length;
      if (blocking.length > 0) {
        context.blocking_messages = blocking.length;
        messages.push(`${blocking.length} BLOCKING message(s) waiting`);
      }
      if (normal.length > 0) {
        messages.push(`${normal.length} message(s) pending`);
      }
    }

    // Bus stats for context
    const stats = messaging.getBusStats();
    if (stats.bus_exists) {
      context.message_bus = {
        messages: stats.message_count,
        size_bytes: stats.bus_size_bytes,
        needs_compaction: stats.needs_compaction
      };
    }
  } catch (e) {
    // Messaging not available yet, skip
  }

  // -------------------------------------------------------------------------
  // 8c. PM Orchestrator Context (Phase 2.4)
  // -------------------------------------------------------------------------

  try {
    const orchestrator = require('./lib/orchestrator');

    // Load PM state if this is a PM session or PM exists
    const pmState = orchestrator.loadPmState();
    if (pmState) {
      context.pm_active = true;
      context.pm_session = pmState.pm_session_id;
    }

    // Check for recent PM decisions that affect this agent
    const memory = require('./lib/memory');
    try {
      const pmChannel = memory.read('pm-decisions');
      if (pmChannel && pmChannel.data && pmChannel.data.decisions) {
        const recent = pmChannel.data.decisions.slice(-5);
        const relevant = recent.filter(d =>
          d.assigned_to === sessionId ||
          d.session_id === sessionId ||
          d.type === 'agent_blocked'
        );
        if (relevant.length > 0) {
          context.pm_decisions = relevant;
          messages.push(`PM: ${relevant.length} decision(s) affecting you`);
        }
      }
    } catch (e) {
      // PM decisions channel not available
    }
  } catch (e) {
    // Orchestrator not available, skip
  }

  // -------------------------------------------------------------------------
  // 9. Build Output
  // -------------------------------------------------------------------------

  if (messages.length > 0) {
    output.systemMessage = messages.join(' | ');
  }

  // Add teleport resume message if present
  if (context.teleport_resume_message) {
    output.systemMessage = context.teleport_resume_message + '\n\n' + (output.systemMessage || '');
  }

  // Add context as additional data in output
  output.hookSpecificOutput = {
    hookEventName: 'SessionStart',
    context: context
  };

  console.log(JSON.stringify(output));
}

main().catch(() => {
  // Fail gracefully
  console.log(JSON.stringify({ continue: true }));
});
