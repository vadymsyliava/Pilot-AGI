#!/usr/bin/env node

/**
 * Verification tests for Coverage Gate (Phase 5.3 — Pilot AGI-wra.4)
 * Run: node tests/coverage-gate.test.js
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
// Load module
// =============================================================================

const {
  GATE_STATUS,
  COVERAGE_FLAGS,
  runTests,
  runWithCoverage,
  checkCoverage,
  findFileCoverage,
  isLineCovered,
  gate
} = require(path.join(__dirname, '..', '.claude', 'pilot', 'hooks', 'lib', 'coverage-gate.js'));

// =============================================================================
// MOCK DATA
// =============================================================================

// Mock Istanbul/NYC coverage data
const MOCK_COVERAGE_DATA = {
  'src/utils.js': {
    statementMap: {
      '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 30 } },
      '1': { start: { line: 3, column: 0 }, end: { line: 5, column: 1 } },
      '2': { start: { line: 4, column: 2 }, end: { line: 4, column: 20 } },
      '3': { start: { line: 10, column: 0 }, end: { line: 15, column: 1 } },
      '4': { start: { line: 11, column: 2 }, end: { line: 11, column: 25 } },
      '5': { start: { line: 12, column: 2 }, end: { line: 12, column: 15 } }
    },
    s: { '0': 1, '1': 1, '2': 3, '3': 1, '4': 0, '5': 0 }
  },
  '/project/src/auth.js': {
    statementMap: {
      '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 30 } },
      '1': { start: { line: 15, column: 0 }, end: { line: 20, column: 1 } },
      '2': { start: { line: 16, column: 2 }, end: { line: 16, column: 30 } }
    },
    s: { '0': 1, '1': 2, '2': 2 }
  }
};

const MOCK_CHANGED_RANGES = [
  {
    filePath: 'src/utils.js',
    ranges: [{ start: 3, end: 5 }, { start: 10, end: 12 }]
  },
  {
    filePath: 'src/auth.js',
    ranges: [{ start: 15, end: 16 }]
  }
];

// =============================================================================
// TESTS: runTests
// =============================================================================

console.log('\n=== runTests ===');

test('runs tests successfully with mock exec', () => {
  const mockExec = () => '3 tests passed';
  const result = runTests({
    testCommand: 'npx vitest run',
    testPath: 'tests/utils.test.js',
    execFn: mockExec
  });
  assertEqual(result.status, GATE_STATUS.PASS, 'status');
  assertEqual(result.output, '3 tests passed', 'output');
  assertEqual(result.error, null, 'no error');
  assert(typeof result.duration === 'number', 'has duration');
});

test('reports test failure on non-zero exit', () => {
  const mockExec = () => {
    const err = new Error('tests failed');
    err.status = 1;
    err.stdout = 'FAIL: test1';
    err.stderr = '';
    throw err;
  };
  const result = runTests({
    testCommand: 'npx vitest run',
    testPath: 'tests/utils.test.js',
    execFn: mockExec
  });
  assertEqual(result.status, GATE_STATUS.FAIL, 'status');
  assertIncludes(result.error, 'exit code 1', 'error msg');
  assertIncludes(result.output, 'FAIL: test1', 'output');
});

test('reports error on exec exception', () => {
  const mockExec = () => { throw new Error('command not found'); };
  const result = runTests({
    testCommand: 'npx vitest run',
    testPath: 'tests/utils.test.js',
    execFn: mockExec
  });
  assertEqual(result.status, GATE_STATUS.ERROR, 'status');
  assertIncludes(result.error, 'command not found', 'error msg');
});

test('returns error for missing testCommand', () => {
  const result = runTests({ testPath: 'tests/utils.test.js' });
  assertEqual(result.status, GATE_STATUS.ERROR, 'status');
  assertIncludes(result.error, 'Missing', 'error msg');
});

test('returns error for missing testPath', () => {
  const result = runTests({ testCommand: 'npx vitest run' });
  assertEqual(result.status, GATE_STATUS.ERROR, 'status');
});

test('passes correct args to exec', () => {
  let capturedArgs = null;
  const mockExec = (cmd, args, opts) => {
    capturedArgs = { cmd, args, opts };
    return '';
  };
  runTests({
    testCommand: 'npx vitest run',
    testPath: 'tests/utils.test.js',
    cwd: '/my/project',
    execFn: mockExec
  });
  assertEqual(capturedArgs.cmd, 'npx', 'cmd');
  assert(capturedArgs.args.includes('vitest'), 'has vitest');
  assert(capturedArgs.args.includes('run'), 'has run');
  assert(capturedArgs.args.includes('tests/utils.test.js'), 'has test path');
  assertEqual(capturedArgs.opts.cwd, '/my/project', 'cwd');
});

// =============================================================================
// TESTS: runWithCoverage
// =============================================================================

console.log('\n=== runWithCoverage ===');

test('runs with coverage flags for vitest', () => {
  let capturedArgs = null;
  const mockExec = (cmd, args) => {
    capturedArgs = { cmd, args };
    return '';
  };
  runWithCoverage({
    testCommand: 'npx vitest run',
    testPath: 'tests/utils.test.js',
    frameworkName: 'vitest',
    execFn: mockExec
  });
  assert(capturedArgs.args.includes('--coverage'), 'has coverage flag');
  assert(capturedArgs.args.some(a => a.includes('reporter=json')), 'has json reporter');
});

test('returns skip for unsupported frameworks', () => {
  const result = runWithCoverage({
    testCommand: 'npx mocha',
    testPath: 'test/utils.test.js',
    frameworkName: 'mocha'
  });
  assertEqual(result.status, GATE_STATUS.SKIP, 'status');
  assertIncludes(result.error, 'not supported', 'skip reason');
});

test('returns error for missing required options', () => {
  const result = runWithCoverage({});
  assertEqual(result.status, GATE_STATUS.ERROR, 'status');
  assertIncludes(result.error, 'Missing', 'error msg');
});

// =============================================================================
// TESTS: checkCoverage
// =============================================================================

console.log('\n=== checkCoverage ===');

test('calculates coverage for changed ranges', () => {
  const result = checkCoverage(MOCK_COVERAGE_DATA, MOCK_CHANGED_RANGES);
  assert(result.total > 0, 'has total lines');
  assert(result.covered >= 0, 'has covered lines');
  assert(result.percentage >= 0 && result.percentage <= 100, 'percentage in range');
  assert(Array.isArray(result.uncoveredFiles), 'has uncoveredFiles array');
});

test('returns zero coverage for empty inputs', () => {
  const r1 = checkCoverage(null, MOCK_CHANGED_RANGES);
  assertEqual(r1.total, 0, 'null coverage data');
  assertEqual(r1.percentage, 0, 'null percentage');

  const r2 = checkCoverage(MOCK_COVERAGE_DATA, []);
  assertEqual(r2.total, 0, 'empty ranges');

  const r3 = checkCoverage(MOCK_COVERAGE_DATA, null);
  assertEqual(r3.total, 0, 'null ranges');
});

test('identifies uncovered files', () => {
  const ranges = [
    { filePath: 'src/nonexistent.js', ranges: [{ start: 1, end: 5 }] }
  ];
  const result = checkCoverage(MOCK_COVERAGE_DATA, ranges);
  assertEqual(result.uncoveredFiles.length, 1, 'one uncovered file');
  assertEqual(result.uncoveredFiles[0].filePath, 'src/nonexistent.js', 'file path');
  assertEqual(result.uncoveredFiles[0].covered, 0, 'zero covered');
  assertEqual(result.uncoveredFiles[0].total, 5, 'total lines');
});

test('counts partially covered files correctly', () => {
  // src/utils.js has statements 0-2 covered (lines 1-5) but 3-5 not covered (lines 10-15)
  const ranges = [{ filePath: 'src/utils.js', ranges: [{ start: 3, end: 5 }] }];
  const result = checkCoverage(MOCK_COVERAGE_DATA, ranges);
  assert(result.covered > 0, 'some lines covered');
  assert(result.covered <= result.total, 'covered <= total');
});

// =============================================================================
// TESTS: findFileCoverage
// =============================================================================

console.log('\n=== findFileCoverage ===');

test('finds by exact key match', () => {
  const result = findFileCoverage(MOCK_COVERAGE_DATA, 'src/utils.js');
  assert(result !== null, 'found');
  assert(result.statementMap, 'has statementMap');
});

test('finds by partial path match', () => {
  const result = findFileCoverage(MOCK_COVERAGE_DATA, 'src/auth.js');
  assert(result !== null, 'found via partial match');
});

test('returns null for missing file', () => {
  const result = findFileCoverage(MOCK_COVERAGE_DATA, 'src/missing.js');
  assertEqual(result, null, 'null');
});

test('returns null for null data', () => {
  assertEqual(findFileCoverage(null, 'src/utils.js'), null, 'null data');
});

// =============================================================================
// TESTS: isLineCovered
// =============================================================================

console.log('\n=== isLineCovered ===');

test('returns true for covered line', () => {
  const fileCov = MOCK_COVERAGE_DATA['src/utils.js'];
  // Line 4 is in statement '2' which has s['2'] = 3
  assert(isLineCovered(fileCov, 4), 'line 4 covered');
});

test('returns false for uncovered line', () => {
  // Use isolated coverage data where line 20 is only in one uncovered statement
  const fileCov = {
    statementMap: {
      '0': { start: { line: 20, column: 0 }, end: { line: 20, column: 30 } }
    },
    s: { '0': 0 }
  };
  assert(!isLineCovered(fileCov, 20), 'line 20 not covered');
});

test('returns false for null coverage', () => {
  assert(!isLineCovered(null, 1), 'null coverage');
  assert(!isLineCovered({}, 1), 'empty coverage');
});

// =============================================================================
// TESTS: gate (integration)
// =============================================================================

console.log('\n=== gate ===');

test('passes when tests pass without coverage check', () => {
  const mockExec = () => 'all tests passed';
  const result = gate({
    testCommand: 'npx vitest run',
    testPath: 'tests/utils.test.js',
    frameworkName: 'vitest',
    execFn: mockExec
  });
  assertEqual(result.status, GATE_STATUS.PASS, 'status');
  assert(result.passed, 'passed');
  assertIncludes(result.summary, 'Tests passed', 'summary');
  assertEqual(result.coverage, null, 'no coverage');
});

test('fails when tests fail', () => {
  const mockExec = () => {
    const err = new Error('test failure');
    err.status = 1;
    err.stdout = 'FAIL';
    err.stderr = '';
    throw err;
  };
  const result = gate({
    testCommand: 'npx vitest run',
    testPath: 'tests/utils.test.js',
    frameworkName: 'vitest',
    execFn: mockExec
  });
  assertEqual(result.status, GATE_STATUS.FAIL, 'status');
  assert(!result.passed, 'not passed');
  assertIncludes(result.summary, 'fail', 'summary');
});

test('skips coverage for unsupported frameworks', () => {
  let callCount = 0;
  const mockExec = () => {
    callCount++;
    return 'passed';
  };
  const result = gate({
    testCommand: 'npx mocha',
    testPath: 'test/utils.test.js',
    frameworkName: 'mocha',
    checkCoverageEnabled: true,
    execFn: mockExec
  });
  assertEqual(result.status, GATE_STATUS.PASS, 'status');
  assert(result.passed, 'passed');
  assert(result.coverage.skipped, 'coverage skipped');
  assertEqual(callCount, 1, 'only ran tests once (no coverage run)');
});

test('passes with coverage above minimum', () => {
  let callCount = 0;
  const mockExec = () => {
    callCount++;
    return 'passed';
  };
  // Coverage check with no actual coverage data = 0% but minCoverage = 0
  const result = gate({
    testCommand: 'npx vitest run',
    testPath: 'tests/utils.test.js',
    frameworkName: 'vitest',
    checkCoverageEnabled: true,
    minCoverage: 0,
    changedRanges: [],
    execFn: mockExec
  });
  assertEqual(result.status, GATE_STATUS.PASS, 'status');
  assert(result.passed, 'passed');
});

// =============================================================================
// TESTS: Module exports
// =============================================================================

console.log('\n=== Module exports ===');

test('exports all expected functions and constants', () => {
  assert(typeof runTests === 'function', 'runTests');
  assert(typeof runWithCoverage === 'function', 'runWithCoverage');
  assert(typeof checkCoverage === 'function', 'checkCoverage');
  assert(typeof findFileCoverage === 'function', 'findFileCoverage');
  assert(typeof isLineCovered === 'function', 'isLineCovered');
  assert(typeof gate === 'function', 'gate');
  assertEqual(GATE_STATUS.PASS, 'pass', 'PASS');
  assertEqual(GATE_STATUS.FAIL, 'fail', 'FAIL');
  assertEqual(GATE_STATUS.ERROR, 'error', 'ERROR');
  assertEqual(GATE_STATUS.SKIP, 'skip', 'SKIP');
  assert(typeof COVERAGE_FLAGS === 'object', 'COVERAGE_FLAGS');
});

// =============================================================================
// SUMMARY
// =============================================================================

console.log('\n========================================');
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
console.log('========================================\n');

process.exit(failed > 0 ? 1 : 0);
