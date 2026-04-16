/**
 * Pattern Evolution — Phase 8.14 (Pilot AGI-zkfs)
 *
 * When a new pattern proves superior (higher quality scores), propose migration.
 * Gradual file-by-file migration with rollback support.
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = '.claude/pilot/registry/migrations';
const EVOLUTION_LOG = '.claude/pilot/registry/evolution-log.jsonl';

// =============================================================================
// PATTERN COMPARISON
// =============================================================================

/**
 * Compare two patterns to determine if one is superior.
 * Uses usage count, quality correlation, and age.
 *
 * @param {object} patternA - First pattern
 * @param {object} patternB - Second pattern (challenger)
 * @returns {{ superior, reason, confidence }}
 */
function comparePatterns(patternA, patternB) {
  if (!patternA || !patternB) return { superior: null, reason: 'invalid input', confidence: 0 };

  let scoreA = 0;
  let scoreB = 0;

  // Usage count (more usage = more proven)
  const usageA = patternA.usage_count || 0;
  const usageB = patternB.usage_count || 0;
  if (usageA > usageB) scoreA += 0.3;
  else if (usageB > usageA) scoreB += 0.3;

  // Canonical status (canonical patterns have been vetted)
  if (patternA.canonical && !patternB.canonical) scoreA += 0.2;
  if (patternB.canonical && !patternA.canonical) scoreB += 0.2;

  // Auto-learned vs manual (manual = intentionally chosen)
  if (!patternA.auto_learned && patternB.auto_learned) scoreA += 0.1;
  if (!patternB.auto_learned && patternA.auto_learned) scoreB += 0.1;

  // More source refs = broader adoption
  const refsA = (patternA.source_refs || []).length;
  const refsB = (patternB.source_refs || []).length;
  if (refsA > refsB) scoreA += 0.2;
  else if (refsB > refsA) scoreB += 0.2;

  // More examples = better documented
  const exA = (patternA.examples || []).length;
  const exB = (patternB.examples || []).length;
  if (exA > exB) scoreA += 0.1;
  else if (exB > exA) scoreB += 0.1;

  const confidence = Math.abs(scoreA - scoreB);
  if (confidence < 0.1) {
    return { superior: null, reason: 'patterns are roughly equivalent', confidence };
  }

  const winner = scoreA > scoreB ? patternA : patternB;
  const loser = scoreA > scoreB ? patternB : patternA;

  return {
    superior: winner,
    inferior: loser,
    reason: `"${winner.name}" scores higher (${Math.max(scoreA, scoreB).toFixed(1)} vs ${Math.min(scoreA, scoreB).toFixed(1)})`,
    confidence
  };
}

// =============================================================================
// MIGRATION PLAN
// =============================================================================

/**
 * Generate a migration plan from old pattern to new pattern.
 *
 * @param {object} oldPattern - Pattern being replaced
 * @param {object} newPattern - Superior pattern
 * @param {object} opts - { projectRoot? }
 * @returns {{ migration_id, steps, status }}
 */
function createMigration(oldPattern, newPattern, opts) {
  if (!oldPattern || !newPattern) return { error: 'both patterns required' };
  opts = opts || {};

  const migrationId = generateMigrationId();
  const steps = [];

  // Identify files using the old pattern
  const oldRefs = oldPattern.source_refs || [];
  for (const filePath of oldRefs) {
    steps.push({
      action: 'migrate_file',
      file_path: filePath,
      old_pattern: oldPattern.name,
      new_pattern: newPattern.name,
      old_rule: oldPattern.rule,
      new_rule: newPattern.rule,
      status: 'pending'
    });
  }

  // Final step: deprecate old pattern
  steps.push({
    action: 'deprecate_pattern',
    pattern_id: oldPattern.id,
    pattern_name: oldPattern.name,
    replacement: newPattern.name,
    status: 'pending'
  });

  const migration = {
    migration_id: migrationId,
    old_pattern: { id: oldPattern.id, name: oldPattern.name },
    new_pattern: { id: newPattern.id, name: newPattern.name },
    steps,
    total_files: oldRefs.length,
    status: 'pending',
    created_at: new Date().toISOString()
  };

  saveMigration(migration);
  logEvolution('migration_created', { migration_id: migrationId, from: oldPattern.name, to: newPattern.name });

  return migration;
}

