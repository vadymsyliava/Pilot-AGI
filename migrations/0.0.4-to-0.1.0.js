/**
 * Migration: 0.0.4 -> 0.1.0
 *
 * Changes:
 * - Adds post-tool-use hook to settings.json if missing
 * - Adds pre-tool-use AskUserQuestion hook if missing
 * - Ensures state directories exist
 * - Writes VERSION lock file with metadata
 */

const fs = require('fs');
const path = require('path');

const description = 'Add new hooks configuration and state directories';

function up(targetDir) {
  const claudeDir = path.join(targetDir, '.claude');
  const pilotDir = path.join(claudeDir, 'pilot');
  const settingsPath = path.join(claudeDir, 'settings.json');

  // 1. Ensure state directories exist
  const stateDirs = [
    'state/sessions',
    'state/approved-plans',
    'state/handoffs',
    'state/respawns',
    'state/costs/tasks',
    'state/costs/agents',
    'state/escalations',
    'state/artifacts',
    'state/orchestrator',
    'state/spawn-context',
    'memory/channels'
  ];

  for (const dir of stateDirs) {
    const fullPath = path.join(pilotDir, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  }

  // 2. Update settings.json with new hooks
  if (fs.existsSync(settingsPath)) {
    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      return; // Can't parse, skip
    }

    if (!settings.hooks) settings.hooks = {};

    // Add PostToolUse hook if missing
    if (!settings.hooks.PostToolUse) {
      settings.hooks.PostToolUse = [];
    }

    const postToolUseExists = settings.hooks.PostToolUse.some(
      h => h.hooks?.[0]?.command?.includes('post-tool-use.js')
    );

    if (!postToolUseExists) {
      settings.hooks.PostToolUse.push({
        matcher: '*',
        hooks: [{
          type: 'command',
          command: `node "${path.join(pilotDir, 'hooks', 'post-tool-use.js')}"`,
          timeout: 10
        }]
      });
    }

    // Add AskUserQuestion interceptor if missing
    const askInterceptorExists = (settings.hooks.PreToolUse || []).some(
      h => h.hooks?.[0]?.command?.includes('ask-interceptor.js')
    );

    if (!askInterceptorExists) {
      if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
      settings.hooks.PreToolUse.push({
        matcher: 'AskUserQuestion',
        hooks: [{
          type: 'command',
          command: `node "${path.join(pilotDir, 'hooks', 'ask-interceptor.js')}"`,
          timeout: 5
        }]
      });
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }

  // 3. Write VERSION lock file
  const versionLock = {
    version: '0.1.0',
    installed_at: new Date().toISOString(),
    migrated_from: '0.0.4'
  };

  fs.writeFileSync(
    path.join(pilotDir, 'VERSION.lock'),
    JSON.stringify(versionLock, null, 2)
  );
}

function down(targetDir) {
  const pilotDir = path.join(targetDir, '.claude', 'pilot');

  // Remove VERSION.lock
  const lockPath = path.join(pilotDir, 'VERSION.lock');
  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath);
  }

  // We don't remove directories or revert settings — those are safe to keep
}

module.exports = { description, up, down };
