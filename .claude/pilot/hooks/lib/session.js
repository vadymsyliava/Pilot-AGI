/**
 * Session Management
 *
 * Handles session ID generation, registration, and multi-session coordination.
 * Used by hooks to track and coordinate concurrent Claude Code sessions.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { loadPolicy } = require('./policy');
const worktree = require('./worktree');

const EVENT_STREAM_FILE = 'runs/sessions.jsonl';
const SESSION_STATE_DIR = '.claude/pilot/state/sessions';
const SESSION_LOCK_DIR = '.claude/pilot/state/locks';
const AGENT_REGISTRY_PATH = '.claude/pilot/agent-registry.json';
const HEARTBEAT_STALE_MULTIPLIER = 2; // Session stale after 2x heartbeat interval
const DEFAULT_LEASE_DURATION_MS = 30 * 60 * 1000; // 30 minutes
const VALID_ROLES = ['frontend', 'backend', 'testing', 'security', 'pm', 'design', 'review', 'infra'];

/**
 * Generate a unique session ID
 * Format: S-<timestamp>-<random4>
 */
function generateSessionId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(2).toString('hex');
  return `S-${ts}-${rand}`;
}

/**
 * Get path to event stream file
 */
function getEventStreamPath() {
  return path.join(process.cwd(), EVENT_STREAM_FILE);
}

/**
 * Get path to session state directory
 */
function getSessionStateDir() {
  return path.join(process.cwd(), SESSION_STATE_DIR);
}

/**
 * Get path to session lock directory
 */
function getSessionLockDir() {
  return path.join(process.cwd(), SESSION_LOCK_DIR);
}

/**
 * Walk the process tree upward to find the parent claude process PID.
 * Uses execFileSync (no shell) for safety.
 * Returns the parent claude PID or falls back to process.pid.
 */
function getParentClaudePID() {
  try {
    let pid = process.pid;
    // Walk up to 10 levels to avoid infinite loops
    for (let i = 0; i < 10; i++) {
      const ppidStr = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 3000
      }).trim();
      const ppid = parseInt(ppidStr, 10);
      if (!ppid || ppid <= 1) break;

      // Check if the parent is a claude process
      try {
        const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(ppid)], {
          encoding: 'utf8',
          timeout: 3000
        }).trim();
        if (comm.includes('claude') || comm.includes('Claude')) {
          return ppid;
        }
      } catch (e) {
        // Process may have exited between checks
        break;
      }
      pid = ppid;
    }
  } catch (e) {
    // Fallback to own PID
  }
  return process.pid;
}

/**
 * Create a session lockfile at .claude/pilot/state/locks/{sessionId}.lock
 * Contains PID + start time. File existence = session alive (verified via PID check).
 */
function createSessionLock(sessionId) {
  const lockDir = getSessionLockDir();
  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }

  const parentPid = getParentClaudePID();
  const lockData = {
    session_id: sessionId,
    pid: process.pid,
    parent_pid: parentPid,
    created_at: new Date().toISOString()
  };

  const lockFile = path.join(lockDir, `${sessionId}.lock`);
  fs.writeFileSync(lockFile, JSON.stringify(lockData, null, 2));

  return { success: true, lock_file: lockFile, parent_pid: parentPid };
}

/**
 * Remove a session lockfile on clean exit.
 */
function removeSessionLock(sessionId) {
  const lockFile = path.join(getSessionLockDir(), `${sessionId}.lock`);
  try {
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
      return { success: true };
    }
    return { success: true, note: 'lockfile already absent' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Check if a session is alive using its lockfile.
 * Alive = lockfile exists AND the PID recorded in it is still running.
 */
function isSessionAlive(sessionId) {
  // Try lockfile first (fast path)
  const lockFile = path.join(getSessionLockDir(), `${sessionId}.lock`);
  if (fs.existsSync(lockFile)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      const pidToCheck = lockData.parent_pid || lockData.pid;
      process.kill(pidToCheck, 0);
      return true;
    } catch (e) {
      if (e.code === 'ESRCH') {
        try { fs.unlinkSync(lockFile); } catch (_) {}
        // Fall through to session state check
      } else if (e.code === 'EPERM') {
        return true;
      }
    }
  }

  // Fallback: check parent_pid from session state file directly.
  // This handles cases where lockfile is missing or stale (e.g. after resurrection).
  try {
    const sessFile = path.join(getSessionStateDir(), `${sessionId}.json`);
    if (fs.existsSync(sessFile)) {
      const sessData = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
      const ppid = sessData.parent_pid;
      if (ppid) {
        try {
          process.kill(ppid, 0);
          return true;
        } catch (e) {
          if (e.code === 'EPERM') return true;
        }
      }
    }
  } catch (e) {
    // ignore
  }

  return false;
}

/**
 * Append event to sessions.jsonl
 */
function logEvent(event) {
  const eventStreamPath = getEventStreamPath();
  const dir = path.dirname(eventStreamPath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...event
  }) + '\n';

  fs.appendFileSync(eventStreamPath, line);
}

/**
 * Register a new session
 */
/**
 * Resolve agent role from explicit value, env var, or null.
 * Returns a valid role string or null.
 */
function resolveAgentRole(explicitRole) {
  // 1. Explicit role passed in context
  if (explicitRole && VALID_ROLES.includes(explicitRole)) {
    return explicitRole;
  }
  // 2. Environment variable (set by PM or agent config)
  const envRole = process.env.PILOT_AGENT_ROLE;
  if (envRole && VALID_ROLES.includes(envRole)) {
    return envRole;
  }
  // 3. Reclaim from most recent ended session with same parent PID
  try {
    const parentPid = getParentClaudePID();
    const allSessions = getAllSessionStates();
    const previous = allSessions
      .filter(s => s.status === 'ended' && s.parent_pid === parentPid && s.role)
      .sort((a, b) => (b.ended_at || b.started_at || '').localeCompare(a.ended_at || a.started_at || ''));
    if (previous.length > 0) {
      return previous[0].role;
    }
  } catch (e) {
    // Best effort reclaim
  }
  return null;
}

