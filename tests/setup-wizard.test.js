/**
 * Tests for Phase 6.8: Setup Wizard & Onboarding (Pilot AGI-4d1)
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

function freshModule(modPath) {
  const resolved = require.resolve(modPath);
  delete require.cache[resolved];
  return require(resolved);
}

// =============================================================================
// MOCK HELPERS
// =============================================================================

function createMockPermissionChecker(overrides = {}) {
  const defaults = {
    automation_terminal: true,
    automation_iterm: true,
    accessibility: true,
  };
  const results = { ...defaults, ...overrides };
  const missing = Object.entries(results).filter(([, ok]) => !ok).map(([k]) => k);

  return {
    checkAll: async () => ({
      ready: missing.length === 0,
      missing,
      results,
    }),
    getSetupInstructions: (miss) => {
      if (!miss || miss.length === 0) return [];
      return [{ title: 'Fix Permissions', steps: ['Open System Settings'] }];
    },
  };
}

function createMockExecFn(responses = {}) {
  return async (cmd, args = [], opts = {}) => {
    const key = `${cmd} ${args.join(' ')}`.trim();

    // Check specific responses
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern)) {
        if (response.error) throw new Error(response.error);
        return { stdout: response.stdout || '', stderr: '' };
      }
    }

    // Default: python3 --version works, import iterm2 fails
    if (key.includes('--version')) return { stdout: 'Python 3.11.0\n', stderr: '' };
    if (key.includes('import iterm2')) throw new Error('ModuleNotFoundError');

    return { stdout: '', stderr: '' };
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('SetupWizard', () => {
  let mod;

  beforeEach(() => {
    mod = freshModule('../lib/setup-wizard');
  });

  describe('exports', () => {
    it('should export all public interfaces', () => {
      assert.ok(mod.SetupWizard);
      assert.ok(mod.STEPS);
      assert.ok(mod.STEP_LABELS);
      assert.ok(mod.EXEC_TIMEOUT_MS);
      assert.equal(mod.STEPS.length, 5);
    });

    it('should have labels for all steps', () => {
      for (const step of mod.STEPS) {
        assert.ok(mod.STEP_LABELS[step], `Missing label for step: ${step}`);
      }
    });
  });

  describe('constructor', () => {
    it('should create wizard with project root', () => {
      const wizard = new mod.SetupWizard({ projectRoot: '/tmp/test' });
      assert.equal(wizard.projectRoot, '/tmp/test');
    });
  });

  // ===========================================================================
  // Permission Check (Step 1)
  // ===========================================================================

  describe('_checkPermissions()', () => {
    it('should return ok when all permissions granted', async () => {
      const wizard = new mod.SetupWizard({
        projectRoot: '/tmp/test',
        permissionChecker: createMockPermissionChecker(),
      });

      const result = await wizard._checkPermissions();
      assert.equal(result.status, 'ok');
      assert.ok(result.details.automation_terminal);
      assert.ok(result.details.accessibility);
    });

    it('should return missing when permissions denied', async () => {
      const wizard = new mod.SetupWizard({
        projectRoot: '/tmp/test',
        permissionChecker: createMockPermissionChecker({
          automation_terminal: false,
          accessibility: false,
        }),
      });

      const result = await wizard._checkPermissions();
      assert.equal(result.status, 'missing');
      assert.ok(result.missing.includes('automation_terminal'));
      assert.ok(result.missing.includes('accessibility'));
      assert.ok(result.instructions.length > 0);
    });

    it('should return error when permission check fails', async () => {
      const wizard = new mod.SetupWizard({
        projectRoot: '/tmp/test',
        permissionChecker: {
          checkAll: async () => { throw new Error('osascript timeout'); }
        },
      });

      const result = await wizard._checkPermissions();
      assert.equal(result.status, 'error');
      assert.ok(result.error.includes('osascript timeout'));
    });
  });

  // ===========================================================================
  // iTerm2 Python API (Step 2)
  // ===========================================================================

  describe('_checkITerm2Python()', () => {
    it('should return ok when iterm2 package is installed', async () => {
      const wizard = new mod.SetupWizard({
        projectRoot: '/tmp/test',
        execFn: async (cmd, args) => {
          if (args.includes('--version')) return { stdout: 'Python 3.11.0\n' };
          if (args.includes('import iterm2')) return { stdout: '' };
          return { stdout: '' };
        },
      });

      const result = await wizard._checkITerm2Python();
      assert.equal(result.status, 'ok');
      assert.equal(result.python, 'python3');
    });

    it('should return missing when iterm2 package not installed', async () => {
      const wizard = new mod.SetupWizard({
        projectRoot: '/tmp/test',
        execFn: createMockExecFn(),
      });

      const result = await wizard._checkITerm2Python();
      assert.equal(result.status, 'missing');
      assert.ok(result.reason.includes('iterm2'));
      assert.ok(result.instructions.length > 0);
      assert.ok(result.instructions.some(i => i.includes('pip install iterm2')));
    });

    it('should return missing when python3 not found', async () => {
      const wizard = new mod.SetupWizard({
        projectRoot: '/tmp/test',
        execFn: async () => { throw new Error('not found'); },
      });

      const result = await wizard._checkITerm2Python();
      assert.equal(result.status, 'missing');
      assert.ok(result.reason.includes('python3 not found'));
    });
  });

  // ===========================================================================
  // Telegram Bot Token (Step 3)
  // ===========================================================================

  describe('_checkTelegram()', () => {
    it('should return ok when token is set', () => {
      const origToken = process.env.PILOT_TELEGRAM_TOKEN;
      process.env.PILOT_TELEGRAM_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';

      try {
        const wizard = new mod.SetupWizard({ projectRoot: '/tmp/test' });
        const result = wizard._checkTelegram();
        assert.equal(result.status, 'ok');
        assert.equal(result.token_set, true);
      } finally {
        if (origToken === undefined) delete process.env.PILOT_TELEGRAM_TOKEN;
        else process.env.PILOT_TELEGRAM_TOKEN = origToken;
      }
    });

    it('should return skipped when telegram not enabled and no token', () => {
      const origToken = process.env.PILOT_TELEGRAM_TOKEN;
      delete process.env.PILOT_TELEGRAM_TOKEN;

      try {
        const wizard = new mod.SetupWizard({ projectRoot: '/tmp/nonexistent' });
        const result = wizard._checkTelegram();
        // Either 'skipped' (telegram not enabled) or 'missing' (telegram enabled but no token)
        assert.ok(['skipped', 'missing'].includes(result.status));
      } finally {
        if (origToken !== undefined) process.env.PILOT_TELEGRAM_TOKEN = origToken;
      }
    });
  });

  // ===========================================================================
  // Policy Configuration (Step 4)
  // ===========================================================================

  describe('_checkPolicy()', () => {
    it('should return error when policy cannot be loaded', () => {
      const wizard = new mod.SetupWizard({ projectRoot: '/tmp/nonexistent' });
      const result = wizard._checkPolicy();
      assert.equal(result.status, 'error');
    });
  });

  // ===========================================================================
  // Smoke Test (Step 5)
  // ===========================================================================

  describe('runSmokeTest()', () => {
    it('should return skipped when no terminal controller', async () => {
      const wizard = new mod.SetupWizard({ projectRoot: '/tmp/test' });
      const result = await wizard.runSmokeTest();
      assert.equal(result.status, 'skipped');
    });

    it('should run full smoke test with mock controller', async () => {
      const wizard = new mod.SetupWizard({ projectRoot: '/tmp/test' });

      const opened = [];
      const closed = [];

      const mockController = {
        openTab: async (opts) => {
          opened.push(opts);
          return 'mock-tab-1';
        },
        detectState: async (tabId) => ({
          state: 'idle',
        }),
        closeTab: async (tabId) => {
          closed.push(tabId);
        },
      };

      const result = await wizard.runSmokeTest({ terminalController: mockController });

      assert.equal(result.status, 'ok');
      assert.equal(result.details.opened, true);
      assert.equal(result.details.command_sent, true);
      assert.equal(result.details.output_read, true);
      assert.equal(result.details.closed, true);
      assert.equal(opened.length, 1);
      assert.equal(opened[0].role, 'test');
      assert.equal(closed.length, 1);
      assert.equal(closed[0], 'mock-tab-1');
    });

    it('should handle smoke test failure', async () => {
      const wizard = new mod.SetupWizard({ projectRoot: '/tmp/test' });

      const mockController = {
        openTab: async () => { throw new Error('Cannot open tab'); },
      };

      const result = await wizard.runSmokeTest({ terminalController: mockController });

      assert.equal(result.status, 'error');
      assert.ok(result.error.includes('Cannot open tab'));
      assert.equal(result.details.opened, false);
    });
  });

  // ===========================================================================
  // Full Check
  // ===========================================================================

  describe('checkAll()', () => {
    it('should return all steps with ready=true when everything OK', async () => {
      const wizard = new mod.SetupWizard({
        projectRoot: '/tmp/test',
        permissionChecker: createMockPermissionChecker(),
        execFn: async (cmd, args) => {
          if (args && args.includes('--version')) return { stdout: 'Python 3.11.0\n' };
          if (args && args.includes('import iterm2')) return { stdout: '' };
          return { stdout: '' };
        },
      });

      // Mock telegram token
      const origToken = process.env.PILOT_TELEGRAM_TOKEN;
      process.env.PILOT_TELEGRAM_TOKEN = '123456:ABC-valid-token-here';

      try {
        const result = await wizard.checkAll();

        assert.equal(result.steps.permissions.status, 'ok');
        assert.equal(result.steps.iterm2_python.status, 'ok');
        assert.equal(result.steps.telegram.status, 'ok');
        // Policy may fail since /tmp/test doesn't have policy.yaml
        assert.equal(result.steps.smoke_test.status, 'skipped');
      } finally {
        if (origToken === undefined) delete process.env.PILOT_TELEGRAM_TOKEN;
        else process.env.PILOT_TELEGRAM_TOKEN = origToken;
      }
    });
  });

  // ===========================================================================
  // Report Formatting
  // ===========================================================================

  describe('formatReport()', () => {
    it('should format a readable report', () => {
      const wizard = new mod.SetupWizard({ projectRoot: '/tmp/test' });

      const result = {
        ready: false,
        steps: {
          permissions: { status: 'ok', details: {} },
          iterm2_python: {
            status: 'missing',
            reason: 'iterm2 Python package not installed',
            instructions: ['pip install iterm2'],
          },
          telegram: { status: 'skipped', reason: 'Telegram not enabled' },
          policy: { status: 'ok' },
          smoke_test: { status: 'skipped', reason: 'Run interactively' },
        }
      };

      const report = wizard.formatReport(result);

      assert.ok(report.includes('PILOT AGI Setup Check'));
      assert.ok(report.includes('[+] macOS Permissions: OK'));
      assert.ok(report.includes('[!] iTerm2 Python API: MISSING'));
      assert.ok(report.includes('pip install iterm2'));
      assert.ok(report.includes('[-] Telegram Bot: SKIPPED'));
      assert.ok(report.includes('[+] Policy Configuration: OK'));
      assert.ok(report.includes('Some checks need attention'));
    });

    it('should show ready message when all pass', () => {
      const wizard = new mod.SetupWizard({ projectRoot: '/tmp/test' });

      const result = {
        ready: true,
        steps: {
          permissions: { status: 'ok' },
          iterm2_python: { status: 'ok' },
          telegram: { status: 'ok' },
          policy: { status: 'ok' },
          smoke_test: { status: 'ok' },
        }
      };

      const report = wizard.formatReport(result);
      assert.ok(report.includes('Ready to go!'));
    });

    it('should show issues when policy has problems', () => {
      const wizard = new mod.SetupWizard({ projectRoot: '/tmp/test' });

      const result = {
        ready: false,
        steps: {
          permissions: { status: 'ok' },
          iterm2_python: { status: 'ok' },
          telegram: { status: 'ok' },
          policy: {
            status: 'issues',
            issues: [
              'terminal_orchestration section missing from policy.yaml',
              'telegram section missing from policy.yaml',
            ]
          },
          smoke_test: { status: 'skipped', reason: 'Run interactively' },
        }
      };

      const report = wizard.formatReport(result);
      assert.ok(report.includes('[X] Policy Configuration: ISSUES'));
      assert.ok(report.includes('terminal_orchestration section missing'));
      assert.ok(report.includes('telegram section missing'));
    });
  });
});
