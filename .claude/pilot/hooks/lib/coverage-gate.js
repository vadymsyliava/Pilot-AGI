/**
 * Coverage Gate — verify generated tests pass and cover changes
 *
 * Runs generated tests, checks exit code. Optionally runs coverage analysis
 * on changed files. Reports pass/fail + coverage delta. Escalates on failure.
 *
 * Part of Phase 5.3 — Autonomous Test Generation (Pilot AGI-wra.4)
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ============================================================================
// CONSTANTS
// ============================================================================

const GATE_STATUS = {
  PASS: 'pass',
  FAIL: 'fail',
  ERROR: 'error',
  SKIP: 'skip'
};

/**
 * Coverage flags per framework for generating JSON/lcov coverage reports.
 */
const COVERAGE_FLAGS = {
  vitest: ['--coverage', '--coverage.reporter=json'],
  jest: ['--coverage', '--coverageReporters=json'],
  mocha: [],  // needs nyc wrapper
  'node:test': [],
  pytest: ['--cov', '--cov-report=json'],
  go_test: ['-coverprofile=coverage.out'],
  cargo_test: [] // needs tarpaulin
};

const DEFAULT_TIMEOUT = 120000;

// ============================================================================
// TEST RUNNER
// ============================================================================

/**
 * Run a test file and return pass/fail status.
 * Uses execFileSync (array args, no shell) to avoid injection.
 *
 * @param {Object} options
 * @param {string} options.testCommand - Base test command (e.g. "npx vitest run")
 * @param {string} options.testPath - Path to the specific test file
 * @param {string} [options.cwd] - Working directory
 * @param {number} [options.timeout] - Timeout in ms
 * @param {Function} [options.execFn] - Custom exec function (for testing)
 * @returns {Object} { status, output, error, duration }
 */
function runTests(options = {}) {
  const { testCommand, testPath, cwd, timeout = DEFAULT_TIMEOUT, execFn } = options;

  if (!testCommand || !testPath) {
    return { status: GATE_STATUS.ERROR, output: '', error: 'Missing testCommand or testPath', duration: 0 };
  }

  const exec = execFn || execFileSync;
  const parts = testCommand.split(/\s+/);
  const cmd = parts[0];
  const args = [...parts.slice(1), testPath];
  const start = Date.now();

  try {
    const output = exec(cmd, args, {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      timeout,
      maxBuffer: 5 * 1024 * 1024
    });

    return {
      status: GATE_STATUS.PASS,
      output: output || '',
      error: null,
      duration: Date.now() - start
    };
  } catch (err) {
    const duration = Date.now() - start;

    // Non-zero exit = test failure (not an error in the runner)
    if (err.status && err.status > 0) {
      return {
        status: GATE_STATUS.FAIL,
        output: (err.stdout || '') + (err.stderr || ''),
        error: `Tests failed with exit code ${err.status}`,
        duration
      };
    }

    return {
      status: GATE_STATUS.ERROR,
      output: '',
      error: err.message || 'Test execution error',
      duration
    };
  }
}

// ============================================================================
// COVERAGE ANALYSIS
// ============================================================================

/**
 * Run tests with coverage and return the coverage report.
 * Uses execFileSync (array args, no shell) to avoid injection.
 *
 * @param {Object} options
 * @param {string} options.testCommand - Base test command
 * @param {string} options.testPath - Path to test file
 * @param {string} options.frameworkName - Framework name for coverage flags
 * @param {string} [options.cwd] - Working directory
 * @param {number} [options.timeout] - Timeout in ms
 * @param {Function} [options.execFn] - Custom exec function (for testing)
 * @returns {Object} { status, coverageData, output, error }
 */
