/**
 * macOS Permission Setup — Phase 6.17 (Pilot AGI-41c)
 *
 * Detects macOS Automation and Accessibility permissions required
 * for AppleScript-based terminal control. Provides clear setup
 * instructions and first-run onboarding flow.
 *
 * Permissions required:
 *   - Automation: Control Terminal.app / iTerm2 via osascript
 *   - Accessibility: System Events for keystroke simulation (tab creation)
 *
 * Used by: pm-daemon.js at startup when terminal_orchestration.enabled = true
 */

'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// =============================================================================
// CONSTANTS
// =============================================================================

const CHECK_TIMEOUT_MS = 5000;

const PERMISSION_TYPES = {
  automation_terminal: {
    label: 'Automation (Terminal.app)',
    app: 'Terminal',
  },
  automation_iterm: {
    label: 'Automation (iTerm2)',
    app: 'iTerm2',
  },
  accessibility: {
    label: 'Accessibility (System Events)',
    app: 'System Events',
  },
};

// =============================================================================
// PERMISSION CHECK CLASS
// =============================================================================

class PermissionCheck {
  /**
   * @param {object} [opts]
   * @param {number} [opts.timeout] - osascript timeout in ms
   * @param {object} [opts.logger]
   */
  constructor(opts = {}) {
    this.timeout = opts.timeout || CHECK_TIMEOUT_MS;
    this.log = opts.logger || { info() {}, warn() {}, error() {}, debug() {} };
  }

  /**
   * Check all required permissions for terminal orchestration.
   *
   * @returns {Promise<{ ready: boolean, missing: string[], results: object }>}
   */
  async checkAll() {
    const results = {
      automation_terminal: await this._checkAutomation('Terminal'),
      automation_iterm: await this._checkAutomation('iTerm2'),
      accessibility: await this._checkAccessibility(),
    };

    const missing = Object.entries(results)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);

    const ready = missing.length === 0;

    this.log.info('Permission check complete', { ready, missing });

    return { ready, missing, results };
  }

  /**
   * Check Automation permission for a specific app.
   * Tries to query the app via osascript — if denied, returns false.
   *
   * @param {string} appName - 'Terminal' or 'iTerm2'
   * @returns {Promise<boolean>}
   */
  async _checkAutomation(appName) {
    try {
      await execFileAsync('osascript', [
        '-e', `tell application "${appName}" to return name`
      ], { timeout: this.timeout });
      return true;
    } catch (e) {
      const msg = e.stderr || e.message || '';
      // "not allowed" or "assistive" = permission denied
      if (msg.includes('not allowed') || msg.includes('assistive') ||
          msg.includes('Not authorized') || msg.includes('(-1743)')) {
        this.log.debug(`Automation denied for ${appName}`, { error: msg });
        return false;
      }
      // Other errors (e.g., app not installed, no windows) mean permission is OK
      return true;
    }
  }

  /**
   * Check Accessibility permission via System Events.
   *
   * @returns {Promise<boolean>}
   */
  async _checkAccessibility() {
    try {
      await execFileAsync('osascript', [
        '-e', 'tell application "System Events" to name of first process'
      ], { timeout: this.timeout });
      return true;
    } catch (e) {
      const msg = e.stderr || e.message || '';
      if (msg.includes('not allowed') || msg.includes('assistive') ||
          msg.includes('Not authorized') || msg.includes('(-1743)')) {
        this.log.debug('Accessibility denied', { error: msg });
        return false;
      }
      return true;
    }
  }

  /**
   * Return setup instructions for missing permissions.
   *
   * @param {string[]} missing - Array of missing permission keys
   * @returns {Array<{ title: string, steps: string[] }>}
   */
  getSetupInstructions(missing) {
    if (!missing || missing.length === 0) return [];

    const instructions = [];

    const hasAutomation = missing.some(m => m.startsWith('automation_'));
    if (hasAutomation) {
      const apps = [];
      if (missing.includes('automation_terminal')) apps.push('Terminal');
      if (missing.includes('automation_iterm')) apps.push('iTerm2');

      instructions.push({
        title: 'Grant Automation Permission',
        steps: [
          'Open System Settings > Privacy & Security > Automation',
          `Find your terminal application (${apps.join(' / ')})`,
          `Enable the checkbox to allow controlling ${apps.join(' and ')}`,
          'If not listed, Pilot AGI will trigger the macOS permission dialog on first run',
        ],
      });
    }

    if (missing.includes('accessibility')) {
      instructions.push({
        title: 'Grant Accessibility Permission',
        steps: [
          'Open System Settings > Privacy & Security > Accessibility',
          'Click the lock icon and authenticate',
          'Add your terminal application to the list',
          'This is needed for creating new tabs via keyboard shortcuts',
        ],
      });
    }

    return instructions;
  }

  /**
   * Attempt to trigger the macOS permission dialog by running a test osascript.
   * This causes macOS to show the "allow?" dialog if not yet granted.
   *
   * @returns {Promise<{ triggered: string[] }>}
   */
  async triggerPermissionDialog() {
    const triggered = [];

    // Try Terminal automation — triggers dialog if not yet allowed
    try {
      await execFileAsync('osascript', [
        '-e', 'tell application "Terminal" to return name'
      ], { timeout: this.timeout });
    } catch (e) {
      triggered.push('automation_terminal');
    }

    // Try System Events — triggers Accessibility dialog
    try {
      await execFileAsync('osascript', [
        '-e', 'tell application "System Events" to name of first process'
      ], { timeout: this.timeout });
    } catch (e) {
      triggered.push('accessibility');
    }

    this.log.info('Permission dialog trigger attempted', { triggered });

    return { triggered };
  }

  /**
   * Format a human-readable summary of permission status.
   *
   * @param {{ ready: boolean, missing: string[], results: object }} checkResult
   * @returns {string}
   */
  formatStatus(checkResult) {
    const lines = ['macOS Permission Status:'];

    for (const [key, ok] of Object.entries(checkResult.results)) {
      const info = PERMISSION_TYPES[key];
      const status = ok ? 'OK' : 'MISSING';
      const icon = ok ? '+' : '!';
      lines.push(`  [${icon}] ${info ? info.label : key}: ${status}`);
    }

    if (checkResult.ready) {
      lines.push('', 'All permissions granted. Terminal orchestration ready.');
    } else {
      lines.push('', `Missing ${checkResult.missing.length} permission(s). Run setup to fix.`);
    }

    return lines.join('\n');
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  PermissionCheck,
  PERMISSION_TYPES,
  CHECK_TIMEOUT_MS,
};
