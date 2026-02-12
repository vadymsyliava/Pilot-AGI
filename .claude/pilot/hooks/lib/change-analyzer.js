/**
 * Change Analyzer — detect change type from git diff
 *
 * Parses unified diff output, classifies changes as new_function, bug_fix,
 * refactor, config_change. Extracts file paths, function names, line ranges.
 *
 * Part of Phase 5.3 — Autonomous Test Generation (Pilot AGI-wra.1)
 */

const { execFileSync } = require('child_process');

// ============================================================================
// CONSTANTS
// ============================================================================

const CHANGE_TYPES = {
  NEW_FUNCTION: 'new_function',
  BUG_FIX: 'bug_fix',
  REFACTOR: 'refactor',
  CONFIG_CHANGE: 'config_change',
  NEW_FILE: 'new_file',
  DELETED_FILE: 'deleted_file',
  TEST_CHANGE: 'test_change',
  DOCS_CHANGE: 'docs_change'
};

const CONFIG_PATTERNS = [
  /\.config\.(js|ts|mjs|cjs|json)$/,
  /\.json$/,
  /\.ya?ml$/,
  /\.toml$/,
  /\.env/,
  /\.eslintrc/,
  /\.prettierrc/,
  /tsconfig/,
  /Dockerfile/,
  /docker-compose/,
  /Makefile/,
  /\.gitignore$/
];

const TEST_PATTERNS = [
  /\.test\.(js|ts|jsx|tsx|mjs)$/,
  /\.spec\.(js|ts|jsx|tsx|mjs)$/,
  /test_.*\.py$/,
  /.*_test\.py$/,
  /.*_test\.go$/
];

const DOCS_PATTERNS = [
  /\.md$/,
  /\.mdx$/,
  /\.rst$/,
  /\.txt$/,
  /LICENSE/,
  /CHANGELOG/,
  /CONTRIBUTING/
];

// Function declaration patterns per language
const FUNCTION_PATTERNS = {
  js: [
    /^\+\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /^\+\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$]\w*)\s*=>/,
    /^\+\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/,
    /^\+\s*(\w+)\s*\([^)]*\)\s*\{/,
    /^\+\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/
  ],
  ts: [
    /^\+\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /^\+\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?(?:\([^)]*\)(?:\s*:\s*[^=]+?)?\s*=>|[a-zA-Z_$]\w*\s*=>)/,
    /^\+\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/
  ],
  py: [
    /^\+\s*(?:async\s+)?def\s+(\w+)/,
    /^\+\s*class\s+(\w+)/
  ],
  go: [
    /^\+\s*func\s+(?:\([^)]+\)\s+)?(\w+)/
  ],
  rust: [
    /^\+\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
    /^\+\s*(?:pub\s+)?struct\s+(\w+)/,
    /^\+\s*impl(?:<[^>]+>)?\s+(\w+)/
  ]
};

// Bug fix indicators in diff content
const BUG_FIX_INDICATORS = [
  /fix(?:ed|es|ing)?/i,
  /bug(?:fix)?/i,
  /patch/i,
  /hotfix/i,
  /error\s+handling/i,
  /null\s*check/i,
  /guard\s*clause/i,
  /off.by.one/i,
  /boundary/i,
  /edge.case/i
];

// Refactor indicators
const REFACTOR_INDICATORS = [
  /refactor/i,
  /rename/i,
  /extract/i,
  /reorganize/i,
  /restructure/i,
  /simplif/i,
  /clean.?up/i
];

// ============================================================================
// DIFF PARSER
// ============================================================================

/**
 * Parse unified diff text into structured hunks.
 *
 * @param {string} diffText - Raw unified diff output
 * @returns {Array<Object>} Parsed file diffs with hunks
 */
function parseDiff(diffText) {
  if (!diffText || typeof diffText !== 'string') return [];

  const files = [];
  const lines = diffText.split('\n');
  let currentFile = null;
  let currentHunk = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // New file diff header: diff --git a/path b/path
    if (line.startsWith('diff --git')) {
      if (currentFile) files.push(currentFile);
      const match = line.match(/diff --git a\/(.+?) b\/(.+)/);
      currentFile = {
        oldPath: match ? match[1] : null,
        newPath: match ? match[2] : null,
        hunks: [],
        isNew: false,
        isDeleted: false,
        isRenamed: false,
        isBinary: false,
        addedLines: [],
        removedLines: []
      };
      currentHunk = null;
      continue;
    }

    if (!currentFile) continue;

    // Detect new file
    if (line.startsWith('new file mode')) {
      currentFile.isNew = true;
      continue;
    }

    // Detect deleted file
    if (line.startsWith('deleted file mode')) {
      currentFile.isDeleted = true;
      continue;
    }

    // Detect rename
    if (line.startsWith('rename from') || line.startsWith('rename to')) {
      currentFile.isRenamed = true;
      continue;
    }

    // Detect binary
    if (line.startsWith('Binary files') || line.match(/^GIT binary patch/)) {
      currentFile.isBinary = true;
      continue;
    }

    // Hunk header: @@ -old,count +new,count @@ context
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@\s*(.*)/);
    if (hunkMatch) {
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newCount: hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1,
        context: hunkMatch[5] || '',
        lines: []
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    // Diff content lines
    if (currentHunk) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentHunk.lines.push({ type: 'add', content: line.slice(1) });
        currentFile.addedLines.push(line.slice(1));
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentHunk.lines.push({ type: 'remove', content: line.slice(1) });
        currentFile.removedLines.push(line.slice(1));
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push({ type: 'context', content: line.slice(1) });
      }
    }
  }

  if (currentFile) files.push(currentFile);
  return files;
}

