#!/usr/bin/env node

/**
 * CLI: PM Watcher management
 *
 * Start, stop, and monitor the autonomous PM-Executor watcher process.
 *
 * Usage:
 *   node pm-watcher-cli.js start [--pm-session <id>] [--dry-run]
 *   node pm-watcher-cli.js stop
 *   node pm-watcher-cli.js status
 *   node pm-watcher-cli.js drain [--force]
 *
 * Part of Pilot AGI-v1k — Autonomous PM-Executor Loop
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Resolve lib relative to this file's location
const libDir = path.join(__dirname, '..', 'lib');

// Project root is CWD (the watcher runs from project root)
const projectRoot = process.cwd();

// ============================================================================
// COMMANDS
// ============================================================================

const commands = {
  start: cmdStart,
  stop: cmdStop,
  status: cmdStatus,
  drain: cmdDrain
};

// Parse args
const args = process.argv.slice(2);
const command = args[0];

if (!command || !commands[command]) {
  console.log(JSON.stringify({
    success: false,
    error: `Usage: pm-watcher-cli.js <start|stop|status|drain> [options]`
  }));
  process.exit(1);
}

commands[command](args.slice(1));

// ============================================================================
// START
// ============================================================================

function cmdStart(args) {
  const { PmWatcher, isWatcherRunning } = require(path.join(libDir, 'pm-watcher'));
  const { PmLoop } = require(path.join(libDir, 'pm-loop'));
  const pmQueue = require(path.join(libDir, 'pm-queue'));

  // Parse options
  const pmSessionIdx = args.indexOf('--pm-session');
  const pmSessionId = pmSessionIdx !== -1 ? args[pmSessionIdx + 1] : discoverPmSession();
  const dryRun = args.includes('--dry-run');
  const daemonize = args.includes('--daemon');

  if (!pmSessionId) {
    console.log(JSON.stringify({
      success: false,
      error: 'No PM session found. Start a PM terminal first or use --pm-session <id>'
    }));
    process.exit(1);
  }

  if (isWatcherRunning(projectRoot)) {
    console.log(JSON.stringify({
      success: false,
      error: 'PM Watcher is already running'
    }));
    process.exit(1);
  }

  if (daemonize) {
    // Fork as a background daemon
    const child = spawn(process.execPath, [__filename, 'start', '--pm-session', pmSessionId, ...(dryRun ? ['--dry-run'] : [])], {
      detached: true,
      stdio: 'ignore',
      cwd: projectRoot
    });
    child.unref();

    console.log(JSON.stringify({
      success: true,
      daemon_pid: child.pid,
      pm_session: pmSessionId,
      dry_run: dryRun
    }));
    process.exit(0);
  }

  // Create watcher and loop
  const watcher = new PmWatcher(projectRoot);
  const loop = new PmLoop(projectRoot, { pmSessionId, dryRun });

  // Initialize loop
  loop.initialize(pmSessionId);

  // Wire watcher events to loop
  watcher.on('bus_event', ({ event, classification }) => {
    const results = loop.processEvents([{ event, classification }]);
    if (results.length > 0 && !dryRun) {
      // Log results for observability
      for (const r of results) {
        process.stderr.write(`[watcher] ${r.action}: ${JSON.stringify(r.result || r.error)}\n`);
      }
    }
  });

  watcher.on('started', (info) => {
    process.stderr.write(`[watcher] Started (PID: ${info.pid})\n`);

    // Start periodic scan timer
    const scanTimer = setInterval(() => {
      if (!watcher.running) {
        clearInterval(scanTimer);
        return;
      }

      const scanResults = loop.runPeriodicScans();
      if (scanResults.length > 0) {
        for (const r of scanResults) {
          process.stderr.write(`[scan] ${r.action}: ${JSON.stringify(r.findings || r)}\n`);
        }
      }

      // Also try to drain the queue
      const drainResult = pmQueue.drainQueue(projectRoot, { dryRun });
      if (drainResult.drained > 0) {
        process.stderr.write(`[drain] Processed ${drainResult.drained} queued actions\n`);
      }
    }, 10000); // Every 10 seconds
  });

  watcher.on('stopped', (info) => {
    process.stderr.write(`[watcher] Stopped: ${info.reason}\n`);
    loop.stop(info.reason);
  });

  watcher.on('error', (err) => {
    process.stderr.write(`[watcher] Error: ${err.message}\n`);
  });

  // Graceful shutdown
  const shutdown = (signal) => {
    process.stderr.write(`\n[watcher] Received ${signal}, shutting down...\n`);
    watcher.stop(signal);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start watching
  watcher.start();

  // Output start confirmation
  console.log(JSON.stringify({
    success: true,
    pid: process.pid,
    pm_session: pmSessionId,
    dry_run: dryRun,
    watching: '.claude/pilot/messages/bus.jsonl'
  }));
}

// ============================================================================
// STOP
// ============================================================================

function cmdStop() {
  const { readPidFile, removePidFile } = require(path.join(libDir, 'pm-watcher'));

  const pidInfo = readPidFile(projectRoot);
  if (!pidInfo || !pidInfo.pid) {
    console.log(JSON.stringify({
      success: false,
      error: 'No PM Watcher running (no PID file found)'
    }));
    process.exit(1);
  }

  try {
    process.kill(pidInfo.pid, 'SIGTERM');
    removePidFile(projectRoot);
    console.log(JSON.stringify({
      success: true,
      stopped_pid: pidInfo.pid,
      was_started_at: pidInfo.started_at
    }));
  } catch (e) {
    // Process might already be dead
    removePidFile(projectRoot);
    console.log(JSON.stringify({
      success: true,
      note: 'Process was already dead, cleaned up PID file',
      pid: pidInfo.pid
    }));
  }
}

// ============================================================================
// STATUS
// ============================================================================

function cmdStatus() {
  const { isWatcherRunning, readPidFile, loadWatcherState } = require(path.join(libDir, 'pm-watcher'));
  const pmQueue = require(path.join(libDir, 'pm-queue'));
  const injector = require(path.join(libDir, 'stdin-injector'));

  const running = isWatcherRunning(projectRoot);
  const pidInfo = readPidFile(projectRoot);
  const watcherState = loadWatcherState(projectRoot);
  const queueHealth = pmQueue.getQueueHealth(projectRoot);
  const queueStats = injector.getQueueStats(projectRoot);

  console.log(JSON.stringify({
    running,
    pid: pidInfo?.pid || null,
    started_at: pidInfo?.started_at || null,
    watcher: {
      events_processed: watcherState.stats?.events_processed || 0,
      errors_count: watcherState.stats?.errors_count || 0,
      last_processed_at: watcherState.last_processed_at,
      byte_offset: watcherState.byte_offset
    },
    queue: queueStats,
    queue_health: {
      pm_available: queueHealth.pm_available,
      consecutive_failures: queueHealth.consecutive_failures,
      needs_attention: queueHealth.needs_attention,
      total_drained: queueHealth.total_drained,
      total_failed: queueHealth.total_failed
    }
  }, null, 2));
}

// ============================================================================
// DRAIN
// ============================================================================

function cmdDrain(args) {
  const pmQueue = require(path.join(libDir, 'pm-queue'));
  const force = args.includes('--force');

  const result = force
    ? pmQueue.forceRetry(projectRoot)
    : pmQueue.drainQueue(projectRoot);

  console.log(JSON.stringify(result, null, 2));
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Discover the PM session ID from orchestrator state
 */
function discoverPmSession() {
  try {
    const pmStatePath = path.join(projectRoot, '.claude/pilot/state/orchestrator/pm-state.json');
    if (fs.existsSync(pmStatePath)) {
      const pmState = JSON.parse(fs.readFileSync(pmStatePath, 'utf8'));
      return pmState.pm_session_id || null;
    }
  } catch (e) {
    // Fall through
  }

  // Try to find active session that looks like PM
  try {
    const session = require(path.join(libDir, 'session'));
    const active = session.getActiveSessions();
    // Return the first active session as PM (fallback)
    return active.length > 0 ? active[0].session_id : null;
  } catch (e) {
    return null;
  }
}
