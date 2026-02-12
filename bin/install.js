#!/usr/bin/env node

/**
 * Pilot AGI Installer (Upgrade-Aware)
 *
 * Fresh install or upgrade with config preservation.
 * Detects existing installations, backs up, merges settings,
 * preserves user customizations, and runs migrations.
 *
 * Usage:
 *   npx pilot-agi --global       # Install/upgrade to ~/.claude/
 *   npx pilot-agi --local        # Install/upgrade to ./.claude/
 *   npx pilot-agi --rollback     # Rollback last upgrade
 *   npx pilot-agi                # Interactive prompt
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const VERSION = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim();
const BACKUP_DIR_NAME = '.pilot-backup';

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

function logStep(step, total, message) {
  console.log(`${colors.cyan}[${step}/${total}]${colors.reset} ${message}`);
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
    const result = spawnSync('which', [cmd], { stdio: 'pipe' });
    return result.status === 0;
  } catch {
    return false;
  }
}

async function promptUser(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}

// ─── File Utilities ───────────────────────────────────────────────────────────

function copyDirectory(src, dest, opts = {}) {
  const { skip = [] } = opts;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (skip.includes(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath, opts);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function getHomePath() {
  return process.env.HOME || process.env.USERPROFILE || '~';
}

// ─── Existing Install Detection ──────────────────────────────────────────────

function detectExistingInstall(targetDir) {
  const claudeDir = path.join(targetDir, '.claude');
  const pilotDir = path.join(claudeDir, 'pilot');
  const versionFile = path.join(pilotDir, 'VERSION');

  if (!fs.existsSync(pilotDir)) return null;

  let installedVersion = '0.0.0';
  if (fs.existsSync(versionFile)) {
    installedVersion = fs.readFileSync(versionFile, 'utf8').trim();
  }

  return {
    claudeDir,
    pilotDir,
    version: installedVersion,
    hasSettings: fs.existsSync(path.join(claudeDir, 'settings.json')),
    hasPolicy: fs.existsSync(path.join(pilotDir, 'policy.yaml')),
    hasState: fs.existsSync(path.join(pilotDir, 'state'))
  };
}

// ─── Backup ──────────────────────────────────────────────────────────────────

function createBackup(targetDir) {
  const claudeDir = path.join(targetDir, '.claude');
  const backupDir = path.join(targetDir, BACKUP_DIR_NAME);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, timestamp);

  fs.mkdirSync(backupPath, { recursive: true });

  // Backup settings.json
  const settingsPath = path.join(claudeDir, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    fs.copyFileSync(settingsPath, path.join(backupPath, 'settings.json'));
  }

  // Backup policy.yaml
  const policyPath = path.join(claudeDir, 'pilot', 'policy.yaml');
  if (fs.existsSync(policyPath)) {
    fs.copyFileSync(policyPath, path.join(backupPath, 'policy.yaml'));
  }

  // Backup VERSION
  const versionPath = path.join(claudeDir, 'pilot', 'VERSION');
  if (fs.existsSync(versionPath)) {
    fs.copyFileSync(versionPath, path.join(backupPath, 'VERSION'));
  }

  // Write backup manifest
  fs.writeFileSync(path.join(backupPath, 'manifest.json'), JSON.stringify({
    created_at: new Date().toISOString(),
    from_version: fs.existsSync(versionPath) ? fs.readFileSync(versionPath, 'utf8').trim() : 'unknown',
    to_version: VERSION,
    files: fs.readdirSync(backupPath)
  }, null, 2));

  return backupPath;
}

function restoreBackup(targetDir) {
  const backupDir = path.join(targetDir, BACKUP_DIR_NAME);
  if (!fs.existsSync(backupDir)) return null;

  // Find most recent backup
  const backups = fs.readdirSync(backupDir).sort().reverse();
  if (backups.length === 0) return null;

  const latestBackup = path.join(backupDir, backups[0]);
  const claudeDir = path.join(targetDir, '.claude');
  const pilotDir = path.join(claudeDir, 'pilot');

  // Restore settings.json
  const backupSettings = path.join(latestBackup, 'settings.json');
  if (fs.existsSync(backupSettings)) {
    fs.copyFileSync(backupSettings, path.join(claudeDir, 'settings.json'));
  }

  // Restore policy.yaml
  const backupPolicy = path.join(latestBackup, 'policy.yaml');
  if (fs.existsSync(backupPolicy)) {
    fs.copyFileSync(backupPolicy, path.join(pilotDir, 'policy.yaml'));
  }

  // Restore VERSION
  const backupVersion = path.join(latestBackup, 'VERSION');
  if (fs.existsSync(backupVersion)) {
    fs.copyFileSync(backupVersion, path.join(pilotDir, 'VERSION'));
  }

  return latestBackup;
}

// ─── Settings Merge ──────────────────────────────────────────────────────────

/**
 * Merge new hook entries into existing settings.json.
 * Preserves all user hooks while adding new Pilot hooks.
 */
