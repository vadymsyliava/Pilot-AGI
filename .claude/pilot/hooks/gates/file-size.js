/**
 * File Size Gate
 *
 * Checks that staged files don't exceed line limits.
 * Default: warn at 300 lines, block at 500 lines.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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
 * Count lines in a file
 */
function countLines(filePath) {
  try {
    const fullPath = path.join(process.cwd(), filePath);
    if (!fs.existsSync(fullPath)) return 0;

    const content = fs.readFileSync(fullPath, 'utf8');
    return content.split('\n').length;
  } catch (e) {
    return 0;
  }
}

/**
 * Check file sizes
 */
async function check(config = {}) {
  const warnThreshold = config.warn || 300;
  const blockThreshold = config.block || 500;

  const files = getStagedFiles();
  const issues = [];
  const warnings = [];

  for (const file of files) {
    // Skip non-code files
    if (!/\.(js|ts|tsx|jsx|py|go|rs|java|c|cpp|h|hpp|rb|php)$/.test(file)) {
      continue;
    }

    const lineCount = countLines(file);

    if (lineCount >= blockThreshold) {
      issues.push({
        file,
        lines: lineCount,
        threshold: blockThreshold,
        severity: 'block'
      });
    } else if (lineCount >= warnThreshold) {
      warnings.push({
        file,
        lines: lineCount,
        threshold: warnThreshold,
        severity: 'warn'
      });
    }
  }

  if (issues.length > 0) {
    return {
      status: 'fail',
      message: `${issues.length} file(s) exceed ${blockThreshold} lines`,
      details: issues.map(i => `${i.file}: ${i.lines} lines (max ${blockThreshold})`).join('\n')
    };
  }

  if (warnings.length > 0) {
    return {
      status: 'warn',
      message: `${warnings.length} file(s) exceed ${warnThreshold} lines`,
      details: warnings.map(w => `${w.file}: ${w.lines} lines (recommended < ${warnThreshold})`).join('\n')
    };
  }

  return {
    status: 'pass',
    message: 'All files within size limits'
  };
}

module.exports = { check };