function runWithCoverage(options = {}) {
  const { testCommand, testPath, frameworkName, cwd, timeout = DEFAULT_TIMEOUT, execFn } = options;

  if (!testCommand || !testPath || !frameworkName) {
    return { status: GATE_STATUS.ERROR, coverageData: null, output: '', error: 'Missing required options' };
  }

  const flags = COVERAGE_FLAGS[frameworkName] || [];
  if (flags.length === 0) {
    // Framework doesn't support coverage flags — run tests only
    return { status: GATE_STATUS.SKIP, coverageData: null, output: '', error: 'Coverage not supported for ' + frameworkName };
  }

  const exec = execFn || execFileSync;
  const parts = testCommand.split(/\s+/);
  const cmd = parts[0];
  const args = [...parts.slice(1), ...flags, testPath];

  try {
    const output = exec(cmd, args, {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      timeout,
      maxBuffer: 5 * 1024 * 1024
    });

    // Try to read coverage JSON
    const coverageData = readCoverageJson(cwd || process.cwd(), frameworkName);

    return {
      status: GATE_STATUS.PASS,
      coverageData,
      output: output || '',
      error: null
    };
  } catch (err) {
    if (err.status && err.status > 0) {
      return {
        status: GATE_STATUS.FAIL,
        coverageData: null,
        output: (err.stdout || '') + (err.stderr || ''),
        error: `Coverage run failed with exit code ${err.status}`
      };
    }

    return {
      status: GATE_STATUS.ERROR,
      coverageData: null,
      output: '',
      error: err.message || 'Coverage execution error'
    };
  }
}

/**
 * Read coverage JSON report from conventional locations.
 */
function readCoverageJson(cwd, frameworkName) {
  const candidates = [
    path.join(cwd, 'coverage', 'coverage-final.json'),
    path.join(cwd, 'coverage', 'coverage-summary.json'),
    path.join(cwd, '.coverage', 'coverage.json'),
    path.join(cwd, 'coverage.json')
  ];

  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch {
      continue;
    }
  }

  return null;
}

// ============================================================================
// COVERAGE CHECKING
// ============================================================================

/**
 * Check whether changed lines are covered by the tests.
 *
 * @param {Object} coverageData - Parsed coverage JSON
 * @param {Array<Object>} changedRanges - From change-analyzer extractChangedRanges()
 * @returns {Object} { covered, total, percentage, uncoveredFiles }
 */
function checkCoverage(coverageData, changedRanges) {
  if (!coverageData || !changedRanges || changedRanges.length === 0) {
    return { covered: 0, total: 0, percentage: 0, uncoveredFiles: [] };
  }

  let totalLines = 0;
  let coveredLines = 0;
  const uncoveredFiles = [];

  for (const fileRange of changedRanges) {
    const filePath = fileRange.filePath;
    const fileCov = findFileCoverage(coverageData, filePath);

    if (!fileCov) {
      // No coverage data for this file
      const fileTotal = fileRange.ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
      totalLines += fileTotal;
      uncoveredFiles.push({ filePath, covered: 0, total: fileTotal });
      continue;
    }

    let fileCovered = 0;
    let fileTotal = 0;

    for (const range of fileRange.ranges) {
      for (let line = range.start; line <= range.end; line++) {
        fileTotal++;
        totalLines++;
        if (isLineCovered(fileCov, line)) {
          fileCovered++;
          coveredLines++;
        }
      }
    }

    if (fileCovered < fileTotal) {
      uncoveredFiles.push({ filePath, covered: fileCovered, total: fileTotal });
    }
  }

  return {
    covered: coveredLines,
    total: totalLines,
    percentage: totalLines > 0 ? Math.round((coveredLines / totalLines) * 100) : 0,
    uncoveredFiles
  };
}

/**
 * Find coverage data for a specific file in the coverage report.
 */
function findFileCoverage(coverageData, filePath) {
  if (!coverageData) return null;

  // Try direct match
  if (coverageData[filePath]) return coverageData[filePath];

  // Try matching by basename or partial path
  for (const key of Object.keys(coverageData)) {
    if (key.endsWith(filePath) || key.endsWith('/' + filePath)) {
      return coverageData[key];
    }
  }

  return null;
}

