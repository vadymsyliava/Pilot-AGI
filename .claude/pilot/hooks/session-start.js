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

      // Read back session state for agent identity
      const sessionState = session.updateSession(sessionId, {}) || {};
      const agentRole = sessionState.role || null;
      const agentName = sessionState.agent_name || sessionId;
      const capabilities = session.getAgentCapabilities(agentRole);

      const messaging = require('./lib/messaging');

      // Broadcast session announcement with agent identity
      messaging.sendBroadcast(sessionId, 'agent_introduced', {
        session_id: sessionId,
        agent_name: agentName,
        role: agentRole,
        capabilities: capabilities,
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
      const name = s.agent_name || s.session_id;
      const roleTag = s.role ? `[${s.role}]` : '';
      const task = s.claimed_task
        ? `working on [${s.claimed_task}]`
        : 'idle';
      const areas = (s.locked_areas || []).length > 0
        ? ` (locked: ${s.locked_areas.join(', ')})`
        : '';
      return `  ${name} ${roleTag}: ${task}${areas}`;
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
  // 7a. Auto-Resume from Checkpoint (Phase 3.5)
  // -------------------------------------------------------------------------

  try {
    const checkpoint = require('./lib/checkpoint');

    // Check all recent sessions for checkpoints (current + previous)
    // A checkpoint may exist under a prior session ID if the agent restarted
    const sessDir = path.join(process.cwd(), '.claude/pilot/state/sessions');
    let savedCheckpoint = null;

    // First try: load checkpoint for the new session ID
    savedCheckpoint = checkpoint.loadCheckpoint(sessionId);

    // Second try: scan recent session files for a checkpoint with a claimed task
    if (!savedCheckpoint && fs.existsSync(sessDir)) {
      const sessFiles = fs.readdirSync(sessDir)
        .filter(f => f.startsWith('S-') && f.endsWith('.json') && !f.includes('.pressure'))
        .sort()
        .reverse()
        .slice(0, 5); // Check last 5 sessions

      for (const f of sessFiles) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
          if (data.session_id && data.session_id !== sessionId) {
            const cp = checkpoint.loadCheckpoint(data.session_id);
            if (cp && cp.task_id) {
              savedCheckpoint = cp;
              break;
            }
          }
        } catch (e) {
          continue;
        }
      }
    }

    if (savedCheckpoint && savedCheckpoint.task_id) {
      const restorePrompt = checkpoint.buildRestorationPrompt(savedCheckpoint);
      if (restorePrompt) {
        context.checkpoint_restored = true;
        context.restored_task = savedCheckpoint.task_id;
        context.restored_version = savedCheckpoint.version;

        // Prepend restoration context so the agent sees it first
        messages.unshift(`CHECKPOINT RESTORED (v${savedCheckpoint.version}): Task ${savedCheckpoint.task_id}`);

        // Add the full restoration prompt to system message
        output.systemMessage = restorePrompt + '\n\n' + (output.systemMessage || '');
      }
    }
  } catch (e) {
    // Checkpoint restore failed — continue without, agent can use /pilot-resume-context
  }

  // -------------------------------------------------------------------------
  // 7b. Recoverable Tasks Check (Phase 3.8)
  // -------------------------------------------------------------------------

  try {
    const orchestrator = require('./lib/orchestrator');
    const recoverableTasks = orchestrator.getRecoverableTasks();
    if (recoverableTasks.length > 0 && !context.checkpoint_restored) {
      // There are tasks from dead agents that can be resumed
      context.recoverable_tasks = recoverableTasks.map(rt => ({
        task_id: rt.task_id,
        plan_step: rt.plan_step,
        total_steps: rt.total_steps,
        title: rt.task_title
      }));
      messages.push(`${recoverableTasks.length} recoverable task(s) from dead agents`);
    }
  } catch (e) {
    // Recovery check failed, continue without
  }

  // -------------------------------------------------------------------------
  // 7c. Worktree Context (Phase 2.1)
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
  // 8d. Agent Memory Context (Phase 3.7)
  // -------------------------------------------------------------------------

  try {
    const agentMemory = require('./lib/memory');

    // Resolve agent type from session state
    let agentType = null;
    try {
      const sessDir = path.join(process.cwd(), '.claude/pilot/state/sessions');
      const sessFile = path.join(sessDir, `${sessionId}.json`);
      if (fs.existsSync(sessFile)) {
        const sessData = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
        agentType = sessData.role || null;
      }
    } catch (e) {
      // No session state — skip agent memory
    }

    if (agentType) {
      const agentContext = {};

      // Load recent discoveries (last 10)
      const discoveries = agentMemory.getDiscoveries(agentType);
      if (discoveries.length > 0) {
        agentContext.discoveries = discoveries.slice(-10);
      }

      // Load recent decisions (last 10)
      const decisions = agentMemory.getDecisions(agentType, { limit: 10 });
      if (decisions.length > 0) {
        agentContext.decisions = decisions;
      }

      // Load recent errors (last 10)
      const errors = agentMemory.getErrors(agentType, { limit: 10 });
      if (errors.length > 0) {
        agentContext.errors = errors;
      }

      // Load preferences
      const prefs = agentMemory.getAgentMemory(agentType, 'preferences');
      if (prefs) {
        agentContext.preferences = prefs;
      }

      if (Object.keys(agentContext).length > 0) {
        context.agent_memory = { type: agentType, ...agentContext };
        const counts = [];
        if (agentContext.discoveries) counts.push(`${agentContext.discoveries.length} discoveries`);
        if (agentContext.decisions) counts.push(`${agentContext.decisions.length} decisions`);
        if (agentContext.errors) counts.push(`${agentContext.errors.length} errors`);
        messages.push(`Agent memory [${agentType}]: ${counts.join(', ')}`);
      }
    }
  } catch (e) {
    // Agent memory not available, continue without
  }

  // -------------------------------------------------------------------------
  // 8e. Agent Soul Context (Phase 7.1)
  // -------------------------------------------------------------------------

  try {
    const souls = require('./lib/souls');

    // Resolve agent role from session state
    let soulRole = null;
    try {
      const sessDir = path.join(process.cwd(), '.claude/pilot/state/sessions');
      const sessFile = path.join(sessDir, `${sessionId}.json`);
      if (fs.existsSync(sessFile)) {
        const sessData = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
        soulRole = sessData.role || null;
      }
    } catch (e) {
      // No session state — skip soul
    }

    if (soulRole) {
      // Auto-initialize soul on first session for this role
      if (!souls.soulExists(soulRole)) {
        souls.initializeSoul(soulRole);
      }

      const soulCtx = souls.loadSoulContext(soulRole);
      if (soulCtx) {
        context.agent_soul = soulCtx;
        const size = souls.getSoulSize(soulRole);
        messages.push(`Soul [${soulRole}]: loaded (${size}b)`);
      }

      // Phase 7.2: Load task-relevant lessons for pre-task context
      try {
        const postMortem = require('./lib/post-mortem');
        const taskDesc = context.current_task?.description || context.current_task?.title || '';
        if (taskDesc) {
          const relevantLessons = postMortem.getRelevantLessons(soulRole, taskDesc);
          if (relevantLessons.length > 0) {
            context.pre_task_lessons = relevantLessons;
            messages.push(`Lessons: ${relevantLessons.length} relevant`);
          }
        }
      } catch (e) {
        // Post-mortem module not available, continue without
      }
    }
  } catch (e) {
    // Soul module not available, continue without
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
  // 8c2. PM Hub Connection (Phase 5.0)
  // -------------------------------------------------------------------------

  try {
    const { AgentConnector } = require('./lib/agent-connector');

    // Resolve agent role from session state
    let agentRole = 'general';
    let agentCaps = [];
    try {
      const sessFile = path.join(process.cwd(), '.claude/pilot/state/sessions', `${sessionId}.json`);
      if (fs.existsSync(sessFile)) {
        const sessData = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
        agentRole = sessData.role || 'general';
        agentCaps = session.getAgentCapabilities(agentRole) || [];
      }
    } catch (e) { /* use defaults */ }

    const connector = new AgentConnector(sessionId, {
      projectRoot: process.cwd(),
      role: agentRole,
      capabilities: agentCaps,
      autoReconnect: true
    });

    // connect() tries HTTP register (sync) + starts WS upgrade (async)
    const connectResult = connector.connect();

    if (connectResult.connected) {
      context.pm_connected = true;
      context.pm_hub_mode = connectResult.mode; // 'http' or 'websocket'
      context.pm_hub_port = connectResult.port;
      messages.push('PM Hub: connected (' + connectResult.mode + ', port ' + connectResult.port + ')');
    } else if (connectResult.fallback === 'file_bus') {
      context.pm_connected = false;
      context.pm_fallback = 'file_bus';
      // WS may still be connecting in background — silent fallback
    }

    // Store connector reference for other hooks (heartbeat, post-tool-use)
    // Write connector state to a temp file for cross-hook access
    try {
      const connectorState = {
        session_id: sessionId,
        port: connector.port,
        pm_connected: connectResult.connected,
        mode: connectResult.mode || 'file_bus',
        pid: process.pid,
        started_at: new Date().toISOString()
      };
      const stateDir = path.join(process.cwd(), '.claude/pilot/state/connectors');
      if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
      const tmpPath = path.join(stateDir, sessionId + '.json.tmp');
      const finalPath = path.join(stateDir, sessionId + '.json');
      fs.writeFileSync(tmpPath, JSON.stringify(connectorState, null, 2));
      fs.renameSync(tmpPath, finalPath);
    } catch (e) { /* best effort */ }
  } catch (e) {
    // Agent connector not available, skip (file bus fallback)
  }

  // -------------------------------------------------------------------------
  // 8d. Per-Agent Persistent Memory (Phase 3.7)
  // -------------------------------------------------------------------------

  try {
    const memory = require('./lib/memory');

    // Determine this agent's role from the session we just registered
    const agentRole = context.session_id
      ? (() => {
          try {
            const sessFile = path.join(process.cwd(), '.claude/pilot/state/sessions', `${sessionId}.json`);
            const sess = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
            return sess.role || null;
          } catch (e) { return null; }
        })()
      : null;

    if (agentRole) {
      const agentMemory = {};

      // Load preferences
      const prefs = memory.getAgentMemory(agentRole, 'preferences');
      if (prefs) {
        agentMemory.preferences = prefs;
      }

      // Load recent decisions (last 10, token-efficient)
      const decisions = memory.getDecisions(agentRole, { limit: 10 });
      if (decisions.length > 0) {
        agentMemory.recent_decisions = decisions;
      }

      // Load recent discoveries (last 10)
      const discoveries = memory.getDiscoveries(agentRole).slice(-10);
      if (discoveries.length > 0) {
        agentMemory.recent_discoveries = discoveries;
      }

      // Load recent errors (last 5)
      const errors = memory.getErrors(agentRole, { limit: 5 });
      if (errors.length > 0) {
        agentMemory.recent_errors = errors;
      }

      if (Object.keys(agentMemory).length > 0) {
        context.agent_memory = agentMemory;
        context.agent_memory_role = agentRole;
        const entryCount = (decisions.length || 0) + (discoveries.length || 0) + (errors.length || 0) + (prefs ? 1 : 0);
        messages.push(`Agent memory: ${entryCount} entries for ${agentRole}`);
      }
    }
  } catch (e) {
    // Agent memory not available, continue without
  }

  // -------------------------------------------------------------------------
  // 8e. Agent Self-Activation (Phase 3.6)
  // -------------------------------------------------------------------------

  try {
    const { isAutonomousEnabled, loadAutonomousConfig } = require('./lib/agent-loop');

    // Determine this agent's role
    let autoRole = null;
    try {
      const sessFile = path.join(process.cwd(), '.claude/pilot/state/sessions', `${sessionId}.json`);
      if (fs.existsSync(sessFile)) {
        const sess = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
        autoRole = sess.role || null;
      }
    } catch (e) { /* no role */ }

    if (autoRole && isAutonomousEnabled(autoRole)) {
      const config = loadAutonomousConfig(autoRole);
      context.autonomous_mode = true;
      context.autonomous_config = {
        auto_claim: config.auto_claim,
        auto_plan: config.auto_plan,
        auto_exec: config.auto_exec,
        checkpoint_at_pressure_pct: config.checkpoint_at_pressure_pct
      };
      messages.push(`AUTONOMOUS MODE active (${autoRole})`);

      // Check for pending delegations on the bus
      try {
        const messaging = require('./lib/messaging');
        const { messages: busMessages } = messaging.readMessages(sessionId, {
          role: autoRole,
          types: ['task_delegate', 'notify']
        });
        const delegations = busMessages.filter(m =>
          m.type === 'task_delegate' || m.topic === 'task.assign'
        );
        if (delegations.length > 0) {
          context.pending_delegations = delegations.length;
          const first = delegations[0];
          const taskId = first.payload?.data?.bd_task_id || first.payload?.data?.task_id;
          messages.push(`${delegations.length} delegation(s) waiting${taskId ? ` — top: ${taskId}` : ''}`);
        }
      } catch (e) {
        // Bus not available
      }

      // Check for pending agent actions from a previous session
      try {
        const agentActions = require('./lib/agent-actions');
        if (agentActions.hasPendingActions(sessionId)) {
          const stats = agentActions.getQueueStats(sessionId);
          context.pending_agent_actions = stats.pending;
          messages.push(`${stats.pending} queued action(s)`);
        }
      } catch (e) {
        // Agent actions not available
      }
    }
  } catch (e) {
    // Agent loop module not available, continue without
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
