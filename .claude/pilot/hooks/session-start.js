#!/usr/bin/env node

/**
 * Pilot AGI Session Start Hook (v2.0)
 *
 * Runs when Claude Code session starts.
 *
 * Features:
 * - Session ID generation and registration
 * - Multi-session coordination (detect other active sessions)
 * - Locked file/area awareness
 * - Project context loading (brief, roadmap)
 * - Policy loading
 * - Version update checking
 * - Beads task context
 * - Session capsule resume hints
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

// Import session and policy utilities
const session = require('./lib/session');
const { loadPolicy } = require('./lib/policy');

// =============================================================================
// VERSION CHECK (preserved from v1)
// =============================================================================

function getInstalledVersion() {
  const locations = [
    path.join(process.env.HOME || '', '.claude', 'pilot', 'VERSION'),
    path.join(process.cwd(), '.claude', 'pilot', 'VERSION')
  ];

  for (const loc of locations) {
    if (fs.existsSync(loc)) {
      return fs.readFileSync(loc, 'utf8').trim();
    }
  }
  return null;
}

function checkLatestVersion() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'registry.npmjs.org',
      path: '/pilot-agi/latest',
      method: 'GET',
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data).version);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function isNewer(latest, current) {
  const l = latest.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return true;
    if ((l[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

// =============================================================================
// BEADS CONTEXT (preserved from v1)
// Note: Uses execSync with hardcoded command - no user input interpolation
// =============================================================================

function getBeadsContext() {
  if (!fs.existsSync(path.join(process.cwd(), '.beads'))) return null;

  try {
    // Safe: command is hardcoded, no user input
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

    // Safe: command is hardcoded, no user input
    const ready = JSON.parse(execSync('bd ready --json 2>/dev/null || echo "[]"', {
      encoding: 'utf8', timeout: 5000
    }));
    return { readyCount: ready.length, hasTask: false };
  } catch (e) {
    return null;
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
  } catch (e) {
    // Continue without registration
  }

  // Check for other active sessions
  const activeSessions = session.getActiveSessions(sessionId);
  if (activeSessions.length > 0) {
    context.active_sessions = activeSessions.length;
    messages.push(`${activeSessions.length} other session(s) active`);

    // Get locked files and areas
    const lockedFiles = session.getLockedFiles(activeSessions);
    const lockedAreas = session.getLockedAreas(activeSessions);

    if (lockedFiles.length > 0) {
      context.locked_files = lockedFiles;
    }
    if (lockedAreas.length > 0) {
      context.locked_areas = lockedAreas;
    }
  }

  // -------------------------------------------------------------------------
  // 2. Policy Loading (new in v2)
  // -------------------------------------------------------------------------

  try {
    const policy = loadPolicy();
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
  // 4. Version Check (preserved from v1)
  // -------------------------------------------------------------------------

  const version = getInstalledVersion();
  if (version) {
    try {
      const latest = await checkLatestVersion();
      if (isNewer(latest, version)) {
        messages.push(`Update: v${latest} available`);
        context.update_available = latest;
      }
    } catch (e) {
      // Network error, skip update check
    }
  }

  // -------------------------------------------------------------------------
  // 5. Beads Context (preserved from v1)
  // -------------------------------------------------------------------------

  const bd = getBeadsContext();
  if (bd) {
    if (bd.currentTask) {
      messages.push(`Active: [${bd.currentTask.id}] ${bd.currentTask.title}`);
      context.active_task = bd.currentTask;
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
  // 7. Build Output
  // -------------------------------------------------------------------------

  if (messages.length > 0) {
    output.systemMessage = messages.join(' | ');
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