function mergeSettings(claudeDir) {
  const settingsPath = path.join(claudeDir, 'settings.json');
  let settings = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      settings = {};
    }
  }

  if (!settings.hooks) settings.hooks = {};

  const pilotHooksDir = path.join(claudeDir, 'pilot', 'hooks');

  // Define the hook entries Pilot AGI needs
  const requiredHooks = [
    {
      event: 'SessionStart',
      matcher: '*',
      file: 'session-start.js',
      timeout: 10
    },
    {
      event: 'PreToolUse',
      matcher: 'Bash',
      file: 'quality-gate.js',
      timeout: 60
    },
    {
      event: 'PreToolUse',
      matcher: 'Edit,Write',
      file: 'pre-tool-use.js',
      timeout: 10
    },
    {
      event: 'PreToolUse',
      matcher: 'AskUserQuestion',
      file: 'ask-interceptor.js',
      timeout: 5
    },
    {
      event: 'PostToolUse',
      matcher: '*',
      file: 'post-tool-use.js',
      timeout: 10
    },
    {
      event: 'UserPromptSubmit',
      matcher: '*',
      file: 'user-prompt-submit.js',
      timeout: 10
    }
  ];

  for (const hook of requiredHooks) {
    if (!settings.hooks[hook.event]) {
      settings.hooks[hook.event] = [];
    }

    const exists = settings.hooks[hook.event].some(
      h => h.hooks?.[0]?.command?.includes(hook.file)
    );

    if (!exists) {
      settings.hooks[hook.event].push({
        matcher: hook.matcher,
        hooks: [{
          type: 'command',
          command: `node "${path.join(pilotHooksDir, hook.file)}"`,
          timeout: hook.timeout
        }]
      });
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// ─── Beads Install ───────────────────────────────────────────────────────────

async function installBeads(stepNum, totalSteps) {
  logStep(stepNum, totalSteps, 'Checking for beads (bd) task manager...');

  if (commandExists('bd')) {
    logSuccess('beads (bd) is already installed');
    return true;
  }

  log('\nbeads (bd) is required for task management.', 'yellow');

  if (commandExists('brew')) {
    log('Installing beads via Homebrew...', 'cyan');
    try {
      spawnSync('brew', ['tap', 'steveyegge/beads'], { stdio: 'inherit' });
      spawnSync('brew', ['install', 'bd'], { stdio: 'inherit' });
      if (commandExists('bd')) {
        logSuccess('beads (bd) installed successfully via Homebrew');
        return true;
      }
    } catch {
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
    } catch {
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
    } catch {
      logWarning('go installation failed');
    }
  }

  logError('Could not install beads automatically.');
  log('\nPlease install manually:', 'yellow');
  log('  Homebrew: brew tap steveyegge/beads && brew install bd');
  log('  npm:      npm install -g @beads/bd');
  log('  Go:       go install github.com/steveyegge/beads/cmd/bd@latest\n');

  const answer = await promptUser('Continue without beads? (y/n): ');
  return answer === 'y' || answer === 'yes';
}

// ─── Core Install / Upgrade ──────────────────────────────────────────────────

async function install(targetDir, isGlobal) {
  const packageDir = path.join(__dirname, '..');
  const claudeDir = path.join(targetDir, '.claude');
  const existing = detectExistingInstall(targetDir);
  const isUpgrade = existing !== null;
  const totalSteps = isUpgrade ? 7 : 6;

  log('\n╔══════════════════════════════════════════╗', 'cyan');
  if (isUpgrade) {
    log('║       Pilot AGI Upgrade                  ║', 'cyan');
    log(`║     ${existing.version} → ${VERSION}`.padEnd(42) + '║', 'cyan');
  } else {
    log('║       Pilot AGI Installer                ║', 'cyan');
    log(`║              v${VERSION}`.padEnd(42) + '║', 'cyan');
  }
  log('╚══════════════════════════════════════════╝\n', 'cyan');

  let step = 1;

  // Step: Beads
  const beadsOk = await installBeads(step++, totalSteps);
  if (!beadsOk) {
    logError('Installation cancelled.');
    process.exit(1);
  }
  log('');

  // Step: Backup (upgrade only)
  if (isUpgrade) {
    logStep(step++, totalSteps, 'Backing up existing installation...');
    const backupPath = createBackup(targetDir);
    logSuccess(`Backup saved to ${path.relative(targetDir, backupPath)}`);
  }

  // Step: Directories
  logStep(step++, totalSteps, 'Creating directories...');
  const skillsDir = path.join(claudeDir, 'skills');
  const pilotDir = path.join(claudeDir, 'pilot');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(pilotDir, { recursive: true });
  logSuccess('Directories created');

  // Step: Skills (always overwrite — no user customization expected)
  logStep(step++, totalSteps, 'Installing skills...');
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
    logSuccess(`${skillDirs.length} skills installed`);
  } else {
    logWarning('No skills found in package');
  }

  // Step: Framework internals (overwrite hooks/lib, preserve state + memory + policy)
  logStep(step++, totalSteps, isUpgrade ? 'Upgrading framework...' : 'Installing framework...');
  const sourcePilotDir = path.join(packageDir, '.claude', 'pilot');
  if (fs.existsSync(sourcePilotDir)) {
    // Copy hooks (always overwrite — these are the framework code)
    const sourceHooks = path.join(sourcePilotDir, 'hooks');
    if (fs.existsSync(sourceHooks)) {
      copyDirectory(sourceHooks, path.join(pilotDir, 'hooks'));
    }

    // Copy templates (always overwrite)
    const sourceTemplates = path.join(sourcePilotDir, 'templates');
    if (fs.existsSync(sourceTemplates)) {
      copyDirectory(sourceTemplates, path.join(pilotDir, 'templates'));
    }

    // Copy agents (always overwrite)
    const sourceAgents = path.join(sourcePilotDir, 'agents');
    if (fs.existsSync(sourceAgents)) {
      copyDirectory(sourceAgents, path.join(pilotDir, 'agents'));
    }

    // Copy policy.yaml ONLY if it doesn't exist (preserve user customizations)
    const sourcePolicy = path.join(sourcePilotDir, 'policy.yaml');
    const destPolicy = path.join(pilotDir, 'policy.yaml');
    if (fs.existsSync(sourcePolicy) && !fs.existsSync(destPolicy)) {
      fs.copyFileSync(sourcePolicy, destPolicy);
    } else if (isUpgrade && fs.existsSync(destPolicy)) {
      logSuccess('policy.yaml preserved (user customizations kept)');
    }

    // Never overwrite: state/, memory/ — these are user runtime data
  }

  // Create work/ and runs/ (only if they don't exist)
  const workDir = path.join(targetDir, 'work');
  const runsDir = path.join(targetDir, 'runs');
  for (const dir of ['milestones', 'sprints', 'specs', 'research', 'plans']) {
    fs.mkdirSync(path.join(workDir, dir), { recursive: true });
  }
  fs.mkdirSync(runsDir, { recursive: true });

  // Copy CLAUDE.md only on fresh install
  if (!isUpgrade) {
    const claudeMd = path.join(packageDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMd)) {
      fs.copyFileSync(claudeMd, path.join(targetDir, 'CLAUDE.md'));
    }
  }

  logSuccess('Framework ' + (isUpgrade ? 'upgraded' : 'installed'));

  // Step: Settings merge
  logStep(step++, totalSteps, isUpgrade ? 'Merging settings...' : 'Configuring settings...');
  mergeSettings(claudeDir);
  logSuccess(isUpgrade ? 'Settings merged (user hooks preserved)' : 'Settings configured');

  // Step: Migrations (upgrade only)
  if (isUpgrade) {
    logStep(step++, totalSteps, 'Running migrations...');
    try {
      const { migrate } = require('./migrate');
      const result = await migrate(targetDir, existing.version, VERSION);

      if (result.applied.length === 0) {
        logSuccess('No migrations needed');
      } else if (result.success) {
        for (const m of result.applied) {
          logSuccess(`Migration ${m.from} → ${m.to}: ${m.description}`);
        }
      } else {
        for (const e of result.errors) {
          logError(`Migration failed: ${e.file} — ${e.error}`);
        }
        logWarning('Some migrations failed. Use --rollback to restore previous version.');
      }
    } catch (err) {
      logWarning(`Migration runner error: ${err.message}`);
    }
  }

  // Write VERSION file
  fs.writeFileSync(path.join(pilotDir, 'VERSION'), VERSION);

  // Write VERSION lock
  fs.writeFileSync(path.join(pilotDir, 'VERSION.lock'), JSON.stringify({
    version: VERSION,
    installed_at: new Date().toISOString(),
    upgraded_from: isUpgrade ? existing.version : null,
    install_type: isGlobal ? 'global' : 'local'
  }, null, 2));

  // Success banner
  log('\n════════════════════════════════════════════', 'green');
  if (isUpgrade) {
    log(`  Upgraded to v${VERSION}!`, 'green');
  } else {
    log('  Installation complete!', 'green');
  }
  log('════════════════════════════════════════════\n', 'green');

  if (!isUpgrade) {
    log('Next steps:', 'bright');
    log('  1. Navigate to your project: cd your-project');
    log('  2. Initialize beads: bd init');
    log('  3. Restart Claude Code to load skills');
    log('  4. Run /pilot-help to see available commands\n');
  } else {
    log('Restart Claude Code to use the new version.\n', 'bright');
  }

  log(`Installed to: ${claudeDir}`, 'yellow');
  if (!isGlobal && !isUpgrade) {
    log('Add .claude/ to your .gitignore if needed\n', 'yellow');
  }
}