/**
 * Generate human-readable agent name from role.
 * Format: "{role}-{N}" where N is the count of active agents with same role + 1.
 * Falls back to session ID suffix if no role.
 */
function generateAgentName(role, sessionId) {
  if (!role) {
    // No role — use last 4 chars of session ID
    return `agent-${sessionId.slice(-4)}`;
  }
  // Count active sessions with same role
  try {
    const active = getActiveSessions(sessionId);
    const sameRole = active.filter(s => s.role === role);
    return `${role}-${sameRole.length + 1}`;
  } catch (e) {
    return `${role}-1`;
  }
}

/**
 * Load the agent registry to look up capabilities for a role.
 */
function loadAgentRegistry() {
  const registryPath = path.join(process.cwd(), AGENT_REGISTRY_PATH);
  try {
    return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Get capabilities for a given role from the agent registry.
 */
function getAgentCapabilities(role) {
  if (!role) return [];
  const registry = loadAgentRegistry();
  if (!registry || !registry.agents || !registry.agents[role]) return [];
  return registry.agents[role].capabilities || [];
}

/**
 * Set or update the role for an existing session.
 */
function setSessionRole(sessionId, role) {
  if (!VALID_ROLES.includes(role)) {
    return { success: false, error: `Invalid role: ${role}. Valid: ${VALID_ROLES.join(', ')}` };
  }
  const agentName = generateAgentName(role, sessionId);
  const updated = updateSession(sessionId, { role, agent_name: agentName });
  if (!updated) return { success: false, error: 'Session not found' };
  return { success: true, role, agent_name: agentName };
}

/**
 * Get active sessions filtered by role.
 * @param {string} role - Agent role to filter by
 * @param {string} [excludeSessionId] - Session to exclude (e.g., caller)
 * @returns {Array} Active sessions with matching role
 */
function getSessionsByRole(role, excludeSessionId = null) {
  const active = getActiveSessions(excludeSessionId);
  if (!role) return active;
  return active.filter(s => s.role === role);
}

/**
 * Get available agents (active sessions with a role, not busy with a claimed task).
 * @param {string} [excludeSessionId] - Session to exclude
 * @returns {Array} Available agent sessions with role, agent_name, capabilities
 */
function getAvailableAgents(excludeSessionId = null) {
  const active = getActiveSessions(excludeSessionId);
  return active
    .filter(s => s.role && !s.claimed_task)
    .map(s => ({
      session_id: s.session_id,
      role: s.role,
      agent_name: s.agent_name || `${s.role}-?`,
      capabilities: getAgentCapabilities(s.role),
      claimed_task: s.claimed_task
    }));
}

// =============================================================================
// AGENT AFFINITY TRACKING (Phase 3.1)
// =============================================================================

const AFFINITY_DIR = '.claude/pilot/memory/agents';

/**
 * Record a task outcome for an agent role to build affinity data.
 * Tracks which files/areas an agent works on and whether tasks succeed.
 *
 * @param {string} role - Agent role
 * @param {string} taskId - Completed task ID
 * @param {string} outcome - 'completed' | 'reassigned' | 'failed'
 * @param {string[]} [files] - Files touched during the task
 */
function recordAgentAffinity(role, taskId, outcome, files = []) {
  if (!role) return;

  const affinityDir = path.join(process.cwd(), AFFINITY_DIR, role);
  if (!fs.existsSync(affinityDir)) {
    fs.mkdirSync(affinityDir, { recursive: true });
  }

  const affinityFile = path.join(affinityDir, 'affinity.jsonl');
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    task_id: taskId,
    outcome,
    files: files.slice(0, 20) // Cap to avoid bloat
  }) + '\n';

  fs.appendFileSync(affinityFile, entry);
}

/**
 * Get affinity summary for an agent role.
 * Returns success rate, frequently touched files, and task count.
 *
 * @param {string} role - Agent role
 * @returns {{ task_count: number, success_rate: number, top_files: string[] }}
 */
function getAgentAffinity(role) {
  if (!role) return { task_count: 0, success_rate: 0, top_files: [] };

  const affinityFile = path.join(process.cwd(), AFFINITY_DIR, role, 'affinity.jsonl');
  if (!fs.existsSync(affinityFile)) {
    return { task_count: 0, success_rate: 0, top_files: [] };
  }

  try {
    const lines = fs.readFileSync(affinityFile, 'utf8').trim().split('\n').filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    const completed = entries.filter(e => e.outcome === 'completed').length;
    const total = entries.length;

    // Count file frequencies
    const fileCounts = {};
    for (const e of entries) {
      for (const f of (e.files || [])) {
        fileCounts[f] = (fileCounts[f] || 0) + 1;
      }
    }
    const topFiles = Object.entries(fileCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([f]) => f);

    return {
      task_count: total,
      success_rate: total > 0 ? completed / total : 0,
      top_files: topFiles
    };
  } catch (e) {
    return { task_count: 0, success_rate: 0, top_files: [] };
  }
}

