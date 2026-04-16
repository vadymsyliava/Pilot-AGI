#!/usr/bin/env node
/**
 * PM Dashboard Live — Phase 6.16 + 6.7 (Pilot AGI-5jg, Pilot AGI-4b6)
 *
 * Runs the multi-model PM dashboard in live-refresh mode.
 * With --interactive flag, enables keyboard shortcuts for PM actions.
 *
 * Usage:
 *   node scripts/pm-dashboard-live.js [--refresh 3000] [--interactive]
 */

'use strict';

const path = require('path');
const { PmDashboard, PmDashboardInteractive } = require(path.join(__dirname, '..', 'lib', 'pm-dashboard-terminal'));

const projectRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

// Parse --refresh flag
let refreshMs = 5000;
const refreshIdx = args.indexOf('--refresh');
if (refreshIdx !== -1 && args[refreshIdx + 1]) {
  refreshMs = parseInt(args[refreshIdx + 1], 10) || 5000;
}

const interactive = args.includes('--interactive') || args.includes('-i');

if (interactive) {
  // Interactive mode with keyboard shortcuts
  const tui = new PmDashboardInteractive({
    projectRoot,
    refreshMs,
    onAction: (action) => {
      if (action.type === 'quit') {
        process.exit(0);
      }
    }
  });

  tui.start();

  process.on('SIGTERM', () => {
    tui.stop();
    process.exit(0);
  });
} else {
  // Classic passive mode
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
}
