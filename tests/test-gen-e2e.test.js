#!/usr/bin/env node

/**
 * E2E tests for Autonomous Test Generation (Phase 5.3 — Pilot AGI-wra.6)
 *
 * Full pipeline: mock code change → analyze → detect framework → generate test → validate
 * Run: node tests/test-gen-e2e.test.js
 */

const path = require('path');
const fs = require('fs');
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

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'Not equal') + ': expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual));
  }
}

function assertIncludes(str, substr, msg) {
  if (!str || !str.includes(substr)) {
    throw new Error((msg || 'Not found') + ': ' + JSON.stringify(substr) + ' not in output');
  }
}

// =============================================================================
// Load modules
// =============================================================================

const LIB_DIR = path.join(__dirname, '..', '.claude', 'pilot', 'hooks', 'lib');

const changeAnalyzer = require(path.join(LIB_DIR, 'change-analyzer.js'));
const frameworkDetector = require(path.join(LIB_DIR, 'framework-detector.js'));
const testGenerator = require(path.join(LIB_DIR, 'test-generator.js'));
const coverageGate = require(path.join(LIB_DIR, 'coverage-gate.js'));

function freshIntegration() {
  const modPath = path.join(LIB_DIR, 'test-gen-integration.js');
  delete require.cache[modPath];
  return require(modPath);
}

// =============================================================================
// TEMP DIR SETUP
// =============================================================================

const TMP_BASE = path.join(os.tmpdir(), 'pilot-e2e-testgen-' + Date.now());
fs.mkdirSync(TMP_BASE, { recursive: true });

function createProject(name, opts = {}) {
  const dir = path.join(TMP_BASE, name);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.vitest) {
    fs.writeFileSync(path.join(dir, 'vitest.config.ts'), 'export default {}');
  }
  if (opts.jest) {
    fs.writeFileSync(path.join(dir, 'jest.config.js'), 'module.exports = {}');
  }
  if (opts.packageJson) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(opts.packageJson, null, 2));
  }
  if (opts.testDir) {
    fs.mkdirSync(path.join(dir, opts.testDir), { recursive: true });
  }
  return dir;
}

// =============================================================================
// SAMPLE DIFFS (shared with change-analyzer tests)
// =============================================================================

const NEW_FUNCTION_DIFF = `diff --git a/src/utils.js b/src/utils.js
index abc1234..def5678 100644
--- a/src/utils.js
+++ b/src/utils.js
@@ -10,3 +10,10 @@ function existingFunc() {
   return true;
 }

+function newHelper(x) {
+  if (x < 0) return 0;
+  return x * 2;
+}
+
+const arrowFunc = (a, b) => a + b;
+
`;

const BUG_FIX_DIFF = `diff --git a/src/auth.js b/src/auth.js
index abc1234..def5678 100644
--- a/src/auth.js
+++ b/src/auth.js
@@ -15,6 +15,8 @@ function validateToken(token) {
   if (!token) return false;
+  // Fix: check token expiry before validation
+  if (token.expiresAt < Date.now()) return false;
   const decoded = jwt.verify(token);
-  return decoded;
+  return decoded !== null;
 }
`;

const REFACTOR_DIFF = `diff --git a/src/service.js b/src/service.js
index abc1234..def5678 100644
--- a/src/service.js
+++ b/src/service.js
@@ -5,12 +5,12 @@ const db = require('./db');

-function getUserById(id) {
-  const user = db.query('SELECT * FROM users WHERE id = ?', [id]);
-  if (!user) throw new Error('not found');
-  return { ...user, fullName: user.first + ' ' + user.last };
+function findUser(id) {
+  const user = db.findOne('users', { id });
+  if (!user) throw new UserNotFoundError(id);
+  return formatUser(user);
 }

-function getUserByEmail(email) {
-  const user = db.query('SELECT * FROM users WHERE email = ?', [email]);
-  if (!user) throw new Error('not found');
-  return { ...user, fullName: user.first + ' ' + user.last };
+function findUserByEmail(email) {
+  const user = db.findOne('users', { email });
+  if (!user) throw new UserNotFoundError(email);
+  return formatUser(user);
 }
`;

const CONFIG_ONLY_DIFF = `diff --git a/tsconfig.json b/tsconfig.json
index abc1234..def5678 100644
--- a/tsconfig.json
+++ b/tsconfig.json
@@ -3,6 +3,7 @@
     "target": "ES2020",
     "module": "commonjs",
+    "strict": true,
     "outDir": "./dist"
   }
 }
`;

const MULTI_FILE_DIFF = NEW_FUNCTION_DIFF + BUG_FIX_DIFF + CONFIG_ONLY_DIFF;

