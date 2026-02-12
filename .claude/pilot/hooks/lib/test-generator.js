/**
 * Test Generator Engine — AI-powered test generation via claude -p
 *
 * Takes change analysis + framework info, generates test file via one-shot
 * claude -p call. Strategy routing: new function = unit test, bug fix =
 * regression test, refactor = snapshot/behavior test.
 *
 * Part of Phase 5.3 — Autonomous Test Generation (Pilot AGI-wra.3)
 */

const { execFileSync } = require('child_process');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const TEST_STRATEGIES = {
  UNIT: 'unit',
  REGRESSION: 'regression',
  BEHAVIOR: 'behavior'
};

/**
 * Map change types to test strategies.
 * Imported from change-analyzer CHANGE_TYPES.
 */
const STRATEGY_MAP = {
  new_function: TEST_STRATEGIES.UNIT,
  new_file: TEST_STRATEGIES.UNIT,
  bug_fix: TEST_STRATEGIES.REGRESSION,
  refactor: TEST_STRATEGIES.BEHAVIOR,
  config_change: null,     // no test generation
  deleted_file: null,      // no test generation
  test_change: null,       // already a test
  docs_change: null        // no test generation
};

const MAX_DIFF_LINES = 500;
const MAX_PROMPT_LENGTH = 12000;

// ============================================================================
// STRATEGY SELECTION
// ============================================================================

/**
 * Select the test strategy for a given change type.
 *
 * @param {string} changeType - One of CHANGE_TYPES values from change-analyzer
 * @returns {string|null} Test strategy or null if no test needed
 */
function selectStrategy(changeType) {
  if (!changeType || typeof changeType !== 'string') return null;
  return STRATEGY_MAP[changeType] || null;
}

/**
 * Filter classifications to only those that need test generation.
 *
 * @param {Array<Object>} classifications - Output from classifyChanges()
 * @returns {Array<Object>} Filtered classifications with strategy attached
 */
function filterTestableChanges(classifications) {
  if (!Array.isArray(classifications)) return [];
  return classifications
    .map(c => ({ ...c, strategy: selectStrategy(c.changeType) }))
    .filter(c => c.strategy !== null);
}

// ============================================================================
// PROMPT BUILDING
// ============================================================================

/**
 * Build a prompt for claude -p to generate tests.
 *
 * @param {Object} options
 * @param {Object} options.change - Single classification from classifyChanges()
 * @param {string} options.strategy - Test strategy (unit/regression/behavior)
 * @param {Array<Object>} options.functions - Extracted functions for this file
 * @param {Object} options.framework - Framework detection result
 * @param {string} [options.sourceCode] - Source code of the changed file
 * @param {string} [options.diffContent] - Diff content for the changed file
 * @returns {string} Prompt text
 */
