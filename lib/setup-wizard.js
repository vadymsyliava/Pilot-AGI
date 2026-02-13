/**
 * Setup Wizard — Phase 6.8 (Pilot AGI-4d1)
 *
 * Guided onboarding for Pilot AGI terminal orchestration.
 * Checks and configures:
 *   1. macOS permissions (Automation + Accessibility)
 *   2. iTerm2 Python API environment (pip install iterm2)
 *   3. Telegram bot token
 *   4. Policy.yaml terminal section
 *   5. First-run smoke test (open tab, run command, read output, close)
 *
 * Designed for both interactive (readline) and non-interactive (headless) modes.
 * Non-interactive mode returns check results without prompting.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// =============================================================================
// CONSTANTS
// =============================================================================

const EXEC_TIMEOUT_MS = 10000;

const STEPS = [
  'permissions',
  'iterm2_python',
  'telegram',
  'policy',
  'smoke_test',
];

const STEP_LABELS = {
  permissions: 'macOS Permissions',
  iterm2_python: 'iTerm2 Python API',
  telegram: 'Telegram Bot',
  policy: 'Policy Configuration',
  smoke_test: 'First-Run Smoke Test',
};

// =============================================================================
// SETUP WIZARD CLASS
// =============================================================================

class SetupWizard {
  /**
   * @param {object} opts
   * @param {string} opts.projectRoot
   * @param {object} [opts.logger]
   * @param {object} [opts.permissionChecker] - PermissionCheck instance (DI for testing)
   * @param {Function} [opts.execFn] - exec function override (DI for testing)
   */
  constructor(opts) {
    this.projectRoot = opts.projectRoot;
    this.log = opts.logger || { info() {}, warn() {}, error() {}, debug() {} };
    this._permissionChecker = opts.permissionChecker || null;
    this._execFn = opts.execFn || execFileAsync;
  }

  // ===========================================================================
  // FULL CHECK (non-interactive)
  // ===========================================================================

  /**
   * Run all setup checks without prompting. Returns status of each step.
   *
   * @returns {Promise<{ ready: boolean, steps: object }>}
   */
  async checkAll() {
    const steps = {};

    steps.permissions = await this._checkPermissions();
    steps.iterm2_python = await this._checkITerm2Python();
    steps.telegram = this._checkTelegram();
    steps.policy = this._checkPolicy();
    steps.smoke_test = { status: 'skipped', reason: 'Run interactively for smoke test' };

    const ready = Object.values(steps).every(s =>
      s.status === 'ok' || s.status === 'skipped'
    );

    return { ready, steps };
  }

  // ===========================================================================
  // STEP 1: macOS Permissions
  // ===========================================================================

  async _checkPermissions() {
    try {
      const checker = this._getPermissionChecker();
      const result = await checker.checkAll();

      if (result.ready) {
        return { status: 'ok', details: result.results };
      }

      return {
        status: 'missing',
        missing: result.missing,
        instructions: checker.getSetupInstructions(result.missing),
        details: result.results,
      };
    } catch (e) {
      return { status: 'error', error: e.message };
    }
  }

  _getPermissionChecker() {
    if (this._permissionChecker) return this._permissionChecker;

    try {
      const { PermissionCheck } = require(path.join(__dirname, 'permission-check'));
      return new PermissionCheck({ logger: this.log });
    } catch (e) {
      throw new Error('permission-check module not found');
    }
  }

  // ===========================================================================
  // STEP 2: iTerm2 Python API
  // ===========================================================================

  async _checkITerm2Python() {
    // Check if python3 exists
    const python = await this._findPython();
    if (!python) {
      return {
        status: 'missing',
        reason: 'python3 not found',
        instructions: ['Install Python 3: brew install python3']
      };
    }

    // Check if iterm2 package is installed
    try {
      await this._execFn(python, ['-c', 'import iterm2'], {
        timeout: EXEC_TIMEOUT_MS,
      });
      return { status: 'ok', python };
    } catch (e) {
      return {
        status: 'missing',
        reason: 'iterm2 Python package not installed',
        python,
        instructions: [
          `Install: ${python} -m pip install iterm2`,
          'Then enable iTerm2 > Settings > General > Magic > Enable Python API',
        ]
      };
    }
  }

  async _findPython() {
    for (const cmd of ['python3', 'python']) {
      try {
        await this._execFn(cmd, ['--version'], { timeout: EXEC_TIMEOUT_MS });
        return cmd;
      } catch (e) {
        // not found
      }
    }
    return null;
  }

  // ===========================================================================
  // STEP 3: Telegram Bot Token
  // ===========================================================================

  _checkTelegram() {
    const token = process.env.PILOT_TELEGRAM_TOKEN;

    if (token && token.length > 10) {
      return { status: 'ok', token_set: true };
    }

    // Check if telegram is enabled in policy
    const policy = this._loadPolicy();
    if (policy && policy.telegram && policy.telegram.enabled) {
      return {
        status: 'missing',
        reason: 'PILOT_TELEGRAM_TOKEN env var not set but telegram is enabled',
        instructions: [
          '1. Create a bot via @BotFather on Telegram',
          '2. Copy the bot token',
          '3. Set env var: export PILOT_TELEGRAM_TOKEN="your-token"',
          '4. Add your chat ID to policy.yaml telegram.allowed_chat_ids',
          '   Get your ID: message @userinfobot on Telegram',
        ]
      };
    }

    return { status: 'skipped', reason: 'Telegram not enabled in policy' };
  }

  // ===========================================================================
  // STEP 4: Policy Configuration
  // ===========================================================================

  _checkPolicy() {
    const policy = this._loadPolicy();
    if (!policy) {
      return { status: 'error', reason: 'Could not load policy.yaml' };
    }

    const issues = [];

    // Check terminal_orchestration section
    if (!policy.terminal_orchestration) {
      issues.push('terminal_orchestration section missing from policy.yaml');
    } else {
      if (policy.terminal_orchestration.enabled !== true && policy.terminal_orchestration.enabled !== false) {
        issues.push('terminal_orchestration.enabled should be true or false');
      }
      if (!['auto', 'iterm2', 'applescript'].includes(policy.terminal_orchestration.provider)) {
        issues.push('terminal_orchestration.provider should be auto, iterm2, or applescript');
      }
    }

    // Check telegram section
    if (!policy.telegram) {
      issues.push('telegram section missing from policy.yaml');
    }

    if (issues.length === 0) {
      return {
        status: 'ok',
        terminal_enabled: policy.terminal_orchestration?.enabled || false,
        telegram_enabled: policy.telegram?.enabled || false,
        provider: policy.terminal_orchestration?.provider || 'auto',
      };
    }

    return { status: 'issues', issues };
  }

  _loadPolicy() {
    try {
      const policyMod = require(path.join(
        this.projectRoot, '.claude', 'pilot', 'hooks', 'lib', 'policy'
      ));
      return policyMod.loadPolicy(this.projectRoot);
    } catch (e) {
      this.log.debug('Policy load failed', { error: e.message });
      return null;
    }
  }

  // ===========================================================================
  // STEP 5: Smoke Test
  // ===========================================================================

  /**
   * Run a first-run smoke test: open tab → run command → read output → close.
   *
   * @param {object} [opts]
   * @param {object} [opts.terminalController] - Terminal controller instance
   * @returns {Promise<{ status: string, details: object }>}
   */
  async runSmokeTest(opts = {}) {
    const controller = opts.terminalController;
    if (!controller) {
      return { status: 'skipped', reason: 'No terminal controller provided' };
    }

    const details = { opened: false, command_sent: false, output_read: false, closed: false };

    try {
      // 1. Open tab
      const tabId = await controller.openTab({
        command: 'echo "PILOT_AGI_SMOKE_TEST_OK"',
        taskId: 'smoke-test',
        role: 'test',
      });
      details.opened = true;
      details.tabId = tabId;

      // 2. Wait briefly for command execution
      await new Promise(r => setTimeout(r, 2000));
      details.command_sent = true;

      // 3. Read output
      const { state } = await controller.detectState(tabId);
      details.output_read = true;
      details.state = state;

      // 4. Close tab
      await controller.closeTab(tabId);
      details.closed = true;

      return { status: 'ok', details };
    } catch (e) {
      return { status: 'error', error: e.message, details };
    }
  }

  // ===========================================================================
  // FORMATTING
  // ===========================================================================

  /**
   * Format setup check results as human-readable text.
   *
   * @param {{ ready: boolean, steps: object }} result - From checkAll()
   * @returns {string}
   */
  formatReport(result) {
    const lines = [
      'PILOT AGI Setup Check',
      '=' .repeat(40),
      '',
    ];

    for (const step of STEPS) {
      const info = result.steps[step];
      const label = STEP_LABELS[step];
      const icon = info.status === 'ok' ? '[+]'
        : info.status === 'skipped' ? '[-]'
        : info.status === 'missing' ? '[!]'
        : '[X]';

      lines.push(`${icon} ${label}: ${info.status.toUpperCase()}`);

      if (info.reason) {
        lines.push(`    ${info.reason}`);
      }

      if (info.missing?.length) {
        lines.push(`    Missing: ${info.missing.join(', ')}`);
      }

      if (info.issues?.length) {
        for (const issue of info.issues) {
          lines.push(`    - ${issue}`);
        }
      }

      if (info.instructions?.length) {
        lines.push('    Setup:');
        const instrs = Array.isArray(info.instructions[0])
          ? info.instructions
          : [{ steps: info.instructions }];

        for (const group of instrs) {
          if (group.title) lines.push(`      ${group.title}:`);
          const steps = group.steps || group;
          if (Array.isArray(steps)) {
            for (const s of steps) {
              lines.push(`      ${s}`);
            }
          }
        }
      }

      lines.push('');
    }

    lines.push('=' .repeat(40));
    lines.push(result.ready ? 'All checks passed. Ready to go!' : 'Some checks need attention.');

    return lines.join('\n');
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  SetupWizard,
  STEPS,
  STEP_LABELS,
  EXEC_TIMEOUT_MS,
};