// ============================================================================
// CHANGE CLASSIFIER
// ============================================================================

/**
 * Classify the type of change for a single file diff.
 *
 * @param {Object} fileDiff - Single parsed file diff from parseDiff()
 * @param {string} [commitMsg] - Optional commit message for hints
 * @returns {string} One of CHANGE_TYPES values
 */
function classifyFile(fileDiff, commitMsg) {
  const filePath = fileDiff.newPath || fileDiff.oldPath || '';

  // Deleted file
  if (fileDiff.isDeleted) return CHANGE_TYPES.DELETED_FILE;

  // New file
  if (fileDiff.isNew) {
    if (TEST_PATTERNS.some(p => p.test(filePath))) return CHANGE_TYPES.TEST_CHANGE;
    if (DOCS_PATTERNS.some(p => p.test(filePath))) return CHANGE_TYPES.DOCS_CHANGE;
    if (CONFIG_PATTERNS.some(p => p.test(filePath))) return CHANGE_TYPES.CONFIG_CHANGE;
    return CHANGE_TYPES.NEW_FILE;
  }

  // Config file change
  if (CONFIG_PATTERNS.some(p => p.test(filePath))) return CHANGE_TYPES.CONFIG_CHANGE;

  // Test file change
  if (TEST_PATTERNS.some(p => p.test(filePath))) return CHANGE_TYPES.TEST_CHANGE;

  // Docs change
  if (DOCS_PATTERNS.some(p => p.test(filePath))) return CHANGE_TYPES.DOCS_CHANGE;

  // Check commit message for hints
  if (commitMsg) {
    if (BUG_FIX_INDICATORS.some(p => p.test(commitMsg))) return CHANGE_TYPES.BUG_FIX;
    if (REFACTOR_INDICATORS.some(p => p.test(commitMsg))) return CHANGE_TYPES.REFACTOR;
  }

  // Analyze diff content
  const addedCount = fileDiff.addedLines.length;
  const removedCount = fileDiff.removedLines.length;
  const allAdded = fileDiff.addedLines.join('\n');
  const allRemoved = fileDiff.removedLines.join('\n');

  // Check for bug fix indicators in diff comments/content
  if (BUG_FIX_INDICATORS.some(p => p.test(allAdded))) return CHANGE_TYPES.BUG_FIX;

  // Heavy removal + addition of similar lines = refactor
  if (removedCount > 0 && addedCount > 0) {
    const ratio = Math.min(addedCount, removedCount) / Math.max(addedCount, removedCount);
    if (ratio > 0.5 && removedCount >= 3) return CHANGE_TYPES.REFACTOR;
  }

  // Mostly additions with function declarations = new function
  if (addedCount > removedCount * 2) {
    const lang = detectLanguage(filePath);
    const patterns = FUNCTION_PATTERNS[lang] || FUNCTION_PATTERNS.js;
    const hasNewFunc = fileDiff.addedLines.some(line =>
      patterns.some(p => p.test('+' + line))
    );
    if (hasNewFunc) return CHANGE_TYPES.NEW_FUNCTION;
  }

  // Default: if mostly additions it's new function, otherwise refactor
  if (addedCount > removedCount * 3) return CHANGE_TYPES.NEW_FUNCTION;
  if (removedCount > 0 && addedCount > 0) return CHANGE_TYPES.REFACTOR;
  if (addedCount > 0) return CHANGE_TYPES.NEW_FUNCTION;

  return CHANGE_TYPES.REFACTOR;
}

/**
 * Classify all changes in a parsed diff.
 *
 * @param {Array<Object>} parsedDiff - Output from parseDiff()
 * @param {string} [commitMsg] - Optional commit message
 * @returns {Array<Object>} Array of { filePath, changeType, ... }
 */
