/**
 * Tests for Phase 6.16: PM Dashboard with Multi-Model View (Pilot AGI-5jg)
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
// TESTS
// =============================================================================

describe('PmDashboard', () => {
  let mod;

  beforeEach(() => {
    mod = freshModule('../lib/pm-dashboard-terminal');
  });

  describe('renderBar()', () => {
    it('should render empty bar at 0%', () => {
      const bar = mod.renderBar(0, 10);
      assert.equal(bar, '[----------]');
    });

    it('should render full bar at 100%', () => {
      const bar = mod.renderBar(1, 10);
      assert.equal(bar, '[==========]');
    });

    it('should render half bar at 50%', () => {
      const bar = mod.renderBar(0.5, 10);
      assert.equal(bar, '[=====-----]');
    });

    it('should clamp values above 1', () => {
      const bar = mod.renderBar(1.5, 10);
      assert.equal(bar, '[==========]');
    });

    it('should clamp negative values', () => {
      const bar = mod.renderBar(-0.5, 10);
      assert.equal(bar, '[----------]');
    });

    it('should work with custom width', () => {
      const bar = mod.renderBar(0.5, 20);
      // 10 filled, 10 empty
      assert.equal(bar.length, 22); // width + 2 brackets
    });
  });

  describe('pad()', () => {
    it('should pad short strings', () => {
      assert.equal(mod.pad('hi', 6), 'hi    ');
    });

    it('should truncate long strings', () => {
      assert.equal(mod.pad('hello world', 5), 'hello');
    });

    it('should handle exact width', () => {
      assert.equal(mod.pad('test', 4), 'test');
    });

    it('should handle null/undefined', () => {
      assert.equal(mod.pad(null, 4), '    ');
      assert.equal(mod.pad(undefined, 4), '    ');
    });
  });

  describe('constructor', () => {
    it('should create dashboard with project root', () => {
      const dashboard = new mod.PmDashboard({
        projectRoot: '/tmp/test'
      });

      assert.equal(dashboard.projectRoot, '/tmp/test');
    });
  });

  describe('render()', () => {
    it('should render with empty data', () => {
      const dashboard = new mod.PmDashboard({
        projectRoot: '/tmp/nonexistent'
      });

      const data = {
        agents: [],
        tasks: { open: 0, in_progress: 0, closed: 0, total: 0, items: [] },
        locks: { areas: [], files: [] },
        costs: [],
        pressure: [],
        drift: [],
        multiModel: {
          dailyReport: null,
          providerBudgets: {},
          savings: { opusEquivalent: 0, actual: 0, saved: 0, percentSaved: '0.0' },
          modelShortNames: {}
        },
        collected_at: new Date().toISOString()
      };

      const output = dashboard.render(data);

      assert.ok(output.includes('PILOT AGI'));
      assert.ok(output.includes('Multi-Model Dashboard'));
      assert.ok(output.includes('AGENTS'));
      assert.ok(output.includes('no active agents'));
      assert.ok(output.includes('COSTS'));
      assert.ok(output.includes('SAVINGS'));
    });

    it('should render agents with model labels', () => {
      const dashboard = new mod.PmDashboard({
        projectRoot: '/tmp/nonexistent'
      });

      const data = {
        agents: [
          {
            session_id: 'S-test-1234',
            agent_name: 'agent-1234',
            claimed_task: 'Pilot AGI-abc',
            status: 'healthy',
            modelId: 'gpt-4.5'
          },
          {
            session_id: 'S-test-5678',
            agent_name: 'agent-5678',
            claimed_task: 'Pilot AGI-def',
            status: 'stale',
            modelId: 'claude-opus-4-6'
          }
        ],
        tasks: { open: 3, in_progress: 2, closed: 10, total: 15, items: [] },
        locks: { areas: [], files: [] },
        costs: [],
        pressure: [],
        drift: [],
        multiModel: {
          dailyReport: null,
          providerBudgets: {},
          savings: { opusEquivalent: 0, actual: 0, saved: 0, percentSaved: '0.0' },
          modelShortNames: {
            'gpt-4.5': 'GPT-4.5',
            'claude-opus-4-6': 'Opus'
          }
        },
        collected_at: new Date().toISOString()
      };

      const output = dashboard.render(data);

      assert.ok(output.includes('GPT-4.5'));
      assert.ok(output.includes('Opus'));
      assert.ok(output.includes('agent-1234'));
      assert.ok(output.includes('agent-5678'));
      assert.ok(output.includes('2 active'));
      assert.ok(output.includes('3 queued'));
    });

    it('should render cost summary by model', () => {
      const dashboard = new mod.PmDashboard({
        projectRoot: '/tmp/nonexistent'
      });

      const data = {
        agents: [],
        tasks: { open: 0, in_progress: 0, closed: 0, total: 0, items: [] },
        locks: { areas: [], files: [] },
        costs: [],
        pressure: [],
        drift: [],
        multiModel: {
          dailyReport: {
            date: '2026-02-12',
            total: 5.25,
            byModel: {
              'claude-opus-4-6': { dollars: 3.75, tokens: 150000, entries: 2 },
              'gpt-4.5': { dollars: 1.50, tokens: 200000, entries: 3 }
            },
            byProvider: {},
            savings: { opusEquivalent: 8.0, actual: 5.25, saved: 2.75, percentSaved: '34.4' },
            entryCount: 5
          },
          providerBudgets: {},
          savings: { opusEquivalent: 8.0, actual: 5.25, saved: 2.75, percentSaved: '34.4' },
          modelShortNames: {
            'claude-opus-4-6': 'Opus',
            'gpt-4.5': 'GPT-4.5'
          }
        },
        collected_at: new Date().toISOString()
      };

      const output = dashboard.render(data);

      assert.ok(output.includes('$5.25'));
      assert.ok(output.includes('Opus'));
      assert.ok(output.includes('GPT-4.5'));
      assert.ok(output.includes('2 calls'));
      assert.ok(output.includes('3 calls'));
    });

    it('should render provider budget bars', () => {
      const dashboard = new mod.PmDashboard({
        projectRoot: '/tmp/nonexistent'
      });

      const data = {
        agents: [],
        tasks: { open: 0, in_progress: 0, closed: 0, total: 0, items: [] },
        locks: { areas: [], files: [] },
        costs: [],
        pressure: [],
        drift: [],
        multiModel: {
          dailyReport: null,
          providerBudgets: {
            anthropic: { status: 'ok', spent: 10.0, budget: 50.0 },
            openai: { status: 'warning', spent: 25.0, budget: 30.0 },
            local: { status: 'ok', spent: 0, budget: null }
          },
          savings: { opusEquivalent: 0, actual: 0, saved: 0, percentSaved: '0.0' },
          modelShortNames: {}
        },
        collected_at: new Date().toISOString()
      };

      const output = dashboard.render(data);

      assert.ok(output.includes('PROVIDER BUDGETS'));
      assert.ok(output.includes('anthropic'));
      assert.ok(output.includes('openai'));
      assert.ok(output.includes('$10.00/$50.00'));
      assert.ok(output.includes('$25.00/$30.00'));
      assert.ok(output.includes('unlimited'));
      // Warning indicator for openai
      assert.ok(output.includes('!'));
    });

    it('should render savings vs all-Opus', () => {
      const dashboard = new mod.PmDashboard({
        projectRoot: '/tmp/nonexistent'
      });

      const data = {
        agents: [],
        tasks: { open: 0, in_progress: 0, closed: 0, total: 0, items: [] },
        locks: { areas: [], files: [] },
        costs: [],
        pressure: [],
        drift: [],
        multiModel: {
          dailyReport: null,
          providerBudgets: {},
          savings: { opusEquivalent: 50.0, actual: 12.50, saved: 37.50, percentSaved: '75.0' },
          modelShortNames: {}
        },
        collected_at: new Date().toISOString()
      };

      const output = dashboard.render(data);

      assert.ok(output.includes('SAVINGS'));
      assert.ok(output.includes('$12.50'));
      assert.ok(output.includes('$50.00'));
      assert.ok(output.includes('$37.50'));
      assert.ok(output.includes('75.0%'));
    });
  });

  describe('_formatStatus()', () => {
    it('should map status codes to display labels', () => {
      const dashboard = new mod.PmDashboard({ projectRoot: '/tmp/test' });

      assert.equal(dashboard._formatStatus('healthy'), 'OK');
      assert.equal(dashboard._formatStatus('stale'), 'STALE');
      assert.equal(dashboard._formatStatus('unresponsive'), 'UNRES');
      assert.equal(dashboard._formatStatus('dead'), 'DEAD');
      assert.equal(dashboard._formatStatus('lease_expired'), 'EXPRD');
      assert.equal(dashboard._formatStatus(null), '-');
      assert.equal(dashboard._formatStatus(undefined), '-');
    });
  });

  describe('_getModelShortName()', () => {
    it('should use provided model short names', () => {
      const dashboard = new mod.PmDashboard({ projectRoot: '/tmp/test' });

      const data = {
        multiModel: {
          modelShortNames: { 'gpt-4.5': 'GPT-4.5' }
        }
      };

      assert.equal(dashboard._getModelShortName('gpt-4.5', data), 'GPT-4.5');
    });

    it('should generate fallback for unknown models', () => {
      const dashboard = new mod.PmDashboard({ projectRoot: '/tmp/test' });

      const data = { multiModel: { modelShortNames: {} } };

      const name = dashboard._getModelShortName('ollama:custom-model', data);
      assert.ok(name.length > 0);
      assert.ok(name !== 'ollama:custom-model'); // Should be formatted
    });
  });

  describe('startLive() / stopLive()', () => {
    it('should start and stop without error', () => {
      const dashboard = new mod.PmDashboard({
        projectRoot: '/tmp/nonexistent'
      });

      // Use a mock output to prevent clearing terminal
      const chunks = [];
      const mockOutput = {
        write(chunk) { chunks.push(chunk); }
      };

      const live = dashboard.startLive({ refreshMs: 100000, output: mockOutput });

      // Should have rendered once immediately
      assert.ok(chunks.length > 0);
      assert.ok(chunks.some(c => c.includes('PILOT AGI')));

      live.stop();
    });

    it('should be stoppable via stopLive()', () => {
      const dashboard = new mod.PmDashboard({
        projectRoot: '/tmp/nonexistent'
      });

      const mockOutput = { write() {} };
      dashboard.startLive({ refreshMs: 100000, output: mockOutput });
      dashboard.stopLive();

      // Should not throw
      assert.equal(dashboard._intervalId, null);
    });
  });

  describe('exports', () => {
    it('should export all public interfaces', () => {
      assert.ok(mod.PmDashboard);
      assert.ok(mod.renderBar);
      assert.ok(mod.pad);
      assert.ok(mod.COLUMN_WIDTHS);
      assert.ok(mod.REFRESH_INTERVAL_MS);
      assert.equal(mod.REFRESH_INTERVAL_MS, 5000);
    });
  });
});
