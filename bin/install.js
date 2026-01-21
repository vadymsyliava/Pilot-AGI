#!/usr/bin/env node

/**
 * Pilot AGI Installer
 *
 * Installs Pilot AGI commands, skills, and hooks for Claude Code.
 * Automatically installs beads (bd) if not present.
 *
 * Usage:
 *   npx pilot-agi --global    # Install to ~/.claude/
 *   npx pilot-agi --local     # Install to ./.claude/
 *   npx pilot-agi             # Interactive prompt
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync, spawnSync } = require('child_process');

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

function logWarning(message) {
  console.log(`${colors.yellow}⚠${colors.reset} ${message}`);
}

function commandExists(cmd) {
  try {
    // Using spawnSync with fixed command - no user input
    const result = spawnSync('which', [cmd], { stdio: 'pipe' });
    return result.status === 0;
  } catch {
    return false;
  }
}

async function installBeads() {
  logStep('0/5', 'Checking for beads (bd) task manager...');

  if (commandExists('bd')) {
    logSuccess('beads (bd) is already installed');
    return true;
  }

  log('\nbeads (bd) is required for task management.', 'yellow');

  // Try different installation methods in order of preference
  if (commandExists('brew')) {
    log('Installing beads via Homebrew...', 'cyan');
    try {
      spawnSync('brew', ['tap', 'steveyegge/beads'], { stdio: 'inherit' });
      spawnSync('brew', ['install', 'bd'], { stdio: 'inherit' });
      if (commandExists('bd')) {
        logSuccess('beads (bd) installed successfully via Homebrew');
        return true;
      }
    } catch (e) {
      logWarning('Homebrew installation failed, trying next method...');
    }
  }

  if (commandExists('npm')) {
    log('Installing beads via npm...', 'cyan');
    try {
      spawnSync('npm', ['install', '-g', '@beads/bd'], { stdio: 'inherit' });
      if (commandExists('bd')) {
        logSuccess('beads (bd) installed successfully via npm');
        return true;
      }
    } catch (e) {
      logWarning('npm installation failed, trying next method...');
    }
  }

  if (commandExists('go')) {
    log('Installing beads via go install...', 'cyan');
    try {
      spawnSync('go', ['install', 'github.com/steveyegge/beads/cmd/bd@latest'], { stdio: 'inherit' });
      if (commandExists('bd')) {
        logSuccess('beads (bd) installed successfully via go');
        return true;
      }
    } catch (e) {
      logWarning('go installation failed');
    }
  }

  logError('Could not install beads automatically.');
  log('\nPlease install manually:', 'yellow');
  log('  Homebrew: brew tap steveyegge/beads && brew install bd');
  log('  npm:      npm install -g @beads/bd');
  log('  Go:       go install github.com/steveyegge/beads/cmd/bd@latest\n');

  const answer = await prompt('Continue without beads? (y/n): ');
  return answer === 'y' || answer === 'yes';
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

  // SessionStart hook for update checking and bd context
  if (!settings.hooks.SessionStart) {
    settings.hooks.SessionStart = [];
  }

  const sessionStartHook = {
    matcher: '*',
    hooks: [{
      type: 'command',
      command: `node "${path.join(claudeDir, 'pilot', 'hooks', 'session-start.js')}"`,
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

  // PreToolUse hook for quality gates (runs before git commits)
  if (!settings.hooks.PreToolUse) {
    settings.hooks.PreToolUse = [];
  }

  const qualityGateHook = {
    matcher: 'Bash',
    hooks: [{
      type: 'command',
      command: `node "${path.join(claudeDir, 'pilot', 'hooks', 'quality-gate.js')}"`,
      timeout: 60
    }]
  };

  // Check if quality gate hook already exists
  const qualityHookExists = settings.hooks.PreToolUse.some(
    h => h.hooks?.[0]?.command?.includes('quality-gate.js')
  );

  if (!qualityHookExists) {
    settings.hooks.PreToolUse.push(qualityGateHook);
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

  // Install beads (bd) if not present
  const beadsOk = await installBeads();
  if (!beadsOk) {
    logError('Installation cancelled.');
    process.exit(1);
  }
  log('');

  logStep('1/5', 'Creating directories...');

  const skillsDir = path.join(claudeDir, 'skills');
  const pilotDir = path.join(claudeDir, 'pilot');

  // Create directories
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(pilotDir, { recursive: true });
  logSuccess('Directories created');

  logStep('2/5', 'Installing skills...');
  // Copy all pilot-* skill directories
  const sourceSkillsDir = path.join(packageDir, '.claude', 'skills');
  if (fs.existsSync(sourceSkillsDir)) {
    const skillDirs = fs.readdirSync(sourceSkillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('pilot-'));

    for (const skill of skillDirs) {
      copyDirectory(
        path.join(sourceSkillsDir, skill.name),
        path.join(skillsDir, skill.name)
      );
    }
  }
  logSuccess('Skills installed');

  logStep('3/5', 'Installing framework internals...');
  copyDirectory(
    path.join(packageDir, '.claude', 'pilot'),
    pilotDir
  );
  logSuccess('Framework installed');

  logStep('4/5', 'Creating project structure...');
  // Create work/ and runs/ directories
  const workDir = path.join(targetDir, 'work');
  const runsDir = path.join(targetDir, 'runs');

  for (const dir of ['milestones', 'sprints', 'specs', 'research', 'plans']) {
    fs.mkdirSync(path.join(workDir, dir), { recursive: true });
  }
  fs.mkdirSync(runsDir, { recursive: true });

  // Copy templates
  const templatesDir = path.join(packageDir, '.claude', 'pilot', 'templates');
  if (fs.existsSync(templatesDir)) {
    const roadmapTemplate = path.join(templatesDir, 'ROADMAP.md');
    if (fs.existsSync(roadmapTemplate)) {
      fs.copyFileSync(roadmapTemplate, path.join(workDir, 'ROADMAP.md'));
    }
  }

  // Copy CLAUDE.md
  const claudeMd = path.join(packageDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMd)) {
    fs.copyFileSync(claudeMd, path.join(targetDir, 'CLAUDE.md'));
  }
  logSuccess('Project structure created');

  logStep('5/5', 'Configuring settings...');
  updateSettings(claudeDir);

  // Write version file
  fs.writeFileSync(
    path.join(pilotDir, 'VERSION'),
    VERSION
  );
  logSuccess('Settings configured');

  log('\n════════════════════════════════════════════', 'green');
  log('  Installation complete!', 'green');
  log('════════════════════════════════════════════\n', 'green');

  log('Next steps:', 'bright');
  log('  1. Navigate to your project: cd your-project');
  log('  2. Initialize beads: bd init');
  log('  3. Restart Claude Code to load skills');
  log('  4. Run /pilot-help to see available commands\n');

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