const PYTHON_NEW_FUNC_DIFF = `diff --git a/app/models.py b/app/models.py
index abc1234..def5678 100644
--- a/app/models.py
+++ b/app/models.py
@@ -10,3 +10,8 @@ class User:
     name: str

+def validate_email(email: str) -> bool:
+    return "@" in email
+
+def normalize_name(name: str) -> str:
+    return name.strip().title()
`;

// Mock claude response for generated tests
const MOCK_VITEST_RESPONSE = `import { describe, it, expect } from 'vitest';
import { newHelper, arrowFunc } from '../src/utils.js';

describe('newHelper', () => {
  it('returns 0 for negative input', () => {
    expect(newHelper(-1)).toBe(0);
  });

  it('doubles positive input', () => {
    expect(newHelper(5)).toBe(10);
  });

  it('handles zero', () => {
    expect(newHelper(0)).toBe(0);
  });
});

describe('arrowFunc', () => {
  it('adds two numbers', () => {
    expect(arrowFunc(2, 3)).toBe(5);
  });
});
`;

const MOCK_REGRESSION_RESPONSE = `import { describe, it, expect } from 'vitest';
import { validateToken } from '../src/auth.js';

describe('validateToken - bug fix regression', () => {
  it('rejects expired tokens', () => {
    const expired = { expiresAt: Date.now() - 1000 };
    expect(validateToken(expired)).toBe(false);
  });

  it('rejects null token', () => {
    expect(validateToken(null)).toBe(false);
  });
});
`;

const MOCK_BEHAVIOR_RESPONSE = `import { describe, it, expect } from 'vitest';
import { findUser, findUserByEmail } from '../src/service.js';

describe('findUser', () => {
  it('returns formatted user for valid id', () => {
    const user = findUser(1);
    expect(user).toBeDefined();
  });
});
`;

// =============================================================================
// E2E TEST 1: Full pipeline with new function
// =============================================================================

console.log('\n=== E2E: New function → unit test ===');

test('parses diff, classifies as new_function, selects unit strategy', () => {
  const files = changeAnalyzer.parseDiff(NEW_FUNCTION_DIFF);
  const classifications = changeAnalyzer.classifyChanges(files);
  assertEqual(classifications[0].changeType, 'new_function', 'change type');

  const strategy = testGenerator.selectStrategy(classifications[0].changeType);
  assertEqual(strategy, 'unit', 'strategy');
});

test('extracts function names from diff', () => {
  const files = changeAnalyzer.parseDiff(NEW_FUNCTION_DIFF);
  const functions = changeAnalyzer.extractChangedFunctions(files);
  const names = functions.map(f => f.functionName);
  assert(names.includes('newHelper'), 'has newHelper');
  assert(names.includes('arrowFunc'), 'has arrowFunc');
});

test('builds prompt and generates test via mocked claude', () => {
  const files = changeAnalyzer.parseDiff(NEW_FUNCTION_DIFF);
  const classifications = changeAnalyzer.classifyChanges(files);
  const functions = changeAnalyzer.extractChangedFunctions(files);
  const framework = { name: 'vitest', testPattern: '**/*.test.js', testDir: 'tests', detected: true };

  const results = testGenerator.generateTests({
    classifications,
    functions,
    framework,
    execFn: () => MOCK_VITEST_RESPONSE
  });

  assertEqual(results.length, 1, 'one result');
  assert(results[0].success, 'success');
  assertIncludes(results[0].code, 'newHelper', 'test references function');
  assertIncludes(results[0].testPath, 'utils.test.js', 'correct test path');
});

// =============================================================================
// E2E TEST 2: Bug fix → regression test
// =============================================================================

console.log('\n=== E2E: Bug fix → regression test ===');

test('classifies bug fix diff correctly', () => {
  const files = changeAnalyzer.parseDiff(BUG_FIX_DIFF);
  const classifications = changeAnalyzer.classifyChanges(files);
  assertEqual(classifications[0].changeType, 'bug_fix', 'change type');
  assertEqual(testGenerator.selectStrategy('bug_fix'), 'regression', 'strategy');
});

test('generates regression test with mocked claude', () => {
  const files = changeAnalyzer.parseDiff(BUG_FIX_DIFF);
  const classifications = changeAnalyzer.classifyChanges(files);
  const framework = { name: 'vitest', testPattern: '**/*.test.js', testDir: 'tests', detected: true };

  const results = testGenerator.generateTests({
    classifications,
    functions: [],
    framework,
    execFn: () => MOCK_REGRESSION_RESPONSE
  });

  assertEqual(results.length, 1, 'one result');
  assert(results[0].success, 'success');
  assertEqual(results[0].strategy, 'regression', 'strategy');
  assertIncludes(results[0].testPath, 'auth.test.js', 'test path');
});

