#!/usr/bin/env node

/**
 * Verification tests for Test Generator Engine (Phase 5.3 — Pilot AGI-wra.3)
 * Run: node tests/test-generator.test.js
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
  TEST_STRATEGIES,
  STRATEGY_MAP,
  selectStrategy,
  filterTestableChanges,
  buildPrompt,
  invokeClaude,
  parseTestOutput,
  generateTestPath,
  generateTests
} = require(path.join(__dirname, '..', '.claude', 'pilot', 'hooks', 'lib', 'test-generator.js'));

// =============================================================================
// MOCK DATA
// =============================================================================

const MOCK_FRAMEWORK_VITEST = {
  name: 'vitest',
  configPath: '/project/vitest.config.ts',
  testCommand: 'npx vitest run',
  testDir: 'tests',
  testPattern: '**/*.test.{js,ts,jsx,tsx}',
  language: 'js',
  detected: true
};

const MOCK_FRAMEWORK_JEST = {
  name: 'jest',
  configPath: '/project/jest.config.js',
  testCommand: 'npx jest',
  testDir: '__tests__',
  testPattern: '**/*.test.{js,ts,jsx,tsx}',
  language: 'js',
  detected: true
};

const MOCK_FRAMEWORK_PYTEST = {
  name: 'pytest',
  configPath: '/project/pytest.ini',
  testCommand: 'pytest',
  testDir: 'tests',
  testPattern: '**/test_*.py',
  language: 'py',
  detected: true
};

const MOCK_FRAMEWORK_UNDETECTED = {
  name: null,
  configPath: null,
  testCommand: null,
  testDir: null,
  testPattern: null,
  language: null,
  detected: false
};

const MOCK_NEW_FUNCTION_CHANGE = {
  filePath: 'src/utils.js',
  changeType: 'new_function',
  isNew: false,
  isDeleted: false,
  addedCount: 10,
  removedCount: 0
};

const MOCK_BUG_FIX_CHANGE = {
  filePath: 'src/auth.js',
  changeType: 'bug_fix',
  isNew: false,
  isDeleted: false,
  addedCount: 3,
  removedCount: 1
};

const MOCK_REFACTOR_CHANGE = {
  filePath: 'src/service.js',
  changeType: 'refactor',
  isNew: false,
  isDeleted: false,
  addedCount: 8,
  removedCount: 8
};

const MOCK_CONFIG_CHANGE = {
  filePath: 'tsconfig.json',
  changeType: 'config_change',
  isNew: false,
  isDeleted: false,
  addedCount: 1,
  removedCount: 0
};

const MOCK_DELETED_CHANGE = {
  filePath: 'src/legacy.js',
  changeType: 'deleted_file',
  isNew: false,
  isDeleted: true,
  addedCount: 0,
  removedCount: 10
};

const MOCK_TEST_CHANGE = {
  filePath: 'tests/auth.test.js',
  changeType: 'test_change',
  isNew: false,
  isDeleted: false,
  addedCount: 5,
  removedCount: 0
};

const MOCK_DOCS_CHANGE = {
  filePath: 'README.md',
  changeType: 'docs_change',
  isNew: false,
  isDeleted: false,
  addedCount: 3,
  removedCount: 0
};

const MOCK_NEW_FILE_CHANGE = {
  filePath: 'src/logger.js',
  changeType: 'new_file',
  isNew: true,
  isDeleted: false,
  addedCount: 15,
  removedCount: 0
};

const MOCK_FUNCTIONS = [
  { filePath: 'src/utils.js', functionName: 'newHelper', language: 'js', lineNumber: 12 },
  { filePath: 'src/utils.js', functionName: 'arrowFunc', language: 'js', lineNumber: 18 },
  { filePath: 'src/logger.js', functionName: 'createLogger', language: 'js', lineNumber: 3 }
];

// Mock claude response — valid vitest test file
const MOCK_CLAUDE_VALID_RESPONSE = `import { describe, it, expect } from 'vitest';
import { newHelper, arrowFunc } from '../src/utils.js';

describe('newHelper', () => {
  it('returns 0 for negative input', () => {
    expect(newHelper(-1)).toBe(0);
  });

  it('doubles positive input', () => {
    expect(newHelper(5)).toBe(10);
  });

  it('returns 0 for zero', () => {
    expect(newHelper(0)).toBe(0);
  });
});

describe('arrowFunc', () => {
  it('adds two numbers', () => {
    expect(arrowFunc(2, 3)).toBe(5);
  });
});
`;

const MOCK_CLAUDE_FENCED_RESPONSE = '```javascript\n' + MOCK_CLAUDE_VALID_RESPONSE + '```';

