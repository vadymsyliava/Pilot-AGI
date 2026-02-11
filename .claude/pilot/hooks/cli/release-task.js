#!/usr/bin/env node

/**
 * CLI helper: Release a claimed task from the current session.
 *
 * Called by /pilot-release or /pilot-close.
 * Performs release: session.releaseTask() + messaging.sendBroadcast().
 *
 * Usage: node release-task.js [--session <session-id>]
 * Output: JSON { success, released_task?, error?, broadcast? }
 */

const path = require('path');
const fs = require('fs');

const libDir = path.join(__dirname, '..', 'lib');
const session = require(path.join(libDir, 'session'));

// Parse args
const args = process.argv.slice(2);
let sessionId = null;

const sessionIdx = args.indexOf('--session');
if (sessionIdx !== -1 && args[sessionIdx + 1]) {
  sessionId = args[sessionIdx + 1];
}

// Find current session ID if not provided
if (!sessionId) {
  const stateDir = path.join(process.cwd(), '.claude/pilot/state/sessions');
  if (fs.existsSync(stateDir)) {
    const files = fs.readdirSync(stateDir)
      .filter(f => f.startsWith('S-') && f.endsWith('.json') && !f.includes('.pressure'))
      .map(f => ({
        name: f,
        mtime: fs.statSync(path.join(stateDir, f)).mtime.getTime()
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > 0) {
      const content = fs.readFileSync(path.join(stateDir, files[0].name), 'utf8');
      const sess = JSON.parse(content);
      if (sess.status === 'active') sessionId = sess.session_id;
    }
  }
}

if (!sessionId) {
  console.log(JSON.stringify({ success: false, error: 'No active session found' }));
  process.exit(1);
}

// Release the task
const result = session.releaseTask(sessionId);

if (!result.success) {
  console.log(JSON.stringify(result));
  process.exit(1);
}

// Broadcast release to other agents
let broadcastResult = null;
try {
  const messaging = require(path.join(libDir, 'messaging'));
  broadcastResult = messaging.sendBroadcast(sessionId, 'task_released', {
    task_id: result.released_task,
    released_by: sessionId
  });
} catch (e) {
  broadcastResult = { error: e.message };
}

console.log(JSON.stringify({
  success: true,
  session_id: sessionId,
  released_task: result.released_task,
  released_areas: result.released_areas,
  broadcast: broadcastResult ? 'sent' : 'skipped'
}));
