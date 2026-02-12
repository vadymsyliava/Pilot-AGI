#!/usr/bin/env node

/**
 * Verification tests for Change Analyzer (Phase 5.3 — Pilot AGI-wra.1)
 * Run: node tests/change-analyzer.test.js
 */

const path = require('path');

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

// =============================================================================
// Load module
// =============================================================================

const {
  CHANGE_TYPES,
  parseDiff,
  classifyFile,
  classifyChanges,
  detectLanguage,
  extractChangedFunctions,
  extractChangedRanges,
  analyzeFromGit
} = require(path.join(__dirname, '..', '.claude', 'pilot', 'hooks', 'lib', 'change-analyzer.js'));

// =============================================================================
// SAMPLE DIFFS
// =============================================================================

const SIMPLE_ADD_DIFF = `diff --git a/src/utils.js b/src/utils.js
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

const CONFIG_DIFF = `diff --git a/tsconfig.json b/tsconfig.json
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

const NEW_FILE_DIFF = `diff --git a/src/logger.js b/src/logger.js
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/logger.js
@@ -0,0 +1,15 @@
+const fs = require('fs');
+
+function createLogger(name) {
+  return {
+    info: (msg) => console.log('[' + name + '] ' + msg),
+    error: (msg) => console.error('[' + name + '] ' + msg),
+  };
+}
+
+function logToFile(path, msg) {
+  fs.appendFileSync(path, msg + '\\n');
+}
+
+module.exports = { createLogger, logToFile };
+
`;

const DELETED_FILE_DIFF = `diff --git a/src/legacy.js b/src/legacy.js
deleted file mode 100644
index abc1234..0000000
--- a/src/legacy.js
+++ /dev/null
@@ -1,10 +0,0 @@
-const old = require('./old');
-
-function deprecatedFunc() {
-  return old.doStuff();
-}
-
-module.exports = { deprecatedFunc };
`;

const MULTI_FILE_DIFF = SIMPLE_ADD_DIFF + CONFIG_DIFF + NEW_FILE_DIFF;

const PYTHON_DIFF = `diff --git a/app/models.py b/app/models.py
index abc1234..def5678 100644
--- a/app/models.py
+++ b/app/models.py
@@ -10,3 +10,12 @@ class User:
     name: str

+async def fetch_user(user_id: int) -> User:
+    return await db.get(User, user_id)
+
+class AdminUser(User):
+    role: str = "admin"
+
+def validate_email(email: str) -> bool:
+    return "@" in email
+
`;

const GO_DIFF = `diff --git a/handlers/user.go b/handlers/user.go
index abc1234..def5678 100644
--- a/handlers/user.go
+++ b/handlers/user.go
@@ -10,3 +10,10 @@ func GetUser(w http.ResponseWriter, r *http.Request) {
 }

+func (s *Server) CreateUser(w http.ResponseWriter, r *http.Request) {
+    var user User
+    json.NewDecoder(r.Body).Decode(&user)
+    s.db.Create(&user)
+    json.NewEncoder(w).Encode(user)
+}
+
`;

const RUST_DIFF = `diff --git a/src/lib.rs b/src/lib.rs
index abc1234..def5678 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -5,3 +5,8 @@ pub struct Config {
 }

+pub async fn load_config(path: &str) -> Config {
+    let data = std::fs::read_to_string(path).unwrap();
+    serde_json::from_str(&data).unwrap()
+}
+
`;

const BINARY_DIFF = `diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000..abc1234
Binary files /dev/null and b/assets/logo.png differ
`;

const RENAME_DIFF = `diff --git a/src/old-name.js b/src/new-name.js
similarity index 95%
rename from src/old-name.js
rename to src/new-name.js
index abc1234..def5678 100644
--- a/src/old-name.js
+++ b/src/new-name.js
@@ -1,3 +1,3 @@
-module.exports.oldExport = function() {};
+module.exports.newExport = function() {};
`;

