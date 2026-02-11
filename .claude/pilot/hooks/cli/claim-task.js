#!/usr/bin/env node

/**
 * CLI helper: Claim a task for the current session.
 *
 * Called by /pilot-next when user selects "Start implementation".
 * Performs atomic claim: session.claimTask() + messaging.sendBroadcast().
 *
 * Usage: node claim-task.js <task-id> [--lease-ms <ms>]
 * Output: JSON { success, claim?, error?, broadcast? }
 */

const path = require('path');

// Resolve lib relative to this file's location
const libDir = path.join(__dirname, '..', 'lib');
const session = require(path.join(libDir, 'session'));

// Parse args
const args = process.argv.slice(2);
const taskId = args[0];

if (!taskId) {
  console.log(JSON.stringify({ success: false, error: 'Usage: claim-task.js <task-id>' }));
  process.exit(1);
}

let leaseDurationMs = session.DEFAULT_LEASE_DURATION_MS;
const leaseIdx = args.indexOf('--lease-ms');
if (leaseIdx !== -1 && args[leaseIdx + 1]) {
  leaseDurationMs = parseInt(args[leaseIdx + 1], 10) || leaseDurationMs;
}

// Find current session ID (most recent active session by mtime)
function getCurrentSessionId() {
  const fs = require('fs');
  const stateDir = path.join(process.cwd(), '.claude/pilot/state/sessions');
  if (!fs.existsSync(stateDir)) return null;

  const files = fs.readdirSync(stateDir)
    .filter(f => f.startsWith('S-') && f.endsWith('.json') && !f.includes('.pressure'))
    .map(f => ({
      name: f,
      mtime: fs.statSync(path.join(stateDir, f)).mtime.getTime()
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) return null;

  const content = fs.readFileSync(path.join(stateDir, files[0].name), 'utf8');
  const sess = JSON.parse(content);
  return sess.status === 'active' ? sess.session_id : null;
}

// Main
const sessionId = getCurrentSessionId();
if (!sessionId) {
  console.log(JSON.stringify({ success: false, error: 'No active session found' }));
  process.exit(1);
}

// Check if already claimed by another session
const existingClaim = session.isTaskClaimed(taskId);
if (existingClaim && existingClaim.session_id !== sessionId) {
  console.log(JSON.stringify({
    success: false,
    error: `Task ${taskId} already claimed by ${existingClaim.session_id}`,
    existing_claim: existingClaim
  }));
  process.exit(1);
}

// Claim the task
const result = session.claimTask(sessionId, taskId, leaseDurationMs);

if (!result.success) {
  console.log(JSON.stringify(result));
  process.exit(1);
}

// Broadcast claim to other agents
let broadcastResult = null;
try {
  const messaging = require(path.join(libDir, 'messaging'));
  broadcastResult = messaging.sendBroadcast(sessionId, 'task_claimed', {
    task_id: taskId,
    claimed_by: sessionId,
    lease_expires_at: result.claim.lease_expires_at
  });
} catch (e) {
  // Messaging not critical — claim still succeeded
  broadcastResult = { error: e.message };
}

console.log(JSON.stringify({
  success: true,
  session_id: sessionId,
  claim: result.claim,
  broadcast: broadcastResult ? 'sent' : 'skipped'
}));
