/**
 * Tests for Dead Code & Legacy Detector — Phase 8.9 (Pilot AGI-t7d1)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/dead-code-detector.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadcode-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/registry'), { recursive: true });
  fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModule() {
  const modPath = '../dead-code-detector';
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

console.log('\n=== Dead Code & Legacy Detector Tests ===\n');

// --- extractExports ---

test('extractExports finds function exports', () => {
  const dd = freshModule();
  const source = `
export function greet(name) { return 'hi ' + name; }
export async function fetch() {}
`;
  const exps = dd.extractExports(source);
  assert.strictEqual(exps.length, 2);
  assert.strictEqual(exps[0].name, 'greet');
  assert.strictEqual(exps[0].type, 'function');
  assert.strictEqual(exps[1].name, 'fetch');
});

test('extractExports finds const exports', () => {
  const dd = freshModule();
  const source = `export const API_URL = 'https://example.com';`;
  const exps = dd.extractExports(source);
  assert.strictEqual(exps.length, 1);
  assert.strictEqual(exps[0].name, 'API_URL');
  assert.strictEqual(exps[0].type, 'variable');
});

test('extractExports finds named exports', () => {
  const dd = freshModule();
  const source = `export { foo, bar }`;
  const exps = dd.extractExports(source);
  assert.strictEqual(exps.length, 2);
  assert.strictEqual(exps[0].name, 'foo');
  assert.strictEqual(exps[1].name, 'bar');
});

test('extractExports finds class exports', () => {
  const dd = freshModule();
  const source = `export class UserService {}`;
  const exps = dd.extractExports(source);
  assert.strictEqual(exps.length, 1);
  assert.strictEqual(exps[0].type, 'class');
});

test('extractExports skips re-exports with from', () => {
  const dd = freshModule();
  const source = `export { Button } from './Button';`;
  const exps = dd.extractExports(source);
  assert.strictEqual(exps.length, 0);
});

// --- findUnusedExports ---

test('findUnusedExports detects unused export', () => {
  const dd = freshModule();

  // Create source files
  fs.writeFileSync(path.join(testDir, 'src/utils.js'),
    'export function used() {}\nexport function unused() {}');
  fs.writeFileSync(path.join(testDir, 'src/main.js'),
    "import { used } from './utils';");

  const unused = dd.findUnusedExports('src/utils.js', testDir, {
    sourceFiles: ['src/utils.js', 'src/main.js']
  });
  assert.strictEqual(unused.length, 1);
  assert.strictEqual(unused[0].name, 'unused');
});

test('findUnusedExports returns empty for fully-used exports', () => {
  const dd = freshModule();

  fs.writeFileSync(path.join(testDir, 'src/utils.js'),
    'export function add() {}');
  fs.writeFileSync(path.join(testDir, 'src/main.js'),
    "import { add } from './utils';\nadd();");

  const unused = dd.findUnusedExports('src/utils.js', testDir, {
    sourceFiles: ['src/utils.js', 'src/main.js']
  });
  assert.strictEqual(unused.length, 0);
});

// --- detectBackwardCompat ---

test('detectBackwardCompat finds renamed unused vars', () => {
  const dd = freshModule();
  const source = `const _oldName = newName;`;
  const results = dd.detectBackwardCompat(source, 'test.js');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].type, 'renamed_unused');
});

test('detectBackwardCompat finds legacy comments', () => {
  const dd = freshModule();
  const source = `
// deprecated: use newFunction instead
// removed: old API handler
// backward compatibility shim
function old() {}
`;
  const results = dd.detectBackwardCompat(source, 'test.js');
  assert.strictEqual(results.length, 3);
  assert.ok(results.every(r => r.type === 'legacy_comment'));
});

test('detectBackwardCompat finds compat aliases', () => {
  const dd = freshModule();
  const source = `export { newFunc as oldFunc }`;
  const results = dd.detectBackwardCompat(source, 'test.js');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].type, 'compat_alias');
});

test('detectBackwardCompat returns empty for clean code', () => {
  const dd = freshModule();
  const source = `
export function greet(name) {
  return 'Hello ' + name;
}
`;
  const results = dd.detectBackwardCompat(source, 'test.js');
  assert.strictEqual(results.length, 0);
});

// --- findTodos ---

test('findTodos finds TODO comments', () => {
  const dd = freshModule();
  const source = `
// TODO: fix this later
// FIXME: broken
// HACK: workaround for bug
function test() {}
`;
  const results = dd.findTodos(source, 'test.js');
  assert.strictEqual(results.length, 3);
  assert.strictEqual(results[0].type, 'TODO');
  assert.strictEqual(results[1].type, 'FIXME');
  assert.strictEqual(results[2].type, 'HACK');
});

test('findTodos marks old TODOs as stale', () => {
  const dd = freshModule();
  const source = `// TODO: 2020-01-01 old task that should be done`;
  const results = dd.findTodos(source, 'test.js', { staleDays: 14 });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].stale, true);
});

test('findTodos marks recent TODOs as not stale', () => {
  const dd = freshModule();
  const today = new Date().toISOString().split('T')[0];
  const source = `// TODO: ${today} just added this`;
  const results = dd.findTodos(source, 'test.js', { staleDays: 14 });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].stale, false);
});

test('findTodos returns empty for clean code', () => {
  const dd = freshModule();
  const source = `function clean() { return true; }`;
  const results = dd.findTodos(source, 'test.js');
  assert.strictEqual(results.length, 0);
});

// --- scanFile ---

test('scanFile returns all detection results', () => {
  const dd = freshModule();
  const source = `
export function used() {}
export function unused() {}
const _old = used;
// TODO: clean this up
// deprecated: legacy
`;
  fs.writeFileSync(path.join(testDir, 'src/test.js'), source);
  fs.writeFileSync(path.join(testDir, 'src/main.js'), "import { used } from './test';");

  const result = dd.scanFile('src/test.js', testDir, {
    sourceFiles: ['src/test.js', 'src/main.js']
  });

  assert.ok(result.unused_exports);
  assert.ok(result.backward_compat);
  assert.ok(result.todos);
  assert.strictEqual(result.unused_exports.length, 1);
  assert.ok(result.backward_compat.length >= 2);
  assert.strictEqual(result.todos.length, 1);
});

test('scanFile returns error for missing file', () => {
  const dd = freshModule();
  const result = dd.scanFile('nonexistent.js', testDir);
  assert.strictEqual(result.error, 'file not found');
});

// --- calculatePenalty ---

test('calculatePenalty returns 0 for clean results', () => {
  const dd = freshModule();
  const penalty = dd.calculatePenalty({
    unused_exports: [],
    backward_compat: [],
    todos: [],
    deprecated_patterns: []
  });
  assert.strictEqual(penalty, 0);
});

test('calculatePenalty increases with more issues', () => {
  const dd = freshModule();
  const penalty = dd.calculatePenalty({
    unused_exports: [{ name: 'a' }, { name: 'b' }],
    backward_compat: [{ type: 'legacy_comment' }],
    todos: [{ stale: true }, { stale: false }],
    deprecated_patterns: []
  });
  assert.ok(penalty > 0);
  assert.ok(penalty <= 1);
});

test('calculatePenalty caps at 1', () => {
  const dd = freshModule();
  const penalty = dd.calculatePenalty({
    unused_exports: Array(20).fill({ name: 'x' }),
    backward_compat: Array(10).fill({ type: 'x' }),
    todos: Array(10).fill({ stale: true }),
    deprecated_patterns: Array(10).fill({ pattern: 'x' })
  });
  assert.strictEqual(penalty, 1);
});

// --- report management ---

test('saveReport and loadReport round-trip', () => {
  const dd = freshModule();
  const report = { files_scanned: 5, issues: 3, scanned_at: new Date().toISOString() };
  dd.saveReport(report);

  const loaded = dd.loadReport();
  assert.deepStrictEqual(loaded, report);
});

test('loadReport returns null when no report exists', () => {
  const dd = freshModule();
  assert.strictEqual(dd.loadReport(), null);
});

// --- discoverSourceFiles ---

test('discoverSourceFiles finds JS/TS files', () => {
  const dd = freshModule();
  fs.writeFileSync(path.join(testDir, 'src/a.js'), '');
  fs.writeFileSync(path.join(testDir, 'src/b.ts'), '');
  fs.writeFileSync(path.join(testDir, 'src/c.txt'), '');

  const files = dd.discoverSourceFiles(testDir);
  assert.ok(files.includes('src/a.js'));
  assert.ok(files.includes('src/b.ts'));
  assert.ok(!files.includes('src/c.txt'));
});

test('discoverSourceFiles skips node_modules', () => {
  const dd = freshModule();
  fs.mkdirSync(path.join(testDir, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(testDir, 'node_modules/pkg/index.js'), '');
  fs.writeFileSync(path.join(testDir, 'src/app.js'), '');

  const files = dd.discoverSourceFiles(testDir);
  assert.ok(!files.some(f => f.includes('node_modules')));
  assert.ok(files.includes('src/app.js'));
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
