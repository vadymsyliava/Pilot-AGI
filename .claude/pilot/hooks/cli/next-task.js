#!/usr/bin/env node

/**
 * CLI helper: Get the next available task for the current session.
 *
 * Combines `bd ready --json` with session claim filtering to return
 * only tasks that are truly available — not claimed by any active session.
 *
 * This replaces the fragile LLM cross-referencing of two separate lists.
 *
 * Usage: node next-task.js [--limit <n>]
 * Output: JSON array of available tasks (empty array if none)
 *
 * Each task includes: { id, title, description, status, priority, labels }
 */

const path = require('path');
const { execFileSync } = require('child_process');

const libDir = path.join(__dirname, '..', 'lib');
const session = require(path.join(libDir, 'session'));

// Parse args
const args = process.argv.slice(2);
let limit = 5;
const limitIdx = args.indexOf('--limit');
if (limitIdx !== -1 && args[limitIdx + 1]) {
  limit = parseInt(args[limitIdx + 1], 10) || 5;
}

// 1. Resolve current session (PID-based, multi-agent safe)
const currentSessionId = session.resolveCurrentSession();

// 2. Get all claimed task IDs, excluding current session
//    (so if THIS session already claimed something, that task still shows for us)
const claimedByOthers = session.getClaimedTaskIds(currentSessionId);

// 3. Get ready tasks from bd
let readyTasks = [];
try {
  const raw = execFileSync('bd', ['ready', '--json'], {
    encoding: 'utf8',
    timeout: 10000,
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  readyTasks = JSON.parse(raw);
} catch (e) {
  // bd not available or no tasks
  console.log(JSON.stringify([]));
  process.exit(0);
}

// 4. Filter out tasks claimed by other sessions
const available = readyTasks.filter(task => !claimedByOthers.includes(task.id));

// 5. Also separate: what does THIS session currently have claimed?
let myClaimedTask = null;
if (currentSessionId) {
  try {
    const stateDir = path.join(process.cwd(), '.claude/pilot/state/sessions');
    const sessFile = path.join(stateDir, `${currentSessionId}.json`);
    const fs = require('fs');
    if (fs.existsSync(sessFile)) {
      const sessData = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
      myClaimedTask = sessData.claimed_task || null;
    }
  } catch (e) { /* ignore */ }
}

// 6. Output result
const result = {
  session_id: currentSessionId,
  my_claimed_task: myClaimedTask,
  available: available.slice(0, limit),
  total_ready: readyTasks.length,
  claimed_by_others: claimedByOthers.length
};

console.log(JSON.stringify(result, null, 2));
