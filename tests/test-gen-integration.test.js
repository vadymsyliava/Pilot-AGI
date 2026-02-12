#!/usr/bin/env node

/**
 * Verification tests for Test Gen Integration (Phase 5.3 — Pilot AGI-wra.5)
 * Run: node tests/test-gen-integration.test.js
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

function assertIncludes(str, substr, msg) {
  if (!str || !str.includes(substr)) {
    throw new Error((msg || 'Not found') + ': ' + JSON.stringify(substr) + ' not in output');
  }
}

// =============================================================================
// Load module (fresh for each section)
// =============================================================================

function freshModule() {
  const modPath = path.join(__dirname, '..', '.claude', 'pilot', 'hooks', 'lib', 'test-gen-integration.js');
  delete require.cache[modPath];
  return require(modPath);
}

// =============================================================================
// MOCK DEPENDENCIES
// =============================================================================

const MOCK_FRAMEWORK = {
  name: 'vitest',
  configPath: '/project/vitest.config.ts',
  testCommand: 'npx vitest run',
  testDir: 'tests',
  testPattern: '**/*.test.{js,ts,jsx,tsx}',
  language: 'js',
  detected: true
};

const MOCK_FRAMEWORK_NONE = {
  name: null,
  detected: false
};

const MOCK_ANALYSIS = {
  files: [
    {
      newPath: 'src/utils.js',
      addedLines: ['function newHelper(x) {', '  return x * 2;', '}'],
      removedLines: [],
      hunks: []
    }
  ],
  classifications: [
    { filePath: 'src/utils.js', changeType: 'new_function', addedCount: 3, removedCount: 0 }
  ],
  functions: [
    { filePath: 'src/utils.js', functionName: 'newHelper', language: 'js', lineNumber: 1 }
  ],
  ranges: [
    { filePath: 'src/utils.js', ranges: [{ start: 1, end: 3 }] }
  ]
};

const MOCK_ANALYSIS_EMPTY = {
  files: [],
  classifications: [],
  functions: [],
  ranges: []
};

const MOCK_ANALYSIS_CONFIG_ONLY = {
  files: [{ newPath: 'tsconfig.json', addedLines: ['"strict": true'], removedLines: [], hunks: [] }],
  classifications: [{ filePath: 'tsconfig.json', changeType: 'config_change', addedCount: 1, removedCount: 0 }],
  functions: [],
  ranges: []
};

const MOCK_VALID_TEST_CODE = `import { describe, it, expect } from 'vitest';
import { newHelper } from '../src/utils.js';

describe('newHelper', () => {
  it('doubles input', () => {
    expect(newHelper(5)).toBe(10);
  });
});
`;

const MOCK_GEN_RESULT = [
  {
    filePath: 'src/utils.js',
    testPath: 'tests/utils.test.js',
    strategy: 'unit',
    success: true,
    code: MOCK_VALID_TEST_CODE,
    issues: []
  }
];

const MOCK_GEN_RESULT_FAILED = [
  {
    filePath: 'src/utils.js',
    testPath: null,
    strategy: 'unit',
    success: false,
    error: 'timeout'
  }
];

function createMockDeps(overrides = {}) {
  return {
    changeAnalyzer: {
      analyzeFromGit: overrides.analyzeFromGit || (() => MOCK_ANALYSIS)
    },
    frameworkDetector: {
      detectFramework: overrides.detectFramework || (() => MOCK_FRAMEWORK)
    },
    testGenerator: {
      generateTests: overrides.generateTests || (() => MOCK_GEN_RESULT)
    },
    coverageGate: {
      gate: overrides.gate || (() => ({ status: 'pass', passed: true, summary: 'OK' }))
    }
  };
}

// =============================================================================
// TESTS: loadConfig
// =============================================================================

console.log('\n=== loadConfig ===');

test('returns defaults when no policy provided', () => {
  const mod = freshModule();
  const config = mod.loadConfig({});
  assertEqual(config.enabled, false, 'disabled by default');
  assertEqual(config.coverage_gate, false, 'coverage disabled');
  assertEqual(config.min_coverage, 0, 'min coverage 0');
  assert(Array.isArray(config.skip_types), 'has skip_types');
});

test('reads test_generation from policy object', () => {
  const mod = freshModule();
  const config = mod.loadConfig({
    test_generation: {
      enabled: true,
      coverage_gate: true,
      min_coverage: 80
    }
  });
  assertEqual(config.enabled, true, 'enabled');
  assertEqual(config.coverage_gate, true, 'coverage enabled');
  assertEqual(config.min_coverage, 80, 'min coverage 80');
});

test('handles missing test_generation section gracefully', () => {
  const mod = freshModule();
  const config = mod.loadConfig({ enforcement: {} });
  assertEqual(config.enabled, false, 'disabled');
});

// =============================================================================
// TESTS: runPipeline — skipped scenarios
// =============================================================================

console.log('\n=== runPipeline (skip scenarios) ===');

test('skips when disabled in policy', () => {
  const mod = freshModule();
  mod._setDeps(createMockDeps());
  const result = mod.runPipeline({ policy: { test_generation: { enabled: false } } });
  assert(result.skipped, 'skipped');
  assertIncludes(result.reason, 'disabled', 'reason');
  mod._resetDeps();
});

