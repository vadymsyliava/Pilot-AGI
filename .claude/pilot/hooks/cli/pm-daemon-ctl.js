#!/usr/bin/env node

/**
 * CLI: PM Daemon control
 *
 * Start, stop, and monitor the persistent PM daemon process.
 *
 * Usage:
 *   node pm-daemon-ctl.js start [--once] [--dry-run]
 *   node pm-daemon-ctl.js stop
 *   node pm-daemon-ctl.js status
 *   node pm-daemon-ctl.js logs [--lines <n>]
 *
 * Part of Phase 3.14 (Pilot AGI-sms) — PM Daemon
 */

const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');

const libDir = path.join(__dirname, '..', 'lib');
const projectRoot = process.cwd();

// ============================================================================
// COMMANDS
// ============================================================================

const commands = { start: cmdStart, stop: cmdStop, status: cmdStatus, logs: cmdLogs };

const args = process.argv.slice(2);
const command = args[0];

if (!command || !commands[command]) {
  console.log(JSON.stringify({
    success: false,
    error: 'Usage: pm-daemon-ctl.js <start|stop|status|logs> [options]'
  }));
  process.exit(1);
}

commands[command](args.slice(1));

// ============================================================================
// start — launch daemon in background
// ============================================================================

function cmdStart(flags) {
  const { isDaemonRunning, readDaemonPid } = require(path.join(libDir, 'pm-daemon'));
  const once = flags.includes('--once');
  const dryRun = flags.includes('--dry-run');

  if (isDaemonRunning(projectRoot)) {
    const existing = readDaemonPid(projectRoot);
    console.log(JSON.stringify({
      success: false,
      error: `PM Daemon already running (PID: ${existing?.pid})`
    }));
    process.exit(1);
  }

  if (once) {
    // Run inline for --once mode
    const { PmDaemon } = require(path.join(libDir, 'pm-daemon'));
    const daemon = new PmDaemon(projectRoot, { once: true, dryRun });
    const result = daemon.start();
    console.log(JSON.stringify(result));
    return;
  }

  // Spawn detached background process
  const daemonScript = path.join(libDir, 'pm-daemon.js');
  const spawnArgs = [daemonScript, '--watch', `--root=${projectRoot}`];
  if (dryRun) spawnArgs.push('--dry-run');

  const child = spawn('node', spawnArgs, {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore']
  });

  child.unref();

  // Wait briefly for PID file to appear
  let attempts = 0;
  const maxAttempts = 10;
  const check = () => {
    attempts++;
    if (isDaemonRunning(projectRoot)) {
      const pidInfo = readDaemonPid(projectRoot);
      console.log(JSON.stringify({
        success: true,
        pid: pidInfo?.pid || child.pid,
        mode: 'watch',
        detached: true
      }));
    } else if (attempts < maxAttempts) {
      setTimeout(check, 200);
    } else {
      console.log(JSON.stringify({
        success: true,
        pid: child.pid,
        mode: 'watch',
        detached: true,
        note: 'Started but PID file not yet confirmed'
      }));
    }
  };

  setTimeout(check, 300);
}

// ============================================================================
// stop — graceful shutdown via SIGTERM
// ============================================================================

function cmdStop() {
  const { isDaemonRunning, readDaemonPid, DAEMON_PID_PATH } = require(path.join(libDir, 'pm-daemon'));

  const pidInfo = readDaemonPid(projectRoot);
  if (!pidInfo || !pidInfo.pid) {
    console.log(JSON.stringify({ success: false, error: 'No daemon PID file found' }));
    process.exit(1);
  }

  try {
    process.kill(pidInfo.pid, 0); // Check if alive
    process.kill(pidInfo.pid, 'SIGTERM');

    console.log(JSON.stringify({
      success: true,
      pid: pidInfo.pid,
      signal: 'SIGTERM'
    }));
  } catch (e) {
    // Process already dead — clean up stale PID
    const pidPath = path.join(projectRoot, DAEMON_PID_PATH);
    try { fs.unlinkSync(pidPath); } catch (e2) { /* best effort */ }

    console.log(JSON.stringify({
      success: true,
      pid: pidInfo.pid,
      note: 'Process already dead, cleaned up PID file'
    }));
  }
}

// ============================================================================
// status — show daemon health
// ============================================================================

function cmdStatus() {
  const {
    isDaemonRunning,
    readDaemonPid,
    loadDaemonState
  } = require(path.join(libDir, 'pm-daemon'));

  const running = isDaemonRunning(projectRoot);
  const pidInfo = readDaemonPid(projectRoot);
  const state = loadDaemonState(projectRoot);

  console.log(JSON.stringify({
    running,
    pid: pidInfo?.pid || null,
    started_at: pidInfo?.started_at || state?.started_at || null,
    state: state || null
  }));
}

// ============================================================================
// logs — tail daemon log
// ============================================================================

function cmdLogs(flags) {
  const { DAEMON_LOG_DIR, DAEMON_LOG_FILE } = require(path.join(libDir, 'pm-daemon'));

  const linesIdx = flags.indexOf('--lines');
  const lines = linesIdx >= 0 && flags[linesIdx + 1]
    ? parseInt(flags[linesIdx + 1], 10)
    : 50;

  const logPath = path.join(projectRoot, DAEMON_LOG_DIR, DAEMON_LOG_FILE);

  if (!fs.existsSync(logPath)) {
    console.log(JSON.stringify({ success: false, error: 'No daemon log file found' }));
    process.exit(1);
  }

  try {
    const content = fs.readFileSync(logPath, 'utf8');
    const allLines = content.trim().split('\n').filter(Boolean);
    const tail = allLines.slice(-lines);

    console.log(JSON.stringify({
      success: true,
      log_path: logPath,
      total_lines: allLines.length,
      showing: tail.length,
      entries: tail.map(line => {
        try { return JSON.parse(line); }
        catch { return { raw: line }; }
      })
    }));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
    process.exit(1);
  }
}
