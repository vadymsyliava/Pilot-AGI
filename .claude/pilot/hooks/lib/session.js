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
  logEvent
};
