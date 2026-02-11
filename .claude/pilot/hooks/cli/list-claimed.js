#!/usr/bin/env node

/**
 * CLI helper: List task IDs currently claimed by active sessions.
 *
 * Used by /pilot-next to filter bd ready results, preventing
 * multiple agents from picking the same task.
 *
 * Usage: node list-claimed.js [--exclude <session-id>]
 * Output: JSON array of claimed task IDs, e.g. ["Pilot AGI-csv", "Pilot AGI-16h"]
 */

const path = require('path');
const session = require(path.join(__dirname, '..', 'lib', 'session'));

const args = process.argv.slice(2);
let excludeSessionId = null;

const excludeIdx = args.indexOf('--exclude');
if (excludeIdx !== -1 && args[excludeIdx + 1]) {
  excludeSessionId = args[excludeIdx + 1];
}

const claimed = session.getClaimedTaskIds(excludeSessionId);
console.log(JSON.stringify(claimed));
