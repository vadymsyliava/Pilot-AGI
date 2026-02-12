/**
 * Tests for Phase 6.17: macOS Permission Setup (Pilot AGI-41c)
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');

// =============================================================================
// HELPERS
// =============================================================================

function freshModule() {
  const modPath = require.resolve('../lib/permission-check');
  delete require.cache[modPath];
  return require(modPath);
}

/**
 * Create a mock for child_process.execFile that responds based on the script content.
 * Note: This mocks execFile (not exec) — no shell injection risk.
 *
 * @param {object} responses - Map of app name patterns to { resolve: bool, stderr: string }
 */
function mockExecFile(responses) {
  const cp = require('child_process');
  const original = cp.execFile;

  const mockFn = mock.fn((cmd, args, opts, cb) => {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }

    const script = args.find(a => a.includes('tell application')) || args.join(' ');

    for (const [pattern, response] of Object.entries(responses)) {
      if (script.includes(pattern)) {
        if (response.resolve) {
          return cb(null, { stdout: response.stdout || 'ok', stderr: '' });
        } else {
          const err = new Error(response.stderr || 'error');
          err.stderr = response.stderr || 'error';
          return cb(err);
        }
      }
    }

    // Default: succeed
    return cb(null, { stdout: 'ok', stderr: '' });
  });

  cp.execFile = mockFn;

  return {
    mock: mockFn,
    restore: () => { cp.execFile = original; },
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('PermissionCheck', () => {
  let mod;
  let execMock;

  beforeEach(() => {
    mod = freshModule();
  });

  afterEach(() => {
    if (execMock) {
      execMock.restore();
      execMock = null;
    }
  });

  // ---------------------------------------------------------------------------
  // checkAll()
  // ---------------------------------------------------------------------------

  describe('checkAll()', () => {
    it('returns ready=true when all permissions granted', async () => {
      execMock = mockExecFile({
        'Terminal': { resolve: true },
        'iTerm2': { resolve: true },
        'System Events': { resolve: true },
      });

      mod = freshModule();
      const checker = new mod.PermissionCheck();
      const result = await checker.checkAll();

      assert.equal(result.ready, true);
      assert.deepEqual(result.missing, []);
      assert.equal(result.results.automation_terminal, true);
      assert.equal(result.results.automation_iterm, true);
      assert.equal(result.results.accessibility, true);
    });

    it('detects missing automation_terminal (not allowed)', async () => {
      execMock = mockExecFile({
        'Terminal': { resolve: false, stderr: 'not allowed to send Apple events' },
        'iTerm2': { resolve: true },
        'System Events': { resolve: true },
      });

      mod = freshModule();
      const checker = new mod.PermissionCheck();
      const result = await checker.checkAll();

      assert.equal(result.ready, false);
      assert.ok(result.missing.includes('automation_terminal'));
      assert.equal(result.results.automation_terminal, false);
      assert.equal(result.results.automation_iterm, true);
    });

    it('detects missing accessibility (assistive error)', async () => {
      execMock = mockExecFile({
        'Terminal': { resolve: true },
        'iTerm2': { resolve: true },
        'System Events': { resolve: false, stderr: 'assistive access not enabled' },
      });

      mod = freshModule();
      const checker = new mod.PermissionCheck();
      const result = await checker.checkAll();

      assert.equal(result.ready, false);
      assert.ok(result.missing.includes('accessibility'));
      assert.equal(result.results.accessibility, false);
    });

    it('detects all missing permissions', async () => {
      execMock = mockExecFile({
        'Terminal': { resolve: false, stderr: 'Not authorized' },
        'iTerm2': { resolve: false, stderr: 'not allowed' },
        'System Events': { resolve: false, stderr: '(-1743)' },
      });

      mod = freshModule();
      const checker = new mod.PermissionCheck();
      const result = await checker.checkAll();

      assert.equal(result.ready, false);
      assert.equal(result.missing.length, 3);
      assert.ok(result.missing.includes('automation_terminal'));
      assert.ok(result.missing.includes('automation_iterm'));
      assert.ok(result.missing.includes('accessibility'));
    });

    it('treats non-permission errors as OK (e.g., app not running)', async () => {
      execMock = mockExecFile({
        'Terminal': { resolve: false, stderr: 'Application isn\'t running' },
        'iTerm2': { resolve: false, stderr: 'Connection is invalid' },
        'System Events': { resolve: false, stderr: 'timeout expired' },
      });

      mod = freshModule();
      const checker = new mod.PermissionCheck();
      const result = await checker.checkAll();

      assert.equal(result.ready, true);
      assert.deepEqual(result.missing, []);
    });
  });

  // ---------------------------------------------------------------------------
  // getSetupInstructions()
  // ---------------------------------------------------------------------------

  describe('getSetupInstructions()', () => {
    it('returns empty array when nothing missing', () => {
      const checker = new mod.PermissionCheck();
      const instructions = checker.getSetupInstructions([]);
      assert.deepEqual(instructions, []);
    });

    it('returns empty array for null input', () => {
      const checker = new mod.PermissionCheck();
      const instructions = checker.getSetupInstructions(null);
      assert.deepEqual(instructions, []);
    });

    it('returns automation instructions for missing Terminal permission', () => {
      const checker = new mod.PermissionCheck();
      const instructions = checker.getSetupInstructions(['automation_terminal']);

      assert.equal(instructions.length, 1);
      assert.equal(instructions[0].title, 'Grant Automation Permission');
      assert.ok(instructions[0].steps.length >= 3);
      assert.ok(instructions[0].steps.some(s => s.includes('Terminal')));
    });

    it('returns automation instructions mentioning both apps when both missing', () => {
      const checker = new mod.PermissionCheck();
      const instructions = checker.getSetupInstructions(['automation_terminal', 'automation_iterm']);

      assert.equal(instructions.length, 1);
      assert.ok(instructions[0].steps.some(s => s.includes('Terminal') && s.includes('iTerm2')));
    });

    it('returns accessibility instructions when missing', () => {
      const checker = new mod.PermissionCheck();
      const instructions = checker.getSetupInstructions(['accessibility']);

      assert.equal(instructions.length, 1);
      assert.equal(instructions[0].title, 'Grant Accessibility Permission');
      assert.ok(instructions[0].steps.some(s => s.includes('Accessibility')));
    });

    it('returns both instruction sets when automation and accessibility missing', () => {
      const checker = new mod.PermissionCheck();
      const instructions = checker.getSetupInstructions([
        'automation_terminal', 'accessibility'
      ]);

      assert.equal(instructions.length, 2);
      assert.equal(instructions[0].title, 'Grant Automation Permission');
      assert.equal(instructions[1].title, 'Grant Accessibility Permission');
    });
  });

  // ---------------------------------------------------------------------------
  // triggerPermissionDialog()
  // ---------------------------------------------------------------------------

  describe('triggerPermissionDialog()', () => {
    it('returns triggered list when permissions denied', async () => {
      execMock = mockExecFile({
        'Terminal': { resolve: false, stderr: 'not allowed' },
        'System Events': { resolve: false, stderr: 'not allowed' },
      });

      mod = freshModule();
      const checker = new mod.PermissionCheck();
      const result = await checker.triggerPermissionDialog();

      assert.ok(result.triggered.includes('automation_terminal'));
      assert.ok(result.triggered.includes('accessibility'));
    });

    it('returns empty triggered list when all permissions OK', async () => {
      execMock = mockExecFile({
        'Terminal': { resolve: true },
        'System Events': { resolve: true },
      });

      mod = freshModule();
      const checker = new mod.PermissionCheck();
      const result = await checker.triggerPermissionDialog();

      assert.deepEqual(result.triggered, []);
    });
  });

  // ---------------------------------------------------------------------------
  // formatStatus()
  // ---------------------------------------------------------------------------

  describe('formatStatus()', () => {
    it('formats all-OK status', () => {
      const checker = new mod.PermissionCheck();
      const status = checker.formatStatus({
        ready: true,
        missing: [],
        results: {
          automation_terminal: true,
          automation_iterm: true,
          accessibility: true,
        },
      });

      assert.ok(status.includes('OK'));
      assert.ok(status.includes('All permissions granted'));
    });

    it('formats missing permissions status', () => {
      const checker = new mod.PermissionCheck();
      const status = checker.formatStatus({
        ready: false,
        missing: ['accessibility'],
        results: {
          automation_terminal: true,
          automation_iterm: true,
          accessibility: false,
        },
      });

      assert.ok(status.includes('MISSING'));
      assert.ok(status.includes('Missing 1 permission'));
    });
  });

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  describe('exports', () => {
    it('exports PermissionCheck class', () => {
      assert.equal(typeof mod.PermissionCheck, 'function');
    });

    it('exports PERMISSION_TYPES', () => {
      assert.ok(mod.PERMISSION_TYPES.automation_terminal);
      assert.ok(mod.PERMISSION_TYPES.automation_iterm);
      assert.ok(mod.PERMISSION_TYPES.accessibility);
    });

    it('exports CHECK_TIMEOUT_MS', () => {
      assert.equal(typeof mod.CHECK_TIMEOUT_MS, 'number');
      assert.ok(mod.CHECK_TIMEOUT_MS > 0);
    });
  });
});
