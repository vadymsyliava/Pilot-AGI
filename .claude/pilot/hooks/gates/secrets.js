/**
 * Secrets Gate
 *
 * Scans staged files for hardcoded secrets and credentials.
 * Blocks commits that contain potential secrets.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Secret patterns to detect
const SECRET_PATTERNS = [
  // API keys and tokens
  { pattern: /['"][a-zA-Z0-9_-]*(?:api[_-]?key|apikey)['"]\s*[:=]\s*['"][a-zA-Z0-9_\-]{16,}['"]/gi, name: 'API Key' },
  { pattern: /['"][a-zA-Z0-9_-]*(?:secret[_-]?key|secretkey)['"]\s*[:=]\s*['"][a-zA-Z0-9_\-]{16,}['"]/gi, name: 'Secret Key' },
  { pattern: /['"][a-zA-Z0-9_-]*(?:access[_-]?token|accesstoken)['"]\s*[:=]\s*['"][a-zA-Z0-9_\-]{16,}['"]/gi, name: 'Access Token' },

  // AWS credentials
  { pattern: /AKIA[0-9A-Z]{16}/g, name: 'AWS Access Key' },
  { pattern: /['"]aws[_-]?secret[_-]?access[_-]?key['"]\s*[:=]\s*['"][a-zA-Z0-9/+=]{40}['"]/gi, name: 'AWS Secret Key' },

  // Common secret assignments
  { pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/gi, name: 'Password' },
  { pattern: /(?:private[_-]?key)\s*[:=]\s*['"][^'"]{20,}['"]/gi, name: 'Private Key' },

  // JWT secrets
  { pattern: /jwt[_-]?secret\s*[:=]\s*['"][^'"]{16,}['"]/gi, name: 'JWT Secret' },

  // Database connection strings with credentials
  { pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^:]+:[^@]+@/gi, name: 'Database URL with credentials' },

  // Generic high-entropy strings that look like secrets
  { pattern: /(?:token|secret|key|credential)\s*[:=]\s*['"][a-zA-Z0-9+/=_\-]{32,}['"]/gi, name: 'Generic Secret' }
];

// Files to skip
const SKIP_PATTERNS = [
  /\.env\.example$/,
  /\.env\.sample$/,
  /\.env\.template$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /__tests__\//,
  /node_modules\//
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
 * Scan file for secrets
 */
function scanFile(filePath) {
  const findings = [];

  try {
    const fullPath = path.join(process.cwd(), filePath);
    if (!fs.existsSync(fullPath)) return findings;

    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split('\n');

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];

      for (const { pattern, name } of SECRET_PATTERNS) {
        // Reset regex lastIndex for global patterns
        pattern.lastIndex = 0;

        if (pattern.test(line)) {
          findings.push({
            file: filePath,
            line: lineNum + 1,
            type: name,
            preview: line.substring(0, 60) + (line.length > 60 ? '...' : '')
          });
        }
      }
    }
  } catch (e) {
    // Skip files that can't be read
  }

  return findings;
}

/**
 * Check for secrets
 */
async function check(config = {}) {
  const files = getStagedFiles();
  const findings = [];

  for (const file of files) {
    if (shouldSkip(file)) continue;

    const fileFindings = scanFile(file);
    findings.push(...fileFindings);
  }

  if (findings.length > 0) {
    const details = findings
      .slice(0, 5)  // Limit to first 5 to avoid overwhelming output
      .map(f => `${f.file}:${f.line} - ${f.type}`)
      .join('\n');

    const moreCount = findings.length > 5 ? `\n... and ${findings.length - 5} more` : '';

    return {
      status: 'fail',
      message: `${findings.length} potential secret(s) detected`,
      details: `[MUST FIX] Secrets should not be committed:\n${details}${moreCount}\n\nUse environment variables instead.`
    };
  }

  return {
    status: 'pass',
    message: 'No secrets detected'
  };
}

module.exports = { check };
