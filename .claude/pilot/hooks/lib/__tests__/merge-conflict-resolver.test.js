/**
 * Tests for Merge Conflict Resolver — Phase 5.2
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Fresh module pattern
function freshModule(modName) {
  const modPath = require.resolve('../' + modName);
  delete require.cache[modPath];
  return require(modPath);
}

function freshResolver() {
  // Clear both modules since resolver depends on registry
  const regPath = require.resolve('../conflict-parser-registry');
  const resPath = require.resolve('../merge-conflict-resolver');
  delete require.cache[regPath];
  delete require.cache[resPath];
  return require(resPath);
}

describe('MergeConflictResolver', () => {
  let resolver;
  let tmpDir;

  beforeEach(() => {
    resolver = freshResolver();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcr-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) { /* best effort */ }
  });

  // =========================================================================
  // CONFLICT MARKER PARSING
  // =========================================================================

  describe('parseConflictMarkers', () => {
    it('should parse standard two-way conflict markers', () => {
      const content = `line1
<<<<<<< HEAD
our change
=======
their change
>>>>>>> branch
line2`;
      const conflicts = resolver.parseConflictMarkers(content);
      assert.strictEqual(conflicts.length, 1);
      assert.strictEqual(conflicts[0].ours, 'our change');
      assert.strictEqual(conflicts[0].theirs, 'their change');
      assert.strictEqual(conflicts[0].base, undefined);
    });

    it('should parse diff3-style three-way conflict markers', () => {
      const content = `<<<<<<< HEAD
our change
||||||| base
original
=======
their change
>>>>>>> branch`;
      const conflicts = resolver.parseConflictMarkers(content);
      assert.strictEqual(conflicts.length, 1);
      assert.strictEqual(conflicts[0].ours, 'our change');
      assert.strictEqual(conflicts[0].theirs, 'their change');
      assert.strictEqual(conflicts[0].base, 'original');
    });

    it('should parse multiple conflicts', () => {
      const content = `<<<<<<< HEAD
a1
=======
b1
>>>>>>> branch
middle
<<<<<<< HEAD
a2
=======
b2
>>>>>>> branch`;
      const conflicts = resolver.parseConflictMarkers(content);
      assert.strictEqual(conflicts.length, 2);
      assert.strictEqual(conflicts[0].ours, 'a1');
      assert.strictEqual(conflicts[1].ours, 'a2');
    });

    it('should handle multi-line conflicts', () => {
      const content = `<<<<<<< HEAD
line1
line2
line3
=======
lineA
lineB
>>>>>>> branch`;
      const conflicts = resolver.parseConflictMarkers(content);
      assert.strictEqual(conflicts[0].ours, 'line1\nline2\nline3');
      assert.strictEqual(conflicts[0].theirs, 'lineA\nlineB');
    });

    it('should return empty array for no conflicts', () => {
      assert.deepStrictEqual(resolver.parseConflictMarkers('no conflicts'), []);
      assert.deepStrictEqual(resolver.parseConflictMarkers(''), []);
      assert.deepStrictEqual(resolver.parseConflictMarkers(null), []);
    });

    it('should track line numbers', () => {
      const content = `line0
<<<<<<< HEAD
our
=======
their
>>>>>>> branch
line6`;
      const conflicts = resolver.parseConflictMarkers(content);
      assert.strictEqual(conflicts[0].startLine, 1);
      assert.strictEqual(conflicts[0].endLine, 5);
    });
  });

  // =========================================================================
  // CONFLICT CLASSIFICATION
  // =========================================================================

  describe('classifyConflict', () => {
    it('should classify import-only conflicts', () => {
      const conflict = {
        ours: "const fs = require('fs');",
        theirs: "const path = require('path');"
      };
      const result = resolver.classifyConflict(conflict, 'index.js');
      assert.strictEqual(result.type, 'import_merge');
    });

    it('should classify additive conflicts (no base, different declarations)', () => {
      const conflict = {
        ours: 'function foo() {\n  return 1;\n}',
        theirs: 'function bar() {\n  return 2;\n}'
      };
      const result = resolver.classifyConflict(conflict, 'utils.js');
      assert.strictEqual(result.type, 'additive');
    });

    it('should classify delete/modify with base (ours deleted)', () => {
      const conflict = {
        ours: '',
        theirs: 'function foo() {\n  return 2;\n}',
        base: 'function foo() {\n  return 1;\n}'
      };
      const result = resolver.classifyConflict(conflict, 'utils.js');
      assert.strictEqual(result.type, 'delete_modify');
      assert.strictEqual(result.details.deleted, 'ours');
    });

    it('should classify delete/modify with base (theirs deleted)', () => {
      const conflict = {
        ours: 'function foo() {\n  return 2;\n}',
        theirs: '',
        base: 'function foo() {\n  return 1;\n}'
      };
      const result = resolver.classifyConflict(conflict, 'utils.js');
      assert.strictEqual(result.type, 'delete_modify');
      assert.strictEqual(result.details.deleted, 'theirs');
    });

    it('should classify contradictory for very different changes', () => {
      const conflict = {
        ours: 'completely different code here with nothing in common',
        theirs: 'totally unrelated code that shares zero lines whatsoever'
      };
      const result = resolver.classifyConflict(conflict, 'main.js');
      assert.strictEqual(result.type, 'contradictory');
    });

    it('should return unknown for unsupported languages', () => {
      const conflict = { ours: 'abc', theirs: 'def' };
      const result = resolver.classifyConflict(conflict, 'Main.java');
      assert.strictEqual(result.type, 'unknown');
    });

    it('should classify overlapping for same-area edits', () => {
      const conflict = {
        ours: 'function foo() {\n  return 1;\n}',
        theirs: 'function foo() {\n  return 2;\n}'
      };
      const result = resolver.classifyConflict(conflict, 'utils.js');
      // Same function name in both = overlapping
      assert.strictEqual(result.type, 'overlapping');
    });
  });

  // =========================================================================
  // INTENT EXTRACTION
  // =========================================================================

  describe('parseCommitIntent', () => {
    it('should parse conventional commit format', () => {
      const result = resolver.parseCommitIntent('feat(auth): add OAuth flow [Pilot AGI-abc]');
      assert.strictEqual(result.type, 'feat');
      assert.strictEqual(result.scope, 'auth');
      assert.strictEqual(result.description, 'add OAuth flow');
      assert.strictEqual(result.taskId, 'Pilot AGI-abc');
      assert.strictEqual(result.priority, 4);
    });

    it('should handle fix commits with high priority', () => {
      const result = resolver.parseCommitIntent('fix(core): null check bug');
      assert.strictEqual(result.type, 'fix');
      assert.strictEqual(result.priority, 5);
    });

    it('should handle commits without scope', () => {
      const result = resolver.parseCommitIntent('docs: update readme');
      assert.strictEqual(result.type, 'docs');
      assert.strictEqual(result.scope, '');
      assert.strictEqual(result.priority, 1);
    });

    it('should handle non-conventional messages', () => {
      const result = resolver.parseCommitIntent('random commit message');
      assert.strictEqual(result.type, 'unknown');
      assert.strictEqual(result.priority, 0);
    });

    it('should handle null/empty input', () => {
      const result = resolver.parseCommitIntent(null);
      assert.strictEqual(result.type, 'unknown');
    });
  });

  describe('compareIntent', () => {
    it('should prefer fix over feat', () => {
      const fix = { type: 'fix', priority: 5 };
      const feat = { type: 'feat', priority: 4 };
      assert.strictEqual(resolver.compareIntent(fix, feat), 'ours');
      assert.strictEqual(resolver.compareIntent(feat, fix), 'theirs');
    });

    it('should return equal for same priority', () => {
      const a = { type: 'feat', priority: 4 };
      const b = { type: 'feat', priority: 4 };
      assert.strictEqual(resolver.compareIntent(a, b), 'equal');
    });
  });

  // =========================================================================
  // RESOLUTION STRATEGIES
  // =========================================================================

  describe('resolveConflictRegion — import merge', () => {
    it('should merge import conflicts by combining and sorting', () => {
      const conflict = {
        ours: "const fs = require('fs');",
        theirs: "const path = require('path');"
      };
      const classification = { type: 'import_merge', details: { language: 'javascript' } };
      const result = resolver.resolveConflictRegion(conflict, classification, {}, 'index.js');

      assert.ok(result.resolved);
      assert.ok(result.resolved.includes('fs'));
      assert.ok(result.resolved.includes('path'));
      assert.strictEqual(result.strategy, 'interleave');
      assert.ok(result.confidence >= 0.9);
    });
  });

  describe('resolveConflictRegion — additive', () => {
    it('should combine additive non-overlapping additions', () => {
      const conflict = {
        ours: 'function foo() {\n  return 1;\n}',
        theirs: 'function bar() {\n  return 2;\n}'
      };
      const classification = { type: 'additive', details: {} };
      const result = resolver.resolveConflictRegion(conflict, classification, {}, 'utils.js');

      assert.ok(result.resolved);
      assert.ok(result.resolved.includes('foo'));
      assert.ok(result.resolved.includes('bar'));
      assert.strictEqual(result.strategy, 'combine');
      assert.ok(result.confidence >= 0.8);
    });
  });

  describe('resolveConflictRegion — delete/modify', () => {
    it('should prefer modification by default', () => {
      const conflict = {
        ours: '',
        theirs: 'function foo() { return 2; }'
      };
      const classification = { type: 'delete_modify', details: { deleted: 'ours', modified: 'theirs' } };
      const result = resolver.resolveConflictRegion(conflict, classification, {}, 'utils.js');

      assert.strictEqual(result.resolved, conflict.theirs);
      assert.strictEqual(result.strategy, 'prefer_theirs');
    });

    it('should use intent to decide delete/modify', () => {
      const conflict = {
        ours: 'function foo() { return fixed; }',
        theirs: ''
      };
      const classification = { type: 'delete_modify', details: { deleted: 'theirs', modified: 'ours' } };
      const intentContext = {
        oursIntent: { type: 'fix', priority: 5 },
        theirsIntent: { type: 'refactor', priority: 3 }
      };
      const result = resolver.resolveConflictRegion(conflict, classification, intentContext, 'utils.js');

      assert.strictEqual(result.resolved, conflict.ours);
      assert.strictEqual(result.strategy, 'prefer_ours');
    });
  });

  describe('resolveConflictRegion — contradictory', () => {
    it('should escalate contradictory conflicts', () => {
      const conflict = { ours: 'a', theirs: 'b' };
      const classification = { type: 'contradictory', details: {} };
      const result = resolver.resolveConflictRegion(conflict, classification, {}, 'utils.js');

      assert.strictEqual(result.resolved, null);
      assert.strictEqual(result.strategy, 'escalate');
      assert.strictEqual(result.confidence, 0);
    });
  });

  describe('resolveConflictRegion — overlapping', () => {
    it('should resolve near-identical overlapping edits', () => {
      const conflict = {
        ours: 'function foo() {\n  return 1;\n}',
        theirs: 'function foo() {\n  return 1;\n}'
      };
      const classification = { type: 'overlapping', details: { similarity: 1.0 } };
      const result = resolver.resolveConflictRegion(conflict, classification, {}, 'utils.js');

      assert.ok(result.resolved);
      assert.ok(result.confidence >= 0.8);
    });
  });

  // =========================================================================
  // THREE-WAY LINE MERGE
  // =========================================================================

  describe('threeWayLineMerge', () => {
    it('should merge when only ours changed a line', () => {
      const base = 'line1\nline2\nline3';
      const ours = 'line1\nMODIFIED\nline3';
      const theirs = 'line1\nline2\nline3';
      const result = resolver.threeWayLineMerge(base, ours, theirs);

      assert.ok(result.success);
      assert.strictEqual(result.merged, 'line1\nMODIFIED\nline3');
    });

    it('should merge when only theirs changed a line', () => {
      const base = 'line1\nline2\nline3';
      const ours = 'line1\nline2\nline3';
      const theirs = 'line1\nline2\nMODIFIED';
      const result = resolver.threeWayLineMerge(base, ours, theirs);

      assert.ok(result.success);
      assert.strictEqual(result.merged, 'line1\nline2\nMODIFIED');
    });

    it('should merge when both change different lines', () => {
      const base = 'a\nb\nc';
      const ours = 'A\nb\nc';
      const theirs = 'a\nb\nC';
      const result = resolver.threeWayLineMerge(base, ours, theirs);

      assert.ok(result.success);
      assert.strictEqual(result.merged, 'A\nb\nC');
    });

    it('should fail when both change the same line differently', () => {
      const base = 'a\nb\nc';
      const ours = 'a\nX\nc';
      const theirs = 'a\nY\nc';
      const result = resolver.threeWayLineMerge(base, ours, theirs);

      assert.ok(!result.success);
      assert.ok(result.conflictLines.length > 0);
    });

    it('should succeed when both make the same change', () => {
      const base = 'a\nb\nc';
      const ours = 'a\nX\nc';
      const theirs = 'a\nX\nc';
      const result = resolver.threeWayLineMerge(base, ours, theirs);

      assert.ok(result.success);
      assert.strictEqual(result.merged, 'a\nX\nc');
    });
  });

  // =========================================================================
  // SIMILARITY
  // =========================================================================

  describe('computeSimilarity', () => {
    it('should return 1.0 for identical strings', () => {
      assert.strictEqual(resolver.computeSimilarity('abc\ndef', 'abc\ndef'), 1.0);
    });

    it('should return 0.0 for completely different strings', () => {
      assert.strictEqual(resolver.computeSimilarity('abc', 'xyz'), 0.0);
    });

    it('should return 1.0 for both empty', () => {
      assert.strictEqual(resolver.computeSimilarity('', ''), 1.0);
    });

    it('should return partial similarity', () => {
      const sim = resolver.computeSimilarity('a\nb\nc', 'a\nb\nd');
      assert.ok(sim > 0 && sim < 1);
    });
  });

  // =========================================================================
  // FILE RECONSTRUCTION
  // =========================================================================

  describe('reconstructFile', () => {
    it('should replace conflict markers with resolved content', () => {
      const content = `before
<<<<<<< HEAD
ours
=======
theirs
>>>>>>> branch
after`;
      const conflicts = resolver.parseConflictMarkers(content);
      const resolutions = [{
        resolution: { resolved: 'merged content' }
      }];

      const result = resolver.reconstructFile(content, conflicts, resolutions);
      assert.ok(result.includes('before'));
      assert.ok(result.includes('merged content'));
      assert.ok(result.includes('after'));
      assert.ok(!result.includes('<<<<<<<'));
      assert.ok(!result.includes('======='));
      assert.ok(!result.includes('>>>>>>>'));
    });

    it('should handle multiple conflicts', () => {
      const content = `a
<<<<<<< HEAD
x1
=======
y1
>>>>>>> b
middle
<<<<<<< HEAD
x2
=======
y2
>>>>>>> b
end`;
      const conflicts = resolver.parseConflictMarkers(content);
      const resolutions = [
        { resolution: { resolved: 'R1' } },
        { resolution: { resolved: 'R2' } }
      ];

      const result = resolver.reconstructFile(content, conflicts, resolutions);
      assert.ok(result.includes('R1'));
      assert.ok(result.includes('R2'));
      assert.ok(result.includes('middle'));
    });
  });

  // =========================================================================
  // resolveFile (integration)
  // =========================================================================

  describe('resolveFile', () => {
    it('should resolve import-only conflict file', () => {
      const filePath = path.join(tmpDir, 'imports.js');
      const content = `<<<<<<< HEAD
const fs = require('fs');
=======
const path = require('path');
>>>>>>> branch`;
      fs.writeFileSync(filePath, content);

      const result = resolver.resolveFile(filePath, { projectRoot: tmpDir });
      assert.ok(result.success);
      assert.ok(result.resolvedContent);
      assert.ok(result.resolvedContent.includes('fs'));
      assert.ok(result.resolvedContent.includes('path'));
      assert.ok(!result.needsEscalation);
    });

    it('should resolve additive conflict file', () => {
      const filePath = path.join(tmpDir, 'funcs.js');
      const content = `<<<<<<< HEAD
function foo() {
  return 1;
}
=======
function bar() {
  return 2;
}
>>>>>>> branch`;
      fs.writeFileSync(filePath, content);

      const result = resolver.resolveFile(filePath, { projectRoot: tmpDir });
      assert.ok(result.success);
      assert.ok(result.resolvedContent.includes('foo'));
      assert.ok(result.resolvedContent.includes('bar'));
    });

    it('should handle file without conflicts', () => {
      const filePath = path.join(tmpDir, 'clean.js');
      fs.writeFileSync(filePath, 'const a = 1;');

      const result = resolver.resolveFile(filePath, { projectRoot: tmpDir });
      assert.ok(result.success);
      assert.strictEqual(result.overallConfidence, 1.0);
    });

    it('should handle missing file', () => {
      const result = resolver.resolveFile('/nonexistent/file.js');
      assert.ok(!result.success);
      assert.ok(result.error);
    });

    it('should escalate unsupported language files', () => {
      const filePath = path.join(tmpDir, 'Main.java');
      const content = `<<<<<<< HEAD
class A {}
=======
class B {}
>>>>>>> branch`;
      fs.writeFileSync(filePath, content);

      const result = resolver.resolveFile(filePath, { projectRoot: tmpDir });
      // Unknown language — should still attempt (falls to escalate)
      assert.ok(result.resolutions.length > 0);
    });
  });

  // =========================================================================
  // STATE MANAGEMENT
  // =========================================================================

  describe('saveResolution / loadResolutions', () => {
    it('should save and load resolution state', () => {
      const result = {
        success: true,
        overallConfidence: 0.88,
        resolutions: [
          { resolution: { strategy: 'combine' }, classification: { type: 'additive' } }
        ],
        needsEscalation: false
      };

      resolver.saveResolution('test-task', 'index.js', result, tmpDir);

      const loaded = resolver.loadResolutions('test-task', tmpDir);
      assert.ok(loaded.resolutions.length > 0);
      assert.strictEqual(loaded.resolutions[0].file, 'index.js');
      assert.strictEqual(loaded.resolutions[0].success, true);
      assert.strictEqual(loaded.resolutions[0].confidence, 0.88);
    });

    it('should append to existing state', () => {
      const result1 = { success: true, overallConfidence: 0.9, resolutions: [], needsEscalation: false };
      const result2 = { success: false, overallConfidence: 0.3, resolutions: [], needsEscalation: true };

      resolver.saveResolution('task2', 'a.js', result1, tmpDir);
      resolver.saveResolution('task2', 'b.js', result2, tmpDir);

      const loaded = resolver.loadResolutions('task2', tmpDir);
      assert.strictEqual(loaded.resolutions.length, 2);
    });

    it('should return empty for non-existent task', () => {
      const loaded = resolver.loadResolutions('nonexistent', tmpDir);
      assert.deepStrictEqual(loaded, { resolutions: [] });
    });
  });

  // =========================================================================
  // resolveAllConflicts (high-level)
  // =========================================================================

  describe('resolveAllConflicts', () => {
    it('should resolve multiple conflict files', () => {
      const file1 = path.join(tmpDir, 'a.js');
      const file2 = path.join(tmpDir, 'b.js');

      fs.writeFileSync(file1, `<<<<<<< HEAD
const a = require('a');
=======
const b = require('b');
>>>>>>> branch`);

      fs.writeFileSync(file2, `<<<<<<< HEAD
function x() { return 1; }
=======
function y() { return 2; }
>>>>>>> branch`);

      const result = resolver.resolveAllConflicts([file1, file2], { projectRoot: tmpDir });
      assert.strictEqual(result.resolvedCount, 2);
      assert.strictEqual(result.escalatedCount, 0);
      assert.ok(result.success);
    });

    it('should report partial resolution', () => {
      const file1 = path.join(tmpDir, 'ok.js');
      const file2 = path.join(tmpDir, 'hard.java');

      fs.writeFileSync(file1, `<<<<<<< HEAD
const a = require('a');
=======
const b = require('b');
>>>>>>> branch`);

      // .java is unsupported — will get classified as unknown
      fs.writeFileSync(file2, `<<<<<<< HEAD
completely different content that has no overlap at all with the other side
=======
totally different code on this side with zero similarity to the other branch
>>>>>>> branch`);

      const result = resolver.resolveAllConflicts([file1, file2], { projectRoot: tmpDir });
      assert.strictEqual(result.resolvedCount, 1);
      assert.strictEqual(result.escalatedCount, 1);
      assert.ok(!result.success);
    });
  });

  // =========================================================================
  // applyResolutions
  // =========================================================================

  describe('applyResolutions', () => {
    it('should write resolved content to disk', () => {
      const file = path.join(tmpDir, 'resolved.js');
      fs.writeFileSync(file, 'old content');

      const results = {
        files: {
          [file]: { success: true, resolvedContent: 'new content' }
        }
      };

      const applied = resolver.applyResolutions(results, tmpDir);
      assert.deepStrictEqual(applied.applied, [file]);
      assert.deepStrictEqual(applied.failed, []);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new content');
    });

    it('should track failed files', () => {
      const results = {
        files: {
          'ok.js': { success: true, resolvedContent: 'content' },
          'bad.js': { success: false, resolvedContent: null }
        }
      };

      const applied = resolver.applyResolutions(results, tmpDir);
      assert.ok(applied.failed.includes('bad.js'));
    });
  });

  // =========================================================================
  // CONSTANTS
  // =========================================================================

  describe('constants', () => {
    it('should export conflict types', () => {
      assert.ok(resolver.CONFLICT_TYPES.ADDITIVE);
      assert.ok(resolver.CONFLICT_TYPES.OVERLAPPING);
      assert.ok(resolver.CONFLICT_TYPES.IMPORT_MERGE);
      assert.ok(resolver.CONFLICT_TYPES.CONTRADICTORY);
    });

    it('should export strategies', () => {
      assert.ok(resolver.STRATEGIES.COMBINE);
      assert.ok(resolver.STRATEGIES.ESCALATE);
      assert.ok(resolver.STRATEGIES.PREFER_OURS);
    });

    it('should export confidence thresholds', () => {
      assert.strictEqual(resolver.CONFIDENCE_THRESHOLDS.high, 0.85);
      assert.strictEqual(resolver.CONFIDENCE_THRESHOLDS.medium, 0.60);
    });
  });
});
