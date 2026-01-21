/**
 * Type Check Gate
 *
 * Runs TypeScript compiler to check for type errors.
 * Only runs if the project has TypeScript configured.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Check if project uses TypeScript
 */
function hasTypeScript() {
  const tsconfigPath = path.join(process.cwd(), 'tsconfig.json');
  return fs.existsSync(tsconfigPath);
}

/**
 * Check if tsc is available
 */
function hasTsc() {
  const tscPath = path.join(process.cwd(), 'node_modules', '.bin', 'tsc');
  return fs.existsSync(tscPath);
}

/**
 * Check if package.json has a type-check script
 */
function hasTypeCheckScript() {
  const pkgPath = path.join(process.cwd(), 'package.json');

  if (!fs.existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.scripts?.['type-check']) return 'type-check';
    if (pkg.scripts?.typecheck) return 'typecheck';
    if (pkg.scripts?.['check-types']) return 'check-types';
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Run type check
 */
function runTypeCheck(timeout) {
  try {
    // Check for custom type-check script first
    const script = hasTypeCheckScript();
    if (script) {
      execFileSync('npm', ['run', script], {
        encoding: 'utf8',
        timeout,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return { success: true };
    }

    // Fall back to tsc --noEmit
    if (hasTsc()) {
      execFileSync(
        path.join(process.cwd(), 'node_modules', '.bin', 'tsc'),
        ['--noEmit'],
        {
          encoding: 'utf8',
          timeout,
          stdio: ['pipe', 'pipe', 'pipe']
        }
      );
      return { success: true };
    }

    // No TypeScript available
    return { success: true, skipped: true };

  } catch (error) {
    // Parse tsc output for specific errors
    const output = error.stderr || error.stdout || error.message || '';

    // Count errors
    const errorMatches = output.match(/error TS\d+/g) || [];
    const errorCount = errorMatches.length;

    return {
      success: false,
      errorCount,
      output: output.substring(0, 500)  // Limit output size
    };
  }
}

/**
 * Check type errors
 */
async function check(config = {}) {
  const timeout = config.timeout || 30000;

  // Check if TypeScript is configured
  if (!hasTypeScript()) {
    return {
      status: 'pass',
      message: 'No TypeScript configured (skipped)'
    };
  }

  if (!hasTsc() && !hasTypeCheckScript()) {
    return {
      status: 'pass',
      message: 'TypeScript compiler not installed (skipped)'
    };
  }

  const result = runTypeCheck(timeout);

  if (result.skipped) {
    return {
      status: 'pass',
      message: 'No TypeScript configured (skipped)'
    };
  }

  if (result.success) {
    return {
      status: 'pass',
      message: 'Type check passed'
    };
  }

  return {
    status: 'fail',
    message: `${result.errorCount} type error(s) found`,
    details: `[MUST FIX] Run 'tsc --noEmit' to see full details:\n${result.output}`
  };
}

module.exports = { check };