function buildPrompt(options) {
  const { change, strategy, functions, framework, sourceCode, diffContent } = options || {};

  if (!change || !strategy || !framework) {
    return '';
  }

  const frameworkName = framework.name || 'vitest';
  const filePath = change.filePath || 'unknown';
  const funcNames = (functions || [])
    .filter(f => f.filePath === filePath)
    .map(f => f.functionName);

  let prompt = `Generate ${strategy} tests for the following code changes.\n\n`;
  prompt += `## Test Framework\n`;
  prompt += `Framework: ${frameworkName}\n`;
  prompt += `Test pattern: ${framework.testPattern || '**/*.test.js'}\n\n`;

  prompt += `## Changed File\n`;
  prompt += `File: ${filePath}\n`;
  prompt += `Change type: ${change.changeType}\n`;

  if (funcNames.length > 0) {
    prompt += `Functions: ${funcNames.join(', ')}\n`;
  }

  prompt += '\n';

  // Strategy-specific instructions
  if (strategy === TEST_STRATEGIES.UNIT) {
    prompt += `## Instructions\n`;
    prompt += `Write unit tests for each new or changed function.\n`;
    prompt += `- Test normal inputs, edge cases, and error conditions\n`;
    prompt += `- Mock external dependencies\n`;
    prompt += `- Each test should be independent\n\n`;
  } else if (strategy === TEST_STRATEGIES.REGRESSION) {
    prompt += `## Instructions\n`;
    prompt += `Write regression tests that verify the bug fix.\n`;
    prompt += `- Include a test that reproduces the original bug (would fail without fix)\n`;
    prompt += `- Include a test that verifies the correct behavior after fix\n`;
    prompt += `- Test edge cases around the fix boundary\n\n`;
  } else if (strategy === TEST_STRATEGIES.BEHAVIOR) {
    prompt += `## Instructions\n`;
    prompt += `Write behavior tests that verify the refactored code preserves behavior.\n`;
    prompt += `- Test public API / exported functions\n`;
    prompt += `- Verify same inputs produce same outputs as before\n`;
    prompt += `- Test interface contracts, not implementation details\n\n`;
  }

  if (diffContent) {
    const trimmedDiff = truncateLines(diffContent, MAX_DIFF_LINES);
    prompt += `## Diff\n\`\`\`diff\n${trimmedDiff}\n\`\`\`\n\n`;
  }

  if (sourceCode) {
    prompt += `## Source Code\n\`\`\`\n${sourceCode}\n\`\`\`\n\n`;
  }

  prompt += `## Output Format\n`;
  prompt += `Return ONLY the test file content. No explanations, no markdown fences around the entire output.\n`;
  prompt += `The output must be a valid, runnable test file using ${frameworkName}.\n`;

  // Enforce max prompt length
  if (prompt.length > MAX_PROMPT_LENGTH) {
    prompt = prompt.slice(0, MAX_PROMPT_LENGTH);
  }

  return prompt;
}

// ============================================================================
// CLAUDE INVOCATION
// ============================================================================

/**
 * Invoke claude -p with a prompt and return the response.
 * Uses execFileSync (not exec) to avoid shell injection — arguments are
 * passed as an array, never interpolated into a shell string.
 *
 * @param {string} prompt - The prompt to send
 * @param {Object} [options]
 * @param {string} [options.cwd] - Working directory
 * @param {number} [options.timeout] - Timeout in ms (default 120000)
 * @param {Function} [options.execFn] - Custom exec function (for testing)
 * @returns {Object} { success, output, error }
 */
function invokeClaude(prompt, options = {}) {
  const { cwd, timeout = 120000, execFn } = options;

  if (!prompt || typeof prompt !== 'string') {
    return { success: false, output: '', error: 'Empty prompt' };
  }

  const exec = execFn || execFileSync;

  try {
    const output = exec('claude', ['-p', prompt], {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      timeout,
      maxBuffer: 5 * 1024 * 1024
    });

    return { success: true, output: output || '', error: null };
  } catch (err) {
    return {
      success: false,
      output: '',
      error: err.message || 'claude invocation failed'
    };
  }
}

// ============================================================================
// OUTPUT PARSING
// ============================================================================

/**
 * Parse test code from claude response.
 * Strips markdown fences, leading/trailing whitespace, and validates
 * that the output looks like a test file.
 *
 * @param {string} rawOutput - Raw response from claude
 * @param {string} frameworkName - Expected test framework
 * @returns {Object} { code, valid, issues }
 */
