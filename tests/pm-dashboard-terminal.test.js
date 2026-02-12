/**
 * Tests for PM Dashboard Terminal
 * Phase 6.16: Multi-Model View (Pilot AGI-5jg)
 * Phase 6.7: Interactive PM Dashboard (Pilot AGI-4b6)
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

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
      assert.ok(mod.PmDashboardInteractive);
      assert.ok(mod.renderBar);
      assert.ok(mod.pad);
      assert.ok(mod.SHORTCUTS);
      assert.ok(mod.COLUMN_WIDTHS);
      assert.ok(mod.REFRESH_INTERVAL_MS);
      assert.ok(mod.MAX_EVENTS);
      assert.ok(mod.MAX_QUEUE_ITEMS);
      assert.equal(mod.REFRESH_INTERVAL_MS, 5000);
    });
  });

  // ===========================================================================
  // Phase 6.7 — Queue Status
  // ===========================================================================

  describe('_renderQueueStatus()', () => {
    it('should show empty queue message', () => {
      const dashboard = new mod.PmDashboard({ projectRoot: '/tmp/test' });

      const data = { tasks: { items: [] } };
      const output = dashboard._renderQueueStatus(data);

      assert.ok(output.includes('QUEUE'));
      assert.ok(output.includes('No tasks in queue'));
    });

    it('should render queued tasks sorted by priority', () => {
      const dashboard = new mod.PmDashboard({ projectRoot: '/tmp/test' });

      const data = {
        tasks: {
          items: [
            { id: 'T-002', status: 'open', priority: 'P2', title: 'Low priority task' },
            { id: 'T-001', status: 'open', priority: 'P1', title: 'High priority task' },
            { id: 'T-003', status: 'in_progress', priority: 'P1', title: 'Active task' },
          ]
        }
      };

      const output = dashboard._renderQueueStatus(data);

      assert.ok(output.includes('QUEUE (2 tasks)'));
      assert.ok(output.includes('T-001'));
      assert.ok(output.includes('T-002'));
      assert.ok(!output.includes('T-003')); // in_progress excluded
      // P1 should appear before P2
      const p1Pos = output.indexOf('P1');
      const p2Pos = output.indexOf('P2');
      assert.ok(p1Pos < p2Pos);
    });

    it('should show blocked dependencies', () => {
      const dashboard = new mod.PmDashboard({ projectRoot: '/tmp/test' });

      const data = {
        tasks: {
          items: [
            { id: 'T-001', status: 'open', priority: 'P1', title: 'Blocked task', blocked_by: ['T-099'] }
          ]
        }
      };

      const output = dashboard._renderQueueStatus(data);
      assert.ok(output.includes('[blocked: T-099]'));
    });
  });

  // ===========================================================================
  // Phase 6.7 — Recent Events
  // ===========================================================================

  describe('_renderRecentEvents()', () => {
    it('should show empty events message', () => {
      const dashboard = new mod.PmDashboard({ projectRoot: '/tmp/test' });

      const output = dashboard._renderRecentEvents({ events: [] });

      assert.ok(output.includes('RECENT EVENTS'));
      assert.ok(output.includes('No recent events'));
    });

    it('should render recent events with timestamps', () => {
      const dashboard = new mod.PmDashboard({ projectRoot: '/tmp/test' });

      const data = {
        events: [
          { timestamp: '2026-02-12T10:00:00Z', type: 'task_assigned', message: 'Agent A assigned T-001' },
          { timestamp: '2026-02-12T10:01:00Z', type: 'merge_approved', message: 'Merge approved for T-002' }
        ]
      };

      const output = dashboard._renderRecentEvents(data);

      assert.ok(output.includes('RECENT EVENTS (2)'));
      assert.ok(output.includes('task_assigned'));
      assert.ok(output.includes('merge_approved'));
      assert.ok(output.includes('Agent A assigned T-001'));
    });

    it('should truncate long event lists', () => {
      const dashboard = new mod.PmDashboard({ projectRoot: '/tmp/test' });

      const events = Array.from({ length: 20 }, (_, i) => ({
        timestamp: '2026-02-12T10:00:00Z',
        type: `event_${i}`,
        message: `Event ${i}`
      }));

      const output = dashboard._renderRecentEvents({ events });

      assert.ok(output.includes('12 older events'));
    });
  });
});

// =============================================================================
// Phase 6.7 — Interactive PM Dashboard (Pilot AGI-4b6)
// =============================================================================

/**
 * Create a mock stdin-like EventEmitter that supports setRawMode.
 */