function registerSession(sessionId, context = {}) {
  // Create session state dir
  const stateDir = getSessionStateDir();
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  // Resolve parent claude PID for accurate liveness checks
  const parentPid = getParentClaudePID();

  // --- Session Resurrection ---
  // If an ended session exists for the same parent_pid (same Claude terminal),
  // resurrect it instead of creating a new one. This preserves claimed_task,
  // locks, and prevents session proliferation when hooks re-fire.
  if (parentPid) {
    try {
      const files = fs.readdirSync(stateDir)
        .filter(f => f.startsWith('S-') && f.endsWith('.json') && !f.includes('.pressure'));
      // Sort newest first to find the most recent session for this terminal
      const candidates = [];
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8'));
          if (data.parent_pid === parentPid && data.status === 'ended') {
            candidates.push({ file: f, data, mtime: fs.statSync(path.join(stateDir, f)).mtime.getTime() });
          }
        } catch (e) { /* skip invalid */ }
      }
      if (candidates.length > 0) {
        // Resurrect the most recent ended session for this terminal
        candidates.sort((a, b) => b.mtime - a.mtime);
        const toResurrect = candidates[0];
        const resurrected = toResurrect.data;
        resurrected.status = 'active';
        resurrected.last_heartbeat = new Date().toISOString();
        resurrected.pid = process.pid; // Update hook pid
        fs.writeFileSync(
          path.join(stateDir, toResurrect.file),
          JSON.stringify(resurrected, null, 2)
        );
        // Re-create lockfile
        createSessionLock(resurrected.session_id);
        logEvent({
          type: 'session_resurrected',
          session_id: resurrected.session_id,
          new_hook_session_id: sessionId,
          parent_pid: parentPid,
          claimed_task: resurrected.claimed_task
        });
        return resurrected;
      }
    } catch (e) {
      // Resurrection failed — fall through to normal registration
    }
  }

  // Log to event stream
  logEvent({
    type: 'session_started',
    session_id: sessionId,
    cwd: process.cwd(),
    pid: process.pid,
    ...context
  });

  // Resolve agent role: explicit > env > auto-detect > null
  const role = resolveAgentRole(context.role);
  const agentName = generateAgentName(role, sessionId);

  const sessionState = {
    session_id: sessionId,
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    status: 'active',
    role: role,
    agent_name: agentName,
    claimed_task: null,
    lease_expires_at: null,
    locked_areas: [],
    locked_files: [],
    cwd: process.cwd(),
    pid: process.pid,
    parent_pid: parentPid
  };

  fs.writeFileSync(
    path.join(stateDir, `${sessionId}.json`),
    JSON.stringify(sessionState, null, 2)
  );

  // Create lockfile for process-based liveness detection
  createSessionLock(sessionId);

  return sessionState;
}

/**
 * Get all session state files
 */
function getAllSessionStates() {
  const stateDir = getSessionStateDir();
  if (!fs.existsSync(stateDir)) return [];

  const files = fs.readdirSync(stateDir).filter(f => f.endsWith('.json'));
  const sessions = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(stateDir, file), 'utf8');
      sessions.push(JSON.parse(content));
    } catch (e) {
      // Skip invalid files
    }
  }

  return sessions;
}

/**
 * Determine if a session is still active based on heartbeat
 */
function isSessionActive(session, policy) {
  if (session.status !== 'active') return false;
  // Sessions marked with ended_at are dead even if status wasn't flipped
  if (session.ended_at) return false;

  const heartbeatInterval = policy?.session?.heartbeat_interval_sec || 60;
  const staleThreshold = heartbeatInterval * HEARTBEAT_STALE_MULTIPLIER * 1000;
  const lastHeartbeat = new Date(session.last_heartbeat).getTime();
  const now = Date.now();

  return (now - lastHeartbeat) < staleThreshold;
}

/**
 * Get active sessions (excluding current).
 * A session is considered active if:
 * 1. Its heartbeat is fresh (isSessionActive), OR
 * 2. Its status is 'active' AND the Claude process is still alive (isSessionAlive)
 * This prevents falsely excluding sessions with stale heartbeats but live processes.
 */
function getActiveSessions(currentSessionId = null) {
  const policy = loadPolicy();
  const allSessions = getAllSessionStates();

  return allSessions.filter(session => {
    if (currentSessionId && session.session_id === currentSessionId) {
      return false;
    }
    // Sessions with ended_at are definitively dead regardless of other signals
    if (session.ended_at) return false;
    if (isSessionActive(session, policy)) return true;
    // Fallback: if heartbeat is stale but process is alive, still include it
    if (session.status === 'active' && isSessionAlive(session.session_id)) return true;
    return false;
  });
}

/**
 * Get all locked files from active sessions
 */
function getLockedFiles(sessions = null) {
  if (!sessions) {
    sessions = getActiveSessions();
  }

  const lockedFiles = [];

  for (const session of sessions) {
    if (session.locked_files && Array.isArray(session.locked_files)) {
      for (const file of session.locked_files) {
        lockedFiles.push({
          path: file,
          session_id: session.session_id,
          task_id: session.claimed_task
        });
      }
    }
  }

  return lockedFiles;
}

/**
 * Get all locked areas from active sessions
 */
function getLockedAreas(sessions = null) {
  if (!sessions) {
    sessions = getActiveSessions();
  }

  const lockedAreas = [];

  for (const session of sessions) {
    if (session.locked_areas && Array.isArray(session.locked_areas)) {
      for (const area of session.locked_areas) {
        lockedAreas.push({
          area: area,
          session_id: session.session_id,
          task_id: session.claimed_task
        });
      }
    }
  }

  return lockedAreas;
}

// =============================================================================
// AREA LOCKING (Sprint 3)
// =============================================================================

/**
 * Area to path pattern mapping
 * Areas are coarse-grained zones that can be locked to prevent conflicts
 */
const AREA_PATTERNS = {
  frontend: ['src/components/**', 'src/app/**', 'src/pages/**', 'src/ui/**'],
  backend: ['src/api/**', 'src/server/**', 'src/services/**', 'src/lib/**'],
  hooks: ['.claude/pilot/hooks/**', '.claude/hooks/**'],
  config: ['*.config.*', '.claude/**', 'package.json', 'tsconfig.json'],
  tests: ['tests/**', 'test/**', '__tests__/**', '*.test.*', '*.spec.*'],
  docs: ['docs/**', '*.md', 'README*']
};

/**
 * Determine which area a file path belongs to
 * Returns area name or null if no match
 */
function getAreaForPath(filePath) {
  const relativePath = filePath.startsWith(process.cwd())
    ? filePath.slice(process.cwd().length + 1)
    : filePath;

  for (const [area, patterns] of Object.entries(AREA_PATTERNS)) {
    for (const pattern of patterns) {
      if (matchGlob(relativePath, pattern)) {
        return area;
      }
    }
  }
  return null;
}

