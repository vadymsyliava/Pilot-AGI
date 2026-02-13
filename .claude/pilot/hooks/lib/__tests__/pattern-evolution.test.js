/**
 * Tests for Pattern Evolution — Phase 8.14 (Pilot AGI-zkfs)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/pattern-evolution.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patevo-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/registry/migrations'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModule() {
  const mods = ['../pattern-evolution', '../canonical-patterns'];
  for (const mod of mods) {
    try { delete require.cache[require.resolve(mod)]; } catch (e) {}
  }
  return require('../pattern-evolution');
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  setup();
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (e) {
    console.error(`  \u2717 ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  } finally {
    teardown();
  }
}

console.log('\n=== Pattern Evolution Tests ===\n');

// --- comparePatterns ---

test('comparePatterns picks pattern with higher usage', () => {
  const pe = freshModule();
  const result = pe.comparePatterns(
    { name: 'A', usage_count: 10, source_refs: ['a.ts', 'b.ts'], canonical: true, examples: ['ex'] },
    { name: 'B', usage_count: 2, source_refs: ['c.ts'], canonical: false, auto_learned: true, examples: [] }
  );
  assert.ok(result.superior);
  assert.strictEqual(result.superior.name, 'A');
  assert.ok(result.confidence > 0);
});

test('comparePatterns returns null for equivalent patterns', () => {
  const pe = freshModule();
  const result = pe.comparePatterns(
    { name: 'A', usage_count: 5, source_refs: ['a.ts'], canonical: true, examples: ['ex'] },
    { name: 'B', usage_count: 5, source_refs: ['b.ts'], canonical: true, examples: ['ex'] }
  );
  assert.strictEqual(result.superior, null);
});

test('comparePatterns handles null input', () => {
  const pe = freshModule();
  const result = pe.comparePatterns(null, { name: 'B' });
  assert.strictEqual(result.superior, null);
});

// --- createMigration ---

test('createMigration generates steps for each source ref', () => {
  const pe = freshModule();
  const oldP = { id: 'P-old', name: 'old way', source_refs: ['a.ts', 'b.ts'], rule: 'old rule' };
  const newP = { id: 'P-new', name: 'new way', rule: 'new rule' };

  const migration = pe.createMigration(oldP, newP);
  assert.ok(migration.migration_id);
  assert.strictEqual(migration.total_files, 2);
  assert.strictEqual(migration.steps.length, 3); // 2 files + 1 deprecate
  assert.strictEqual(migration.steps[0].action, 'migrate_file');
  assert.strictEqual(migration.steps[2].action, 'deprecate_pattern');
});

test('createMigration saves to disk', () => {
  const pe = freshModule();
  const migration = pe.createMigration(
    { id: 'P-1', name: 'old', source_refs: [] },
    { id: 'P-2', name: 'new' }
  );

  const loaded = pe.loadMigration(migration.migration_id);
  assert.ok(loaded);
  assert.strictEqual(loaded.migration_id, migration.migration_id);
});

// --- completeMigrationStep ---

test('completeMigrationStep marks step and detects completion', () => {
  const pe = freshModule();
  const migration = pe.createMigration(
    { id: 'P-1', name: 'old', source_refs: [] },
    { id: 'P-2', name: 'new' }
  );

  // Only deprecate step (no file migration steps)
  const r = pe.completeMigrationStep(migration.migration_id, 0, 'done');
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.all_done, true);

  const loaded = pe.loadMigration(migration.migration_id);
  assert.strictEqual(loaded.status, 'completed');
});

test('completeMigrationStep returns error for invalid index', () => {
  const pe = freshModule();
  const migration = pe.createMigration(
    { id: 'P-1', name: 'old', source_refs: ['a.ts'] },
    { id: 'P-2', name: 'new' }
  );

  const r = pe.completeMigrationStep(migration.migration_id, 99);
  assert.strictEqual(r.success, false);
});

// --- rollbackMigration ---

test('rollbackMigration marks migration as rolled back', () => {
  const pe = freshModule();
  const migration = pe.createMigration(
    { id: 'P-1', name: 'old', source_refs: [] },
    { id: 'P-2', name: 'new' }
  );

  const r = pe.rollbackMigration(migration.migration_id, 'caused regressions');
  assert.strictEqual(r.success, true);

  const loaded = pe.loadMigration(migration.migration_id);
  assert.strictEqual(loaded.status, 'rolled_back');
  assert.strictEqual(loaded.rollback_reason, 'caused regressions');
});

// --- listMigrations ---

test('listMigrations returns all migrations', () => {
  const pe = freshModule();
  pe.createMigration({ id: 'P-1', name: 'a', source_refs: [] }, { id: 'P-2', name: 'b' });
  pe.createMigration({ id: 'P-3', name: 'c', source_refs: [] }, { id: 'P-4', name: 'd' });

  const all = pe.listMigrations();
  assert.strictEqual(all.length, 2);
});

test('listMigrations filters by status', () => {
  const pe = freshModule();
  const m1 = pe.createMigration({ id: 'P-1', name: 'a', source_refs: [] }, { id: 'P-2', name: 'b' });
  pe.createMigration({ id: 'P-3', name: 'c', source_refs: [] }, { id: 'P-4', name: 'd' });
  pe.completeMigrationStep(m1.migration_id, 0);

  const completed = pe.listMigrations({ status: 'completed' });
  assert.strictEqual(completed.length, 1);
});

// --- detectEvolutions ---

test('detectEvolutions returns empty for no patterns', () => {
  const pe = freshModule();
  const evolutions = pe.detectEvolutions();
  assert.strictEqual(evolutions.length, 0);
});

// --- Edge cases ---

test('loadMigration returns null for missing id', () => {
  const pe = freshModule();
  assert.strictEqual(pe.loadMigration('nonexistent'), null);
});

test('rollbackMigration returns error for missing migration', () => {
  const pe = freshModule();
  const r = pe.rollbackMigration('nonexistent');
  assert.strictEqual(r.success, false);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