const MOCK_CLAUDE_INVALID_RESPONSE = 'Here is some explanation about the code...';

const MOCK_CLAUDE_SHORT_RESPONSE = 'test("x", () => {})';

// =============================================================================
// TESTS: selectStrategy
// =============================================================================

console.log('\n=== selectStrategy ===');

test('maps new_function to unit strategy', () => {
  assertEqual(selectStrategy('new_function'), TEST_STRATEGIES.UNIT, 'unit');
});

test('maps new_file to unit strategy', () => {
  assertEqual(selectStrategy('new_file'), TEST_STRATEGIES.UNIT, 'unit');
});

test('maps bug_fix to regression strategy', () => {
  assertEqual(selectStrategy('bug_fix'), TEST_STRATEGIES.REGRESSION, 'regression');
});

test('maps refactor to behavior strategy', () => {
  assertEqual(selectStrategy('refactor'), TEST_STRATEGIES.BEHAVIOR, 'behavior');
});

test('returns null for config_change', () => {
  assertEqual(selectStrategy('config_change'), null, 'null');
});

test('returns null for deleted_file', () => {
  assertEqual(selectStrategy('deleted_file'), null, 'null');
});

test('returns null for test_change', () => {
  assertEqual(selectStrategy('test_change'), null, 'null');
});

test('returns null for docs_change', () => {
  assertEqual(selectStrategy('docs_change'), null, 'null');
});

test('returns null for unknown type', () => {
  assertEqual(selectStrategy('unknown_type'), null, 'null');
});

test('returns null for empty/null input', () => {
  assertEqual(selectStrategy(null), null, 'null input');
  assertEqual(selectStrategy(''), null, 'empty string');
  assertEqual(selectStrategy(undefined), null, 'undefined');
});

// =============================================================================
// TESTS: filterTestableChanges
// =============================================================================

console.log('\n=== filterTestableChanges ===');

test('filters to only testable changes', () => {
  const all = [
    MOCK_NEW_FUNCTION_CHANGE,
    MOCK_CONFIG_CHANGE,
    MOCK_BUG_FIX_CHANGE,
    MOCK_DELETED_CHANGE,
    MOCK_REFACTOR_CHANGE,
    MOCK_TEST_CHANGE,
    MOCK_DOCS_CHANGE,
    MOCK_NEW_FILE_CHANGE
  ];
  const result = filterTestableChanges(all);
  assertEqual(result.length, 4, 'count');
  assertEqual(result[0].strategy, 'unit', 'first strategy');
  assertEqual(result[1].strategy, 'regression', 'second strategy');
  assertEqual(result[2].strategy, 'behavior', 'third strategy');
  assertEqual(result[3].strategy, 'unit', 'fourth strategy');
});

test('returns empty for non-array input', () => {
  assertEqual(filterTestableChanges(null).length, 0, 'null');
  assertEqual(filterTestableChanges('not array').length, 0, 'string');
  assertEqual(filterTestableChanges(undefined).length, 0, 'undefined');
});

test('returns empty when all changes are non-testable', () => {
  const result = filterTestableChanges([MOCK_CONFIG_CHANGE, MOCK_DELETED_CHANGE, MOCK_DOCS_CHANGE]);
  assertEqual(result.length, 0, 'empty');
});

// =============================================================================
// TESTS: buildPrompt
// =============================================================================

console.log('\n=== buildPrompt ===');

test('builds unit test prompt for new function', () => {
  const prompt = buildPrompt({
    change: MOCK_NEW_FUNCTION_CHANGE,
    strategy: TEST_STRATEGIES.UNIT,
    functions: MOCK_FUNCTIONS,
    framework: MOCK_FRAMEWORK_VITEST
  });
  assertIncludes(prompt, 'unit', 'has strategy');
  assertIncludes(prompt, 'vitest', 'has framework');
  assertIncludes(prompt, 'src/utils.js', 'has file path');
  assertIncludes(prompt, 'newHelper', 'has function name');
  assertIncludes(prompt, 'arrowFunc', 'has second function');
  assertIncludes(prompt, 'unit tests for each new', 'has unit instructions');
});

test('builds regression test prompt for bug fix', () => {
  const prompt = buildPrompt({
    change: MOCK_BUG_FIX_CHANGE,
    strategy: TEST_STRATEGIES.REGRESSION,
    functions: [],
    framework: MOCK_FRAMEWORK_VITEST
  });
  assertIncludes(prompt, 'regression', 'has strategy');
  assertIncludes(prompt, 'reproduces the original bug', 'has regression instructions');
});