/**
 * Simple glob matching (supports ** and *)
 */
function matchGlob(filePath, pattern) {
  // Escape regex special chars first, except * which we handle specially
  let regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape special regex chars (not *)
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')     // Temporarily replace **
    .replace(/\*/g, '[^/]*')                // * matches anything except /
    .replace(/<<<GLOBSTAR>>>/g, '.*');      // ** matches anything including /

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(filePath);
}

/**
 * Check if an area is locked by another session
 * Returns locking session info or null
 */
function isAreaLocked(area, currentSessionId = null) {
  const policy = loadPolicy();
  const allSessions = getAllSessionStates();

  for (const session of allSessions) {
    // Skip current session
    if (currentSessionId && session.session_id === currentSessionId) continue;

    // Skip inactive sessions
    if (!isSessionActive(session, policy)) continue;

    // Check if this session has the area locked
    if (session.locked_areas && session.locked_areas.includes(area)) {
      return {
        session_id: session.session_id,
        task_id: session.claimed_task,
        area: area
      };
    }
  }

  return null;
}

/**
 * Lock an area for a session
 */
function lockArea(sessionId, area) {
  // Check if area is already locked by another session
  const existingLock = isAreaLocked(area, sessionId);
  if (existingLock) {
    return {
      success: false,
      error: `Area '${area}' is locked by session ${existingLock.session_id}`,
      existing_lock: existingLock
    };
  }

  const stateDir = getSessionStateDir();
  const sessionFile = path.join(stateDir, `${sessionId}.json`);

  if (!fs.existsSync(sessionFile)) {
    return {
      success: false,
      error: `Session ${sessionId} not found`
    };
  }

  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

    // Initialize locked_areas if needed
    if (!session.locked_areas) {
      session.locked_areas = [];
    }

    // Add area if not already locked by this session
    if (!session.locked_areas.includes(area)) {
      session.locked_areas.push(area);
    }

    session.last_heartbeat = new Date().toISOString();
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));

    // Log the lock event
    logEvent({
      type: 'area_locked',
      session_id: sessionId,
      area: area,
      task_id: session.claimed_task
    });

    return {
      success: true,
      locked_areas: session.locked_areas
    };
  } catch (e) {
    return {
      success: false,
      error: `Failed to lock area: ${e.message}`
    };
  }
}

/**
 * Unlock an area for a session
 */
function unlockArea(sessionId, area) {
  const stateDir = getSessionStateDir();
  const sessionFile = path.join(stateDir, `${sessionId}.json`);

  if (!fs.existsSync(sessionFile)) {
    return {
      success: false,
      error: `Session ${sessionId} not found`
    };
  }

  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

    if (!session.locked_areas || !session.locked_areas.includes(area)) {
      return {
        success: false,
        error: `Area '${area}' is not locked by this session`
      };
    }

    session.locked_areas = session.locked_areas.filter(a => a !== area);
    session.last_heartbeat = new Date().toISOString();
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));

    // Log the unlock event
    logEvent({
      type: 'area_unlocked',
      session_id: sessionId,
      area: area
    });

    return {
      success: true,
      locked_areas: session.locked_areas
    };
  } catch (e) {
    return {
      success: false,
      error: `Failed to unlock area: ${e.message}`
    };
  }
}

/**
 * Release all locks for a session
 */
function releaseAllLocks(sessionId) {
  const stateDir = getSessionStateDir();
  const sessionFile = path.join(stateDir, `${sessionId}.json`);

  if (!fs.existsSync(sessionFile)) {
    return { success: false, error: `Session ${sessionId} not found` };
  }

  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const releasedAreas = session.locked_areas || [];
    const releasedFiles = session.locked_files || [];

    session.locked_areas = [];
    session.locked_files = [];
    session.last_heartbeat = new Date().toISOString();
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));

    // Log if any locks were released
    if (releasedAreas.length > 0 || releasedFiles.length > 0) {
      logEvent({
        type: 'locks_released',
        session_id: sessionId,
        areas: releasedAreas,
        files: releasedFiles
      });
    }

    return {
      success: true,
      released_areas: releasedAreas,
      released_files: releasedFiles
    };
  } catch (e) {
    return {
      success: false,
      error: `Failed to release locks: ${e.message}`
    };
  }
}

/**
 * Update session heartbeat
 */
function updateHeartbeat(sessionId) {
  const stateDir = getSessionStateDir();
  const sessionFile = path.join(stateDir, `${sessionId}.json`);

  if (!fs.existsSync(sessionFile)) return false;

  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    session.last_heartbeat = new Date().toISOString();
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));

    // Publish agent status to shared working context (Phase 3.9)
    try {
      const agentContext = require('./agent-context');
      agentContext.publishProgress(sessionId, {
        taskId: session.claimed_task || null,
        taskTitle: session.claimed_task_title || null,
        status: session.claimed_task ? 'working' : 'idle',
        filesModified: session.locked_files || []
      });
    } catch (e) {
      // Non-critical — don't fail heartbeat if agent-context has issues
    }

    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Find and update heartbeat for the current (most recent active) session.
 * Logs heartbeat event periodically (every 5 minutes).
 *
 * @returns {{ updated: boolean, session_id?: string, logged?: boolean }}
 */
