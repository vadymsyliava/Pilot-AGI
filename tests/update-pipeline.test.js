#!/usr/bin/env node

/**
 * Tests for Update Pipeline (Pilot AGI-706)
 * Tests: bin/migrate.js (migration framework), bin/install.js (upgrade-aware installer)
 *
 * Run: node tests/update-pipeline.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS: ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL: ' + name + ' - ' + e.message);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── Migration Framework Tests ───────────────────────────────────────────────

console.log('\n=== Migration Framework ===\n');

const { compareSemver, parseMigrationName, discoverMigrations, buildMigrationPath, migrate } = require('../bin/migrate');

test('compareSemver: equal versions', () => {
  assertEqual(compareSemver('1.0.0', '1.0.0'), 0);
});

test('compareSemver: lesser version', () => {
  assertEqual(compareSemver('0.0.4', '0.1.0'), -1);
});

test('compareSemver: greater version', () => {
  assertEqual(compareSemver('1.0.0', '0.9.9'), 1);
});

test('compareSemver: patch difference', () => {
  assertEqual(compareSemver('1.0.0', '1.0.1'), -1);
});

test('parseMigrationName: valid filename', () => {
  const result = parseMigrationName('0.0.4-to-0.1.0.js');
  assertEqual(result.from, '0.0.4');
  assertEqual(result.to, '0.1.0');
});

test('parseMigrationName: invalid filename', () => {
  const result = parseMigrationName('readme.md');
  assertEqual(result, null);
});

test('parseMigrationName: partial version', () => {
  const result = parseMigrationName('1.0-to-2.0.js');
  assertEqual(result, null);
});

test('discoverMigrations: finds migration files', () => {
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const migrations = discoverMigrations(migrationsDir);
  assert(migrations.length >= 1, 'Should find at least one migration');
  assert(migrations[0].from === '0.0.4', 'First migration should be from 0.0.4');
  assert(migrations[0].to === '0.1.0', 'First migration should be to 0.1.0');
});

test('discoverMigrations: nonexistent directory returns empty', () => {
  const result = discoverMigrations('/nonexistent/path');
  assertEqual(result.length, 0);
});

test('buildMigrationPath: finds path from 0.0.4 to 0.1.0', () => {
  const migrations = [
    { file: '0.0.4-to-0.1.0.js', from: '0.0.4', to: '0.1.0' }
  ];
  const chain = buildMigrationPath(migrations, '0.0.4', '0.1.0');
  assertEqual(chain.length, 1);
  assertEqual(chain[0].from, '0.0.4');
});

test('buildMigrationPath: no path needed for same version', () => {
  const migrations = [
    { file: '0.0.4-to-0.1.0.js', from: '0.0.4', to: '0.1.0' }
  ];
  const chain = buildMigrationPath(migrations, '0.1.0', '0.1.0');
  assertEqual(chain.length, 0);
});

test('buildMigrationPath: multi-step chain', () => {
  const migrations = [
    { file: '0.0.4-to-0.1.0.js', from: '0.0.4', to: '0.1.0' },
    { file: '0.1.0-to-0.2.0.js', from: '0.1.0', to: '0.2.0' }
  ];
  const chain = buildMigrationPath(migrations, '0.0.4', '0.2.0');
  assertEqual(chain.length, 2);
  assertEqual(chain[0].to, '0.1.0');
  assertEqual(chain[1].to, '0.2.0');
});

test('buildMigrationPath: partial path returns what is available', () => {
  const migrations = [
    { file: '0.0.4-to-0.1.0.js', from: '0.0.4', to: '0.1.0' }
  ];
  const chain = buildMigrationPath(migrations, '0.0.4', '0.5.0');
  assertEqual(chain.length, 1, 'Should find one step even if target is further');
});

// ─── Migration Execution Tests ───────────────────────────────────────────────

console.log('\n=== Migration Execution ===\n');

test('migrate: runs 0.0.4-to-0.1.0 migration on fresh dir', async () => {
  const tmpDir = makeTmpDir();
  try {
    // Set up minimal structure
    const pilotDir = path.join(tmpDir, '.claude', 'pilot');
    fs.mkdirSync(pilotDir, { recursive: true });
    fs.writeFileSync(path.join(pilotDir, 'VERSION'), '0.0.4');

    // Write a settings.json
    const claudeDir = path.join(tmpDir, '.claude');
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'node session-start.js', timeout: 10 }] }]
      }
    }, null, 2));

    const result = await migrate(tmpDir, '0.0.4', '0.1.0');
    assert(result.success, 'Migration should succeed');
    assert(result.applied.length === 1, 'Should apply 1 migration');

    // Check VERSION.lock was created
    const lockPath = path.join(pilotDir, 'VERSION.lock');
    assert(fs.existsSync(lockPath), 'VERSION.lock should be created');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assertEqual(lock.version, '0.1.0');

    // Check state directories created
    assert(fs.existsSync(path.join(pilotDir, 'state', 'sessions')), 'state/sessions should exist');
    assert(fs.existsSync(path.join(pilotDir, 'memory', 'channels')), 'memory/channels should exist');
  } finally {
    cleanup(tmpDir);
  }
});

test('migrate: dry-run does not modify files', async () => {
  const tmpDir = makeTmpDir();
  try {
    const pilotDir = path.join(tmpDir, '.claude', 'pilot');
    fs.mkdirSync(pilotDir, { recursive: true });
    fs.writeFileSync(path.join(pilotDir, 'VERSION'), '0.0.4');

    const result = await migrate(tmpDir, '0.0.4', '0.1.0', { dryRun: true });
    assert(result.success, 'Dry run should succeed');
    assert(result.applied[0].skipped, 'Should be marked as skipped');

    // VERSION.lock should NOT exist
    assert(!fs.existsSync(path.join(pilotDir, 'VERSION.lock')), 'VERSION.lock should not be created in dry run');
  } finally {
    cleanup(tmpDir);
  }
});

test('migrate: no-op for same version', async () => {
  const tmpDir = makeTmpDir();
  try {
    const result = await migrate(tmpDir, '0.1.0', '0.1.0');
    assert(result.success, 'Should succeed');
    assertEqual(result.applied.length, 0, 'No migrations needed');
  } finally {
    cleanup(tmpDir);
  }
});

// ─── Installer Tests ─────────────────────────────────────────────────────────

console.log('\n=== Installer Utilities ===\n');

const { detectExistingInstall, createBackup, restoreBackup, mergeSettings, verify } = require('../bin/install');

test('detectExistingInstall: returns null for fresh dir', () => {
  const tmpDir = makeTmpDir();
  try {
    const result = detectExistingInstall(tmpDir);
    assertEqual(result, null);
  } finally {
    cleanup(tmpDir);
  }
});

test('detectExistingInstall: detects existing install with version', () => {
  const tmpDir = makeTmpDir();
  try {
    const pilotDir = path.join(tmpDir, '.claude', 'pilot');
    fs.mkdirSync(pilotDir, { recursive: true });
    fs.writeFileSync(path.join(pilotDir, 'VERSION'), '0.0.4');

    const result = detectExistingInstall(tmpDir);
    assert(result !== null, 'Should detect install');
    assertEqual(result.version, '0.0.4');
  } finally {
    cleanup(tmpDir);
  }
});

test('detectExistingInstall: defaults to 0.0.0 without VERSION', () => {
  const tmpDir = makeTmpDir();
  try {
    const pilotDir = path.join(tmpDir, '.claude', 'pilot');
    fs.mkdirSync(pilotDir, { recursive: true });

    const result = detectExistingInstall(tmpDir);
    assertEqual(result.version, '0.0.0');
  } finally {
    cleanup(tmpDir);
  }
});

test('createBackup: creates backup with manifest', () => {
  const tmpDir = makeTmpDir();
  try {
    const claudeDir = path.join(tmpDir, '.claude');
    const pilotDir = path.join(claudeDir, 'pilot');
    fs.mkdirSync(pilotDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{"hooks":{}}');
    fs.writeFileSync(path.join(pilotDir, 'policy.yaml'), 'version: "2.0"');
    fs.writeFileSync(path.join(pilotDir, 'VERSION'), '0.0.4');

    const backupPath = createBackup(tmpDir);
    assert(fs.existsSync(backupPath), 'Backup directory should exist');
    assert(fs.existsSync(path.join(backupPath, 'manifest.json')), 'Manifest should exist');
    assert(fs.existsSync(path.join(backupPath, 'settings.json')), 'Settings backup should exist');
    assert(fs.existsSync(path.join(backupPath, 'policy.yaml')), 'Policy backup should exist');

    const manifest = JSON.parse(fs.readFileSync(path.join(backupPath, 'manifest.json'), 'utf8'));
    assertEqual(manifest.from_version, '0.0.4');
  } finally {
    cleanup(tmpDir);
  }
});

test('restoreBackup: restores from most recent backup', () => {
  const tmpDir = makeTmpDir();
  try {
    const claudeDir = path.join(tmpDir, '.claude');
    const pilotDir = path.join(claudeDir, 'pilot');
    fs.mkdirSync(pilotDir, { recursive: true });

    // Create original files
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{"original":true}');
    fs.writeFileSync(path.join(pilotDir, 'VERSION'), '0.0.4');

    // Create backup
    createBackup(tmpDir);

    // Simulate upgrade — overwrite files
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{"upgraded":true}');
    fs.writeFileSync(path.join(pilotDir, 'VERSION'), '0.1.0');

    // Restore
    const restored = restoreBackup(tmpDir);
    assert(restored !== null, 'Should find backup');

    // Check restored content
    const settings = fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8');
    assert(settings.includes('"original"'), 'Settings should be restored');
    const version = fs.readFileSync(path.join(pilotDir, 'VERSION'), 'utf8').trim();
    assertEqual(version, '0.0.4');
  } finally {
    cleanup(tmpDir);
  }
});

test('restoreBackup: returns null when no backup exists', () => {
  const tmpDir = makeTmpDir();
  try {
    const result = restoreBackup(tmpDir);
    assertEqual(result, null);
  } finally {
    cleanup(tmpDir);
  }
});

test('mergeSettings: adds missing hooks to existing settings', () => {
  const tmpDir = makeTmpDir();
  try {
    const claudeDir = path.join(tmpDir, '.claude');
    const pilotDir = path.join(claudeDir, 'pilot', 'hooks');
    fs.mkdirSync(pilotDir, { recursive: true });

    // Existing settings with some user hooks
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'CustomTool', hooks: [{ type: 'command', command: 'echo custom' }] }]
      }
    }, null, 2));

    mergeSettings(claudeDir);

    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));

    // User hook should be preserved
    const customHook = settings.hooks.PreToolUse.find(h => h.matcher === 'CustomTool');
    assert(customHook, 'User custom hook should be preserved');

    // Pilot hooks should be added
    assert(settings.hooks.SessionStart, 'SessionStart hooks should be added');
    assert(settings.hooks.SessionStart.length > 0, 'Should have at least one SessionStart hook');
    assert(settings.hooks.PostToolUse, 'PostToolUse hooks should be added');
  } finally {
    cleanup(tmpDir);
  }
});

test('mergeSettings: does not duplicate existing pilot hooks', () => {
  const tmpDir = makeTmpDir();
  try {
    const claudeDir = path.join(tmpDir, '.claude');
    const pilotDir = path.join(claudeDir, 'pilot', 'hooks');
    fs.mkdirSync(pilotDir, { recursive: true });

    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: '*',
          hooks: [{ type: 'command', command: 'node "something/session-start.js"' }]
        }]
      }
    }, null, 2));

    mergeSettings(claudeDir);
    mergeSettings(claudeDir); // Run twice

    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    const sessionStartHooks = settings.hooks.SessionStart.filter(
      h => h.hooks?.[0]?.command?.includes('session-start.js')
    );
    assertEqual(sessionStartHooks.length, 1, 'Should not duplicate session-start hook');
  } finally {
    cleanup(tmpDir);
  }
});

test('mergeSettings: creates settings from scratch', () => {
  const tmpDir = makeTmpDir();
  try {
    const claudeDir = path.join(tmpDir, '.claude');
    const pilotDir = path.join(claudeDir, 'pilot', 'hooks');
    fs.mkdirSync(pilotDir, { recursive: true });

    // No settings.json exists
    mergeSettings(claudeDir);

    assert(fs.existsSync(path.join(claudeDir, 'settings.json')), 'settings.json should be created');
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    assert(settings.hooks, 'Should have hooks');
    assert(settings.hooks.SessionStart, 'Should have SessionStart');
  } finally {
    cleanup(tmpDir);
  }
});

test('verify: all checks pass on valid install', () => {
  const tmpDir = makeTmpDir();
  try {
    const claudeDir = path.join(tmpDir, '.claude');
    const pilotDir = path.join(claudeDir, 'pilot');
    const hooksDir = path.join(pilotDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });

    fs.writeFileSync(path.join(pilotDir, 'VERSION'), '0.1.0');
    fs.writeFileSync(path.join(hooksDir, 'session-start.js'), '');
    fs.writeFileSync(path.join(hooksDir, 'pre-tool-use.js'), '');
    fs.writeFileSync(path.join(pilotDir, 'policy.yaml'), '');
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'test' }] }] }
    }));

    const checks = verify(tmpDir);
    const allOk = checks.every(c => c.ok);
    assert(allOk, 'All checks should pass: ' + checks.filter(c => !c.ok).map(c => c.label).join(', '));
  } finally {
    cleanup(tmpDir);
  }
});

test('verify: detects missing files', () => {
  const tmpDir = makeTmpDir();
  try {
    const checks = verify(tmpDir);
    const allOk = checks.every(c => c.ok);
    assert(!allOk, 'Should detect missing files');
  } finally {
    cleanup(tmpDir);
  }
});

// ─── Package.json Tests ──────────────────────────────────────────────────────

console.log('\n=== Package Configuration ===\n');

test('package.json: version is 0.1.0', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assertEqual(pkg.version, '0.1.0');
});

test('package.json: has publishConfig', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert(pkg.publishConfig, 'Should have publishConfig');
  assertEqual(pkg.publishConfig.access, 'public');
});

test('package.json: files excludes __tests__', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const hasExclusion = pkg.files.some(f => f.includes('__tests__') && f.startsWith('!'));
  assert(hasExclusion, 'Should exclude __tests__ from files');
});

test('package.json: includes migrations/', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert(pkg.files.includes('migrations/'), 'Should include migrations/');
});

test('VERSION file matches package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const version = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim();
  assertEqual(version, pkg.version);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n══════════════════════════════════════════`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`══════════════════════════════════════════\n`);

if (failed > 0) process.exit(1);
