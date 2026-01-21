#!/usr/bin/env node

/**
 * Pilot AGI Installer
 *
 * Installs Pilot AGI commands, skills, and hooks for Claude Code.
 *
 * Usage:
 *   npx pilot-agi --global    # Install to ~/.claude/
 *   npx pilot-agi --local     # Install to ./.claude/
 *   npx pilot-agi             # Interactive prompt
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const VERSION = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim();

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logStep(step, message) {
  console.log(`${colors.cyan}[${step}]${colors.reset} ${message}`);
}

function logSuccess(message) {
  console.log(`${colors.green}✓${colors.reset} ${message}`);
}

function logError(message) {
  console.error(`${colors.red}✗${colors.reset} ${message}`);
}

async function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function copyDirectory(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function getHomePath() {
  return process.env.HOME || process.env.USERPROFILE || '~';
}

function updateSettings(claudeDir) {
  const settingsPath = path.join(claudeDir, 'settings.json');
  let settings = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      settings = {};
    }
  }

  // Add hooks configuration
  if (!settings.hooks) {
    settings.hooks = {};
  }

  // SessionStart hook for update checking
  if (!settings.hooks.SessionStart) {
    settings.hooks.SessionStart = [];
  }

  const sessionStartHook = {
    matcher: '*',
    hooks: [{
      type: 'command',
      command: `node "${path.join(claudeDir, 'hooks', 'session-start.js')}"`,
      timeout: 10
    }]
  };

  // Check if hook already exists
  const hookExists = settings.hooks.SessionStart.some(
    h => h.hooks?.[0]?.command?.includes('session-start.js')
  );

  if (!hookExists) {
    settings.hooks.SessionStart.push(sessionStartHook);
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

async function install(targetDir, isGlobal) {
  const packageDir = path.join(__dirname, '..');
  const claudeDir = path.join(targetDir, '.claude');

  log('\n╔══════════════════════════════════════════╗', 'cyan');
  log('║         Pilot AGI Installer              ║', 'cyan');
  log(`║              v${VERSION.padEnd(26)}║`, 'cyan');
  log('╚══════════════════════════════════════════╝\n', 'cyan');

  logStep('1/5', 'Creating directories...');

  const dirs = [
    path.join(claudeDir, 'commands', 'pilot'),
    path.join(claudeDir, 'skills', 'pilot'),
    path.join(claudeDir, 'hooks'),
    path.join(claudeDir, 'agents')
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
  logSuccess('Directories created');

  logStep('2/5', 'Installing commands...');
  copyDirectory(
    path.join(packageDir, 'commands', 'pilot'),
    path.join(claudeDir, 'commands', 'pilot')
  );
  logSuccess('Commands installed');

  logStep('3/5', 'Installing skills...');
  copyDirectory(
    path.join(packageDir, 'skills', 'pilot'),
    path.join(claudeDir, 'skills', 'pilot')
  );
  logSuccess('Skills installed');

  logStep('4/5', 'Installing hooks...');
  copyDirectory(
    path.join(packageDir, 'hooks'),
    path.join(claudeDir, 'hooks')
  );
  logSuccess('Hooks installed');

  logStep('5/5', 'Configuring settings...');
  updateSettings(claudeDir);

  // Write version file
  fs.writeFileSync(
    path.join(claudeDir, 'pilot-version'),
    VERSION
  );
  logSuccess('Settings configured');

  // Copy agents
  if (fs.existsSync(path.join(packageDir, 'agents'))) {
    copyDirectory(
      path.join(packageDir, 'agents'),
      path.join(claudeDir, 'agents')
    );
  }

  log('\n════════════════════════════════════════════', 'green');
  log('  Installation complete!', 'green');
  log('════════════════════════════════════════════\n', 'green');

  log('Next steps:', 'bright');
  log('  1. Restart Claude Code to load commands');
  log('  2. Run /pilot:help to see available commands');
  log('  3. Run /pilot:init to start a new project\n');

  if (isGlobal) {
    log(`Installed to: ${claudeDir}`, 'yellow');
  } else {
    log(`Installed to: ${claudeDir}`, 'yellow');
    log('Add .claude/ to your .gitignore if needed\n', 'yellow');
  }
}

async function main() {
  const args = process.argv.slice(2);

  // Check for flags
  const isGlobal = args.includes('--global') || args.includes('-g');
  const isLocal = args.includes('--local') || args.includes('-l');
  const showHelp = args.includes('--help') || args.includes('-h');

  if (showHelp) {
    log('\nPilot AGI Installer\n', 'bright');
    log('Usage:');
    log('  npx pilot-agi [options]\n');
    log('Options:');
    log('  --global, -g    Install to ~/.claude/ (available everywhere)');
    log('  --local, -l     Install to ./.claude/ (project only)');
    log('  --help, -h      Show this help message\n');
    process.exit(0);
  }

  let targetDir;

  if (isGlobal) {
    targetDir = getHomePath();
  } else if (isLocal) {
    targetDir = process.cwd();
  } else {
    // Interactive prompt
    log('\nWhere would you like to install Pilot AGI?\n', 'bright');
    log('  [g] Global (~/.claude/) - Available in all projects');
    log('  [l] Local (./.claude/)  - This project only\n');

    const answer = await prompt('Choose (g/l): ');

    if (answer === 'g' || answer === 'global') {
      targetDir = getHomePath();
    } else if (answer === 'l' || answer === 'local') {
      targetDir = process.cwd();
    } else {
      log('\nDefaulting to global installation...', 'yellow');
      targetDir = getHomePath();
    }
  }

  try {
    await install(targetDir, targetDir === getHomePath());
  } catch (error) {
    logError(`Installation failed: ${error.message}`);
    process.exit(1);
  }
}

main();
