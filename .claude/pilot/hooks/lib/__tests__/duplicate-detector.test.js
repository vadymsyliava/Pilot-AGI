/**
 * Tests for Duplicate Code Detection — Phase 8.8 (Pilot AGI-e8d7)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/duplicate-detector.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupdet-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/registry'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModule() {
  const modPath = '../duplicate-detector';
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

console.log('\n=== Duplicate Code Detection Tests ===\n');

// --- extractFunctions ---

test('extractFunctions finds function declarations', () => {
  const dd = freshModule();
  const source = `
function hello(name) {
  return 'Hello ' + name;
}

async function fetchUser(id) {
  const res = await fetch(id);
  return res.json();
}
`;
  const funcs = dd.extractFunctions(source, 'test.js');
  assert.strictEqual(funcs.length, 2);
  assert.strictEqual(funcs[0].name, 'hello');
  assert.strictEqual(funcs[0].params, 'name');
  assert.strictEqual(funcs[1].name, 'fetchUser');
});

test('extractFunctions finds arrow functions', () => {
  const dd = freshModule();
  const source = `
const add = (a, b) => {
  return a + b;
};

export const multiply = (x, y) => {
  return x * y;
};
`;
  const funcs = dd.extractFunctions(source, 'math.ts');
  assert.strictEqual(funcs.length, 2);
  assert.strictEqual(funcs[0].name, 'add');
  assert.strictEqual(funcs[0].params, 'a,b');
  assert.strictEqual(funcs[0].exported, false);
  assert.strictEqual(funcs[1].name, 'multiply');
  assert.strictEqual(funcs[1].exported, true);
});

test('extractFunctions finds exported functions', () => {
  const dd = freshModule();
  const source = `
export function saveUser(user) {
  db.save(user);
}
`;
  const funcs = dd.extractFunctions(source, 'api.ts');
  assert.strictEqual(funcs.length, 1);
  assert.strictEqual(funcs[0].exported, true);
});

test('extractFunctions skips non-JS files', () => {
  const dd = freshModule();
  const funcs = dd.extractFunctions('def hello(): pass', 'test.py');
  assert.strictEqual(funcs.length, 0);
});

test('extractFunctions finds class methods', () => {
  const dd = freshModule();
  const source = `
class UserService {
  getUser(id) {
    return this.db.find(id);
  }
  async deleteUser(id) {
    return this.db.delete(id);
  }
}
`;
  const funcs = dd.extractFunctions(source, 'service.ts');
  assert.strictEqual(funcs.length, 2);
  assert.strictEqual(funcs[0].name, 'getUser');
  assert.strictEqual(funcs[1].name, 'deleteUser');
});

// --- normalizeParams ---

test('normalizeParams strips types and defaults', () => {
  const dd = freshModule();
  assert.strictEqual(dd.normalizeParams('name: string, age: number'), 'name,age');
  assert.strictEqual(dd.normalizeParams('x = 5, y = 10'), 'x,y');
  assert.strictEqual(dd.normalizeParams(''), '');
});

// --- hashBody ---

test('hashBody produces same hash for identical bodies', () => {
  const dd = freshModule();
  const body1 = ['  return a + b;', '}'];
  const body2 = ['  return a + b;', '}'];
  assert.strictEqual(dd.hashBody(body1), dd.hashBody(body2));
});

test('hashBody produces different hash for different bodies', () => {
  const dd = freshModule();
  const body1 = ['  return a + b;', '}'];
  const body2 = ['  return a * b;', '}'];
  assert.notStrictEqual(dd.hashBody(body1), dd.hashBody(body2));
});

// --- paramSimilarity ---

test('paramSimilarity returns 1 for identical params', () => {
  const dd = freshModule();
  assert.strictEqual(dd.paramSimilarity('a,b,c', 'a,b,c'), 1);
});

test('paramSimilarity returns 0 for completely different params', () => {
  const dd = freshModule();
  assert.strictEqual(dd.paramSimilarity('a,b', 'x,y'), 0);
});

test('paramSimilarity returns partial for overlapping params', () => {
  const dd = freshModule();
  const sim = dd.paramSimilarity('a,b,c', 'a,b,d');
  assert.ok(sim > 0.5);
  assert.ok(sim < 1);
});

// --- indexFile + findDuplicateFunction ---

test('indexFile adds functions to the index', () => {
  const dd = freshModule();
  const source = `
function greet(name) {
  return 'Hello ' + name;
}

function farewell(name) {
  return 'Goodbye ' + name;
}
`;
  const result = dd.indexFile('src/utils.js', source);
  assert.strictEqual(result.added, 2);

  const stats = dd.getStats();
  assert.strictEqual(stats.total_functions, 2);
  assert.strictEqual(stats.total_files, 1);
});

test('indexFile replaces existing entries for same file', () => {
  const dd = freshModule();

  dd.indexFile('src/utils.js', 'function a() { return 1; }');
  assert.strictEqual(dd.getStats().total_functions, 1);

  dd.indexFile('src/utils.js', 'function b() { return 2; }\nfunction c() { return 3; }');
  assert.strictEqual(dd.getStats().total_functions, 2);

  const index = dd.loadIndex();
  assert.ok(index.every(e => e.name !== 'a'));
});

test('findDuplicateFunction detects exact body match', () => {
  const dd = freshModule();

  // Index a function
  dd.indexFile('src/utils.js', `
function add(a, b) {
  return a + b;
}
`);

  // Check a new function with same body
  const newFunc = dd.extractFunctions(`
function sum(a, b) {
  return a + b;
}
`, 'src/other.js')[0];

  const result = dd.findDuplicateFunction(newFunc);
  assert.strictEqual(result.duplicate, true);
  assert.strictEqual(result.matches[0].type, 'exact_body');
  assert.strictEqual(result.matches[0].file_path, 'src/utils.js');
});

test('findDuplicateFunction detects same name match', () => {
  const dd = freshModule();

  dd.indexFile('src/utils.js', `
function processData(input) {
  return input.map(x => x * 2);
}
`);

  const newFunc = {
    name: 'processData',
    params: 'input',
    body_hash: 'different'
  };

  const result = dd.findDuplicateFunction(newFunc);
  assert.strictEqual(result.duplicate, true);
  assert.strictEqual(result.matches[0].type, 'same_name');
});

test('findDuplicateFunction excludes same file', () => {
  const dd = freshModule();

  dd.indexFile('src/utils.js', `
function helper(x) {
  return x + 1;
}
`);

  const newFunc = { name: 'helper', params: 'x', body_hash: 'same' };
  const result = dd.findDuplicateFunction(newFunc, { excludeFile: 'src/utils.js' });
  assert.strictEqual(result.duplicate, false);
});

// --- detectReexports ---

test('detectReexports finds re-exports', () => {
  const dd = freshModule();
  const source = `
export { Button } from './Button';
export { Card, Badge } from './components';
`;
  const results = dd.detectReexports(source, 'index.ts');
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].type, 'reexport');
  assert.deepStrictEqual(results[0].names, ['Button']);
  assert.strictEqual(results[1].names.length, 2);
});

test('detectReexports finds wrapper functions', () => {
  const dd = freshModule();
  const source = `const fetchUser = (id) => getUser(id);`;
  const results = dd.detectReexports(source, 'api.ts');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].type, 'wrapper');
  assert.strictEqual(results[0].wrapper_name, 'fetchUser');
  assert.strictEqual(results[0].calls, 'getUser');
});

// --- checkForDuplicates ---

test('checkForDuplicates returns empty for unique code', () => {
  const dd = freshModule();
  const source = `
function uniqueFunction(x) {
  return x * 42;
}
`;
  const result = dd.checkForDuplicates(source, 'new.js');
  assert.strictEqual(result.duplicates.length, 0);
  assert.strictEqual(result.reexports.length, 0);
  assert.strictEqual(result.wrappers.length, 0);
});

test('checkForDuplicates finds duplicate against index', () => {
  const dd = freshModule();

  dd.indexFile('src/math.js', `
function multiply(a, b) {
  return a * b;
}
`);

  const source = `
function multiply(a, b) {
  return a * b;
}
`;
  const result = dd.checkForDuplicates(source, 'src/other.js');
  assert.strictEqual(result.duplicates.length, 1);
  assert.strictEqual(result.duplicates[0].function_name, 'multiply');
});

test('checkForDuplicates returns null results for empty input', () => {
  const dd = freshModule();
  const result = dd.checkForDuplicates(null, null);
  assert.deepStrictEqual(result, { duplicates: [], reexports: [], wrappers: [] });
});

// --- removeFile ---

test('removeFile removes entries from index', () => {
  const dd = freshModule();
  dd.indexFile('a.js', 'function foo() { return 1; }');
  dd.indexFile('b.js', 'function bar() { return 2; }');
  assert.strictEqual(dd.getStats().total_functions, 2);

  const r = dd.removeFile('a.js');
  assert.strictEqual(r.removed, 1);
  assert.strictEqual(dd.getStats().total_functions, 1);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