test('skips when no framework detected', () => {
  const mod = freshModule();
  mod._setDeps(createMockDeps({
    detectFramework: () => MOCK_FRAMEWORK_NONE
  }));
  const result = mod.runPipeline({ policy: { test_generation: { enabled: true } } });
  assert(result.skipped, 'skipped');
  assertIncludes(result.reason, 'No test framework', 'reason');
  mod._resetDeps();
});

test('skips when no changes detected', () => {
  const mod = freshModule();
  mod._setDeps(createMockDeps({
    analyzeFromGit: () => MOCK_ANALYSIS_EMPTY
  }));
  const result = mod.runPipeline({ policy: { test_generation: { enabled: true } } });
  assert(result.skipped, 'skipped');
  mod._resetDeps();
});

test('skips when only non-testable changes', () => {
  const mod = freshModule();
  mod._setDeps(createMockDeps({
    analyzeFromGit: () => MOCK_ANALYSIS_CONFIG_ONLY
  }));
  const result = mod.runPipeline({ policy: { test_generation: { enabled: true } } });
  assert(result.skipped, 'skipped');
  assertIncludes(result.reason, 'No testable', 'reason');
  mod._resetDeps();
});

// =============================================================================
// TESTS: runPipeline — success scenarios
// =============================================================================

console.log('\n=== runPipeline (success scenarios) ===');

test('runs full pipeline and generates tests', () => {
  const mod = freshModule();
  mod._setDeps(createMockDeps());
  const result = mod.runPipeline({
    policy: { test_generation: { enabled: true } },
    readFileFn: () => 'function newHelper(x) { return x * 2; }'
  });
  assert(!result.skipped, 'not skipped');
  assertEqual(result.framework, 'vitest', 'framework');
  assertEqual(result.generated, 1, 'generated count');
  assert(result.results.length > 0, 'has results');
  assert(result.results[0].success, 'first result success');
  assertIncludes(result.summary, 'Generated 1/1', 'summary');
  mod._resetDeps();
});

test('handles failed generation gracefully', () => {
  const mod = freshModule();
  mod._setDeps(createMockDeps({
    generateTests: () => MOCK_GEN_RESULT_FAILED
  }));
  const result = mod.runPipeline({
    policy: { test_generation: { enabled: true } },
    readFileFn: () => ''
  });
  assert(!result.skipped, 'not skipped');
  assertEqual(result.generated, 1, 'generated count');
  assert(!result.results[0].success, 'first result failed');
  assertIncludes(result.summary, 'failed', 'summary mentions failure');
  mod._resetDeps();
});

test('runs coverage gate when enabled', () => {
  let gateCalledWith = null;
  const mod = freshModule();
  mod._setDeps(createMockDeps({
    gate: (opts) => {
      gateCalledWith = opts;
      return { status: 'pass', passed: true, summary: 'OK' };
    }
  }));
  const result = mod.runPipeline({
    policy: { test_generation: { enabled: true, coverage_gate: true, min_coverage: 50 } },
    readFileFn: () => ''
  });
  assert(!result.skipped, 'not skipped');
  assert(result.gateResults.length > 0, 'has gate results');
  assert(result.gateResults[0].gate.passed, 'gate passed');
  mod._resetDeps();
});

// =============================================================================
// TESTS: buildSummary
// =============================================================================

console.log('\n=== buildSummary ===');

test('builds summary for successful generation', () => {
  const mod = freshModule();
  const summary = mod.buildSummary(
    [{ success: true }, { success: true }],
    [],
    ['tests/a.test.js', 'tests/b.test.js']
  );
  assertIncludes(summary, 'Generated 2/2', 'gen count');
  assertIncludes(summary, 'wrote 2 files', 'write count');
});

test('builds summary with failures', () => {
  const mod = freshModule();
  const summary = mod.buildSummary(
    [{ success: true }, { success: false }],
    [],
    ['tests/a.test.js']
  );
  assertIncludes(summary, '1 failed', 'failure count');
});

test('builds summary with coverage gate', () => {
  const mod = freshModule();
  const summary = mod.buildSummary(
    [{ success: true }],
    [{ gate: { passed: true } }],
    ['tests/a.test.js']
  );
  assertIncludes(summary, 'Coverage gate: 1/1 passed', 'gate summary');
});

// =============================================================================
// TESTS: Module exports
// =============================================================================

console.log('\n=== Module exports ===');

test('exports all expected functions and constants', () => {
  const mod = freshModule();
  assert(typeof mod.loadConfig === 'function', 'loadConfig');
  assert(typeof mod.runPipeline === 'function', 'runPipeline');
  assert(typeof mod.buildSummary === 'function', 'buildSummary');
  assert(typeof mod._setDeps === 'function', '_setDeps');
  assert(typeof mod._resetDeps === 'function', '_resetDeps');
  assert(typeof mod.DEFAULT_CONFIG === 'object', 'DEFAULT_CONFIG');
});

// =============================================================================
// SUMMARY
// =============================================================================

console.log('\n========================================');
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
console.log('========================================\n');

process.exit(failed > 0 ? 1 : 0);
