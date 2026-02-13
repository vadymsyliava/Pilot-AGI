/**
 * Tests for Canonical Pattern Registry — Phase 8.7 (Pilot AGI-80xy)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/canonical-patterns.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canpat-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/registry'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModule() {
  const modPath = '../canonical-patterns';
  try { delete require.cache[require.resolve(modPath)]; } catch (e) {}
  return require(modPath);
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

console.log('\n=== Canonical Pattern Registry Tests ===\n');

// --- registerPattern ---

test('registerPattern creates a pattern with valid fields', () => {
  const cp = freshModule();
  const r = cp.registerPattern({
    name: 'camelCase variables',
    category: 'naming',
    purpose: 'local variable naming convention',
    rule: 'Use camelCase for all local variables'
  });
  assert.strictEqual(r.success, true);
  assert.ok(r.id);

  const found = cp.getById(r.id);
  assert.strictEqual(found.name, 'camelCase variables');
  assert.strictEqual(found.category, 'naming');
  assert.strictEqual(found.canonical, true); // manual = canonical immediately
  assert.strictEqual(found.usage_count, 0);
});

test('registerPattern rejects missing name', () => {
  const cp = freshModule();
  const r = cp.registerPattern({ category: 'naming', purpose: 'test' });
  assert.strictEqual(r.success, false);
  assert.ok(r.error.includes('name'));
});

test('registerPattern rejects invalid category', () => {
  const cp = freshModule();
  const r = cp.registerPattern({ name: 'test', category: 'invalid', purpose: 'test' });
  assert.strictEqual(r.success, false);
  assert.ok(r.error.includes('category'));
});

test('registerPattern rejects missing purpose', () => {
  const cp = freshModule();
  const r = cp.registerPattern({ name: 'test', category: 'naming' });
  assert.strictEqual(r.success, false);
  assert.ok(r.error.includes('purpose'));
});

test('registerPattern rejects duplicate name', () => {
  const cp = freshModule();
  cp.registerPattern({ name: 'camelCase', category: 'naming', purpose: 'var naming' });
  const r = cp.registerPattern({ name: 'camelCase', category: 'naming', purpose: 'other naming' });
  assert.strictEqual(r.success, false);
  assert.ok(r.error.includes('already exists'));
});

test('registerPattern detects purpose conflict', () => {
  const cp = freshModule();
  cp.registerPattern({ name: 'camelCase vars', category: 'naming', purpose: 'local variable naming convention' });
  const r = cp.registerPattern({ name: 'snake_case vars', category: 'naming', purpose: 'local variable naming convention' });
  assert.strictEqual(r.success, false);
  assert.ok(r.conflict);
  assert.ok(r.error.includes('conflicting'));
});

test('registerPattern allows same purpose in different category', () => {
  const cp = freshModule();
  cp.registerPattern({ name: 'import order', category: 'imports', purpose: 'ordering convention' });
  const r = cp.registerPattern({ name: 'file order', category: 'file_structure', purpose: 'ordering convention' });
  assert.strictEqual(r.success, true);
});

// --- updatePattern ---

test('updatePattern changes name and rule', () => {
  const cp = freshModule();
  const { id } = cp.registerPattern({ name: 'old name', category: 'naming', purpose: 'test' });
  const r = cp.updatePattern(id, { name: 'new name', rule: 'new rule' });
  assert.strictEqual(r.success, true);

  const found = cp.getById(id);
  assert.strictEqual(found.name, 'new name');
  assert.strictEqual(found.rule, 'new rule');
  assert.ok(found.updated_at);
});

test('updatePattern rejects duplicate name', () => {
  const cp = freshModule();
  cp.registerPattern({ name: 'A', category: 'naming', purpose: 'p1' });
  const { id } = cp.registerPattern({ name: 'B', category: 'naming', purpose: 'p2' });
  const r = cp.updatePattern(id, { name: 'A' });
  assert.strictEqual(r.success, false);
  assert.ok(r.error.includes('duplicate'));
});

// --- removePattern ---

test('removePattern deletes a pattern', () => {
  const cp = freshModule();
  const { id } = cp.registerPattern({ name: 'temp', category: 'other', purpose: 'temp' });
  assert.ok(cp.getById(id));

  const r = cp.removePattern(id);
  assert.strictEqual(r.success, true);
  assert.strictEqual(cp.getById(id), null);
});

test('removePattern returns error for missing id', () => {
  const cp = freshModule();
  assert.strictEqual(cp.removePattern('nonexistent').success, false);
});

// --- findByCategory ---

test('findByCategory returns matching patterns', () => {
  const cp = freshModule();
  cp.registerPattern({ name: 'A', category: 'naming', purpose: 'p1' });
  cp.registerPattern({ name: 'B', category: 'naming', purpose: 'p2' });
  cp.registerPattern({ name: 'C', category: 'imports', purpose: 'p3' });

  const naming = cp.findByCategory('naming');
  assert.strictEqual(naming.length, 2);
  const imports = cp.findByCategory('imports');
  assert.strictEqual(imports.length, 1);
});

// --- findByPurpose ---

test('findByPurpose finds matching patterns', () => {
  const cp = freshModule();
  cp.registerPattern({ name: 'barrel exports', category: 'imports', purpose: 'module re-exports through index files' });
  cp.registerPattern({ name: 'direct imports', category: 'imports', purpose: 'import directly from source file' });

  const found = cp.findByPurpose('index files');
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].name, 'barrel exports');
});

// --- findByName ---

test('findByName finds exact match', () => {
  const cp = freshModule();
  cp.registerPattern({ name: 'camelCase variables', category: 'naming', purpose: 'local vars' });
  const found = cp.findByName('camelCase variables');
  assert.strictEqual(found.length, 1);
});

test('findByName finds fuzzy match', () => {
  const cp = freshModule();
  cp.registerPattern({ name: 'camelCase variables', category: 'naming', purpose: 'local vars' });
  const found = cp.findByName('camelCase');
  assert.strictEqual(found.length, 1);
});

// --- recordUsage ---

test('recordUsage increments count and adds source_ref', () => {
  const cp = freshModule();
  const { id } = cp.registerPattern({ name: 'A', category: 'naming', purpose: 'p1' });

  cp.recordUsage(id, 'src/file1.ts');
  cp.recordUsage(id, 'src/file2.ts');

  const found = cp.getById(id);
  assert.strictEqual(found.usage_count, 2);
  assert.strictEqual(found.source_refs.length, 2);
});

test('recordUsage does not duplicate source_ref', () => {
  const cp = freshModule();
  const { id } = cp.registerPattern({ name: 'A', category: 'naming', purpose: 'p1' });

  cp.recordUsage(id, 'src/file1.ts');
  cp.recordUsage(id, 'src/file1.ts');

  const found = cp.getById(id);
  assert.strictEqual(found.source_refs.length, 1);
});

// --- observe + auto-learn ---

test('observe creates candidate on first sighting', () => {
  const cp = freshModule();
  const r = cp.observe({
    purpose: 'error boundary wrapping',
    category: 'error_handling',
    name: 'ErrorBoundary wrapper',
    source_ref: 'src/components/App.tsx'
  });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.action, 'created_candidate');

  const found = cp.getById(r.pattern_id);
  assert.strictEqual(found.auto_learned, true);
  assert.strictEqual(found.canonical, false);
});

test('observe records usage for existing pattern', () => {
  const cp = freshModule();
  cp.registerPattern({
    name: 'try-catch async',
    category: 'error_handling',
    purpose: 'async error handling with try-catch',
    rule: 'Wrap all async operations in try-catch'
  });

  const r = cp.observe({
    purpose: 'async error handling with try-catch',
    source_ref: 'src/api/users.ts'
  });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.action, 'usage_recorded');
});

test('observe promotes auto-learned pattern to canonical after threshold', () => {
  const cp = freshModule();

  // First observation creates candidate (usage_count = 1)
  const r1 = cp.observe({ purpose: 'button click handler naming', category: 'naming' });
  assert.strictEqual(r1.action, 'created_candidate');

  // Second observation records usage (usage_count = 2, still below threshold of 3)
  const r2 = cp.observe({ purpose: 'button click handler naming', source_ref: 'src/a.tsx' });
  assert.strictEqual(r2.action, 'usage_recorded');

  const mid = cp.getById(r2.pattern_id);
  assert.strictEqual(mid.canonical, false);
  assert.strictEqual(mid.usage_count, 2);

  // Third observation reaches threshold (usage_count = 3) — promotes to canonical
  const r3 = cp.observe({ purpose: 'button click handler naming', source_ref: 'src/b.tsx' });
  assert.strictEqual(r3.action, 'promoted');

  const after = cp.getById(r3.pattern_id);
  assert.strictEqual(after.canonical, true);
  assert.strictEqual(after.usage_count, 3);
});

// --- getAllConflicts ---

test('getAllConflicts detects conflicting patterns', () => {
  const cp = freshModule();
  // Register two patterns then manually insert a conflicting one
  cp.registerPattern({ name: 'A', category: 'naming', purpose: 'local variable naming convention' });

  // Force-insert a conflicting pattern by directly editing the file
  const patterns = cp.listAll();
  patterns.push({
    id: 'P-test-conflict',
    name: 'B',
    category: 'naming',
    purpose: 'local variable naming convention',
    rule: 'different rule',
    examples: [],
    source_refs: [],
    usage_count: 0,
    auto_learned: false,
    canonical: true,
    created_at: new Date().toISOString()
  });
  fs.writeFileSync(
    path.join(testDir, '.claude/pilot/registry/patterns.json'),
    JSON.stringify(patterns, null, 2)
  );

  const conflicts = cp.getAllConflicts();
  assert.strictEqual(conflicts.length, 1);
  assert.strictEqual(conflicts[0].category, 'naming');
});

test('getAllConflicts returns empty when no conflicts', () => {
  const cp = freshModule();
  cp.registerPattern({ name: 'A', category: 'naming', purpose: 'p1' });
  cp.registerPattern({ name: 'B', category: 'imports', purpose: 'p2' });

  const conflicts = cp.getAllConflicts();
  assert.strictEqual(conflicts.length, 0);
});

// --- listCanonical ---

test('listCanonical returns only canonical patterns', () => {
  const cp = freshModule();
  cp.registerPattern({ name: 'A', category: 'naming', purpose: 'p1' }); // canonical (manual)
  cp.observe({ purpose: 'new auto pattern', category: 'other', name: 'B' }); // not canonical yet

  const canonical = cp.listCanonical();
  assert.strictEqual(canonical.length, 1);
  assert.strictEqual(canonical[0].name, 'A');
});

// --- buildContext ---

test('buildContext returns null when no canonical patterns exist', () => {
  const cp = freshModule();
  assert.strictEqual(cp.buildContext(), null);
});

test('buildContext returns grouped canonical patterns', () => {
  const cp = freshModule();
  cp.registerPattern({ name: 'camelCase', category: 'naming', purpose: 'vars', rule: 'Use camelCase' });
  cp.registerPattern({ name: 'barrel imports', category: 'imports', purpose: 'reexports', rule: 'Use index.ts' });

  const ctx = cp.buildContext();
  assert.ok(ctx);
  assert.strictEqual(ctx.total_canonical, 2);
  assert.ok(ctx.categories.naming);
  assert.ok(ctx.categories.imports);
  assert.strictEqual(ctx.categories.naming[0].name, 'camelCase');
});

// --- Edge cases ---

test('listAll returns empty array for fresh registry', () => {
  const cp = freshModule();
  assert.deepStrictEqual(cp.listAll(), []);
});

test('findByCategory returns empty for unknown category', () => {
  const cp = freshModule();
  assert.deepStrictEqual(cp.findByCategory('unknown'), []);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