function heartbeat() {
  const stateDir = getSessionStateDir();
  if (!fs.existsSync(stateDir)) return { updated: false };

  try {
    // Find the session file belonging to THIS terminal (by parent_pid).
    // Falls back to most recent active session if parent_pid matching fails.
    const parentPid = getParentClaudePID();
    const allFiles = fs.readdirSync(stateDir)
      .filter(f => f.startsWith('S-') && f.endsWith('.json') && !f.includes('.pressure'))
      .map(f => ({
        name: f,
        mtime: fs.statSync(path.join(stateDir, f)).mtime.getTime()
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (allFiles.length === 0) return { updated: false };

    // Prefer matching by parent_pid (correct terminal)
    let sessionFile = null;
    let session = null;
    if (parentPid) {
      for (const f of allFiles) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(stateDir, f.name), 'utf8'));
          if (data.parent_pid === parentPid && data.status === 'active' && !data.ended_at) {
            sessionFile = path.join(stateDir, f.name);
            session = data;
            break;
          }
        } catch (e) { /* skip */ }
      }
    }

    // Fallback: most recent active session (skip ended ones)
    if (!session) {
      for (const f of allFiles) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(stateDir, f.name), 'utf8'));
          if (data.status === 'active' && !data.ended_at) {
            sessionFile = path.join(stateDir, f.name);
            session = data;
            break;
          }
        } catch (e) { /* skip */ }
      }
    }

    if (!session || !sessionFile) return { updated: false };

    const now = new Date();
    const lastHeartbeat = new Date(session.last_heartbeat);
    const timeSinceLastHeartbeat = now.getTime() - lastHeartbeat.getTime();

    // Update heartbeat
    session.last_heartbeat = now.toISOString();
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));

    // Log heartbeat event periodically (every 5 minutes)
    const HEARTBEAT_LOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    let logged = false;

    if (timeSinceLastHeartbeat >= HEARTBEAT_LOG_INTERVAL_MS) {
      logEvent({
        type: 'heartbeat',
        session_id: session.session_id,
        claimed_task: session.claimed_task,
        locked_areas: session.locked_areas
      });
      logged = true;
    }

    return {
      updated: true,
      session_id: session.session_id,
      logged: logged
    };
  } catch (e) {
    return { updated: false, error: e.message };
  }
}

/**
 * Update session state
 */
function updateSession(sessionId, updates) {
  const stateDir = getSessionStateDir();
  const sessionFile = path.join(stateDir, `${sessionId}.json`);

  if (!fs.existsSync(sessionFile)) return null;

  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    Object.assign(session, updates, { last_heartbeat: new Date().toISOString() });
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
    return session;
  } catch (e) {
    return null;
  }
}

/**
 * End a session
 */
function endSession(sessionId, reason = 'user_exit') {
  const stateDir = getSessionStateDir();
  const sessionFile = path.join(stateDir, `${sessionId}.json`);

  // Remove lockfile on clean exit
  removeSessionLock(sessionId);

  // Remove from shared working context (Phase 3.9)
  try {
    const agentContext = require('./agent-context');
    agentContext.removeAgent(sessionId);
  } catch (e) {
    // Non-critical
  }

  // Log event
  logEvent({
    type: 'session_ended',
    session_id: sessionId,
    reason
  });

  // Update state file
  if (fs.existsSync(sessionFile)) {
    try {
      const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      session.status = 'ended';
      session.ended_at = new Date().toISOString();
      session.end_reason = reason;
      fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
    } catch (e) {
      // Best effort
    }
  }
}

/**
 * Clean up stale sessions
 */
function cleanupStaleSessions() {
  const policy = loadPolicy();
  const allSessions = getAllSessionStates();
  let cleaned = 0;

  for (const session of allSessions) {
    // Fix zombie sessions: ended_at set but status still 'active'
    if (session.status === 'active' && session.ended_at) {
      endSession(session.session_id, session.end_reason || 'zombie_cleanup');
      cleaned++;
      continue;
    }

    if (session.status === 'active' && !isSessionActive(session, policy)) {
      // Before marking stale, check if the actual Claude process is still alive.
      // The heartbeat may be outdated (e.g. during long tool calls) but the
      // process can still be running. Don't kill live sessions.
      if (isSessionAlive(session.session_id)) {
        // Process is alive — refresh heartbeat instead of killing it
        try {
          const sessFile = path.join(getSessionStateDir(), `${session.session_id}.json`);
          const data = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
          data.last_heartbeat = new Date().toISOString();
          fs.writeFileSync(sessFile, JSON.stringify(data, null, 2));
        } catch (e) {
          // Best effort refresh
        }
        continue;
      }
      // Phase 3.8: Assess recovery strategy before ending
      try {
        const recovery = require('./recovery');
        if (session.claimed_task) {
          const assessment = recovery.assessRecovery(session.session_id);
          if (assessment.strategy === recovery.STRATEGIES.RESUME) {
            // Checkpoint exists — log recoverable event before ending
            recovery.logRecoveryEvent(session.session_id, 'stale_with_checkpoint', {
              task_id: session.claimed_task,
              plan_step: assessment.checkpoint?.plan_step
            });
          }
        }
      } catch (e) {
        // Recovery module not available, continue with normal cleanup
      }

      endSession(session.session_id, 'stale');
      cleaned++;
    }
  }

  // Clean up orphaned worktrees (if enabled)
  if (policy.worktree && policy.worktree.auto_cleanup) {
    try {
      var activeSessions = allSessions.filter(function(s) {
        return s.status === 'active' && isSessionActive(s, policy);
      });
      worktree.cleanupOrphanedWorktrees(activeSessions);
    } catch (e) {
      // Best effort — don't break session cleanup
    }
  }

  // Clean up messaging cursors for ended sessions
  try {
    const messaging = require('./messaging');
    const activeIds = allSessions
      .filter(s => s.status === 'active' && isSessionActive(s, policy))
      .map(s => s.session_id);
    messaging.cleanupCursors(activeIds);
  } catch (e) {
    // Messaging module not available yet, skip
  }

  return cleaned;
}

// =============================================================================
// TASK CLAIM/LEASE PROTOCOL (Sprint 3)
// =============================================================================

/**
 * Get all task IDs currently claimed by active sessions.
 * Used by /pilot-next to filter out tasks that another agent is already working on.
 *
 * @param {string} [excludeSessionId] - Optional session ID to exclude (e.g., current session)
 * @returns {string[]} Array of claimed task IDs
 */