test('builds behavior test prompt for refactor', () => {
  const prompt = buildPrompt({
    change: MOCK_REFACTOR_CHANGE,
    strategy: TEST_STRATEGIES.BEHAVIOR,
    functions: [],
    framework: MOCK_FRAMEWORK_VITEST
  });
  assertIncludes(prompt, 'behavior', 'has strategy');
  assertIncludes(prompt, 'preserves behavior', 'has behavior instructions');
});

test('includes diff content when provided', () => {
  const prompt = buildPrompt({
    change: MOCK_NEW_FUNCTION_CHANGE,
    strategy: TEST_STRATEGIES.UNIT,
    functions: [],
    framework: MOCK_FRAMEWORK_VITEST,
    diffContent: '+function newHelper(x) {\n+  return x * 2;\n+}'
  });
  assertIncludes(prompt, '## Diff', 'has diff section');
  assertIncludes(prompt, 'newHelper', 'has diff content');
});

test('includes source code when provided', () => {
  const prompt = buildPrompt({
    change: MOCK_NEW_FUNCTION_CHANGE,
    strategy: TEST_STRATEGIES.UNIT,
    functions: [],
    framework: MOCK_FRAMEWORK_VITEST,
    sourceCode: 'function newHelper(x) { return x * 2; }'
  });
  assertIncludes(prompt, '## Source Code', 'has source section');
});

test('returns empty string for missing required params', () => {
  assertEqual(buildPrompt(null), '', 'null');
  assertEqual(buildPrompt({}), '', 'empty');
  assertEqual(buildPrompt({ change: MOCK_NEW_FUNCTION_CHANGE }), '', 'missing strategy+framework');
  assertEqual(buildPrompt({ change: MOCK_NEW_FUNCTION_CHANGE, strategy: 'unit' }), '', 'missing framework');
});

test('uses correct framework name in prompt', () => {
  const prompt = buildPrompt({
    change: MOCK_NEW_FUNCTION_CHANGE,
    strategy: TEST_STRATEGIES.UNIT,
    functions: [],
    framework: MOCK_FRAMEWORK_JEST
  });
  assertIncludes(prompt, 'jest', 'has jest framework');
});

test('truncates prompt at MAX_PROMPT_LENGTH', () => {
  const longSource = 'x'.repeat(20000);
  const prompt = buildPrompt({
    change: MOCK_NEW_FUNCTION_CHANGE,
    strategy: TEST_STRATEGIES.UNIT,
    functions: [],
    framework: MOCK_FRAMEWORK_VITEST,
    sourceCode: longSource
  });
  assert(prompt.length <= 12000, 'prompt within limit: ' + prompt.length);
});

// =============================================================================
// TESTS: invokeClaude
// =============================================================================

console.log('\n=== invokeClaude ===');

test('calls claude with correct args via execFn', () => {
  let capturedArgs = null;
  const mockExec = (cmd, args, opts) => {
    capturedArgs = { cmd, args, opts };
    return MOCK_CLAUDE_VALID_RESPONSE;
  };

  const result = invokeClaude('test prompt', { execFn: mockExec });
  assert(result.success, 'success');
  assertEqual(capturedArgs.cmd, 'claude', 'command');
  assertEqual(capturedArgs.args[0], '-p', 'flag');
  assertEqual(capturedArgs.args[1], 'test prompt', 'prompt');
  assertEqual(result.output, MOCK_CLAUDE_VALID_RESPONSE, 'output');
  assertEqual(result.error, null, 'no error');
});

test('returns error for empty prompt', () => {
  const result = invokeClaude('');
  assert(!result.success, 'not success');
  assertEqual(result.error, 'Empty prompt', 'error msg');
});

test('returns error for null prompt', () => {
  const result = invokeClaude(null);
  assert(!result.success, 'not success');
});

test('handles exec failure gracefully', () => {
  const mockExec = () => { throw new Error('command not found'); };
  const result = invokeClaude('test prompt', { execFn: mockExec });
  assert(!result.success, 'not success');
  assertIncludes(result.error, 'command not found', 'error contains message');
});

test('passes cwd and timeout to exec', () => {
  let capturedOpts = null;
  const mockExec = (cmd, args, opts) => {
    capturedOpts = opts;
    return '';
  };

  invokeClaude('test', { cwd: '/my/dir', timeout: 60000, execFn: mockExec });
  assertEqual(capturedOpts.cwd, '/my/dir', 'cwd');
  assertEqual(capturedOpts.timeout, 60000, 'timeout');
});

// =============================================================================
// TESTS: parseTestOutput
// =============================================================================

