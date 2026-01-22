/**
 * Duplicate Detection Gate
 *
 * Detects similar/duplicate code in staged files before commits.
 * Uses token-based similarity comparison against the existing codebase.
 *
 * Thresholds:
 * - >70% similarity → Block and suggest reuse
 * - >50% similarity → Warning with reference
 * - Minimum 15 lines for detection
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// File extensions to check for duplicates
const CODE_EXTENSIONS = /\.(js|ts|tsx|jsx|py|go|rs|java|c|cpp|h|hpp|rb|php)$/;

// Files/directories to skip
const SKIP_PATTERNS = [
  /node_modules\//,
  /\.git\//,
  /dist\//,
  /build\//,
  /coverage\//,
  /\.next\//,
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /__tests__\//,
  /\.d\.ts$/
];

/**
 * Get list of staged files
 */
function getStagedFiles() {
  try {
    const output = execFileSync('git', ['diff', '--cached', '--name-only'], {
      encoding: 'utf8',
      timeout: 5000
    });
    return output.trim().split('\n').filter(Boolean);
  } catch (e) {
    return [];
  }
}

/**
 * Check if file should be skipped
 */
function shouldSkip(filePath) {
  return SKIP_PATTERNS.some(pattern => pattern.test(filePath));
}

/**
 * Extract tokens from code (simplified tokenization)
 */
function tokenize(code) {
  // Remove comments
  code = code.replace(/\/\/.*$/gm, '');
  code = code.replace(/\/\*[\s\S]*?\*\//g, '');
  code = code.replace(/#.*$/gm, '');

  // Remove string literals (replace with placeholder)
  code = code.replace(/"[^"]*"/g, '"STR"');
  code = code.replace(/'[^']*'/g, "'STR'");
  code = code.replace(/`[^`]*`/g, '`STR`');

  // Normalize whitespace
  code = code.replace(/\s+/g, ' ').trim();

  // Split into tokens (identifiers, keywords, operators)
  const tokens = code.match(/[a-zA-Z_$][a-zA-Z0-9_$]*|[0-9]+|[^\s\w]/g) || [];

  return tokens;
}

/**
 * Calculate Jaccard similarity between two token arrays
 */
function calculateSimilarity(tokens1, tokens2) {
  if (tokens1.length === 0 || tokens2.length === 0) return 0;

  const set1 = new Set(tokens1);
  const set2 = new Set(tokens2);

  let intersection = 0;
  for (const token of set1) {
    if (set2.has(token)) intersection++;
  }

  const union = set1.size + set2.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Extract functions/blocks from code
 */
function extractBlocks(code, minLines) {
  const lines = code.split('\n');
  const blocks = [];

  // Simple block detection: look for function-like patterns
  let blockStart = -1;
  let braceCount = 0;
  let currentBlock = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect start of a function/block
    if (blockStart === -1 &&
        (line.match(/^\s*(async\s+)?function\s+\w+/) ||
         line.match(/^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/) ||
         line.match(/^\s*(export\s+)?(async\s+)?(\w+)\s*\([^)]*\)\s*{?/) ||
         line.match(/^\s*class\s+\w+/))) {
      blockStart = i;
      currentBlock = [line];
      braceCount = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
    } else if (blockStart !== -1) {
      currentBlock.push(line);
      braceCount += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;

      // End of block
      if (braceCount <= 0) {
        if (currentBlock.length >= minLines) {
          blocks.push({
            startLine: blockStart + 1,
            endLine: i + 1,
            code: currentBlock.join('\n'),
            tokens: tokenize(currentBlock.join('\n'))
          });
        }
        blockStart = -1;
        currentBlock = [];
        braceCount = 0;
      }
    }
  }

  return blocks;
}

/**
 * Search codebase for similar code blocks
 */
function searchCodebase(block, config) {
  const searchDir = process.cwd();
  const matches = [];

  try {
    // Get list of code files in codebase
    const output = execFileSync('git', ['ls-files'], {
      cwd: searchDir,
      encoding: 'utf8',
      timeout: 10000
    });

    const files = output.trim().split('\n').filter(f =>
      CODE_EXTENSIONS.test(f) && !shouldSkip(f)
    );

    // Search each file for similar blocks
    for (const file of files.slice(0, 100)) {  // Limit to 100 files for speed
      const filePath = path.join(searchDir, file);

      try {
        if (!fs.existsSync(filePath)) continue;

        const content = fs.readFileSync(filePath, 'utf8');
        const fileBlocks = extractBlocks(content, config.min_lines || 15);

        for (const existingBlock of fileBlocks) {
          const similarity = calculateSimilarity(block.tokens, existingBlock.tokens);

          if (similarity >= (config.warn_threshold || 0.5)) {
            matches.push({
              file,
              startLine: existingBlock.startLine,
              endLine: existingBlock.endLine,
              similarity: Math.round(similarity * 100),
              preview: existingBlock.code.substring(0, 100)
            });
          }
        }
      } catch (e) {
        // Skip files that can't be read
      }
    }
  } catch (e) {
    // Git ls-files failed, fall back to no matches
  }

  // Sort by similarity descending
  return matches.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Check for duplicates in staged files
 */
async function check(config = {}) {
  const blockThreshold = config.block_threshold || 0.7;
  const warnThreshold = config.warn_threshold || 0.5;
  const minLines = config.min_lines || 15;

  const files = getStagedFiles();
  const blockedIssues = [];
  const warnings = [];

  for (const file of files) {
    if (!CODE_EXTENSIONS.test(file) || shouldSkip(file)) continue;

    const filePath = path.join(process.cwd(), file);

    try {
      if (!fs.existsSync(filePath)) continue;

      const content = fs.readFileSync(filePath, 'utf8');
      const blocks = extractBlocks(content, minLines);

      for (const block of blocks) {
        const matches = searchCodebase(block, {
          ...config,
          currentFile: file  // Skip self-matches
        }).filter(m => m.file !== file);  // Don't match against self

        for (const match of matches.slice(0, 3)) {  // Top 3 matches per block
          if (match.similarity >= blockThreshold * 100) {
            blockedIssues.push({
              file,
              line: block.startLine,
              matchFile: match.file,
              matchLine: match.startLine,
              similarity: match.similarity
            });
          } else if (match.similarity >= warnThreshold * 100) {
            warnings.push({
              file,
              line: block.startLine,
              matchFile: match.file,
              matchLine: match.startLine,
              similarity: match.similarity
            });
          }
        }
      }
    } catch (e) {
      // Skip files that can't be processed
    }
  }

  if (blockedIssues.length > 0) {
    const details = blockedIssues
      .slice(0, 3)
      .map(i => `${i.file}:${i.line} → ${i.similarity}% similar to ${i.matchFile}:${i.matchLine}`)
      .join('\n');

    return {
      status: 'fail',
      message: `${blockedIssues.length} duplicate(s) detected (>${Math.round(blockThreshold * 100)}% similar)`,
      details: `[MUST FIX] Potential duplicate code found:\n${details}\n\nConsider reusing existing code instead of duplicating.`
    };
  }

  if (warnings.length > 0) {
    const details = warnings
      .slice(0, 3)
      .map(w => `${w.file}:${w.line} → ${w.similarity}% similar to ${w.matchFile}:${w.matchLine}`)
      .join('\n');

    return {
      status: 'warn',
      message: `${warnings.length} potential duplicate(s) found`,
      details: `Similar code exists:\n${details}\n\nConsider if this could be refactored to reuse existing code.`
    };
  }

  return {
    status: 'pass',
    message: 'No duplicates detected'
  };
}

module.exports = { check };
