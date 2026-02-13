/**
 * Tests for Phase 7.9: Soul Persistence & Cross-Session Identity
 *
 * Tests soul-persistence.js — backup, restore, merge, snapshots,
 * diff, format versioning, global listing.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

let tmpDir;
let origCwd;
let globalSoulsDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-persist-test-'));
  origCwd = process.cwd();
  process.chdir(tmpDir);

  // Create souls dir with test soul
  const soulsDir = path.join(tmpDir, '.claude', 'pilot', 'souls');
  fs.mkdirSync(soulsDir, { recursive: true });
  fs.writeFileSync(path.join(soulsDir, 'backend.md'), [
    '---', 'role: backend', 'created: 2026-02-13', 'updated: 2026-02-13',
    'version: 2', 'risk_tolerance: conservative', '---', '',
    '## Expertise', '- api design', '- database', '',
    '## Preferences', '- Node.js', '',
    '## Lessons Learned',
    '- [2026-02-12] (task-1) Always validate input', '',
    '## Decision Rules',
    '- [api] Use JSON schema validation (confidence: 0.9)', ''
  ].join('\n'));
  fs.writeFileSync(path.join(soulsDir, 'frontend.md'), [
    '---', 'role: frontend', 'created: 2026-02-13', 'updated: 2026-02-13',
    'version: 1', '---', '',
    '## Expertise', '- React', '',
    '## Preferences', '- TypeScript', ''
  ].join('\n'));

  // Create snapshot dir
  fs.mkdirSync(path.join(tmpDir, '.claude', 'pilot', 'state', 'soul-snapshots'), { recursive: true });
}

function cleanup() {
  process.chdir(origCwd);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ok */ }
  // Clean up any global souls created in home dir
  if (globalSoulsDir) {
    try { fs.rmSync(globalSoulsDir, { recursive: true, force: true }); } catch (e) { /* ok */ }
  }
}

let sp;