const TEST_FILE_DIFF = `diff --git a/tests/auth.test.js b/tests/auth.test.js
index abc1234..def5678 100644
--- a/tests/auth.test.js
+++ b/tests/auth.test.js
@@ -5,3 +5,8 @@ test('existing test', () => {
 });

+test('new regression test for token expiry', () => {
+  const expired = { expiresAt: Date.now() - 1000 };
+  assert(!validateToken(expired));
+});
+
`;

const DOCS_DIFF = `diff --git a/README.md b/README.md
index abc1234..def5678 100644
--- a/README.md
+++ b/README.md
@@ -10,3 +10,5 @@ ## Installation
 npm install my-package

+## Configuration
+See config.md for details.
+
`;

const TS_ARROW_DIFF = `diff --git a/src/api.ts b/src/api.ts
index abc1234..def5678 100644
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,3 +1,10 @@
 import { User } from './types';

+export const fetchUsers = async (limit: number): Promise<User[]> => {
+  const res = await fetch('/api/users?limit=' + limit);
+  return res.json();
+};
+
+export const deleteUser = (id: string) => fetch('/api/users/' + id, { method: 'DELETE' });
+
`;

// =============================================================================
// TESTS: parseDiff
// =============================================================================

console.log('\n=== parseDiff ===');

test('parses empty/null input', () => {
  assertEqual(parseDiff('').length, 0, 'empty string');
  assertEqual(parseDiff(null).length, 0, 'null');
  assertEqual(parseDiff(undefined).length, 0, 'undefined');
});

test('parses single file diff with added lines', () => {
  const result = parseDiff(SIMPLE_ADD_DIFF);
  assertEqual(result.length, 1, 'file count');
  assertEqual(result[0].newPath, 'src/utils.js', 'file path');
  assert(result[0].addedLines.length > 0, 'has added lines');
  assertEqual(result[0].removedLines.length, 0, 'no removed lines');
  assertEqual(result[0].isNew, false, 'not new file');
});

test('parses hunk headers correctly', () => {
  const result = parseDiff(SIMPLE_ADD_DIFF);
  assertEqual(result[0].hunks.length, 1, 'hunk count');
  assertEqual(result[0].hunks[0].oldStart, 10, 'old start');
  assertEqual(result[0].hunks[0].newStart, 10, 'new start');
  assert(result[0].hunks[0].context !== undefined, 'hunk context exists');
});

test('parses multi-file diff', () => {
  const result = parseDiff(MULTI_FILE_DIFF);
  assertEqual(result.length, 3, 'file count');
  assertEqual(result[0].newPath, 'src/utils.js', 'first file');
  assertEqual(result[1].newPath, 'tsconfig.json', 'second file');
  assertEqual(result[2].newPath, 'src/logger.js', 'third file');
});

test('detects new file', () => {
  const result = parseDiff(NEW_FILE_DIFF);
  assertEqual(result.length, 1, 'file count');
  assert(result[0].isNew, 'is new file');
  assertEqual(result[0].newPath, 'src/logger.js', 'file path');
});

test('detects deleted file', () => {
  const result = parseDiff(DELETED_FILE_DIFF);
  assertEqual(result.length, 1, 'file count');
  assert(result[0].isDeleted, 'is deleted');
});

test('detects binary file', () => {
  const result = parseDiff(BINARY_DIFF);
  assertEqual(result.length, 1, 'file count');
  assert(result[0].isBinary, 'is binary');
});

test('detects renamed file', () => {
  const result = parseDiff(RENAME_DIFF);
  assertEqual(result.length, 1, 'file count');
  assert(result[0].isRenamed, 'is renamed');
});

test('separates added and removed lines', () => {
  const result = parseDiff(BUG_FIX_DIFF);
  assert(result[0].addedLines.length > 0, 'has added');
  assert(result[0].removedLines.length > 0, 'has removed');
});

