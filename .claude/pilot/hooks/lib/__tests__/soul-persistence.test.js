/**
 * Tests for Soul Persistence & Cross-Session Identity — Phase 7.9 (Pilot AGI-nvn8)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/soul-persistence.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let testDir;
let originalCwd;
let globalDir;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpersist-test-'));
  globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulglobal-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/soul-snapshots'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/souls'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot'), { recursive: true });
  fs.writeFileSync(path.join(testDir, '.claude/pilot/agent-registry.json'), JSON.stringify({
    agents: {
      frontend: { name: 'Frontend', capabilities: ['styling'] },
      backend: { name: 'Backend', capabilities: ['api_design'] }
    }
  }, null, 2));

  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
  fs.rmSync(globalDir, { recursive: true, force: true });
}

function freshModule() {
  const modPaths = ['../soul-persistence', '../souls', '../policy', '../session', '../memory', '../messaging'];
  for (const modPath of modPaths) {
    try { delete require.cache[require.resolve(modPath)]; } catch (e) {}
  }
  const sp = require('../soul-persistence');
  // Override global souls dir to test-specific directory
  sp.setGlobalSoulsDir(globalDir);
  return sp;
}

function freshSouls() {
  try { delete require.cache[require.resolve('../souls')]; } catch (e) {}
  return require('../souls');
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  setup();
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  } finally {
    teardown();
  }
}

console.log('\n=== Soul Persistence Tests ===\n');

// --- backupSoul ---

test('backupSoul saves soul to global directory', () => {
  const sp = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');
  souls.recordLesson('frontend', 'Test lesson', 'T-001');

  const r = sp.backupSoul('frontend');
  assert.ok(r.success);
  assert.ok(r.backed_up_at);

  // Check file exists in global dir
  const files = fs.readdirSync(globalDir);
  assert.ok(files.includes('frontend.json'));

  const backup = JSON.parse(fs.readFileSync(path.join(globalDir, 'frontend.json'), 'utf8'));
  assert.strictEqual(backup.role, 'frontend');
  assert.strictEqual(backup.format_version, sp.SOUL_FORMAT_VERSION);
  assert.ok(backup.soul.lessons_learned.length > 0);
});

test('backupSoul creates snapshot before backup', () => {
  const sp = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  sp.backupSoul('frontend');

  const snapshots = sp.listSnapshots('frontend');
  assert.ok(snapshots.length > 0);
});

test('backupSoul requires role', () => {
  const sp = freshModule();
  assert.strictEqual(sp.backupSoul(null).success, false);
});

test('backupSoul returns error for missing soul', () => {
  const sp = freshModule();
  const r = sp.backupSoul('nonexistent');
  assert.strictEqual(r.success, false);
});

// --- restoreSoul ---

test('restoreSoul loads global backup into local soul', () => {
  const sp = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');
  souls.recordLesson('frontend', 'Global lesson', 'G-001');

  // Backup
  sp.backupSoul('frontend');

  // Clear local soul
  souls.resetSoul('frontend');

  // Restore
  const r = sp.restoreSoul('frontend', { overwrite: true });
  assert.ok(r.success);

  const restored = souls.loadSoul('frontend');
  assert.ok(restored.lessons_learned.some(l => l.lesson.includes('Global')));
});

test('restoreSoul merges global and local', () => {
  const sp = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');
  souls.recordLesson('frontend', 'Global lesson', 'G-001');

  sp.backupSoul('frontend');

  // Add local lesson
  souls.recordLesson('frontend', 'Local lesson', 'L-001');

  // Restore with merge
  const r = sp.restoreSoul('frontend');
  assert.ok(r.success);
  assert.ok(r.merged);

  const soul = souls.loadSoul('frontend');
  assert.ok(soul.lessons_learned.some(l => l.lesson.includes('Local')));
  assert.ok(soul.lessons_learned.some(l => l.lesson.includes('Global')));
});

test('restoreSoul returns error for missing backup', () => {
  const sp = freshModule();
  const r = sp.restoreSoul('nonexistent');
  assert.strictEqual(r.success, false);
});

test('restoreSoul requires role', () => {
  const sp = freshModule();
  assert.strictEqual(sp.restoreSoul(null).success, false);
});

// --- mergeSouls ---

test('mergeSouls combines lessons without duplicates', () => {
  const sp = freshModule();
  const local = {
    traits: { risk_tolerance: 'high' },
    expertise: ['styling'],
    preferences: ['Tailwind'],
    lessons_learned: [{ lesson: 'shared lesson' }, { lesson: 'local only' }],
    decision_rules: [{ rule: 'use Vitest' }]
  };
  const global = {
    traits: { risk_tolerance: 'moderate', verbosity: 'concise' },
    expertise: ['styling', 'api_design'],
    preferences: ['Tailwind', 'Zustand'],
    lessons_learned: [{ lesson: 'shared lesson' }, { lesson: 'global only' }],
    decision_rules: [{ rule: 'use Vitest' }, { rule: 'prefer Zod' }]
  };

  const merged = sp.mergeSouls(local, global);

  // Local trait wins
  assert.strictEqual(merged.traits.risk_tolerance, 'high');
  // Global trait added
  assert.strictEqual(merged.traits.verbosity, 'concise');
  // Expertise union
  assert.ok(merged.expertise.includes('styling'));
  assert.ok(merged.expertise.includes('api_design'));
  // Lessons deduplicated
  assert.strictEqual(merged.lessons_learned.filter(l => l.lesson === 'shared lesson').length, 1);
  assert.ok(merged.lessons_learned.some(l => l.lesson === 'local only'));
  assert.ok(merged.lessons_learned.some(l => l.lesson === 'global only'));
  // Rules deduplicated
  assert.strictEqual(merged.decision_rules.filter(r => r.rule === 'use Vitest').length, 1);
  assert.ok(merged.decision_rules.some(r => r.rule === 'prefer Zod'));
});

// --- takeSnapshot ---

test('takeSnapshot saves current soul state', () => {
  const sp = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  const r = sp.takeSnapshot('frontend');
  assert.ok(r.success);

  const snapshots = sp.listSnapshots('frontend');
  assert.strictEqual(snapshots.length, 1);
});

test('takeSnapshot requires role', () => {
  const sp = freshModule();
  assert.strictEqual(sp.takeSnapshot(null).success, false);
});

test('takeSnapshot caps at MAX_SNAPSHOTS', () => {
  const sp = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  for (let i = 0; i < sp.MAX_SNAPSHOTS + 5; i++) {
    sp.takeSnapshot('frontend');
  }

  const snapshots = sp.listSnapshots('frontend');
  assert.ok(snapshots.length <= sp.MAX_SNAPSHOTS);
});

// --- diffSoul ---

test('diffSoul detects added lessons', () => {
  const sp = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  // Take snapshot of initial state
  sp.takeSnapshot('frontend');

  // Add a lesson
  souls.recordLesson('frontend', 'New lesson after snapshot', 'T-001');

  const r = sp.diffSoul('frontend');
  assert.ok(r.success);
  assert.ok(r.changes.length > 0);
  assert.ok(r.changes.some(c => c.section === 'lessons_learned' && c.type === 'added'));
});

test('diffSoul returns empty changes for identical state', () => {
  const sp = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  sp.takeSnapshot('frontend');

  const r = sp.diffSoul('frontend');
  assert.ok(r.success);
  assert.strictEqual(r.changes.length, 0);
});

test('diffSoul returns message when no snapshots', () => {
  const sp = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  const r = sp.diffSoul('frontend');
  assert.ok(r.success);
  assert.ok(r.message.includes('no snapshots'));
});

test('diffSoul requires role', () => {
  const sp = freshModule();
  assert.strictEqual(sp.diffSoul(null).success, false);
});

// --- hasGlobalBackup ---

test('hasGlobalBackup detects existing backup', () => {
  const sp = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  assert.strictEqual(sp.hasGlobalBackup('frontend'), false);
  sp.backupSoul('frontend');
  assert.strictEqual(sp.hasGlobalBackup('frontend'), true);
});

// --- listGlobalSouls ---

test('listGlobalSouls returns all backed up roles', () => {
  const sp = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');
  souls.initializeSoul('backend');

  sp.backupSoul('frontend');
  sp.backupSoul('backend');

  const list = sp.listGlobalSouls();
  assert.strictEqual(list.length, 2);
  assert.ok(list.some(s => s.role === 'frontend'));
  assert.ok(list.some(s => s.role === 'backend'));
});

test('listGlobalSouls returns empty when no backups', () => {
  const sp = freshModule();
  const list = sp.listGlobalSouls();
  assert.deepStrictEqual(list, []);
});

// --- listSnapshots ---

test('listSnapshots returns sorted snapshot list', () => {
  const sp = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  sp.takeSnapshot('frontend');
  sp.takeSnapshot('frontend');
  sp.takeSnapshot('frontend');

  const snapshots = sp.listSnapshots('frontend');
  assert.strictEqual(snapshots.length, 3);
  // Should be sorted chronologically
  assert.ok(snapshots[0].filename < snapshots[1].filename);
});

test('listSnapshots returns empty for no snapshots', () => {
  const sp = freshModule();
  assert.deepStrictEqual(sp.listSnapshots('frontend'), []);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