describe('Soul Persistence — Phase 7.9', () => {
  beforeEach(() => {
    setup();
    for (const key of Object.keys(require.cache)) {
      if (key.includes('soul-persistence') || key.includes('souls')) {
        delete require.cache[key];
      }
    }
    sp = require('../.claude/pilot/hooks/lib/soul-persistence');
    // Redirect global souls dir to tmp for test isolation
    globalSoulsDir = path.join(tmpDir, '.pilot-agi-test-global', 'souls');
    sp.setGlobalSoulsDir(globalSoulsDir);
    // Clean any pre-existing
    try { fs.rmSync(globalSoulsDir, { recursive: true, force: true }); } catch (e) { /* ok */ }
  });

  afterEach(() => {
    cleanup();
  });

  // ===========================================================================
  // backupSoul
  // ===========================================================================

  describe('backupSoul', () => {
    it('backs up soul to global directory', () => {
      const result = sp.backupSoul('backend');
      assert.ok(result.success);
      assert.ok(result.global_path);
      assert.ok(fs.existsSync(result.global_path));
    });

    it('creates snapshot during backup', () => {
      sp.backupSoul('backend');
      const snapshots = sp.listSnapshots('backend');
      assert.ok(snapshots.length > 0);
    });

    it('returns error for missing role', () => {
      const result = sp.backupSoul(null);
      assert.ok(!result.success);
      assert.ok(result.error);
    });

    it('returns error for non-existent soul', () => {
      const result = sp.backupSoul('nonexistent');
      assert.ok(!result.success);
    });

    it('stores format version in backup', () => {
      sp.backupSoul('backend');
      const data = JSON.parse(fs.readFileSync(globalSoulsDir + '/backend.json', 'utf8'));
      assert.equal(data.format_version, sp.SOUL_FORMAT_VERSION);
      assert.equal(data.role, 'backend');
    });
  });

  // ===========================================================================
  // restoreSoul
  // ===========================================================================

  describe('restoreSoul', () => {
    it('restores from global backup (merge)', () => {
      sp.backupSoul('backend');
      // Modify local soul to make merge detectable
      const souls = require('../.claude/pilot/hooks/lib/souls');
      const soul = souls.loadSoul('backend');
      soul.expertise.push('new-skill');
      souls.writeSoul('backend', soul);

      const result = sp.restoreSoul('backend');
      assert.ok(result.success);
      assert.equal(result.merged, true);
    });

    it('restores with overwrite', () => {
      sp.backupSoul('backend');
      const result = sp.restoreSoul('backend', { overwrite: true });
      assert.ok(result.success);
      assert.equal(result.merged, false);
      assert.equal(result.source, 'global');
    });

    it('returns error when no global backup exists', () => {
      const result = sp.restoreSoul('backend');
      assert.ok(!result.success);
      assert.ok(result.error.includes('no global backup'));
    });

    it('returns error for missing role', () => {
      const result = sp.restoreSoul(null);
      assert.ok(!result.success);
    });
  });

  // ===========================================================================
  // mergeSouls
  // ===========================================================================

  describe('mergeSouls', () => {
    it('merges expertise from both souls', () => {
      const local = {
        meta: { role: 'backend' },
        traits: { risk_tolerance: 'conservative' },
        expertise: ['api design'],
        preferences: ['Node.js'],
        lessons_learned: [{ lesson: 'local lesson', date: '2026-02-13' }],
        decision_rules: [{ rule: 'local rule', area: 'api', confidence: 0.9 }]
      };
      const global = {
        meta: { role: 'backend' },
        traits: { risk_tolerance: 'moderate', verbosity: 'concise' },
        expertise: ['api design', 'database'],
        preferences: ['TypeScript'],
        lessons_learned: [{ lesson: 'global lesson', date: '2026-02-10' }],
        decision_rules: [{ rule: 'global rule', area: 'db', confidence: 0.8 }]
      };

      const merged = sp.mergeSouls(local, global);
      assert.ok(merged.expertise.includes('api design'));
      assert.ok(merged.expertise.includes('database'));
      assert.equal(merged.traits.risk_tolerance, 'conservative'); // Local wins
      assert.equal(merged.traits.verbosity, 'concise'); // Global fills gap
      assert.ok(merged.preferences.includes('Node.js'));
      assert.ok(merged.preferences.includes('TypeScript'));
      assert.equal(merged.lessons_learned.length, 2);
      assert.equal(merged.decision_rules.length, 2);
    });

    it('deduplicates lessons by text', () => {
      const local = {
        meta: {}, traits: {}, expertise: [], preferences: [],
        lessons_learned: [{ lesson: 'same lesson', date: '2026-02-13' }],
        decision_rules: []
      };
      const global = {
        meta: {}, traits: {}, expertise: [], preferences: [],
        lessons_learned: [{ lesson: 'same lesson', date: '2026-02-10' }],
        decision_rules: []
      };

      const merged = sp.mergeSouls(local, global);
      assert.equal(merged.lessons_learned.length, 1);
    });

    it('caps expertise at 15', () => {
      const local = {
        meta: {}, traits: {},
        expertise: Array.from({ length: 10 }, (_, i) => 'skill-L-' + i),
        preferences: [], lessons_learned: [], decision_rules: []
      };
      const global = {
        meta: {}, traits: {},
        expertise: Array.from({ length: 10 }, (_, i) => 'skill-G-' + i),
        preferences: [], lessons_learned: [], decision_rules: []
      };

      const merged = sp.mergeSouls(local, global);
      assert.ok(merged.expertise.length <= 15);
    });
  });

  // ===========================================================================
  // takeSnapshot
  // ===========================================================================

  describe('takeSnapshot', () => {
    it('creates a snapshot file', () => {
      const result = sp.takeSnapshot('backend');
      assert.ok(result.success);
      assert.ok(result.snapshot_path);
      assert.ok(fs.existsSync(result.snapshot_path));
    });

    it('stores soul data in snapshot', () => {
      const result = sp.takeSnapshot('backend');
      const data = JSON.parse(fs.readFileSync(result.snapshot_path, 'utf8'));
      assert.equal(data.role, 'backend');
      assert.ok(data.soul);
      assert.ok(data.snapshot_at);
    });

    it('returns error for missing role', () => {
      const result = sp.takeSnapshot(null);
      assert.ok(!result.success);
    });

    it('returns error for non-existent soul', () => {
      const result = sp.takeSnapshot('nonexistent');
      assert.ok(!result.success);
    });
  });

  // ===========================================================================
  // diffSoul
  // ===========================================================================

  describe('diffSoul', () => {
    it('returns no changes message when no snapshots', () => {
      const result = sp.diffSoul('backend');
      assert.ok(result.success);
      assert.equal(result.changes.length, 0);
    });

    it('detects added expertise', () => {
      // Take snapshot first
      sp.takeSnapshot('backend');

      // Add expertise to soul
      const souls = require('../.claude/pilot/hooks/lib/souls');
      const soul = souls.loadSoul('backend');
      soul.expertise.push('new-skill');
      souls.writeSoul('backend', soul);

      const result = sp.diffSoul('backend');
      assert.ok(result.success);
      assert.ok(result.changes.length > 0);
      const expertiseChange = result.changes.find(c => c.section === 'expertise');
      assert.ok(expertiseChange);
      assert.ok(expertiseChange.items.includes('new-skill'));
    });

    it('detects added lessons', () => {
      sp.takeSnapshot('backend');

      const souls = require('../.claude/pilot/hooks/lib/souls');
      souls.recordLesson('backend', 'new important lesson', 'task-99');

      const result = sp.diffSoul('backend');
      assert.ok(result.success);
      const lessonChange = result.changes.find(c =>
        c.section === 'lessons_learned' && c.type === 'added'
      );
      assert.ok(lessonChange);
    });

    it('returns error for missing role', () => {
      const result = sp.diffSoul(null);
      assert.ok(!result.success);
    });
  });

  // ===========================================================================
  // listSnapshots
  // ===========================================================================

  describe('listSnapshots', () => {
    it('returns empty for role with no snapshots', () => {
      const snapshots = sp.listSnapshots('backend');
      assert.equal(snapshots.length, 0);
    });

    it('lists snapshots in order', () => {
      // Manually create two snapshot files with different timestamps
      const dir = path.join(tmpDir, '.claude', 'pilot', 'state', 'soul-snapshots', 'backend');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '2026-02-12T00-00-00-000Z.json'), '{"role":"backend","soul":{}}');
      fs.writeFileSync(path.join(dir, '2026-02-13T00-00-00-000Z.json'), '{"role":"backend","soul":{}}');

      const snapshots = sp.listSnapshots('backend');
      assert.ok(snapshots.length >= 2);
      // Should be sorted
      assert.ok(snapshots[0].filename < snapshots[1].filename);
    });
  });

  // ===========================================================================
  // hasGlobalBackup / listGlobalSouls
  // ===========================================================================

  describe('global backup queries', () => {
    it('hasGlobalBackup returns false when no backup', () => {
      assert.ok(!sp.hasGlobalBackup('backend'));
    });

    it('hasGlobalBackup returns true after backup', () => {
      sp.backupSoul('backend');
      assert.ok(sp.hasGlobalBackup('backend'));
    });

    it('listGlobalSouls returns empty when no backups', () => {
      assert.equal(sp.listGlobalSouls().length, 0);
    });

    it('listGlobalSouls lists backed up souls', () => {
      sp.backupSoul('backend');
      sp.backupSoul('frontend');
      const list = sp.listGlobalSouls();
      assert.ok(list.length >= 2);
      assert.ok(list.some(s => s.role === 'backend'));
      assert.ok(list.some(s => s.role === 'frontend'));
    });
  });

  // ===========================================================================
  // Module exports
  // ===========================================================================

  describe('module exports', () => {
    it('exports all expected functions', () => {
      const exports = [
        'backupSoul', 'restoreSoul', 'hasGlobalBackup', 'listGlobalSouls',
        'mergeSouls', 'takeSnapshot', 'diffSoul', 'listSnapshots'
      ];
      for (const name of exports) {
        assert.ok(name in sp, 'Missing export: ' + name);
      }
    });
  });
});