// =============================================================================
// TESTS: classifyChanges
// =============================================================================

console.log('\n=== classifyChanges ===');

test('classifies new function addition', () => {
  const parsed = parseDiff(SIMPLE_ADD_DIFF);
  const classified = classifyChanges(parsed);
  assertEqual(classified[0].changeType, CHANGE_TYPES.NEW_FUNCTION, 'type');
});

test('classifies bug fix from diff content', () => {
  const parsed = parseDiff(BUG_FIX_DIFF);
  const classified = classifyChanges(parsed);
  assertEqual(classified[0].changeType, CHANGE_TYPES.BUG_FIX, 'type');
});

test('classifies bug fix from commit message', () => {
  const parsed = parseDiff(REFACTOR_DIFF);
  const classified = classifyChanges(parsed, 'fix: resolve null pointer in user lookup');
  assertEqual(classified[0].changeType, CHANGE_TYPES.BUG_FIX, 'type');
});

test('classifies refactor', () => {
  const parsed = parseDiff(REFACTOR_DIFF);
  const classified = classifyChanges(parsed);
  assertEqual(classified[0].changeType, CHANGE_TYPES.REFACTOR, 'type');
});

test('classifies config change', () => {
  const parsed = parseDiff(CONFIG_DIFF);
  const classified = classifyChanges(parsed);
  assertEqual(classified[0].changeType, CHANGE_TYPES.CONFIG_CHANGE, 'type');
});

test('classifies new file', () => {
  const parsed = parseDiff(NEW_FILE_DIFF);
  const classified = classifyChanges(parsed);
  assertEqual(classified[0].changeType, CHANGE_TYPES.NEW_FILE, 'type');
  assert(classified[0].isNew, 'isNew flag');
});

test('classifies deleted file', () => {
  const parsed = parseDiff(DELETED_FILE_DIFF);
  const classified = classifyChanges(parsed);
  assertEqual(classified[0].changeType, CHANGE_TYPES.DELETED_FILE, 'type');
  assert(classified[0].isDeleted, 'isDeleted flag');
});

test('classifies test file change', () => {
  const parsed = parseDiff(TEST_FILE_DIFF);
  const classified = classifyChanges(parsed);
  assertEqual(classified[0].changeType, CHANGE_TYPES.TEST_CHANGE, 'type');
});

test('classifies docs change', () => {
  const parsed = parseDiff(DOCS_DIFF);
  const classified = classifyChanges(parsed);
  assertEqual(classified[0].changeType, CHANGE_TYPES.DOCS_CHANGE, 'type');
});

test('classifies multi-file diff', () => {
  const parsed = parseDiff(MULTI_FILE_DIFF);
  const classified = classifyChanges(parsed);
  assertEqual(classified.length, 3, 'count');
  assertEqual(classified[0].changeType, CHANGE_TYPES.NEW_FUNCTION, 'first file type');
  assertEqual(classified[1].changeType, CHANGE_TYPES.CONFIG_CHANGE, 'second file type');
  assertEqual(classified[2].changeType, CHANGE_TYPES.NEW_FILE, 'third file type');
});

test('includes added/removed counts', () => {
  const parsed = parseDiff(REFACTOR_DIFF);
  const classified = classifyChanges(parsed);
  assert(classified[0].addedCount > 0, 'has added count');
  assert(classified[0].removedCount > 0, 'has removed count');
});

// =============================================================================
// TESTS: extractChangedFunctions
// =============================================================================

console.log('\n=== extractChangedFunctions ===');

test('extracts JS function declarations', () => {
  const parsed = parseDiff(SIMPLE_ADD_DIFF);
  const funcs = extractChangedFunctions(parsed);
  const names = funcs.map(f => f.functionName);
  assert(names.includes('newHelper'), 'has newHelper');
  assert(names.includes('arrowFunc'), 'has arrowFunc');
});

