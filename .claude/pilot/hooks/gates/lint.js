/**
 * Lint Gate
 *
 * Runs the project's linter (if available) before commits.
 * Supports npm/yarn lint scripts and direct eslint.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Check if package.json has a lint script
 */
function hasLintScript() {
  const pkgPath = path.join(process.cwd(), 'package.json');

  if (!fs.existsSync(pkgPath)) return false;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return !!(pkg.scripts?.lint || pkg.scripts?.['lint:check']);
  } catch (e) {
    return false;
  }
}

/**
 * Check if eslint is available
 */
function hasEslint() {
  const eslintPath = path.join(process.cwd(), 'node_modules', '.bin', 'eslint');
  return fs.existsSync(eslintPath);
}

/**
 * Run lint command
 */
function runLint(timeout) {
  try {
    // Prefer npm run lint if available
    if (hasLintScript()) {
      execFileSync('npm', ['run', 'lint', '--', '--max-warnings=0'], {
        encoding: 'utf8',
        timeout,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return { success: true };
    }

    // Fall back to eslint directly
    if (hasEslint()) {
      execFileSync(
        path.join(process.cwd(), 'node_modules', '.bin', 'eslint'),
        ['.', '--max-warnings=0'],
        {
          encoding: 'utf8',
          timeout,
          stdio: ['pipe', 'pipe', 'pipe']
        }
      );
      return { success: true };
    }

    // No linter available
    return { success: true, skipped: true };

  } catch (error) {
    // Parse eslint output for specific errors
    const output = error.stderr || error.stdout || error.message || '';

    return {
      success: false,
      output: output.substring(0, 500)  // Limit output size
    };
  }
}

/**
 * Check lint status
 */
async function check(config = {}) {
  const timeout = config.timeout || 30000;

  // Check if there's a linter configured
  if (!hasLintScript() && !hasEslint()) {
    return {
      status: 'pass',
      message: 'No linter configured (skipped)'
    };
  }

  const result = runLint(timeout);

  if (result.skipped) {
    return {
      status: 'pass',
      message: 'No linter configured (skipped)'
    };
  }

  if (result.success) {
    return {
      status: 'pass',
      message: 'Lint passed'
    };
  }

  return {
    status: 'fail',
    message: 'Lint errors found',
    details: `[MUST FIX] Run 'npm run lint' to see full details:\n${result.output}`
  };
}

module.exports = { check };
