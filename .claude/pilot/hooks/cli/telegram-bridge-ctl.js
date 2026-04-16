#!/usr/bin/env node
/**
 * Telegram Bridge CLI Controller (Phase 6.5)
 *
 * Usage:
 *   node telegram-bridge-ctl.js start   — Start the bridge daemon
 *   node telegram-bridge-ctl.js stop    — Stop the bridge daemon
 *   node telegram-bridge-ctl.js status  — Check bridge status
 *
 * Environment:
 *   PILOT_TELEGRAM_TOKEN — Telegram bot token (required for start)
 *
 * Part of Phase 6.5 (Pilot AGI-6l3)
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// RESOLVE PROJECT ROOT
// ============================================================================

function findProjectRoot() {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.claude', 'pilot'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

const PROJECT_ROOT = findProjectRoot();
const PID_FILE = path.join(PROJECT_ROOT, '.claude/pilot/state/telegram/bridge.pid');
const POLICY_PATH = path.join(PROJECT_ROOT, '.claude/pilot/policy.yaml');

// ============================================================================
// POLICY LOADER (inline, minimal)
// ============================================================================

function loadTelegramConfig() {
  try {
    const policyLoader = require('../lib/policy');
    const policy = policyLoader.loadPolicy(PROJECT_ROOT);
    return policy.telegram || {};
  } catch {
    // Fallback: read telegram section manually
    try {
      if (!fs.existsSync(POLICY_PATH)) return {};
      const content = fs.readFileSync(POLICY_PATH, 'utf8');
      // Simple extraction — look for telegram: section
      const match = content.match(/^telegram:\s*\n((?:  .+\n)+)/m);
      if (!match) return {};
      // Parse basic key-value pairs
      const config = {};
      const lines = match[1].split('\n');
      for (const line of lines) {
        const kv = line.trim().match(/^(\w+):\s*(.+)$/);
        if (kv) {
          let val = kv[2].trim();
          if (val === 'true') val = true;
          else if (val === 'false') val = false;
          else if (/^\d+$/.test(val)) val = parseInt(val, 10);
          else if (val.startsWith('[') && val.endsWith(']')) {
            val = val.slice(1, -1).split(',').map(s => {
              const n = parseInt(s.trim(), 10);
              return isNaN(n) ? s.trim() : n;
            }).filter(Boolean);
          }
          config[kv[1]] = val;
        }
      }
      return config;
    } catch {
      return {};
    }
  }
}

// ============================================================================
// COMMANDS
// ============================================================================

function cmdStatus() {
  if (!fs.existsSync(PID_FILE)) {
    console.log(JSON.stringify({ running: false }));
    return;
  }

  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);

  // Check if process is alive
  try {
    process.kill(pid, 0);
    console.log(JSON.stringify({ running: true, pid }));
  } catch {
    // Stale PID file
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    console.log(JSON.stringify({ running: false, stale_pid: pid }));
  }
}

function cmdStop() {
  if (!fs.existsSync(PID_FILE)) {
    console.log(JSON.stringify({ success: false, error: 'Bridge not running' }));
    return;
  }

  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);

  try {
    process.kill(pid, 'SIGTERM');
    // Wait briefly and clean up
    setTimeout(() => {
      try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    }, 1000);
    console.log(JSON.stringify({ success: true, stopped_pid: pid }));
  } catch (e) {
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    console.log(JSON.stringify({ success: false, error: `Process ${pid} not found: ${e.message}` }));
  }
}

async function cmdStart() {
  // Check if already running
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    try {
      process.kill(pid, 0);
      console.log(JSON.stringify({ success: false, error: `Bridge already running (PID ${pid})` }));
      return;
    } catch {
      // Stale PID file
      try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    }
  }

  // Get token
  const token = process.env.PILOT_TELEGRAM_TOKEN;
  if (!token) {
    console.log(JSON.stringify({
      success: false,
      error: 'PILOT_TELEGRAM_TOKEN environment variable not set',
    }));
    process.exitCode = 1;
    return;
  }

  // Load config
  const config = loadTelegramConfig();

  if (!config.enabled) {
    console.log(JSON.stringify({
      success: false,
      error: 'Telegram is not enabled in policy.yaml. Set telegram.enabled: true',
    }));
    process.exitCode = 1;
    return;
  }

  const allowedChatIds = config.allowed_chat_ids || [];
  if (allowedChatIds.length === 0) {
    console.log(JSON.stringify({
      success: false,
      error: 'No allowed_chat_ids configured in policy.yaml telegram section',
    }));
    process.exitCode = 1;
    return;
  }

  // Start bridge
  const { TelegramBridge } = require('../lib/telegram-bridge');

  const bridge = new TelegramBridge({
    token,
    allowedChatIds,
    projectRoot: PROJECT_ROOT,
    rateLimit: config.rate_limit,
    killSwitchPhrase: config.kill_switch_phrase,
    notifications: config.notifications || config.proactive_updates,
    approval: config.approval,
  });

  try {
    const result = await bridge.start();
    console.log(JSON.stringify({
      success: true,
      pid: process.pid,
      bot_username: result.username,
    }));

    // Graceful shutdown handlers
    process.on('SIGTERM', async () => {
      await bridge.stop();
      process.exit(0);
    });
    process.on('SIGINT', async () => {
      await bridge.stop();
      process.exit(0);
    });
  } catch (e) {
    console.log(JSON.stringify({
      success: false,
      error: e.message,
    }));
    process.exitCode = 1;
  }
}

// ============================================================================
// MAIN
// ============================================================================

const command = process.argv[2] || 'status';

switch (command) {
  case 'start':
    cmdStart().catch(e => {
      console.log(JSON.stringify({ success: false, error: e.message }));
      process.exitCode = 1;
    });
    break;
  case 'stop':
    cmdStop();
    break;
  case 'status':
    cmdStatus();
    break;
  default:
    console.log(JSON.stringify({
      success: false,
      error: `Unknown command: ${command}. Use start, stop, or status.`,
    }));
    process.exitCode = 1;
}
