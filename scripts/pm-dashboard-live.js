#!/usr/bin/env node
/**
 * PM Dashboard Live — Phase 6.16 (Pilot AGI-5jg)
 *
 * Runs the multi-model PM dashboard in live-refresh mode.
 *
 * Usage:
 *   node scripts/pm-dashboard-live.js [--refresh 3000]
 */

'use strict';

const path = require('path');
const { PmDashboard } = require(path.join(__dirname, '..', 'lib', 'pm-dashboard-terminal'));

const projectRoot = path.resolve(__dirname, '..');

// Parse --refresh flag
let refreshMs = 5000;
const refreshIdx = process.argv.indexOf('--refresh');
if (refreshIdx !== -1 && process.argv[refreshIdx + 1]) {
  refreshMs = parseInt(process.argv[refreshIdx + 1], 10) || 5000;
}

const dashboard = new PmDashboard({ projectRoot });

console.log(`Starting PM Dashboard (refresh: ${refreshMs}ms, Ctrl+C to exit)`);

const live = dashboard.startLive({ refreshMs });

process.on('SIGINT', () => {
  live.stop();
  console.log('\nDashboard stopped.');
  process.exit(0);
});

process.on('SIGTERM', () => {
  live.stop();
  process.exit(0);
});
