#!/usr/bin/env node

/**
 * CLI helper: Release a claimed task from the current session.
 *
 * Called by /pilot-release or /pilot-close.
 * Performs release: session.releaseTask() + messaging.sendBroadcast().
 *
 * Usage: node release-task.js [--session <session-id>] [--pm-override]
 * Output: JSON { success, released_task?, error?, broadcast? }
 *
 * Ownership: By default, only the calling session can release its own task.
 * Use --session <id> with --pm-override to release another session's task (PM only).
 */

const path = require('path');
const fs = require('fs');

const libDir = path.join(__dirname, '..', 'lib');
const session = require(path.join(libDir, 'session'));

// Parse args
const args = process.argv.slice(2);
let targetSessionId = null;
const pmOverride = args.includes('--pm-override');

const sessionIdx = args.indexOf('--session');
if (sessionIdx !== -1 && args[sessionIdx + 1]) {
  targetSessionId = args[sessionIdx + 1];
}

// Resolve current session via PID matching (not mtime — multi-agent safe)
const callerSessionId = session.resolveCurrentSession();

// If no target specified, release caller's own task
if (!targetSessionId) {
  targetSessionId = callerSessionId;
}

if (!targetSessionId) {
  console.log(JSON.stringify({ success: false, error: 'No active session found' }));
  process.exit(1);
}

// Release the task (with ownership check)
const result = session.releaseTask(targetSessionId, {
  callerSessionId: callerSessionId,
  pmOverride: pmOverride
});

if (!result.success) {
  console.log(JSON.stringify(result));
  process.exit(1);
}

// Broadcast release to other agents
let broadcastResult = null;
try {
  const messaging = require(path.join(libDir, 'messaging'));
  broadcastResult = messaging.sendBroadcast(callerSessionId || targetSessionId, 'task_released', {
    task_id: result.released_task,
    released_by: callerSessionId || targetSessionId
  });
} catch (e) {
  broadcastResult = { error: e.message };
}

console.log(JSON.stringify({
  success: true,
  session_id: targetSessionId,
  released_task: result.released_task,
  released_areas: result.released_areas,
  broadcast: broadcastResult ? 'sent' : 'skipped'
}));