/**
 * Complete a migration step.
 */
function completeMigrationStep(migrationId, stepIndex, result) {
  const migration = loadMigration(migrationId);
  if (!migration) return { success: false, error: 'migration not found' };
  if (stepIndex < 0 || stepIndex >= migration.steps.length) {
    return { success: false, error: 'invalid step index' };
  }

  migration.steps[stepIndex].status = 'completed';
  migration.steps[stepIndex].completed_at = new Date().toISOString();
  migration.steps[stepIndex].result = result || 'success';

  const allDone = migration.steps.every(s => s.status === 'completed');
  if (allDone) {
    migration.status = 'completed';
    migration.completed_at = new Date().toISOString();
    logEvolution('migration_completed', { migration_id: migrationId });
  }

  saveMigration(migration);
  return { success: true, all_done: allDone };
}

/**
 * Rollback a migration (mark as rolled back, re-enable old pattern).
 */
function rollbackMigration(migrationId, reason) {
  const migration = loadMigration(migrationId);
  if (!migration) return { success: false, error: 'migration not found' };

  migration.status = 'rolled_back';
  migration.rolled_back_at = new Date().toISOString();
  migration.rollback_reason = reason || 'manual rollback';

  saveMigration(migration);
  logEvolution('migration_rolled_back', { migration_id: migrationId, reason });

  return { success: true };
}

// =============================================================================
// EVOLUTION DETECTION
// =============================================================================

/**
 * Scan for patterns that could evolve (supersede others).
 * Returns pairs of (old, new) where new is demonstrably better.
 *
 * @returns {Array<{ old, new, comparison }>}
 */
function detectEvolutions() {
  let canonicalPatterns;
  try {
    canonicalPatterns = require('./canonical-patterns');
  } catch (e) {
    return [];
  }

  const all = canonicalPatterns.listAll();
  const evolutions = [];

  // Group by category
  const byCategory = {};
  for (const p of all) {
    if (!byCategory[p.category]) byCategory[p.category] = [];
    byCategory[p.category].push(p);
  }

  // Compare within each category for purpose overlap
  for (const patterns of Object.values(byCategory)) {
    for (let i = 0; i < patterns.length; i++) {
      for (let j = i + 1; j < patterns.length; j++) {
        const comparison = comparePatterns(patterns[i], patterns[j]);
        if (comparison.superior && comparison.confidence >= 0.3) {
          evolutions.push({
            old: comparison.inferior,
            new: comparison.superior,
            comparison
          });
        }
      }
    }
  }

  return evolutions;
}

// =============================================================================
// STORAGE
// =============================================================================

function getMigrationsDir() {
  return path.join(process.cwd(), MIGRATIONS_DIR);
}

function saveMigration(migration) {
  const dir = getMigrationsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${migration.migration_id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(migration, null, 2), 'utf8');
}

function loadMigration(migrationId) {
  if (!migrationId) return null;
  const filePath = path.join(getMigrationsDir(), `${migrationId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function listMigrations(opts) {
  opts = opts || {};
  const dir = getMigrationsDir();
  if (!fs.existsSync(dir)) return [];

  const migrations = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (opts.status && m.status !== opts.status) continue;
      migrations.push(m);
    } catch (e) { /* skip */ }
  }

  return migrations.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

function logEvolution(event, data) {
  const logPath = path.join(process.cwd(), EVOLUTION_LOG);
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const entry = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
  fs.appendFileSync(logPath, entry + '\n');
}

let _migSeq = 0;
function generateMigrationId() {
  const ts = Date.now().toString(36);
  const seq = (_migSeq++).toString(36);
  return `M-${ts}-${seq}`;
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Comparison
  comparePatterns,

  // Migration
  createMigration,
  completeMigrationStep,
  rollbackMigration,
  loadMigration,
  listMigrations,

  // Evolution detection
  detectEvolutions
};