/**
 * Check if a specific line is covered in the coverage data.
 * Supports Istanbul/NYC format (statementMap + s).
 */
function isLineCovered(fileCov, lineNumber) {
  if (!fileCov || !fileCov.statementMap || !fileCov.s) return false;

  for (const [stmtId, stmt] of Object.entries(fileCov.statementMap)) {
    if (stmt.start && stmt.end &&
        stmt.start.line <= lineNumber && stmt.end.line >= lineNumber) {
      return fileCov.s[stmtId] > 0;
    }
  }

  return false;
}

// ============================================================================
// GATE ORCHESTRATION
// ============================================================================

/**
 * Run the full coverage gate: execute tests, check coverage, produce report.
 *
 * @param {Object} options
 * @param {string} options.testCommand - Base test command
 * @param {string} options.testPath - Path to generated test file
 * @param {string} options.frameworkName - Framework name
 * @param {Array<Object>} [options.changedRanges] - Changed line ranges
 * @param {boolean} [options.checkCoverageEnabled] - Whether to run coverage analysis
 * @param {number} [options.minCoverage] - Minimum coverage percentage (0-100)
 * @param {string} [options.cwd] - Working directory
 * @param {Function} [options.execFn] - Custom exec function (for testing)
 * @returns {Object} Gate result with status, test results, coverage results
 */
function gate(options = {}) {
  const {
    testCommand,
    testPath,
    frameworkName,
    changedRanges,
    checkCoverageEnabled = false,
    minCoverage = 0,
    cwd,
    execFn
  } = options;

  // Step 1: Run tests
  const testResult = runTests({ testCommand, testPath, cwd, execFn });

  if (testResult.status !== GATE_STATUS.PASS) {
    return {
      status: testResult.status,
      tests: testResult,
      coverage: null,
      passed: false,
      summary: `Tests ${testResult.status}: ${testResult.error || 'unknown error'}`
    };
  }

  // Step 2: Coverage (optional)
  if (!checkCoverageEnabled) {
    return {
      status: GATE_STATUS.PASS,
      tests: testResult,
      coverage: null,
      passed: true,
      summary: `Tests passed in ${testResult.duration}ms`
    };
  }

  const covResult = runWithCoverage({ testCommand, testPath, frameworkName, cwd, execFn });

  if (covResult.status === GATE_STATUS.SKIP) {
    return {
      status: GATE_STATUS.PASS,
      tests: testResult,
      coverage: { skipped: true, reason: covResult.error },
      passed: true,
      summary: `Tests passed. Coverage skipped: ${covResult.error}`
    };
  }

  if (covResult.status !== GATE_STATUS.PASS) {
    return {
      status: covResult.status,
      tests: testResult,
      coverage: covResult,
      passed: false,
      summary: `Coverage run ${covResult.status}: ${covResult.error}`
    };
  }

  // Step 3: Check coverage against changed lines
  const coverageCheck = checkCoverage(covResult.coverageData, changedRanges || []);

  const meetsMinimum = coverageCheck.percentage >= minCoverage;

  return {
    status: meetsMinimum ? GATE_STATUS.PASS : GATE_STATUS.FAIL,
    tests: testResult,
    coverage: {
      ...coverageCheck,
      meetsMinimum,
      minCoverage
    },
    passed: meetsMinimum,
    summary: meetsMinimum
      ? `Tests passed. Coverage: ${coverageCheck.percentage}% (${coverageCheck.covered}/${coverageCheck.total} lines)`
      : `Coverage below minimum: ${coverageCheck.percentage}% < ${minCoverage}%`
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  GATE_STATUS,
  COVERAGE_FLAGS,
  runTests,
  runWithCoverage,
  readCoverageJson,
  checkCoverage,
  findFileCoverage,
  isLineCovered,
  gate
};