function getClaimedTaskIds(excludeSessionId = null) {
  const policy = loadPolicy();
  const allSessions = getAllSessionStates();
  const now = Date.now();
  const claimed = [];

  for (const session of allSessions) {
    if (excludeSessionId && session.session_id === excludeSessionId) continue;
    if (!isSessionActive(session, policy)) continue;
    if (!session.claimed_task) continue;

    // Check lease expiry
    if (session.lease_expires_at) {
      const expiresAt = new Date(session.lease_expires_at).getTime();
      if (now >= expiresAt) continue; // Lease expired, task is available
    }

    claimed.push(session.claimed_task);
  }

  return claimed;
}

/**
 * Check if a task is currently claimed by any active session
 * Returns the claiming session info or null if unclaimed/expired
 */
function isTaskClaimed(taskId) {
  const policy = loadPolicy();
  const allSessions = getAllSessionStates();
  const now = Date.now();

  for (const session of allSessions) {
    // Skip inactive sessions
    if (!isSessionActive(session, policy)) continue;

    // Check if this session has the task claimed
    if (session.claimed_task === taskId) {
      // Check if lease has expired
      if (session.lease_expires_at) {
        const expiresAt = new Date(session.lease_expires_at).getTime();
        if (now >= expiresAt) {
          // Lease expired - task can be re-claimed
          return null;
        }
      }

      // Task is claimed with valid lease
      return {
        session_id: session.session_id,
        claimed_at: session.claimed_at,
        lease_expires_at: session.lease_expires_at
      };
    }
  }

  return null;
}

/**
 * Claim a task for this session with a time-limited lease
 *
 * @param {string} sessionId - The session claiming the task
 * @param {string} taskId - The task to claim
 * @param {number} leaseDurationMs - Lease duration (default: 30 minutes)
 * @returns {{ success: boolean, error?: string, claim?: object }}
 */
function claimTask(sessionId, taskId, leaseDurationMs = DEFAULT_LEASE_DURATION_MS) {
  // Check if task is already claimed
  const existingClaim = isTaskClaimed(taskId);
  if (existingClaim && existingClaim.session_id !== sessionId) {
    return {
      success: false,
      error: `Task ${taskId} is already claimed by session ${existingClaim.session_id}`,
      existing_claim: existingClaim
    };
  }

  const stateDir = getSessionStateDir();
  const sessionFile = path.join(stateDir, `${sessionId}.json`);

  if (!fs.existsSync(sessionFile)) {
    return {
      success: false,
      error: `Session ${sessionId} not found`
    };
  }

  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseDurationMs);

    session.claimed_task = taskId;
    session.claimed_at = now.toISOString();
    session.lease_expires_at = expiresAt.toISOString();
    session.last_heartbeat = now.toISOString();

    // Create worktree for isolated development (if enabled)
    var wtResult = worktree.createWorktree(taskId, sessionId);
    if (wtResult.success) {
      session.worktree_path = wtResult.path;
      session.worktree_branch = wtResult.branch;
      session.worktree_created_at = now.toISOString();
    }

    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));

    // Log the claim event
    logEvent({
      type: 'task_claimed',
      session_id: sessionId,
      task_id: taskId,
      lease_expires_at: expiresAt.toISOString(),
      worktree: wtResult.success ? { path: wtResult.path, branch: wtResult.branch } : null
    });

    return {
      success: true,
      claim: {
        session_id: sessionId,
        task_id: taskId,
        claimed_at: now.toISOString(),
        lease_expires_at: expiresAt.toISOString()
      },
      worktree: wtResult.success ? wtResult : null
    };
  } catch (e) {
    return {
      success: false,
      error: `Failed to claim task: ${e.message}`
    };
  }
}

/**
 * Release a claimed task
 *
 * @param {string} sessionId - The session releasing the task
 * @returns {{ success: boolean, error?: string, released_task?: string }}
 */
function releaseTask(sessionId) {
  const stateDir = getSessionStateDir();
  const sessionFile = path.join(stateDir, `${sessionId}.json`);

  if (!fs.existsSync(sessionFile)) {
    return {
      success: false,
      error: `Session ${sessionId} not found`
    };
  }

  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const releasedTask = session.claimed_task;

    if (!releasedTask) {
      return {
        success: false,
        error: 'No task claimed by this session'
      };
    }

    // Release all locks when task is released
    const releasedAreas = session.locked_areas || [];
    const releasedFiles = session.locked_files || [];

    // Remove worktree if one exists for this task
    var wtResult = null;
    if (session.worktree_path) {
      wtResult = worktree.removeWorktree(releasedTask);
    }

    session.claimed_task = null;
    session.claimed_at = null;
    session.lease_expires_at = null;
    session.locked_areas = [];
    session.locked_files = [];
    session.worktree_path = null;
    session.worktree_branch = null;
    session.worktree_created_at = null;
    session.last_heartbeat = new Date().toISOString();

    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));

    // Log the release event
    logEvent({
      type: 'task_released',
      session_id: sessionId,
      task_id: releasedTask,
      released_areas: releasedAreas,
      released_files: releasedFiles,
      worktree_removed: wtResult ? wtResult.success : false
    });

    return {
      success: true,
      released_task: releasedTask,
      released_areas: releasedAreas,
      released_files: releasedFiles,
      worktree: wtResult
    };
  } catch (e) {
    return {
      success: false,
      error: `Failed to release task: ${e.message}`
    };
  }
}

/**
 * Extend the lease on a claimed task
 *
 * @param {string} sessionId - The session extending the lease
 * @param {number} leaseDurationMs - New lease duration from now
 * @returns {{ success: boolean, error?: string, new_expires_at?: string }}
 */
