/**
 * Session Management
 *
 * Handles session ID generation, registration, and multi-session coordination.
 * Used by hooks to track and coordinate concurrent Claude Code sessions.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadPolicy } = require('./policy');

const EVENT_STREAM_FILE = 'runs/sessions.jsonl';
const SESSION_STATE_DIR = '.claude/pilot/state/sessions';
const HEARTBEAT_STALE_MULTIPLIER = 2; // Session stale after 2x heartbeat interval
const DEFAULT_LEASE_DURATION_MS = 30 * 60 * 1000; // 30 minutes

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
function registerSession(sessionId, context = {}) {
  // Log to event stream
  logEvent({
    type: 'session_started',
    session_id: sessionId,
    cwd: process.cwd(),
    pid: process.pid,
    ...context
  });

  // Create session state file
  const stateDir = getSessionStateDir();
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  const sessionState = {
    session_id: sessionId,
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    status: 'active',
    claimed_task: null,
    lease_expires_at: null,
    locked_areas: [],
    locked_files: [],
    cwd: process.cwd(),
    pid: process.pid
  };

  fs.writeFileSync(
    path.join(stateDir, `${sessionId}.json`),
    JSON.stringify(sessionState, null, 2)
  );

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

  const heartbeatInterval = policy?.session?.heartbeat_interval_sec || 60;
  const staleThreshold = heartbeatInterval * HEARTBEAT_STALE_MULTIPLIER * 1000;
  const lastHeartbeat = new Date(session.last_heartbeat).getTime();
  const now = Date.now();

  return (now - lastHeartbeat) < staleThreshold;
}

/**
 * Get active sessions (excluding current)
 */
function getActiveSessions(currentSessionId = null) {
  const policy = loadPolicy();
  const allSessions = getAllSessionStates();

  return allSessions.filter(session => {
    if (currentSessionId && session.session_id === currentSessionId) {
      return false;
    }
    return isSessionActive(session, policy);
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
    // Find most recent session file
    const files = fs.readdirSync(stateDir)
      .filter(f => f.startsWith('S-') && f.endsWith('.json'))
      .map(f => ({
        name: f,
        mtime: fs.statSync(path.join(stateDir, f)).mtime.getTime()
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return { updated: false };

    const sessionFile = path.join(stateDir, files[0].name);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

    // Only update active sessions
    if (session.status !== 'active') return { updated: false };

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
    if (session.status === 'active' && !isSessionActive(session, policy)) {
      endSession(session.session_id, 'stale');
      cleaned++;
    }
  }

  return cleaned;
}

// =============================================================================
// TASK CLAIM/LEASE PROTOCOL (Sprint 3)
// =============================================================================

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

    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));

    // Log the claim event
    logEvent({
      type: 'task_claimed',
      session_id: sessionId,
      task_id: taskId,
      lease_expires_at: expiresAt.toISOString()
    });

    return {
      success: true,
      claim: {
        session_id: sessionId,
        task_id: taskId,
        claimed_at: now.toISOString(),
        lease_expires_at: expiresAt.toISOString()
      }
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

    session.claimed_task = null;
    session.claimed_at = null;
    session.lease_expires_at = null;
    session.locked_areas = [];
    session.locked_files = [];
    session.last_heartbeat = new Date().toISOString();

    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));

    // Log the release event
    logEvent({
      type: 'task_released',
      session_id: sessionId,
      task_id: releasedTask,
      released_areas: releasedAreas,
      released_files: releasedFiles
    });

    return {
      success: true,
      released_task: releasedTask,
      released_areas: releasedAreas,
      released_files: releasedFiles
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

module.exports = {
  generateSessionId,
  registerSession,
  getActiveSessions,
  getLockedFiles,
  getLockedAreas,
  updateHeartbeat,
  updateSession,
  endSession,
  cleanupStaleSessions,
  logEvent,
  // Task claim/lease protocol
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
  heartbeat
};
