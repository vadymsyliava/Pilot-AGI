#!/usr/bin/env node

/**
 * Pilot AGI Migration Runner
 *
 * Runs versioned migration scripts when upgrading between versions.
 * Each migration script handles structural changes between versions.
 *
 * Usage:
 *   node bin/migrate.js <targetDir> [--from 0.0.4] [--to 0.1.0] [--dry-run]
 */

const fs = require('fs');
const path = require('path');

/**
 * Compare two semver strings. Returns -1, 0, or 1.
 */
function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

/**
 * Parse migration filename into { from, to } versions.
 * Expected format: "0.0.4-to-0.1.0.js"
 */
function parseMigrationName(filename) {
  const match = filename.match(/^(\d+\.\d+\.\d+)-to-(\d+\.\d+\.\d+)\.js$/);
  if (!match) return null;
  return { from: match[1], to: match[2] };
}

/**
 * Discover available migration scripts, sorted by source version.
 */
function discoverMigrations(migrationsDir) {
  if (!fs.existsSync(migrationsDir)) return [];

  return fs.readdirSync(migrationsDir)
    .map(f => {
      const parsed = parseMigrationName(f);
      if (!parsed) return null;
      return { file: f, ...parsed };
    })
    .filter(Boolean)
    .sort((a, b) => compareSemver(a.from, b.from));
}

/**
 * Build an ordered migration path from `fromVersion` to `toVersion`.
 * Returns array of migration descriptors or null if no path exists.
 */
function buildMigrationPath(migrations, fromVersion, toVersion) {
  if (compareSemver(fromVersion, toVersion) >= 0) return [];

  const chain = [];
  let current = fromVersion;

  while (compareSemver(current, toVersion) < 0) {
    const next = migrations.find(m => m.from === current);
    if (!next) return chain; // No more migrations available — partial path
    if (compareSemver(next.to, toVersion) > 0) break; // Don't overshoot
    chain.push(next);
    current = next.to;
  }

  return chain;
}

/**
 * Run a single migration script.
 * Each migration module exports: { up(targetDir), down(targetDir) }
 */
async function runMigration(migrationPath, targetDir, dryRun) {
  const mod = require(migrationPath);

  if (typeof mod.up !== 'function') {
    throw new Error(`Migration ${path.basename(migrationPath)} missing up() export`);
  }

  if (dryRun) {
    return { skipped: true, description: mod.description || 'No description' };
  }

  await mod.up(targetDir);
  return { skipped: false, description: mod.description || 'No description' };
}

/**
 * Roll back a migration (if it has a down function).
 */
async function rollbackMigration(migrationPath, targetDir) {
  const mod = require(migrationPath);
  if (typeof mod.down === 'function') {
    await mod.down(targetDir);
    return true;
  }
  return false;
}

/**
 * Run all migrations from fromVersion to toVersion.
 * Returns { success, applied, errors }.
 */
async function migrate(targetDir, fromVersion, toVersion, options = {}) {
  const { dryRun = false } = options;
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const migrations = discoverMigrations(migrationsDir);
  const chain = buildMigrationPath(migrations, fromVersion, toVersion);

  if (chain.length === 0) {
    return { success: true, applied: [], errors: [] };
  }

  const applied = [];
  const errors = [];

  for (const migration of chain) {
    const migrationFile = path.join(migrationsDir, migration.file);
    try {
      const result = await runMigration(migrationFile, targetDir, dryRun);
      applied.push({
        file: migration.file,
        from: migration.from,
        to: migration.to,
        ...result
      });
    } catch (err) {
      errors.push({ file: migration.file, error: err.message });

      // Rollback previously applied migrations in reverse order
      if (!dryRun) {
        for (let i = applied.length - 1; i >= 0; i--) {
          if (!applied[i].skipped) {
            const rollbackFile = path.join(migrationsDir, applied[i].file);
            try {
              await rollbackMigration(rollbackFile, targetDir);
              applied[i].rolledBack = true;
            } catch (rollbackErr) {
              applied[i].rollbackError = rollbackErr.message;
            }
          }
        }
      }

      return { success: false, applied, errors };
    }
  }

  return { success: true, applied, errors: [] };
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const targetDir = args.find(a => !a.startsWith('--')) || process.cwd();
  const dryRun = args.includes('--dry-run');

  let fromVersion = null;
  let toVersion = null;

  const fromIdx = args.indexOf('--from');
  if (fromIdx !== -1 && args[fromIdx + 1]) fromVersion = args[fromIdx + 1];

  const toIdx = args.indexOf('--to');
  if (toIdx !== -1 && args[toIdx + 1]) toVersion = args[toIdx + 1];

  // Auto-detect from VERSION file
  if (!fromVersion) {
    const versionFile = path.join(targetDir, '.claude', 'pilot', 'VERSION');
    if (fs.existsSync(versionFile)) {
      fromVersion = fs.readFileSync(versionFile, 'utf8').trim();
    } else {
      fromVersion = '0.0.0';
    }
  }

  if (!toVersion) {
    toVersion = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim();
  }

  console.log(`Migrating ${targetDir}`);
  console.log(`  From: v${fromVersion}`);
  console.log(`  To:   v${toVersion}`);
  if (dryRun) console.log('  (dry run)');
  console.log('');

  migrate(targetDir, fromVersion, toVersion, { dryRun })
    .then(result => {
      if (result.applied.length === 0) {
        console.log('No migrations needed.');
        return;
      }

      for (const m of result.applied) {
        const status = m.skipped ? '(dry run)' : m.rolledBack ? '(rolled back)' : 'OK';
        console.log(`  ${m.from} -> ${m.to}: ${m.description} [${status}]`);
      }

      if (!result.success) {
        console.error('\nMigration failed:');
        for (const e of result.errors) {
          console.error(`  ${e.file}: ${e.error}`);
        }
        process.exit(1);
      }

      console.log('\nAll migrations applied successfully.');
    })
    .catch(err => {
      console.error(`Migration error: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { migrate, discoverMigrations, buildMigrationPath, compareSemver, parseMigrationName };