function extendLease(sessionId, leaseDurationMs = DEFAULT_LEASE_DURATION_MS) {
  const stateDir = getSessionStateDir();
  const sessionFile = path.join(stateDir, `${sessionId}.json`);

  if (!fs.existsSync(sessionFile)) {
    return {
      success: false,
      error: `Session ${sessionId} not found`
    };
  }

  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

    if (!session.claimed_task) {
      return {
        success: false,
        error: 'No task claimed by this session'
      };
    }

    const now = new Date();
    const newExpiresAt = new Date(now.getTime() + leaseDurationMs);

    session.lease_expires_at = newExpiresAt.toISOString();
    session.last_heartbeat = now.toISOString();

    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));

    return {
      success: true,
      new_expires_at: newExpiresAt.toISOString()
    };
  } catch (e) {
    return {
      success: false,
      error: `Failed to extend lease: ${e.message}`
    };
  }
}

// =============================================================================
// AGENT DISCOVERY (Phase 3.9)
// =============================================================================

/**
 * Discover agents by capability (searches agent registry + active sessions).
 *
 * @param {string} capability - Capability to search for (e.g., 'api_design')
 * @param {string} [excludeSessionId] - Session to exclude
 * @returns {object[]} Active agents with the requested capability
 */
function discoverAgentByCap(capability, excludeSessionId) {
  const registry = loadAgentRegistry();
  if (!registry || !registry.agents) return [];

  const matchingRoles = [];
  for (const [role, config] of Object.entries(registry.agents)) {
    const caps = config.capabilities || [];
    if (caps.includes(capability)) {
      matchingRoles.push(role);
    }
  }

  if (matchingRoles.length === 0) return [];

  const activeSessions = getActiveSessions(excludeSessionId);
  return activeSessions
    .filter(s => s.role && matchingRoles.includes(s.role))
    .map(s => ({
      session_id: s.session_id,
      agent_name: s.agent_name,
      role: s.role,
      claimed_task: s.claimed_task,
      capabilities: getAgentCapabilities(s.role)
    }));
}

/**
 * Discover agent by file pattern match.
 * Uses agent-registry.json file_patterns.
 *
 * @param {string} filePath - File path to match
 * @param {string} [excludeSessionId] - Session to exclude
 * @returns {object|null} Best matching agent or null
 */
function discoverAgentByFile(filePath, excludeSessionId) {
  const registry = loadAgentRegistry();
  if (!registry || !registry.agents) return null;

  let bestRole = null;
  let bestScore = 0;

  for (const [role, config] of Object.entries(registry.agents)) {
    const patterns = config.file_patterns || [];
    const excluded = config.excluded_patterns || [];

    const isExcluded = excluded.some(p => _simpleGlobMatch(filePath, p));
    if (isExcluded) continue;

    for (const pattern of patterns) {
      if (_simpleGlobMatch(filePath, pattern)) {
        const score = _patternSpecificity(pattern);
        if (score > bestScore) {
          bestScore = score;
          bestRole = role;
        }
      }
    }
  }

  if (!bestRole) return null;

  const activeSessions = getActiveSessions(excludeSessionId);
  const match = activeSessions.find(s => s.role === bestRole);

  if (!match) {
    return { role: bestRole, session_id: null, agent_name: null, active: false };
  }

  return {
    session_id: match.session_id,
    agent_name: match.agent_name,
    role: bestRole,
    capabilities: getAgentCapabilities(bestRole),
    active: true
  };
}

function _simpleGlobMatch(filePath, pattern) {
  let regex = pattern
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\./g, '\\.');
  try {
    return new RegExp(regex).test(filePath);
  } catch (e) {
    return false;
  }
}

function _patternSpecificity(pattern) {
  let score = 1;
  const parts = pattern.split('/');
  for (const part of parts) {
    if (part !== '**' && part !== '*') score += 2;
    if (part.includes('.')) score += 1;
  }
  return score;
}

/**
 * Transfer a task claim from a dead/stale session to a new session.
 * Used during recovery to let a new agent resume work on the same task.
 *
 * @param {string} deadSessionId - The dead session to recover from
 * @param {string} newSessionId - The new session taking over
 * @param {number} [leaseDurationMs] - Lease duration for the new claim
 * @returns {{ success: boolean, transferred?: object, error?: string }}
 */
function recoverSession(deadSessionId, newSessionId, leaseDurationMs = DEFAULT_LEASE_DURATION_MS) {
  const stateDir = getSessionStateDir();
  const deadFile = path.join(stateDir, `${deadSessionId}.json`);
  const newFile = path.join(stateDir, `${newSessionId}.json`);

  if (!fs.existsSync(deadFile)) {
    return { success: false, error: `Dead session ${deadSessionId} not found` };
  }
  if (!fs.existsSync(newFile)) {
    return { success: false, error: `New session ${newSessionId} not found` };
  }

  try {
    const deadState = JSON.parse(fs.readFileSync(deadFile, 'utf8'));
    const newState = JSON.parse(fs.readFileSync(newFile, 'utf8'));

    if (!deadState.claimed_task) {
      return { success: false, error: 'Dead session has no claimed task' };
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseDurationMs);

    // Transfer task claim
    newState.claimed_task = deadState.claimed_task;
    newState.claimed_at = now.toISOString();
    newState.lease_expires_at = expiresAt.toISOString();
    newState.last_heartbeat = now.toISOString();

    // Transfer area locks
    if (deadState.locked_areas && deadState.locked_areas.length > 0) {
      newState.locked_areas = deadState.locked_areas;
    }

    // Transfer worktree reference (don't recreate — reuse existing)
    if (deadState.worktree_path) {
      newState.worktree_path = deadState.worktree_path;
      newState.worktree_branch = deadState.worktree_branch;
      newState.worktree_created_at = deadState.worktree_created_at;
    }

    // Clear dead session
    deadState.claimed_task = null;
    deadState.claimed_at = null;
    deadState.lease_expires_at = null;
    deadState.locked_areas = [];
    deadState.locked_files = [];
    deadState.status = 'ended';

    // Write both atomically (new first, then dead)
    fs.writeFileSync(newFile, JSON.stringify(newState, null, 2));
    fs.writeFileSync(deadFile, JSON.stringify(deadState, null, 2));

    logEvent({
      type: 'session_recovered',
      dead_session: deadSessionId,
      new_session: newSessionId,
      task_id: newState.claimed_task,
      transferred_areas: newState.locked_areas || []
    });

    return {
      success: true,
      transferred: {
        task_id: newState.claimed_task,
        locked_areas: newState.locked_areas || [],
        worktree_path: newState.worktree_path || null,
        lease_expires_at: expiresAt.toISOString()
      }
    };
  } catch (e) {
    return { success: false, error: `Recovery failed: ${e.message}` };
  }
}