function createMockInput() {
  const emitter = new EventEmitter();
  emitter.isTTY = true;
  emitter.setRawMode = () => {};
  emitter.resume = () => {};
  emitter.pause = () => {};
  return emitter;
}

/**
 * Create a mock output that captures writes.
 */
function createMockOutput() {
  const chunks = [];
  return {
    chunks,
    write(chunk) { chunks.push(chunk); },
    lastOutput() { return chunks[chunks.length - 1] || ''; },
    allOutput() { return chunks.join(''); }
  };
}

/**
 * Build a standard empty data object for testing renders.
 */
function emptyData() {
  return {
    agents: [],
    tasks: { open: 0, in_progress: 0, closed: 0, total: 0, items: [] },
    locks: { areas: [], files: [] },
    costs: [],
    pressure: [],
    drift: [],
    events: [],
    multiModel: {
      dailyReport: null,
      providerBudgets: {},
      savings: { opusEquivalent: 0, actual: 0, saved: 0, percentSaved: '0.0' },
      modelShortNames: {}
    },
    collected_at: new Date().toISOString()
  };
}

describe('PmDashboardInteractive', () => {
  let mod, input, output;

  beforeEach(() => {
    mod = freshModule('../lib/pm-dashboard-terminal');
    input = createMockInput();
    output = createMockOutput();
  });

  describe('constructor and lifecycle', () => {
    it('should create interactive dashboard', () => {
      const interactive = new mod.PmDashboardInteractive({
        projectRoot: '/tmp/test',
        input,
        output,
        refreshMs: 100000
      });

      assert.ok(interactive.inner instanceof mod.PmDashboard);
      assert.equal(interactive.running, false);
    });

    it('should start and stop cleanly', () => {
      const interactive = new mod.PmDashboardInteractive({
        projectRoot: '/tmp/test',
        input,
        output,
        refreshMs: 100000
      });

      interactive.start();
      assert.equal(interactive.running, true);

      // Should have rendered
      assert.ok(output.chunks.length > 0);

      interactive.stop();
      assert.equal(interactive.running, false);
    });

    it('should render status bar with shortcuts', () => {
      const interactive = new mod.PmDashboardInteractive({
        projectRoot: '/tmp/test',
        input,
        output,
        refreshMs: 100000
      });

      interactive.start();

      const all = output.allOutput();
      assert.ok(all.includes('k:kill'));
      assert.ok(all.includes('a:approve'));
      assert.ok(all.includes('s:scale'));
      assert.ok(all.includes('q:quit'));
      assert.ok(all.includes('?:help'));

      interactive.stop();
    });
  });

  describe('keyboard shortcuts', () => {
    it('should quit on q key', () => {
      const actions = [];
      const interactive = new mod.PmDashboardInteractive({
        projectRoot: '/tmp/test',
        input,
        output,
        refreshMs: 100000,
        onAction: (a) => actions.push(a)
      });

      interactive.start();
      input.emit('data', Buffer.from('q'));

      assert.equal(interactive.running, false);
      assert.equal(actions.length, 1);
      assert.equal(actions[0].type, 'quit');
    });

    it('should quit on Ctrl+C', () => {
      const actions = [];
      const interactive = new mod.PmDashboardInteractive({
        projectRoot: '/tmp/test',
        input,
        output,
        refreshMs: 100000,
        onAction: (a) => actions.push(a)
      });

      interactive.start();
      input.emit('data', Buffer.from('\x03'));

      assert.equal(interactive.running, false);
      assert.equal(actions[0].type, 'quit');
    });

    it('should show help on ? key', () => {
      const interactive = new mod.PmDashboardInteractive({
        projectRoot: '/tmp/test',
        input,
        output,
        refreshMs: 100000
      });

      interactive.start();
      output.chunks.length = 0; // Clear initial render

      input.emit('data', Buffer.from('?'));

      const all = output.allOutput();
      assert.ok(all.includes('Keyboard Shortcuts'));
      assert.ok(all.includes('Kill agent'));
      assert.ok(all.includes('Approve pending merge'));
      assert.ok(all.includes('Scale agents'));

      // Press any key to return
      output.chunks.length = 0;
      input.emit('data', Buffer.from('x'));
      const after = output.allOutput();
      assert.ok(after.includes('PILOT AGI'));

      interactive.stop();
    });

    it('should refresh on r key', () => {
      const interactive = new mod.PmDashboardInteractive({
        projectRoot: '/tmp/test',
        input,
        output,
        refreshMs: 100000
      });

      interactive.start();
      const initialChunks = output.chunks.length;

      input.emit('data', Buffer.from('r'));

      // Should have rendered again
      assert.ok(output.chunks.length > initialChunks);
      assert.ok(output.allOutput().includes('Refreshed'));

      interactive.stop();
    });
  });

  describe('kill agent action', () => {
    it('should show "no agents" when empty', () => {
      const interactive = new mod.PmDashboardInteractive({
        projectRoot: '/tmp/test',
        input,
        output,
        refreshMs: 100000
      });

      interactive.start();
      input.emit('data', Buffer.from('k'));

      assert.ok(output.allOutput().includes('No agents to kill'));

      interactive.stop();
    });

    it('should prompt for agent number and kill', async () => {
      const actions = [];
      const closedTabs = [];
      const interactive = new mod.PmDashboardInteractive({
        projectRoot: '/tmp/test',
        input,
        output,
        refreshMs: 100000,
        terminalController: {
          closeTab: async (tabId) => { closedTabs.push(tabId); }
        },
        onAction: (a) => actions.push(a)
      });

      // Inject agent data
      interactive.start();
      interactive._lastData = {
        ...emptyData(),
        agents: [
          { agent_name: 'agent-1', session_id: 'S-1', claimed_task: 'T-001', tabId: 'tab-1', status: 'healthy' },
          { agent_name: 'agent-2', session_id: 'S-2', claimed_task: 'T-002', tabId: 'tab-2', status: 'healthy' }
        ]
      };

      // Press 'k'
      input.emit('data', Buffer.from('k'));
      assert.ok(output.allOutput().includes('Kill agent'));

      // Type '1' and Enter
      input.emit('data', Buffer.from('1'));
      input.emit('data', Buffer.from('\r'));

      // Wait for async closeTab
      await new Promise(r => setTimeout(r, 20));

      assert.deepEqual(closedTabs, ['tab-1']);
      assert.equal(actions.length, 1);
      assert.equal(actions[0].type, 'kill');
      assert.equal(actions[0].agent, 'agent-1');

      interactive.stop();
    });

    it('should reject invalid agent number', () => {
      const interactive = new mod.PmDashboardInteractive({
        projectRoot: '/tmp/test',
        input,
        output,
        refreshMs: 100000
      });

      interactive.start();
      interactive._lastData = {
        ...emptyData(),
        agents: [{ agent_name: 'agent-1', session_id: 'S-1', status: 'healthy' }]
      };

      input.emit('data', Buffer.from('k'));
      input.emit('data', Buffer.from('9'));
      input.emit('data', Buffer.from('\r'));

      assert.ok(output.allOutput().includes('Invalid agent number'));

      interactive.stop();
    });
  });

  describe('approve action', () => {
    it('should prompt for task ID and approve', () => {
      const actions = [];
      const interactive = new mod.PmDashboardInteractive({
        projectRoot: '/tmp/test',
        input,
        output,
        refreshMs: 100000,
        orchestrator: {
          approveMerge: (taskId) => ({ success: true })
        },
        onAction: (a) => actions.push(a)
      });

      interactive.start();

      input.emit('data', Buffer.from('a'));
      assert.ok(output.allOutput().includes('Approve task ID'));

      // Type task ID and enter
      'T-001'.split('').forEach(c => input.emit('data', Buffer.from(c)));
      input.emit('data', Buffer.from('\r'));

      assert.ok(output.allOutput().includes('Approved merge for T-001'));
      assert.equal(actions.length, 1);
      assert.equal(actions[0].type, 'approve');
      assert.equal(actions[0].taskId, 'T-001');

      interactive.stop();
    });

    it('should handle approve "all"', () => {
      const actions = [];
      const interactive = new mod.PmDashboardInteractive({
        projectRoot: '/tmp/test',
        input,
        output,
        refreshMs: 100000,
        onAction: (a) => actions.push(a)
      });

      interactive.start();
      input.emit('data', Buffer.from('a'));
      'all'.split('').forEach(c => input.emit('data', Buffer.from(c)));
      input.emit('data', Buffer.from('\r'));

      assert.equal(actions[0].type, 'approve_all');

      interactive.stop();
    });
  });

  describe('scale action', () => {
    it('should prompt for target count and scale', async () => {
      const actions = [];
      const interactive = new mod.PmDashboardInteractive({
        projectRoot: '/tmp/test',
        input,
        output,
        refreshMs: 100000,
        terminalController: {
          scaleAgents: async (target) => ({ opened: target, closed: 0 })
        },
        onAction: (a) => actions.push(a)
      });

      interactive.start();
      input.emit('data', Buffer.from('s'));
      assert.ok(output.allOutput().includes('Target agent count'));

      input.emit('data', Buffer.from('3'));
      input.emit('data', Buffer.from('\r'));

      await new Promise(r => setTimeout(r, 20));

      assert.ok(output.allOutput().includes('+3'));
      assert.equal(actions[0].type, 'scale');
      assert.equal(actions[0].target, 3);

      interactive.stop();
    });

    it('should reject invalid scale number', () => {
      const interactive = new mod.PmDashboardInteractive({
        projectRoot: '/tmp/test',
        input,
        output,
        refreshMs: 100000
      });

      interactive.start();
      input.emit('data', Buffer.from('s'));
      input.emit('data', Buffer.from('x'));
      input.emit('data', Buffer.from('\r'));

      assert.ok(output.allOutput().includes('Invalid number'));

      interactive.stop();
    });

    it('should handle missing terminal controller', () => {
      const interactive = new mod.PmDashboardInteractive({
        projectRoot: '/tmp/test',
        input,
        output,
        refreshMs: 100000
      });

      interactive.start();
      input.emit('data', Buffer.from('s'));
      input.emit('data', Buffer.from('3'));
      input.emit('data', Buffer.from('\r'));

      assert.ok(output.allOutput().includes('Terminal controller unavailable'));

      interactive.stop();
    });
  });

  describe('input mode', () => {
    it('should cancel input on ESC', () => {
      const interactive = new mod.PmDashboardInteractive({
        projectRoot: '/tmp/test',
        input,
        output,
        refreshMs: 100000
      });

      interactive.start();
      interactive._lastData = {
        ...emptyData(),
        agents: [{ agent_name: 'agent-1', session_id: 'S-1', status: 'healthy' }]
      };

      input.emit('data', Buffer.from('k'));
      assert.equal(interactive._mode, 'input');

      input.emit('data', Buffer.from('\x1B'));
      assert.equal(interactive._mode, 'dashboard');
      assert.ok(output.allOutput().includes('Cancelled'));

      interactive.stop();
    });

    it('should handle backspace in input', () => {
      const interactive = new mod.PmDashboardInteractive({
        projectRoot: '/tmp/test',
        input,
        output,
        refreshMs: 100000,
        orchestrator: { approveMerge: () => ({ success: true }) }
      });

      interactive.start();
      input.emit('data', Buffer.from('a'));

      // Type "AB", backspace, then "C"
      input.emit('data', Buffer.from('A'));
      input.emit('data', Buffer.from('B'));
      input.emit('data', Buffer.from('\x7f')); // Backspace
      input.emit('data', Buffer.from('C'));
      input.emit('data', Buffer.from('\r'));

      assert.ok(output.allOutput().includes('Approved merge for AC'));

      interactive.stop();
    });
  });

  describe('SHORTCUTS constant', () => {
    it('should define all expected shortcuts', () => {
      assert.ok(mod.SHORTCUTS.k);
      assert.ok(mod.SHORTCUTS.a);
      assert.ok(mod.SHORTCUTS.s);
      assert.ok(mod.SHORTCUTS.r);
      assert.ok(mod.SHORTCUTS.q);
      assert.ok(mod.SHORTCUTS['?']);
    });

    it('should have labels and descriptions', () => {
      for (const [key, info] of Object.entries(mod.SHORTCUTS)) {
        assert.ok(info.label, `Missing label for ${key}`);
        assert.ok(info.description, `Missing description for ${key}`);
      }
    });
  });
});
