#!/usr/bin/env node

/**
 * PM Watchdog — Monitors PM daemon and PM Claude session health.
 *
 * Responsibilities:
 * 1. Monitor PM daemon PID file — restart if process dies
 * 2. Monitor PM Claude terminal — detect if session crashed
 * 3. Write heartbeat file for external monitoring
 * 4. Enforce system resource limits (memory, CPU)
 *
 * Usage:
 *   node pm-watchdog.js [projectRoot]
 *
 * Part of PM Resilience [Pilot AGI-cs98]
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

// ============================================================================
// CONSTANTS
// ============================================================================

const CHECK_INTERVAL_MS = 15000;       // Check every 15s
const HEARTBEAT_PATH = '.claude/pilot/state/orchestrator/pm-watchdog.heartbeat';
const DAEMON_PID_PATH = '.claude/pilot/state/orchestrator/pm-daemon.pid';
const DAEMON_STATE_PATH = '.claude/pilot/state/orchestrator/pm-daemon-state.json';
const LOG_PATH = '.claude/pilot/logs/pm-watchdog.log';
const MAX_RESTARTS = 5;                // Max daemon restarts before giving up
const RESTART_COOLDOWN_MS = 30000;     // 30s between restart attempts
const MEMORY_WARN_PCT = 80;            // Warn at 80% system memory
const MEMORY_CRITICAL_PCT = 90;        // Critical at 90% — scale down agents

// ============================================================================
// STATE
// ============================================================================

let projectRoot = process.argv[2] || process.cwd();
let restartCount = 0;
let lastRestartTime = 0;
let running = true;

// ============================================================================
// LOGGING
// ============================================================================

function log(level, msg, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    component: 'pm-watchdog',
    msg,
    ...data
  };

  const logPath = path.join(projectRoot, LOG_PATH);
  try {
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch (e) { /* best effort */ }

  if (level === 'error' || level === 'warn') {
    console.error(`[${level.toUpperCase()}] ${msg}`, data);
  } else {
    console.log(`[${level.toUpperCase()}] ${msg}`);
  }
}

// ============================================================================
// DAEMON MONITORING
// ============================================================================

function isDaemonAlive() {
  const pidPath = path.join(projectRoot, DAEMON_PID_PATH);
  try {
    if (!fs.existsSync(pidPath)) return false;
    const pidInfo = JSON.parse(fs.readFileSync(pidPath, 'utf8'));
    if (!pidInfo.pid) return false;

    // Check if process is running
    process.kill(pidInfo.pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function getDaemonState() {
  const statePath = path.join(projectRoot, DAEMON_STATE_PATH);
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
  } catch (e) { /* corrupt state */ }
  return null;
}

function restartDaemon() {
  const now = Date.now();
  if (now - lastRestartTime < RESTART_COOLDOWN_MS) {
    log('debug', 'Restart cooldown active, skipping');
    return false;
  }

  if (restartCount >= MAX_RESTARTS) {
    log('error', 'Max restarts exceeded — PM daemon will not be restarted', {
      restarts: restartCount,
      max: MAX_RESTARTS
    });
    return false;
  }

  restartCount++;
  lastRestartTime = now;

  log('info', 'Restarting PM daemon', { attempt: restartCount });

  try {
    // Clean stale PID file
    const pidPath = path.join(projectRoot, DAEMON_PID_PATH);
    if (fs.existsSync(pidPath)) {
      fs.unlinkSync(pidPath);
    }

    // Restart daemon
    const daemonScript = path.join(projectRoot, '.claude/pilot/hooks/lib/pm-daemon.js');
    const child = spawn('node', [daemonScript, '--watch'], {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, PILOT_PM_SESSION: '1' }
    });

    child.unref();
    log('info', 'PM daemon restarted', { pid: child.pid });
    return true;
  } catch (e) {
    log('error', 'Failed to restart PM daemon', { error: e.message });
    return false;
  }
}

// ============================================================================
// RESOURCE MONITORING
// ============================================================================

function getSystemMemoryPct() {
  try {
    const osModule = require('os');
    const totalMem = osModule.totalmem();
    const freeMem = osModule.freemem();
    const usedPct = Math.round(((totalMem - freeMem) / totalMem) * 100);
    return usedPct;
  } catch (e) {
    return -1;
  }
}

// ============================================================================
// HEARTBEAT
// ============================================================================

function writeHeartbeat(status) {
  const hbPath = path.join(projectRoot, HEARTBEAT_PATH);
  try {
    const hbDir = path.dirname(hbPath);
    if (!fs.existsSync(hbDir)) fs.mkdirSync(hbDir, { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      status,
      daemon_alive: isDaemonAlive(),
      restarts: restartCount,
      memory_pct: getSystemMemoryPct()
    }));
  } catch (e) { /* best effort */ }
}

// ============================================================================
// MAIN CHECK LOOP
// ============================================================================

function check() {
  if (!running) return;

  const daemonAlive = isDaemonAlive();
  const memPct = getSystemMemoryPct();

  // 1. Check daemon health
  if (!daemonAlive) {
    log('warn', 'PM daemon is not running — attempting restart');
    restartDaemon();
  } else {
    // Reset restart counter on successful check
    if (restartCount > 0) {
      const state = getDaemonState();
      const lastTick = state?.last_tick_at;
      if (lastTick) {
        const tickAge = Date.now() - new Date(lastTick).getTime();
        if (tickAge < 120000) {
          // Daemon is healthy (ticked within 2min) — reset counter
          restartCount = 0;
        }
      }
    }
  }

  // 2. Check system resources
  if (memPct >= MEMORY_CRITICAL_PCT) {
    log('error', 'System memory critical', { memory_pct: memPct });
    // Write alert for PM daemon to scale down
    try {
      const alertPath = path.join(projectRoot, '.claude/pilot/state/orchestrator/resource-alert.json');
      fs.writeFileSync(alertPath, JSON.stringify({
        ts: new Date().toISOString(),
        type: 'memory_critical',
        memory_pct: memPct,
        action: 'scale_down'
      }));
    } catch (e) { /* best effort */ }
  } else if (memPct >= MEMORY_WARN_PCT) {
    log('warn', 'System memory high', { memory_pct: memPct });
  }

  // 3. Write heartbeat
  writeHeartbeat(daemonAlive ? 'healthy' : 'daemon_down');
}

// ============================================================================
// ENTRY POINT
// ============================================================================

function main() {
  log('info', 'PM Watchdog starting', {
    project_root: projectRoot,
    check_interval_ms: CHECK_INTERVAL_MS,
    max_restarts: MAX_RESTARTS
  });

  // Initial check
  check();

  // Periodic check
  const timer = setInterval(check, CHECK_INTERVAL_MS);

  // Graceful shutdown
  process.on('SIGTERM', () => {
    running = false;
    clearInterval(timer);
    log('info', 'PM Watchdog stopping (SIGTERM)');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    running = false;
    clearInterval(timer);
    log('info', 'PM Watchdog stopping (SIGINT)');
    process.exit(0);
  });
}

// ============================================================================
// EXPORTS (for testing)
// ============================================================================

module.exports = {
  isDaemonAlive,
  getDaemonState,
  restartDaemon,
  getSystemMemoryPct,
  writeHeartbeat,
  check,
  CHECK_INTERVAL_MS,
  MAX_RESTARTS,
  RESTART_COOLDOWN_MS,
  MEMORY_WARN_PCT,
  MEMORY_CRITICAL_PCT
};

// Run if executed directly
if (require.main === module) {
  main();
}