test('extracts JS functions from new file', () => {
  const parsed = parseDiff(NEW_FILE_DIFF);
  const funcs = extractChangedFunctions(parsed);
  const names = funcs.map(f => f.functionName);
  assert(names.includes('createLogger'), 'has createLogger');
  assert(names.includes('logToFile'), 'has logToFile');
});

test('extracts Python functions and classes', () => {
  const parsed = parseDiff(PYTHON_DIFF);
  const funcs = extractChangedFunctions(parsed);
  const names = funcs.map(f => f.functionName);
  assert(names.includes('fetch_user'), 'has fetch_user');
  assert(names.includes('AdminUser'), 'has AdminUser class');
  assert(names.includes('validate_email'), 'has validate_email');
  assertEqual(funcs[0].language, 'py', 'language is py');
});

test('extracts Go functions', () => {
  const parsed = parseDiff(GO_DIFF);
  const funcs = extractChangedFunctions(parsed);
  const names = funcs.map(f => f.functionName);
  assert(names.includes('CreateUser'), 'has CreateUser');
  assertEqual(funcs[0].language, 'go', 'language is go');
});

test('extracts Rust functions', () => {
  const parsed = parseDiff(RUST_DIFF);
  const funcs = extractChangedFunctions(parsed);
  const names = funcs.map(f => f.functionName);
  assert(names.includes('load_config'), 'has load_config');
  assertEqual(funcs[0].language, 'rust', 'language is rust');
});

test('extracts TS arrow functions', () => {
  const parsed = parseDiff(TS_ARROW_DIFF);
  const funcs = extractChangedFunctions(parsed);
  const names = funcs.map(f => f.functionName);
  assert(names.includes('fetchUsers'), 'has fetchUsers');
  assert(names.includes('deleteUser'), 'has deleteUser');
  assertEqual(funcs[0].language, 'ts', 'language is ts');
});

test('skips binary files', () => {
  const parsed = parseDiff(BINARY_DIFF);
  const funcs = extractChangedFunctions(parsed);
  assertEqual(funcs.length, 0, 'no functions from binary');
});

test('deduplicates function names per file', () => {
  const dupDiff = `diff --git a/src/utils.js b/src/utils.js
index abc1234..def5678 100644
--- a/src/utils.js
+++ b/src/utils.js
@@ -1,3 +1,6 @@
+function myFunc() {
+  return 1;
+}
@@ -20,3 +23,6 @@
+function myFunc() {
+  return 2;
+}
`;
  const parsed = parseDiff(dupDiff);
  const funcs = extractChangedFunctions(parsed);
  const myFuncCount = funcs.filter(f => f.functionName === 'myFunc').length;
  assertEqual(myFuncCount, 1, 'deduplicated');
});

test('includes line numbers', () => {
  const parsed = parseDiff(SIMPLE_ADD_DIFF);
  const funcs = extractChangedFunctions(parsed);
  assert(funcs.length > 0, 'has functions');
  assert(typeof funcs[0].lineNumber === 'number', 'has line number');
  assert(funcs[0].lineNumber > 0, 'line number > 0');
});

test('filters out keywords like if/for/while', () => {
  const keywordDiff = `diff --git a/src/code.js b/src/code.js
index abc1234..def5678 100644
--- a/src/code.js
+++ b/src/code.js
@@ -1,3 +1,8 @@
+if (condition) {
+  doSomething();
+}
+for (const item of list) {
+  process(item);
+}
`;
  const parsed = parseDiff(keywordDiff);
  const funcs = extractChangedFunctions(parsed);
  const names = funcs.map(f => f.functionName);
  assert(!names.includes('if'), 'no "if"');
  assert(!names.includes('for'), 'no "for"');
});

// =============================================================================
// TESTS: extractChangedRanges
// =============================================================================

console.log('\n=== extractChangedRanges ===');