/**
 * Resolve the current session ID for the calling process.
 *
 * Resolution order:
 * 1. PILOT_SESSION_ID env var (set by hooks if available)
 * 2. Match process.ppid against pid/parent_pid in active sessions
 * 3. Walk process tree via getParentClaudePID() and match
 * 4. null (caller must handle — never guess wrong)
 *
 * This replaces the broken "most-recent-mtime" approach that caused
 * all terminals to resolve to the same session in multi-agent setups.
 */
function resolveCurrentSession() {
  // 1. Env var — fastest, most reliable when set
  if (process.env.PILOT_SESSION_ID) {
    return process.env.PILOT_SESSION_ID;
  }

  const stateDir = getSessionStateDir();
  if (!fs.existsSync(stateDir)) return null;

  const files = fs.readdirSync(stateDir)
    .filter(f => f.startsWith('S-') && f.endsWith('.json') && !f.includes('.pressure'));

  const activeSessions = [];
  const endedSessions = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8'));
      if (data.status === 'active') {
        activeSessions.push(data);
      } else if (data.status === 'ended' && data.parent_pid) {
        endedSessions.push({ file: f, data });
      }
    } catch (e) { /* skip invalid */ }
  }

  // Helper: pick best match when multiple sessions share a PID
  // Prefer most recent heartbeat (the one actively in use)
  function bestMatch(candidates) {
    if (candidates.length === 1) return candidates[0].session_id;
    candidates.sort((a, b) =>
      new Date(b.last_heartbeat || 0).getTime() - new Date(a.last_heartbeat || 0).getTime()
    );
    return candidates[0].session_id;
  }

  // Collect PIDs to try: direct ppid first, then walked claude parent PID
  const pidsToTry = [];
  if (process.ppid) pidsToTry.push(process.ppid);
  try {
    const claudePid = getParentClaudePID();
    if (claudePid && claudePid !== process.pid && claudePid !== process.ppid) {
      pidsToTry.push(claudePid);
    }
  } catch (e) { /* ignore */ }

  // 2. Try matching active sessions by PID
  for (const pid of pidsToTry) {
    const matches = activeSessions.filter(s => s.pid === pid || s.parent_pid === pid);
    if (matches.length > 0) return bestMatch(matches);
  }

  // 3. No active session matched — try to resurrect an ended session
  //    whose parent_pid matches (same Claude terminal restarted hooks).
  //    This mirrors the resurrection logic in registerSession().
  for (const pid of pidsToTry) {
    const candidates = endedSessions.filter(e => e.data.parent_pid === pid);
    if (candidates.length === 0) continue;

    // Pick most recently updated
    candidates.sort((a, b) => {
      const aTime = new Date(a.data.last_heartbeat || a.data.started_at || 0).getTime();
      const bTime = new Date(b.data.last_heartbeat || b.data.started_at || 0).getTime();
      return bTime - aTime;
    });

    const toResurrect = candidates[0];
    const resurrected = toResurrect.data;
    resurrected.status = 'active';
    resurrected.last_heartbeat = new Date().toISOString();
    resurrected.pid = process.pid; // Update hook pid
    delete resurrected.ended_at;
    delete resurrected.end_reason;

    try {
      fs.writeFileSync(
        path.join(stateDir, toResurrect.file),
        JSON.stringify(resurrected, null, 2)
      );
      // Re-create lockfile
      createSessionLock(resurrected.session_id);
      logEvent({
        type: 'session_resurrected',
        session_id: resurrected.session_id,
        parent_pid: pid,
        source: 'resolveCurrentSession',
        claimed_task: resurrected.claimed_task
      });
      return resurrected.session_id;
    } catch (e) {
      // Resurrection failed — continue trying other PIDs
    }
  }

  // No match — return null instead of guessing wrong
  return null;
}

module.exports = {
  generateSessionId,
  registerSession,
  getAllSessionStates,
  getActiveSessions,
  getLockedFiles,
  getLockedAreas,
  updateHeartbeat,
  updateSession,
  endSession,
  cleanupStaleSessions,
  logEvent,
  // Task claim/lease protocol
  getClaimedTaskIds,
  isTaskClaimed,
  claimTask,
  releaseTask,
  extendLease,
  DEFAULT_LEASE_DURATION_MS,
  // Area locking
  AREA_PATTERNS,
  getAreaForPath,
  isAreaLocked,
  lockArea,
  unlockArea,
  releaseAllLocks,
  // Heartbeat
  heartbeat,
  // Lockfile-based liveness (Session Guardian)
  getParentClaudePID,
  createSessionLock,
  removeSessionLock,
  isSessionAlive,
  // Agent identity (Phase 3.1)
  VALID_ROLES,
  resolveAgentRole,
  generateAgentName,
  loadAgentRegistry,
  getAgentCapabilities,
  setSessionRole,
  getSessionsByRole,
  getAvailableAgents,
  // Agent affinity (Phase 3.1)
  recordAgentAffinity,
  getAgentAffinity,
  // Agent discovery (Phase 3.9)
  discoverAgentByCap,
  discoverAgentByFile,
  // Recovery (Phase 3.8)
  recoverSession,
  // Session resolution (multi-agent fix)
  resolveCurrentSession
};
