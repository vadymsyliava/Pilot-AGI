#!/usr/bin/env node

/**
 * Verification tests for Framework Detector (Phase 5.3 — Pilot AGI-wra.2)
 * Run: node tests/framework-detector.test.js
 */

const fs = require('fs');
const path = require('path');
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

// =============================================================================
// SETUP: temp directories for each framework scenario
// =============================================================================

const TMP_BASE = path.join(os.tmpdir(), 'pilot-framework-detect-' + Date.now());
fs.mkdirSync(TMP_BASE, { recursive: true });

function createScenario(name) {
  const dir = path.join(TMP_BASE, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(dir, filename, data) {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2));
}

function writeFile(dir, filename, content) {
  const filePath = path.join(dir, filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// =============================================================================
// Load module
// =============================================================================

const {
  FRAMEWORKS,
  detectFramework,
  detectAllFrameworks,
  readPackageJson,
  detectFromPackageJson,
  findTestDir
} = require(path.join(__dirname, '..', '.claude', 'pilot', 'hooks', 'lib', 'framework-detector.js'));

// =============================================================================
// TESTS: Vitest detection
// =============================================================================

console.log('\n=== Vitest detection ===');

test('detects Vitest from config file', () => {
  const dir = createScenario('vitest-config');
  writeFile(dir, 'vitest.config.ts', 'export default {}');
  writeJson(dir, 'package.json', { name: 'test', devDependencies: {} });
  const result = detectFramework(dir);
  assertEqual(result.name, FRAMEWORKS.VITEST, 'framework name');
  assert(result.detected, 'detected');
  assert(result.configPath.includes('vitest.config.ts'), 'config path');
  assertEqual(result.testCommand, 'npx vitest run', 'test command');
  assertEqual(result.language, 'js', 'language');
});

test('detects Vitest from package.json devDependencies', () => {
  const dir = createScenario('vitest-pkg');
  writeJson(dir, 'package.json', {
    name: 'test',
    devDependencies: { vitest: '^1.0.0' }
  });
  const result = detectFramework(dir);
  assertEqual(result.name, FRAMEWORKS.VITEST, 'framework name');
  assert(result.detected, 'detected');
});

test('detects Vitest from test script', () => {
  const dir = createScenario('vitest-script');
  writeJson(dir, 'package.json', {
    name: 'test',
    scripts: { test: 'vitest run' }
  });
  const result = detectFramework(dir);
  assertEqual(result.name, FRAMEWORKS.VITEST, 'framework name');
});

// =============================================================================
// TESTS: Jest detection
// =============================================================================

console.log('\n=== Jest detection ===');

test('detects Jest from config file', () => {
  const dir = createScenario('jest-config');
  writeFile(dir, 'jest.config.js', 'module.exports = {}');
  writeJson(dir, 'package.json', { name: 'test' });
  const result = detectFramework(dir);
  assertEqual(result.name, FRAMEWORKS.JEST, 'framework name');
  assertEqual(result.testCommand, 'npx jest', 'test command');
});

test('detects Jest from package.json jest key', () => {
  const dir = createScenario('jest-pkg-key');
  writeJson(dir, 'package.json', {
    name: 'test',
    jest: { testEnvironment: 'node' }
  });
  const result = detectFramework(dir);
  assertEqual(result.name, FRAMEWORKS.JEST, 'framework name');
});

// =============================================================================
// TESTS: Mocha detection
// =============================================================================

console.log('\n=== Mocha detection ===');

test('detects Mocha from .mocharc.yml', () => {
  const dir = createScenario('mocha-config');
  writeFile(dir, '.mocharc.yml', 'timeout: 5000');
  const result = detectFramework(dir);
  assertEqual(result.name, FRAMEWORKS.MOCHA, 'framework name');
  assertEqual(result.testCommand, 'npx mocha', 'test command');
});

// =============================================================================
// TESTS: node:test detection
// =============================================================================

console.log('\n=== node:test detection ===');

test('detects node:test from test script', () => {
  const dir = createScenario('node-test');
  writeJson(dir, 'package.json', {
    name: 'test',
    scripts: { test: 'node --test' }
  });
  const result = detectFramework(dir);
  assertEqual(result.name, FRAMEWORKS.NODE_TEST, 'framework name');
  assertEqual(result.testCommand, 'node --test', 'test command');
});

// =============================================================================
// TESTS: pytest detection
// =============================================================================

console.log('\n=== pytest detection ===');

test('detects pytest from pytest.ini', () => {
  const dir = createScenario('pytest-ini');
  writeFile(dir, 'pytest.ini', '[pytest]\naddopts = -v');
  const result = detectFramework(dir);
  assertEqual(result.name, FRAMEWORKS.PYTEST, 'framework name');
  assertEqual(result.testCommand, 'pytest', 'test command');
  assertEqual(result.language, 'py', 'language');
});

test('detects pytest from pyproject.toml', () => {
  const dir = createScenario('pytest-pyproject');
  writeFile(dir, 'pyproject.toml', '[tool.pytest.ini_options]\naddopts = "-v"');
  const result = detectFramework(dir);
  assertEqual(result.name, FRAMEWORKS.PYTEST, 'framework name');
});

// =============================================================================
// TESTS: Go test detection
// =============================================================================

console.log('\n=== Go test detection ===');

test('detects Go test from go.mod', () => {
  const dir = createScenario('go-test');
  writeFile(dir, 'go.mod', 'module example.com/myapp\n\ngo 1.21');
  const result = detectFramework(dir);
  assertEqual(result.name, FRAMEWORKS.GO_TEST, 'framework name');
  assertEqual(result.testCommand, 'go test ./...', 'test command');
  assertEqual(result.language, 'go', 'language');
});

// =============================================================================
// TESTS: Cargo test detection
// =============================================================================

console.log('\n=== Cargo test detection ===');

test('detects Cargo test from Cargo.toml', () => {
  const dir = createScenario('cargo-test');
  writeFile(dir, 'Cargo.toml', '[package]\nname = "myapp"\nversion = "0.1.0"');
  const result = detectFramework(dir);
  assertEqual(result.name, FRAMEWORKS.CARGO_TEST, 'framework name');
  assertEqual(result.testCommand, 'cargo test', 'test command');
  assertEqual(result.language, 'rust', 'language');
});

// =============================================================================
// TESTS: Edge cases
// =============================================================================

console.log('\n=== Edge cases ===');

test('returns detected=false for empty directory', () => {
  const dir = createScenario('empty');
  const result = detectFramework(dir);
  assertEqual(result.detected, false, 'not detected');
  assertEqual(result.name, null, 'no name');
  assertEqual(result.configPath, null, 'no config');
  assertEqual(result.testCommand, null, 'no command');
});

test('Vitest takes priority over Jest when both present', () => {
  const dir = createScenario('both-vitest-jest');
  writeFile(dir, 'vitest.config.ts', 'export default {}');
  writeFile(dir, 'jest.config.js', 'module.exports = {}');
  writeJson(dir, 'package.json', { name: 'test' });
  const result = detectFramework(dir);
  assertEqual(result.name, FRAMEWORKS.VITEST, 'vitest wins');
});

test('detectAllFrameworks finds multiple frameworks', () => {
  const dir = createScenario('multi-framework');
  writeFile(dir, 'vitest.config.ts', 'export default {}');
  writeFile(dir, 'jest.config.js', 'module.exports = {}');
  writeJson(dir, 'package.json', { name: 'test' });
  const results = detectAllFrameworks(dir);
  assert(results.length >= 2, 'found at least 2 frameworks');
  const names = results.map(r => r.name);
  assert(names.includes(FRAMEWORKS.VITEST), 'has vitest');
  assert(names.includes(FRAMEWORKS.JEST), 'has jest');
});

test('finds actual test directory', () => {
  const dir = createScenario('test-dir');
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  const result = findTestDir(dir, '__tests__');
  assertEqual(result, 'tests', 'found tests dir');
});

test('FRAMEWORKS constants are defined', () => {
  assertEqual(FRAMEWORKS.VITEST, 'vitest', 'vitest');
  assertEqual(FRAMEWORKS.JEST, 'jest', 'jest');
  assertEqual(FRAMEWORKS.MOCHA, 'mocha', 'mocha');
  assertEqual(FRAMEWORKS.NODE_TEST, 'node:test', 'node:test');
  assertEqual(FRAMEWORKS.PYTEST, 'pytest', 'pytest');
  assertEqual(FRAMEWORKS.GO_TEST, 'go_test', 'go_test');
  assertEqual(FRAMEWORKS.CARGO_TEST, 'cargo_test', 'cargo_test');
});

test('exports all expected functions', () => {
  assert(typeof detectFramework === 'function', 'detectFramework');
  assert(typeof detectAllFrameworks === 'function', 'detectAllFrameworks');
  assert(typeof readPackageJson === 'function', 'readPackageJson');
});

// =============================================================================
// CLEANUP
// =============================================================================

try {
  fs.rmSync(TMP_BASE, { recursive: true, force: true });
} catch {
  // best effort cleanup
}

// =============================================================================
// SUMMARY
// =============================================================================

console.log('\n========================================');
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
console.log('========================================\n');

process.exit(failed > 0 ? 1 : 0);
