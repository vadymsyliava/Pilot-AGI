/**
 * Framework Detector — auto-detect project test framework
 *
 * Scans package.json, config files to detect the test framework in use.
 * Returns framework name, config path, test command, test directory convention.
 *
 * Part of Phase 5.3 — Autonomous Test Generation (Pilot AGI-wra.2)
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const FRAMEWORKS = {
  VITEST: 'vitest',
  JEST: 'jest',
  MOCHA: 'mocha',
  NODE_TEST: 'node:test',
  PYTEST: 'pytest',
  GO_TEST: 'go_test',
  CARGO_TEST: 'cargo_test'
};

/**
 * Framework detection rules. Order matters — first match wins.
 * Each entry defines config files to check, package.json indicators, and defaults.
 */
const DETECTION_RULES = [
  {
    name: FRAMEWORKS.VITEST,
    configFiles: [
      'vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs'
    ],
    packageJsonKey: 'vitest',
    packageJsonScript: /vitest/,
    testCommand: 'npx vitest run',
    testDir: 'tests',
    testPattern: '**/*.test.{js,ts,jsx,tsx}',
    language: 'js'
  },
  {
    name: FRAMEWORKS.JEST,
    configFiles: [
      'jest.config.ts', 'jest.config.js', 'jest.config.mjs', 'jest.config.cjs', 'jest.config.json'
    ],
    packageJsonKey: 'jest',
    packageJsonScript: /jest/,
    testCommand: 'npx jest',
    testDir: '__tests__',
    testPattern: '**/*.test.{js,ts,jsx,tsx}',
    language: 'js'
  },
  {
    name: FRAMEWORKS.MOCHA,
    configFiles: [
      '.mocharc.yml', '.mocharc.yaml', '.mocharc.json', '.mocharc.js', '.mocharc.cjs'
    ],
    packageJsonKey: 'mocha',
    packageJsonScript: /mocha/,
    testCommand: 'npx mocha',
    testDir: 'test',
    testPattern: '**/*.test.{js,ts}',
    language: 'js'
  },
  {
    name: FRAMEWORKS.NODE_TEST,
    configFiles: [],
    packageJsonKey: null,
    packageJsonScript: /node --test|node:test/,
    testCommand: 'node --test',
    testDir: 'tests',
    testPattern: '**/*.test.js',
    language: 'js'
  },
  {
    name: FRAMEWORKS.PYTEST,
    configFiles: [
      'pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'
    ],
    markerFiles: ['pytest.ini'],
    markerContent: { 'pyproject.toml': /\[tool\.pytest/, 'setup.cfg': /\[tool:pytest\]/, 'tox.ini': /\[pytest\]/ },
    testCommand: 'pytest',
    testDir: 'tests',
    testPattern: '**/test_*.py',
    language: 'py'
  },
  {
    name: FRAMEWORKS.GO_TEST,
    configFiles: ['go.mod'],
    testCommand: 'go test ./...',
    testDir: '.',
    testPattern: '**/*_test.go',
    language: 'go'
  },
  {
    name: FRAMEWORKS.CARGO_TEST,
    configFiles: ['Cargo.toml'],
    testCommand: 'cargo test',
    testDir: 'tests',
    testPattern: '**/*_test.rs',
    language: 'rust'
  }
];

// ============================================================================
// DETECTOR
// ============================================================================

/**
 * Check if a file exists at the given path.
 */
function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Read and parse package.json if it exists.
 */
function readPackageJson(cwd) {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fileExists(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Detect test framework from config files.
 *
 * @param {Object} rule - Detection rule
 * @param {string} cwd - Working directory
 * @returns {string|null} Config file path if found
 */
function detectFromConfigFiles(rule, cwd) {
  for (const configFile of (rule.configFiles || [])) {
    const configPath = path.join(cwd, configFile);
    if (fileExists(configPath)) {
      // For frameworks with marker content, verify the file contains the marker
      if (rule.markerContent && rule.markerContent[configFile]) {
        try {
          const content = fs.readFileSync(configPath, 'utf8');
          if (rule.markerContent[configFile].test(content)) {
            return configPath;
          }
        } catch {
          continue;
        }
      } else if (rule.markerFiles && rule.markerFiles.includes(configFile)) {
        return configPath;
      } else if (!rule.markerContent) {
        return configPath;
      }
    }
  }
  return null;
}

/**
 * Detect test framework from package.json.
 *
 * @param {Object} rule - Detection rule
 * @param {Object} pkg - Parsed package.json
 * @returns {boolean} Whether the framework was found
 */
function detectFromPackageJson(rule, pkg) {
  if (!pkg) return false;

  // Check devDependencies and dependencies
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (rule.packageJsonKey && deps[rule.packageJsonKey]) return true;

  // Check scripts for test command pattern
  if (rule.packageJsonScript && pkg.scripts) {
    const testScript = pkg.scripts.test || '';
    if (rule.packageJsonScript.test(testScript)) return true;
  }

  // Check for jest config in package.json
  if (rule.name === FRAMEWORKS.JEST && pkg.jest) return true;

  return false;
}

/**
 * Find actual test directory by checking common conventions.
 */
function findTestDir(cwd, defaultDir) {
  const candidates = [defaultDir, 'tests', 'test', '__tests__', 'spec'];
  for (const dir of candidates) {
    const dirPath = path.join(cwd, dir);
    try {
      if (fs.statSync(dirPath).isDirectory()) return dir;
    } catch {
      continue;
    }
  }
  return defaultDir;
}

/**
 * Detect the test framework used in a project.
 *
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @returns {Object} Detection result
 * @returns {string} result.name - Framework name (one of FRAMEWORKS values)
 * @returns {string|null} result.configPath - Path to framework config file
 * @returns {string} result.testCommand - Command to run tests
 * @returns {string} result.testDir - Test directory convention
 * @returns {string} result.testPattern - Glob pattern for test files
 * @returns {string} result.language - Primary language
 * @returns {boolean} result.detected - Whether a framework was detected
 */
function detectFramework(cwd) {
  cwd = cwd || process.cwd();
  const pkg = readPackageJson(cwd);

  for (const rule of DETECTION_RULES) {
    // Try config files first
    const configPath = detectFromConfigFiles(rule, cwd);
    if (configPath) {
      return {
        name: rule.name,
        configPath,
        testCommand: rule.testCommand,
        testDir: findTestDir(cwd, rule.testDir),
        testPattern: rule.testPattern,
        language: rule.language,
        detected: true
      };
    }

    // Try package.json
    if (detectFromPackageJson(rule, pkg)) {
      return {
        name: rule.name,
        configPath: path.join(cwd, 'package.json'),
        testCommand: rule.testCommand,
        testDir: findTestDir(cwd, rule.testDir),
        testPattern: rule.testPattern,
        language: rule.language,
        detected: true
      };
    }
  }

  // No framework detected
  return {
    name: null,
    configPath: null,
    testCommand: null,
    testDir: null,
    testPattern: null,
    language: null,
    detected: false
  };
}

/**
 * Detect all test frameworks in a project (some projects use multiple).
 *
 * @param {string} [cwd] - Working directory
 * @returns {Array<Object>} Array of detection results
 */
function detectAllFrameworks(cwd) {
  cwd = cwd || process.cwd();
  const pkg = readPackageJson(cwd);
  const results = [];

  for (const rule of DETECTION_RULES) {
    const configPath = detectFromConfigFiles(rule, cwd);
    if (configPath || detectFromPackageJson(rule, pkg)) {
      results.push({
        name: rule.name,
        configPath: configPath || (pkg ? path.join(cwd, 'package.json') : null),
        testCommand: rule.testCommand,
        testDir: findTestDir(cwd, rule.testDir),
        testPattern: rule.testPattern,
        language: rule.language,
        detected: true
      });
    }
  }

  return results;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  FRAMEWORKS,
  detectFramework,
  detectAllFrameworks,
  // Exported for testing
  readPackageJson,
  detectFromConfigFiles,
  detectFromPackageJson,
  findTestDir
};