// =============================================================================
// E2E TEST 3: Refactor → behavior test
// =============================================================================

console.log('\n=== E2E: Refactor → behavior test ===');

test('classifies refactor and generates behavior test', () => {
  const files = changeAnalyzer.parseDiff(REFACTOR_DIFF);
  const classifications = changeAnalyzer.classifyChanges(files);
  assertEqual(classifications[0].changeType, 'refactor', 'change type');

  const results = testGenerator.generateTests({
    classifications,
    functions: [],
    framework: { name: 'vitest', testDir: 'tests', detected: true },
    execFn: () => MOCK_BEHAVIOR_RESPONSE
  });

  assertEqual(results[0].strategy, 'behavior', 'strategy');
  assert(results[0].success, 'success');
});

// =============================================================================
// E2E TEST 4: Config-only change → skip
// =============================================================================

console.log('\n=== E2E: Config-only → skip ===');

test('config-only changes produce no test generation', () => {
  const files = changeAnalyzer.parseDiff(CONFIG_ONLY_DIFF);
  const classifications = changeAnalyzer.classifyChanges(files);
  assertEqual(classifications[0].changeType, 'config_change', 'change type');

  const testable = testGenerator.filterTestableChanges(classifications);
  assertEqual(testable.length, 0, 'no testable changes');
});

// =============================================================================
// E2E TEST 5: Multi-file diff with mixed change types
// =============================================================================

console.log('\n=== E2E: Multi-file mixed changes ===');

test('handles multi-file diff with selective generation', () => {
  const files = changeAnalyzer.parseDiff(MULTI_FILE_DIFF);
  const classifications = changeAnalyzer.classifyChanges(files);
  assertEqual(classifications.length, 3, 'three files');

  const testable = testGenerator.filterTestableChanges(classifications);
  // new_function + bug_fix, but not config_change
  assertEqual(testable.length, 2, 'two testable');
  assertEqual(testable[0].strategy, 'unit', 'first strategy');
  assertEqual(testable[1].strategy, 'regression', 'second strategy');
});

// =============================================================================
// E2E TEST 6: Framework detection + path generation
// =============================================================================

console.log('\n=== E2E: Framework detection → test path ===');

test('vitest project generates correct test paths', () => {
  const dir = createProject('vitest-e2e', { vitest: true, testDir: 'tests' });
  const framework = frameworkDetector.detectFramework(dir);
  assertEqual(framework.name, 'vitest', 'framework');

  const testPath = testGenerator.generateTestPath('src/utils.js', framework);
  assertEqual(testPath, path.join('tests', 'utils.test.js'), 'path');
});

test('jest project generates __tests__ paths', () => {
  const dir = createProject('jest-e2e', { jest: true });
  fs.mkdirSync(path.join(dir, '__tests__'), { recursive: true });
  const framework = frameworkDetector.detectFramework(dir);
  assertEqual(framework.name, 'jest', 'framework');

  const testPath = testGenerator.generateTestPath('src/api.ts', framework);
  assertEqual(testPath, path.join('__tests__', 'api.test.ts'), 'path');
});

// =============================================================================
// E2E TEST 7: Coverage gate with test results
// =============================================================================

console.log('\n=== E2E: Coverage gate ===');

test('gate passes when tests succeed', () => {
  const result = coverageGate.gate({
    testCommand: 'npx vitest run',
    testPath: 'tests/utils.test.js',
    frameworkName: 'vitest',
    execFn: () => 'all tests passed'
  });
  assertEqual(result.status, 'pass', 'status');
  assert(result.passed, 'passed');
});

test('gate fails when tests fail', () => {
  const result = coverageGate.gate({
    testCommand: 'npx vitest run',
    testPath: 'tests/utils.test.js',
    frameworkName: 'vitest',
    execFn: () => {
      const err = new Error('test fail');
      err.status = 1;
      err.stdout = 'FAIL';
      err.stderr = '';
      throw err;
    }
  });
  assertEqual(result.status, 'fail', 'status');
  assert(!result.passed, 'not passed');
});

// =============================================================================
// E2E TEST 8: Full integration pipeline
// =============================================================================

console.log('\n=== E2E: Full integration pipeline ===');