function parseTestOutput(rawOutput, frameworkName) {
  if (!rawOutput || typeof rawOutput !== 'string') {
    return { code: '', valid: false, issues: ['Empty output'] };
  }

  let code = rawOutput.trim();
  const issues = [];

  // Strip markdown code fences if present
  const fenceMatch = code.match(/^```(?:\w+)?\n([\s\S]*?)```\s*$/);
  if (fenceMatch) {
    code = fenceMatch[1].trim();
  }

  // Also handle multiple code blocks — take the first one
  if (!fenceMatch) {
    const blockMatch = code.match(/```(?:\w+)?\n([\s\S]*?)```/);
    if (blockMatch) {
      code = blockMatch[1].trim();
    }
  }

  // Validate: should contain test-related keywords
  const hasTestKeyword = /\b(test|it|describe|expect|assert|should)\s*\(/.test(code);
  if (!hasTestKeyword) {
    issues.push('No test keywords found (test, it, describe, expect, assert)');
  }

  // Validate: should import or require the framework
  const fw = (frameworkName || '').toLowerCase();
  const hasImport = code.includes('require(') || code.includes('import ');
  if (!hasImport && fw !== 'node:test') {
    issues.push('No import/require statement found');
  }

  // Validate: non-trivially short
  if (code.split('\n').length < 5) {
    issues.push('Output too short (less than 5 lines)');
  }

  return {
    code,
    valid: issues.length === 0,
    issues
  };
}

// ============================================================================
// TEST FILE PATH GENERATION
// ============================================================================

/**
 * Generate the output test file path for a given source file.
 *
 * @param {string} sourceFilePath - Path to the source file
 * @param {Object} framework - Framework detection result
 * @returns {string} Path to the generated test file
 */
function generateTestPath(sourceFilePath, framework) {
  if (!sourceFilePath) return 'tests/generated.test.js';

  const ext = path.extname(sourceFilePath);
  const basename = path.basename(sourceFilePath, ext);
  const testDir = (framework && framework.testDir) || 'tests';

  // Determine test file extension based on source
  if (ext === '.ts' || ext === '.tsx') {
    return path.join(testDir, basename + '.test.ts');
  } else if (ext === '.py') {
    return path.join(testDir, `test_${basename}.py`);
  } else if (ext === '.go') {
    const dir = path.dirname(sourceFilePath);
    return path.join(dir, `${basename}_test.go`);
  } else if (ext === '.rs') {
    return path.join(testDir, `${basename}_test.rs`);
  }

  return path.join(testDir, basename + '.test.js');
}

// ============================================================================
// HIGH-LEVEL API
// ============================================================================

/**
 * Generate tests for a set of code changes.
 *
 * @param {Object} options
 * @param {Array<Object>} options.classifications - From change-analyzer classifyChanges()
 * @param {Array<Object>} options.functions - From change-analyzer extractChangedFunctions()
 * @param {Object} options.framework - From framework-detector detectFramework()
 * @param {Object} [options.fileSources] - Map of filePath → source code content
 * @param {Object} [options.fileDiffs] - Map of filePath → diff text
 * @param {string} [options.cwd] - Working directory
 * @param {Function} [options.execFn] - Custom exec function (for testing)
 * @returns {Array<Object>} Generated test results
 */
function generateTests(options = {}) {
  const {
    classifications,
    functions,
    framework,
    fileSources = {},
    fileDiffs = {},
    cwd,
    execFn
  } = options;

  if (!framework || !framework.detected) {
    return [{ error: 'No test framework detected', files: [] }];
  }

  const testable = filterTestableChanges(classifications);
  if (testable.length === 0) {
    return [];
  }

  const results = [];

  for (const change of testable) {
    const prompt = buildPrompt({
      change,
      strategy: change.strategy,
      functions: functions || [],
      framework,
      sourceCode: fileSources[change.filePath],
      diffContent: fileDiffs[change.filePath]
    });

    if (!prompt) {
      results.push({
        filePath: change.filePath,
        testPath: null,
        strategy: change.strategy,
        success: false,
        error: 'Failed to build prompt'
      });
      continue;
    }

    const response = invokeClaude(prompt, { cwd, execFn });
    if (!response.success) {
      results.push({
        filePath: change.filePath,
        testPath: null,
        strategy: change.strategy,
        success: false,
        error: response.error
      });
      continue;
    }

    const parsed = parseTestOutput(response.output, framework.name);
    const testPath = generateTestPath(change.filePath, framework);

    results.push({
      filePath: change.filePath,
      testPath,
      strategy: change.strategy,
      success: parsed.valid,
      code: parsed.code,
      issues: parsed.issues
    });
  }

  return results;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Truncate text to a maximum number of lines.
 */
function truncateLines(text, maxLines) {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + '\n... (truncated)';
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  TEST_STRATEGIES,
  STRATEGY_MAP,
  selectStrategy,
  filterTestableChanges,
  buildPrompt,
  invokeClaude,
  parseTestOutput,
  generateTestPath,
  generateTests
};