console.log('\n=== parseTestOutput ===');

test('parses valid test output', () => {
  const result = parseTestOutput(MOCK_CLAUDE_VALID_RESPONSE, 'vitest');
  assert(result.valid, 'valid');
  assertEqual(result.issues.length, 0, 'no issues');
  assertIncludes(result.code, 'describe(', 'has describe');
  assertIncludes(result.code, 'import', 'has import');
});

test('strips markdown code fences', () => {
  const result = parseTestOutput(MOCK_CLAUDE_FENCED_RESPONSE, 'vitest');
  assert(result.valid, 'valid');
  assert(!result.code.includes('```'), 'no fences');
  assertIncludes(result.code, 'describe(', 'has describe');
});

test('handles embedded code blocks', () => {
  const withBlock = 'Some text\n```js\n' + MOCK_CLAUDE_VALID_RESPONSE + '```\nMore text';
  const result = parseTestOutput(withBlock, 'vitest');
  assert(result.valid, 'valid');
  assertIncludes(result.code, 'describe(', 'has describe');
});

test('detects missing test keywords', () => {
  const result = parseTestOutput(MOCK_CLAUDE_INVALID_RESPONSE, 'vitest');
  assert(!result.valid, 'not valid');
  assert(result.issues.some(i => i.includes('No test keywords')), 'has keyword issue');
});

test('detects too-short output', () => {
  const result = parseTestOutput(MOCK_CLAUDE_SHORT_RESPONSE, 'vitest');
  assert(!result.valid, 'not valid');
  assert(result.issues.some(i => i.includes('too short')), 'has short issue');
});

test('handles empty/null input', () => {
  const r1 = parseTestOutput('', 'vitest');
  assert(!r1.valid, 'empty not valid');
  assertEqual(r1.code, '', 'empty code');

  const r2 = parseTestOutput(null, 'vitest');
  assert(!r2.valid, 'null not valid');
});

test('allows node:test without import requirement', () => {
  const nodeTestCode = `const { test } = require('node:test');
const assert = require('assert');

test('example', () => {
  assert.strictEqual(1 + 1, 2);
});
`;
  const result = parseTestOutput(nodeTestCode, 'node:test');
  assert(result.valid, 'valid for node:test');
});

// =============================================================================
// TESTS: generateTestPath
// =============================================================================

console.log('\n=== generateTestPath ===');

test('generates JS test path', () => {
  const result = generateTestPath('src/utils.js', MOCK_FRAMEWORK_VITEST);
  assertEqual(result, path.join('tests', 'utils.test.js'), 'js path');
});

test('generates TS test path', () => {
  const result = generateTestPath('src/api.ts', MOCK_FRAMEWORK_VITEST);
  assertEqual(result, path.join('tests', 'api.test.ts'), 'ts path');
});

test('generates Python test path', () => {
  const result = generateTestPath('app/models.py', MOCK_FRAMEWORK_PYTEST);
  assertEqual(result, path.join('tests', 'test_models.py'), 'py path');
});

test('generates Go test path (co-located)', () => {
  const result = generateTestPath('handlers/user.go', MOCK_FRAMEWORK_VITEST);
  assertEqual(result, path.join('handlers', 'user_test.go'), 'go path');
});

test('generates Rust test path', () => {
  const result = generateTestPath('src/lib.rs', MOCK_FRAMEWORK_VITEST);
  assertEqual(result, path.join('tests', 'lib_test.rs'), 'rust path');
});

test('uses framework testDir', () => {
  const result = generateTestPath('src/app.js', MOCK_FRAMEWORK_JEST);
  assertEqual(result, path.join('__tests__', 'app.test.js'), 'jest dir');
});

test('handles missing sourceFilePath', () => {
  const result = generateTestPath(null, MOCK_FRAMEWORK_VITEST);
  assertEqual(result, 'tests/generated.test.js', 'default path');
});

// =============================================================================
// TESTS: generateTests (integration)
// =============================================================================

console.log('\n=== generateTests ===');

test('generates tests for testable changes with mocked claude', () => {
  const mockExec = () => MOCK_CLAUDE_VALID_RESPONSE;

  const results = generateTests({
    classifications: [MOCK_NEW_FUNCTION_CHANGE, MOCK_CONFIG_CHANGE],
    functions: MOCK_FUNCTIONS,
    framework: MOCK_FRAMEWORK_VITEST,
    execFn: mockExec
  });

  assertEqual(results.length, 1, 'one testable change');
  assert(results[0].success, 'success');
  assertEqual(results[0].strategy, 'unit', 'strategy');
  assertEqual(results[0].filePath, 'src/utils.js', 'file path');
  assertIncludes(results[0].testPath, 'utils.test.js', 'test path');
  assertIncludes(results[0].code, 'describe(', 'has code');
});