test('integration pipeline runs end-to-end with mocks', () => {
  const integration = freshIntegration();
  integration._setDeps({
    changeAnalyzer: {
      analyzeFromGit: () => {
        const files = changeAnalyzer.parseDiff(NEW_FUNCTION_DIFF);
        return {
          files,
          classifications: changeAnalyzer.classifyChanges(files),
          functions: changeAnalyzer.extractChangedFunctions(files),
          ranges: changeAnalyzer.extractChangedRanges(files)
        };
      }
    },
    frameworkDetector: {
      detectFramework: () => ({
        name: 'vitest', testCommand: 'npx vitest run', testDir: 'tests',
        testPattern: '**/*.test.js', language: 'js', detected: true
      })
    },
    testGenerator: {
      generateTests: (opts) => {
        // Verify the pipeline passes correct data through
        assert(opts.classifications.length > 0, 'has classifications');
        assert(opts.framework.detected, 'has framework');
        return [{
          filePath: 'src/utils.js',
          testPath: 'tests/utils.test.js',
          strategy: 'unit',
          success: true,
          code: MOCK_VITEST_RESPONSE,
          issues: []
        }];
      }
    },
    coverageGate: {
      gate: () => ({ status: 'pass', passed: true, summary: 'OK' })
    }
  });

  const result = integration.runPipeline({
    policy: { test_generation: { enabled: true } },
    readFileFn: () => 'mock source code'
  });

  assert(!result.skipped, 'not skipped');
  assertEqual(result.framework, 'vitest', 'framework');
  assertEqual(result.generated, 1, 'one generated');
  assert(result.results[0].success, 'success');
  assertIncludes(result.summary, 'Generated 1/1', 'summary');
  integration._resetDeps();
});

// =============================================================================
// E2E TEST 9: Python project pipeline
// =============================================================================

console.log('\n=== E2E: Python project pipeline ===');

test('detects python functions and generates correct test path', () => {
  const files = changeAnalyzer.parseDiff(PYTHON_NEW_FUNC_DIFF);
  const classifications = changeAnalyzer.classifyChanges(files);
  const functions = changeAnalyzer.extractChangedFunctions(files);

  assert(functions.some(f => f.functionName === 'validate_email'), 'has validate_email');
  assert(functions.some(f => f.functionName === 'normalize_name'), 'has normalize_name');
  assertEqual(functions[0].language, 'py', 'language');

  const testPath = testGenerator.generateTestPath('app/models.py', { testDir: 'tests' });
  assertEqual(testPath, path.join('tests', 'test_models.py'), 'python test path');
});

// =============================================================================
// E2E TEST 10: Output validation
// =============================================================================

console.log('\n=== E2E: Output validation ===');

test('parseTestOutput validates generated test code', () => {
  const good = testGenerator.parseTestOutput(MOCK_VITEST_RESPONSE, 'vitest');
  assert(good.valid, 'valid output');
  assertEqual(good.issues.length, 0, 'no issues');

  const bad = testGenerator.parseTestOutput('not a test file', 'vitest');
  assert(!bad.valid, 'invalid output');
  assert(bad.issues.length > 0, 'has issues');
});

test('parseTestOutput handles fenced responses from claude', () => {
  const fenced = '```javascript\n' + MOCK_VITEST_RESPONSE + '```';
  const result = testGenerator.parseTestOutput(fenced, 'vitest');
  assert(result.valid, 'valid after stripping fences');
  assert(!result.code.includes('```'), 'no fences in code');
});

// =============================================================================
// E2E TEST 11: Strategy map completeness
// =============================================================================

console.log('\n=== E2E: Strategy completeness ===');

test('all CHANGE_TYPES have a strategy mapping (even if null)', () => {
  const allTypes = Object.values(changeAnalyzer.CHANGE_TYPES);
  for (const type of allTypes) {
    const strategy = testGenerator.selectStrategy(type);
    // Strategy can be null (skip) or a valid strategy
    assert(strategy === null || ['unit', 'regression', 'behavior'].includes(strategy),
      'valid strategy for ' + type + ': ' + strategy);
  }
});

test('testable change types map to expected strategies', () => {
  assertEqual(testGenerator.selectStrategy('new_function'), 'unit', 'new_function');
  assertEqual(testGenerator.selectStrategy('new_file'), 'unit', 'new_file');
  assertEqual(testGenerator.selectStrategy('bug_fix'), 'regression', 'bug_fix');
  assertEqual(testGenerator.selectStrategy('refactor'), 'behavior', 'refactor');
  assertEqual(testGenerator.selectStrategy('config_change'), null, 'config_change');
  assertEqual(testGenerator.selectStrategy('deleted_file'), null, 'deleted_file');
  assertEqual(testGenerator.selectStrategy('test_change'), null, 'test_change');
  assertEqual(testGenerator.selectStrategy('docs_change'), null, 'docs_change');
});

// =============================================================================
// CLEANUP
// =============================================================================

try {
  fs.rmSync(TMP_BASE, { recursive: true, force: true });
} catch {
  // best effort
}

// =============================================================================
// SUMMARY
// =============================================================================

console.log('\n========================================');
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
console.log('========================================\n');

process.exit(failed > 0 ? 1 : 0);
