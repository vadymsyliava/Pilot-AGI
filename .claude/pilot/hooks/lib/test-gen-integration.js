/**
 * Test Generation Integration — orchestrates the full auto-test pipeline
 *
 * Called as a post-step hook by /pilot-exec after code changes are detected.
 * Combines change-analyzer → framework-detector → test-generator → coverage-gate.
 * Configurable via policy.yaml under `test_generation`.
 *
 * Part of Phase 5.3 — Autonomous Test Generation (Pilot AGI-wra.5)
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// LAZY-LOADED DEPENDENCIES (for testing/mocking)
// ============================================================================

let _changeAnalyzer = null;
let _frameworkDetector = null;
let _testGenerator = null;
let _coverageGate = null;

function getChangeAnalyzer() {
  if (!_changeAnalyzer) _changeAnalyzer = require('./change-analyzer');
  return _changeAnalyzer;
}

function getFrameworkDetector() {
  if (!_frameworkDetector) _frameworkDetector = require('./framework-detector');
  return _frameworkDetector;
}

function getTestGenerator() {
  if (!_testGenerator) _testGenerator = require('./test-generator');
  return _testGenerator;
}

function getCoverageGate() {
  if (!_coverageGate) _coverageGate = require('./coverage-gate');
  return _coverageGate;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_CONFIG = {
  enabled: false,
  coverage_gate: false,
  min_coverage: 0,
  skip_types: ['config_change', 'deleted_file', 'test_change', 'docs_change']
};

/**
 * Load test generation config from policy.yaml.
 *
 * @param {Object} [policy] - Pre-loaded policy object (avoids re-reading file)
 * @returns {Object} Merged config with defaults
 */
function loadConfig(policy) {
  if (!policy) {
    try {
      const { loadPolicy } = require('./policy');
      policy = loadPolicy();
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  const tg = policy.test_generation || {};
  return {
    enabled: tg.enabled === true,
    coverage_gate: tg.coverage_gate === true,
    min_coverage: typeof tg.min_coverage === 'number' ? tg.min_coverage : DEFAULT_CONFIG.min_coverage,
    skip_types: Array.isArray(tg.skip_types) ? tg.skip_types : DEFAULT_CONFIG.skip_types
  };
}

// ============================================================================
// PIPELINE
// ============================================================================

/**
 * Run the full test generation pipeline for recent code changes.
 *
 * @param {Object} options
 * @param {string} [options.cwd] - Working directory
 * @param {Object} [options.policy] - Pre-loaded policy object
 * @param {boolean} [options.staged] - Analyze staged changes (default: true)
 * @param {Function} [options.execFn] - Custom exec function (for testing)
 * @param {Function} [options.readFileFn] - Custom file reader (for testing)
 * @returns {Object} Pipeline result
 */
function runPipeline(options = {}) {
  const {
    cwd = process.cwd(),
    policy,
    staged = true,
    execFn,
    readFileFn
  } = options;

  const config = loadConfig(policy);

  if (!config.enabled) {
    return { skipped: true, reason: 'Test generation disabled in policy', results: [] };
  }

  // Step 1: Detect framework
  const framework = getFrameworkDetector().detectFramework(cwd);
  if (!framework.detected) {
    return { skipped: true, reason: 'No test framework detected', results: [] };
  }

  // Step 2: Analyze changes
  const analysis = getChangeAnalyzer().analyzeFromGit({ staged, cwd });
  if (analysis.error || analysis.files.length === 0) {
    return { skipped: true, reason: analysis.error || 'No changes detected', results: [] };
  }

  // Step 3: Filter testable changes
  const testable = analysis.classifications.filter(
    c => !config.skip_types.includes(c.changeType)
  );

  if (testable.length === 0) {
    return { skipped: true, reason: 'No testable changes', results: [] };
  }

  // Step 4: Read source files for context
  const fileSources = {};
  const fileDiffs = {};
  const readFile = readFileFn || defaultReadFile;

  for (const c of testable) {
    const fullPath = path.join(cwd, c.filePath);
    fileSources[c.filePath] = readFile(fullPath);

    // Extract per-file diff content from parsed files
    const fileDiff = analysis.files.find(f => (f.newPath || f.oldPath) === c.filePath);
    if (fileDiff) {
      fileDiffs[c.filePath] = fileDiff.addedLines.map(l => '+' + l).join('\n');
    }
  }

  // Step 5: Generate tests
  const genResults = getTestGenerator().generateTests({
    classifications: testable,
    functions: analysis.functions,
    framework,
    fileSources,
    fileDiffs,
    cwd,
    execFn
  });

  // Step 6: Write generated test files
  const written = [];
  for (const result of genResults) {
    if (result.success && result.code && result.testPath) {
      const fullTestPath = path.join(cwd, result.testPath);
      try {
        const dir = path.dirname(fullTestPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(fullTestPath, result.code, 'utf8');
        written.push(result.testPath);
      } catch (err) {
        result.writeError = err.message;
      }
    }
  }

  // Step 7: Run coverage gate (optional)
  const gateResults = [];
  if (config.coverage_gate) {
    for (const result of genResults) {
      if (result.success && result.testPath) {
        const gateResult = getCoverageGate().gate({
          testCommand: framework.testCommand,
          testPath: result.testPath,
          frameworkName: framework.name,
          changedRanges: analysis.ranges.filter(r => r.filePath === result.filePath),
          checkCoverageEnabled: true,
          minCoverage: config.min_coverage,
          cwd,
          execFn
        });
        gateResults.push({ filePath: result.filePath, testPath: result.testPath, gate: gateResult });
      }
    }
  }

  return {
    skipped: false,
    framework: framework.name,
    generated: genResults.length,
    written,
    results: genResults,
    gateResults,
    summary: buildSummary(genResults, gateResults, written)
  };
}

// ============================================================================
// HELPERS
// ============================================================================

function defaultReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function buildSummary(genResults, gateResults, written) {
  const total = genResults.length;
  const successful = genResults.filter(r => r.success).length;
  const failed = total - successful;

  let summary = `Generated ${successful}/${total} test files`;
  if (written.length > 0) {
    summary += `, wrote ${written.length} files`;
  }
  if (failed > 0) {
    summary += ` (${failed} failed)`;
  }
  if (gateResults.length > 0) {
    const gatePass = gateResults.filter(r => r.gate && r.gate.passed).length;
    summary += `. Coverage gate: ${gatePass}/${gateResults.length} passed`;
  }
  return summary;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  DEFAULT_CONFIG,
  loadConfig,
  runPipeline,
  // Exported for testing
  buildSummary,
  // Allow dependency injection for tests
  _setDeps: (deps) => {
    if (deps.changeAnalyzer) _changeAnalyzer = deps.changeAnalyzer;
    if (deps.frameworkDetector) _frameworkDetector = deps.frameworkDetector;
    if (deps.testGenerator) _testGenerator = deps.testGenerator;
    if (deps.coverageGate) _coverageGate = deps.coverageGate;
  },
  _resetDeps: () => {
    _changeAnalyzer = null;
    _frameworkDetector = null;
    _testGenerator = null;
    _coverageGate = null;
  }
};