test('extracts line ranges from single-hunk diff', () => {
  const parsed = parseDiff(SIMPLE_ADD_DIFF);
  const ranges = extractChangedRanges(parsed);
  assertEqual(ranges.length, 1, 'file count');
  assertEqual(ranges[0].filePath, 'src/utils.js', 'file path');
  assert(ranges[0].ranges.length >= 1, 'has range');
  assert(ranges[0].ranges[0].start > 0, 'start > 0');
  assert(ranges[0].ranges[0].end >= ranges[0].ranges[0].start, 'end >= start');
});

test('extracts ranges from multi-file diff', () => {
  const parsed = parseDiff(MULTI_FILE_DIFF);
  const ranges = extractChangedRanges(parsed);
  assertEqual(ranges.length, 3, 'three files');
});

// =============================================================================
// TESTS: detectLanguage
// =============================================================================

console.log('\n=== detectLanguage ===');

test('detects JS/TS/Python/Go/Rust', () => {
  assertEqual(detectLanguage('src/app.js'), 'js', 'js');
  assertEqual(detectLanguage('src/app.jsx'), 'js', 'jsx');
  assertEqual(detectLanguage('src/app.mjs'), 'js', 'mjs');
  assertEqual(detectLanguage('src/app.ts'), 'ts', 'ts');
  assertEqual(detectLanguage('src/app.tsx'), 'ts', 'tsx');
  assertEqual(detectLanguage('app/models.py'), 'py', 'py');
  assertEqual(detectLanguage('handlers/user.go'), 'go', 'go');
  assertEqual(detectLanguage('src/lib.rs'), 'rust', 'rust');
});

test('defaults to js for unknown extensions', () => {
  assertEqual(detectLanguage('file.unknown'), 'js', 'unknown');
  assertEqual(detectLanguage(null), 'js', 'null');
  assertEqual(detectLanguage(''), 'js', 'empty');
});

// =============================================================================
// TESTS: analyzeFromGit
// =============================================================================

console.log('\n=== analyzeFromGit ===');

test('returns error gracefully for non-git directory', () => {
  const result = analyzeFromGit({ cwd: '/tmp' });
  assert(result.error || result.files.length === 0, 'handles non-git gracefully');
});

test('exports all expected functions', () => {
  assert(typeof parseDiff === 'function', 'parseDiff');
  assert(typeof classifyFile === 'function', 'classifyFile');
  assert(typeof classifyChanges === 'function', 'classifyChanges');
  assert(typeof detectLanguage === 'function', 'detectLanguage');
  assert(typeof extractChangedFunctions === 'function', 'extractChangedFunctions');
  assert(typeof extractChangedRanges === 'function', 'extractChangedRanges');
  assert(typeof analyzeFromGit === 'function', 'analyzeFromGit');
});

test('CHANGE_TYPES constants are defined', () => {
  assert(CHANGE_TYPES.NEW_FUNCTION === 'new_function', 'NEW_FUNCTION');
  assert(CHANGE_TYPES.BUG_FIX === 'bug_fix', 'BUG_FIX');
  assert(CHANGE_TYPES.REFACTOR === 'refactor', 'REFACTOR');
  assert(CHANGE_TYPES.CONFIG_CHANGE === 'config_change', 'CONFIG_CHANGE');
  assert(CHANGE_TYPES.NEW_FILE === 'new_file', 'NEW_FILE');
  assert(CHANGE_TYPES.DELETED_FILE === 'deleted_file', 'DELETED_FILE');
  assert(CHANGE_TYPES.TEST_CHANGE === 'test_change', 'TEST_CHANGE');
  assert(CHANGE_TYPES.DOCS_CHANGE === 'docs_change', 'DOCS_CHANGE');
});

// =============================================================================
// SUMMARY
// =============================================================================

console.log('\n========================================');
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
console.log('========================================\n');

process.exit(failed > 0 ? 1 : 0);