// ─── Rollback ────────────────────────────────────────────────────────────────

function rollback(targetDir) {
  log('\n╔══════════════════════════════════════════╗', 'yellow');
  log('║       Pilot AGI Rollback                 ║', 'yellow');
  log('╚══════════════════════════════════════════╝\n', 'yellow');

  const result = restoreBackup(targetDir);
  if (result) {
    logSuccess(`Restored from backup: ${path.basename(result)}`);
    log('\nRestart Claude Code to complete rollback.\n', 'bright');
  } else {
    logError('No backup found. Cannot rollback.');
    process.exit(1);
  }
}

// ─── Verify ──────────────────────────────────────────────────────────────────

function verify(targetDir) {
  const claudeDir = path.join(targetDir, '.claude');
  const pilotDir = path.join(claudeDir, 'pilot');
  const checks = [];

  // Check critical files exist
  const criticalFiles = [
    [path.join(pilotDir, 'VERSION'), 'VERSION file'],
    [path.join(pilotDir, 'hooks', 'session-start.js'), 'session-start hook'],
    [path.join(pilotDir, 'hooks', 'pre-tool-use.js'), 'pre-tool-use hook'],
    [path.join(pilotDir, 'policy.yaml'), 'policy.yaml'],
    [path.join(claudeDir, 'settings.json'), 'settings.json']
  ];

  for (const [filePath, label] of criticalFiles) {
    checks.push({ label, ok: fs.existsSync(filePath) });
  }

  // Check settings.json has hooks
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    checks.push({ label: 'hooks configured', ok: !!settings.hooks?.SessionStart?.length });
  } catch {
    checks.push({ label: 'hooks configured', ok: false });
  }

  return checks;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  const isGlobal = args.includes('--global') || args.includes('-g');
  const isLocal = args.includes('--local') || args.includes('-l');
  const isRollback = args.includes('--rollback');
  const isVerify = args.includes('--verify');
  const showHelp = args.includes('--help') || args.includes('-h');
  const showVersion = args.includes('--version') || args.includes('-v');

  if (showVersion) {
    console.log(VERSION);
    process.exit(0);
  }

  if (showHelp) {
    log('\nPilot AGI Installer\n', 'bright');
    log('Usage:');
    log('  npx pilot-agi [options]\n');
    log('Options:');
    log('  --global, -g     Install/upgrade to ~/.claude/ (available everywhere)');
    log('  --local, -l      Install/upgrade to ./.claude/ (project only)');
    log('  --rollback       Restore previous version from backup');
    log('  --verify         Check installation integrity');
    log('  --version, -v    Show version');
    log('  --help, -h       Show this help message\n');
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

    const answer = await promptUser('Choose (g/l): ');

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
    if (isRollback) {
      rollback(targetDir);
    } else if (isVerify) {
      const checks = verify(targetDir);
      log('\nInstallation Verification:', 'bright');
      let allOk = true;
      for (const check of checks) {
        if (check.ok) {
          logSuccess(check.label);
        } else {
          logError(check.label);
          allOk = false;
        }
      }
      process.exit(allOk ? 0 : 1);
    } else {
      await install(targetDir, targetDir === getHomePath());

      // Post-install verification
      const checks = verify(targetDir);
      const allOk = checks.every(c => c.ok);
      if (!allOk) {
        logWarning('Post-install verification found issues:');
        for (const check of checks) {
          if (!check.ok) logError(`  Missing: ${check.label}`);
        }
      }
    }
  } catch (error) {
    logError(`Operation failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  detectExistingInstall,
  createBackup,
  restoreBackup,
  mergeSettings,
  verify
};

if (require.main === module) {
  main();
}