test('returns empty for no testable changes', () => {
  const results = generateTests({
    classifications: [MOCK_CONFIG_CHANGE, MOCK_DELETED_CHANGE],
    functions: [],
    framework: MOCK_FRAMEWORK_VITEST
  });
  assertEqual(results.length, 0, 'no results');
});

test('returns error when no framework detected', () => {
  const results = generateTests({
    classifications: [MOCK_NEW_FUNCTION_CHANGE],
    functions: [],
    framework: MOCK_FRAMEWORK_UNDETECTED
  });
  assertEqual(results.length, 1, 'one error');
  assertIncludes(results[0].error, 'No test framework', 'error message');
});

test('handles claude invocation failure', () => {
  const mockExec = () => { throw new Error('timeout'); };

  const results = generateTests({
    classifications: [MOCK_NEW_FUNCTION_CHANGE],
    functions: [],
    framework: MOCK_FRAMEWORK_VITEST,
    execFn: mockExec
  });

  assertEqual(results.length, 1, 'one result');
  assert(!results[0].success, 'not success');
  assertIncludes(results[0].error, 'timeout', 'error message');
});

test('handles invalid claude response', () => {
  const mockExec = () => MOCK_CLAUDE_INVALID_RESPONSE;

  const results = generateTests({
    classifications: [MOCK_NEW_FUNCTION_CHANGE],
    functions: [],
    framework: MOCK_FRAMEWORK_VITEST,
    execFn: mockExec
  });

  assertEqual(results.length, 1, 'one result');
  assert(!results[0].success, 'not success');
  assert(results[0].issues.length > 0, 'has issues');
});

test('generates multiple test files for multiple testable changes', () => {
  const mockExec = () => MOCK_CLAUDE_VALID_RESPONSE;

  const results = generateTests({
    classifications: [MOCK_NEW_FUNCTION_CHANGE, MOCK_BUG_FIX_CHANGE, MOCK_REFACTOR_CHANGE],
    functions: MOCK_FUNCTIONS,
    framework: MOCK_FRAMEWORK_VITEST,
    execFn: mockExec
  });

  assertEqual(results.length, 3, 'three results');
  assertEqual(results[0].strategy, 'unit', 'first strategy');
  assertEqual(results[1].strategy, 'regression', 'second strategy');
  assertEqual(results[2].strategy, 'behavior', 'third strategy');
});

test('passes fileSources and fileDiffs to prompt builder', () => {
  let capturedPrompt = '';
  const mockExec = (cmd, args) => {
    capturedPrompt = args[1];
    return MOCK_CLAUDE_VALID_RESPONSE;
  };

  generateTests({
    classifications: [MOCK_NEW_FUNCTION_CHANGE],
    functions: [],
    framework: MOCK_FRAMEWORK_VITEST,
    fileSources: { 'src/utils.js': 'function newHelper(x) { return x * 2; }' },
    fileDiffs: { 'src/utils.js': '+function newHelper(x) { return x * 2; }' },
    execFn: mockExec
  });

  assertIncludes(capturedPrompt, '## Source Code', 'has source');
  assertIncludes(capturedPrompt, '## Diff', 'has diff');
});

// =============================================================================
// TESTS: Module exports
// =============================================================================

console.log('\n=== Module exports ===');

test('exports all expected functions and constants', () => {
  assert(typeof selectStrategy === 'function', 'selectStrategy');
  assert(typeof filterTestableChanges === 'function', 'filterTestableChanges');
  assert(typeof buildPrompt === 'function', 'buildPrompt');
  assert(typeof invokeClaude === 'function', 'invokeClaude');
  assert(typeof parseTestOutput === 'function', 'parseTestOutput');
  assert(typeof generateTestPath === 'function', 'generateTestPath');
  assert(typeof generateTests === 'function', 'generateTests');
  assert(TEST_STRATEGIES.UNIT === 'unit', 'UNIT constant');
  assert(TEST_STRATEGIES.REGRESSION === 'regression', 'REGRESSION constant');
  assert(TEST_STRATEGIES.BEHAVIOR === 'behavior', 'BEHAVIOR constant');
  assert(typeof STRATEGY_MAP === 'object', 'STRATEGY_MAP');
});

// =============================================================================
// SUMMARY
// =============================================================================

console.log('\n========================================');
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
console.log('========================================\n');

process.exit(failed > 0 ? 1 : 0);