function classifyChanges(parsedDiff, commitMsg) {
  return parsedDiff.map(fileDiff => ({
    filePath: fileDiff.newPath || fileDiff.oldPath,
    changeType: classifyFile(fileDiff, commitMsg),
    isNew: fileDiff.isNew,
    isDeleted: fileDiff.isDeleted,
    isRenamed: fileDiff.isRenamed,
    isBinary: fileDiff.isBinary,
    addedCount: fileDiff.addedLines.length,
    removedCount: fileDiff.removedLines.length
  }));
}

// ============================================================================
// FUNCTION EXTRACTION
// ============================================================================

/**
 * Detect language from file extension.
 */
function detectLanguage(filePath) {
  if (!filePath) return 'js';
  if (/\.tsx?$/.test(filePath)) return 'ts';
  if (/\.jsx?$/.test(filePath) || /\.mjs$/.test(filePath) || /\.cjs$/.test(filePath)) return 'js';
  if (/\.py$/.test(filePath)) return 'py';
  if (/\.go$/.test(filePath)) return 'go';
  if (/\.rs$/.test(filePath)) return 'rust';
  return 'js';
}

/**
 * Extract newly added/changed function names from parsed diffs.
 *
 * @param {Array<Object>} parsedDiff - Output from parseDiff()
 * @returns {Array<Object>} Array of { filePath, functionName, language, lineNumber }
 */
function extractChangedFunctions(parsedDiff) {
  const results = [];

  for (const fileDiff of parsedDiff) {
    if (fileDiff.isBinary) continue;
    const filePath = fileDiff.newPath || fileDiff.oldPath;
    const lang = detectLanguage(filePath);
    const patterns = FUNCTION_PATTERNS[lang] || FUNCTION_PATTERNS.js;

    for (const hunk of fileDiff.hunks) {
      let lineNum = hunk.newStart;
      for (const line of hunk.lines) {
        if (line.type === 'add') {
          for (const pattern of patterns) {
            const match = ('+' + line.content).match(pattern);
            if (match && match[1]) {
              // Filter out common false positives
              if (!['if', 'else', 'for', 'while', 'switch', 'catch', 'return', 'new', 'delete', 'typeof', 'void'].includes(match[1])) {
                results.push({
                  filePath,
                  functionName: match[1],
                  language: lang,
                  lineNumber: lineNum
                });
              }
              break;
            }
          }
          lineNum++;
        } else if (line.type === 'context') {
          lineNum++;
        }
        // removed lines don't increment new line counter
      }
    }
  }

  // Deduplicate by filePath + functionName
  const seen = new Set();
  return results.filter(r => {
    const key = `${r.filePath}:${r.functionName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================================================
// LINE RANGE EXTRACTION
// ============================================================================

/**
 * Extract changed line ranges per file.
 *
 * @param {Array<Object>} parsedDiff - Output from parseDiff()
 * @returns {Array<Object>} Array of { filePath, ranges: [{start, end}] }
 */
function extractChangedRanges(parsedDiff) {
  return parsedDiff.map(fileDiff => {
    const ranges = fileDiff.hunks.map(hunk => ({
      start: hunk.newStart,
      end: hunk.newStart + hunk.newCount - 1
    }));
    return {
      filePath: fileDiff.newPath || fileDiff.oldPath,
      ranges
    };
  });
}

// ============================================================================
// GIT INTEGRATION
// ============================================================================

/**
 * Run full analysis pipeline from git diff.
 *
 * @param {Object} options
 * @param {string} [options.base] - Base ref (default: HEAD~1)
 * @param {string} [options.head] - Head ref (default: HEAD)
 * @param {boolean} [options.staged] - Analyze staged changes
 * @param {boolean} [options.unstaged] - Analyze unstaged changes
 * @param {string} [options.cwd] - Working directory
 * @returns {Object} { files, classifications, functions, ranges }
 */
function analyzeFromGit(options = {}) {
  const { base, head, staged, unstaged, cwd } = options;

  let args = ['diff', '--no-color'];

  if (staged) {
    args.push('--cached');
  } else if (!unstaged) {
    const baseRef = base || 'HEAD~1';
    const headRef = head || 'HEAD';
    args.push(baseRef, headRef);
  }

  let diffText;
  try {
    diffText = execFileSync('git', args, {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (err) {
    return { files: [], classifications: [], functions: [], ranges: [], error: err.message };
  }

  // Try to get commit message for classification hints
  let commitMsg = '';
  try {
    commitMsg = execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: cwd || process.cwd(),
      encoding: 'utf8'
    }).trim();
  } catch (_) {
    // Ignore — commit message is optional
  }

  const files = parseDiff(diffText);
  const classifications = classifyChanges(files, commitMsg);
  const functions = extractChangedFunctions(files);
  const ranges = extractChangedRanges(files);

  return { files, classifications, functions, ranges };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  CHANGE_TYPES,
  parseDiff,
  classifyFile,
  classifyChanges,
  detectLanguage,
  extractChangedFunctions,
  extractChangedRanges,
  analyzeFromGit
};
