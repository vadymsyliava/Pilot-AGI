/**
 * Tests for Terminal Controller — Phase 6.3 (Pilot AGI-l6p)
 *
 * Tests the unified terminal controller:
 * - Provider detection (iterm2 vs applescript)
 * - Tab registry (open, close, find, list)
 * - Sync loop (state updates, removal of closed tabs)
 * - High-level ops (scaleAgents, autoApprove, broadcastToAll, etc.)
 * - Monitoring (getGroundTruth, detectStalled, getTabMetrics)
 *
 * Mocks both applescript-bridge and iterm2-bridge modules.
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/terminal-controller.test.js
 */

const assert = require('assert');
const path = require('path');

// ============================================================================
// TEST INFRASTRUCTURE
// ============================================================================

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

// ============================================================================
// MOCK PROVIDERS
// ============================================================================

function createMockAppleScript() {
  let tabCounter = 0;
  const tabs = new Map();

  return {
    _tabs: tabs,
    isAvailable: async () => true,
    openTab: async (opts) => {
      const tabId = `terminal:${++tabCounter}:${opts.title || 'pilot-test'}`;
      tabs.set(tabId, { title: opts.title, state: 'idle' });
      return { tabId, title: opts.title };
    },
    sendToTab: async (tabId, command) => {
      if (!tabs.has(tabId)) throw new Error(`Tab not found: ${tabId}`);
    },
    readTab: async (tabId, opts) => {
      if (!tabs.has(tabId)) throw new Error(`Tab not found: ${tabId}`);
      return '> ';
    },
    closeTab: async (tabId) => {
      if (!tabs.has(tabId)) return false;
      tabs.delete(tabId);
      return true;
    },
    detectState: async (tabId) => {
      if (!tabs.has(tabId)) throw new Error(`Tab not found: ${tabId}`);
      const tab = tabs.get(tabId);
      return { state: tab.state || 'idle', match: null };
    },
    listTabs: async () => {
      return Array.from(tabs.entries()).map(([tabId, t]) => ({
        tabId,
        title: t.title,
        windowId: '1',
      }));
    },
  };
}

function createMockITerm2Bridge() {
  let tabCounter = 0;
  const tabs = new Map();

  return {
    _tabs: tabs,
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    openTab: async (opts) => {
      const tabId = `iterm2-session-${++tabCounter}`;
      tabs.set(tabId, { title: opts.title, state: 'idle' });
      return { tabId, title: opts.title };
    },
    sendToTab: async (tabId, command) => {
      if (!tabs.has(tabId)) throw new Error(`Session not found: ${tabId}`);
    },
    readTab: async (tabId, opts) => {
      if (!tabs.has(tabId)) throw new Error(`Session not found: ${tabId}`);
      return '> ';
    },
    closeTab: async (tabId) => {
      if (!tabs.has(tabId)) return false;
      tabs.delete(tabId);
      return true;
    },
    detectState: async (tabId) => {
      if (!tabs.has(tabId)) throw new Error(`Session not found: ${tabId}`);
      const tab = tabs.get(tabId);
      return { state: tab.state || 'idle', match: null };
    },
    listTabs: async () => {
      return Array.from(tabs.entries()).map(([tabId, t]) => ({
        tabId,
        title: t.title,
        alive: true,
      }));
    },
  };
}

/**
 * Setup fresh controller with mocked dependencies.
 */
function setupController(providerType = 'applescript') {
  // Clear caches
  Object.keys(require.cache).forEach(k => {
    if (k.includes('terminal-controller') || k.includes('applescript-bridge') || k.includes('iterm2-bridge')) {
      if (!k.includes('__tests__')) delete require.cache[k];
    }
  });

  const mockAS = createMockAppleScript();
  const mockIT = createMockITerm2Bridge();

  // Override require resolution
  const asPath = require.resolve('../applescript-bridge');
  const itPath = require.resolve('../iterm2-bridge');

  require.cache[asPath] = {
    id: asPath,
    filename: asPath,
    loaded: true,
    exports: mockAS,
  };

  require.cache[itPath] = {
    id: itPath,
    filename: itPath,
    loaded: true,
    exports: {
      ITerm2Bridge: function() { return mockIT; },
      checkAvailability: async () => ({
        available: providerType === 'iterm2',
        installed: providerType === 'iterm2',
        running: providerType === 'iterm2',
        pythonAPI: providerType === 'iterm2',
      }),
    },
  };

  const { TerminalController } = require('../terminal-controller');

  const controller = new TerminalController({
    policy: { provider: providerType === 'auto' ? 'auto' : providerType },
  });

  return { controller, mockAS, mockIT };
}

// ============================================================================
// PROVIDER DETECTION TESTS
// ============================================================================

async function testProviderDetection() {
  console.log('\n── Provider Detection ──');

  await test('detects applescript when forced', async () => {
    const { controller } = setupController('applescript');
    const { provider } = await controller.start();
    assert.strictEqual(provider, 'applescript');
    await controller.stop();
  });

  await test('detects iterm2 when forced', async () => {
    const { controller } = setupController('iterm2');
    const { provider } = await controller.start();
    assert.strictEqual(provider, 'iterm2');
    await controller.stop();
  });

  await test('auto-detects iterm2 when available', async () => {
    // Setup auto mode where iterm2 is available
    Object.keys(require.cache).forEach(k => {
      if (k.includes('terminal-controller') || k.includes('applescript-bridge') || k.includes('iterm2-bridge')) {
        if (!k.includes('__tests__')) delete require.cache[k];
      }
    });

    const mockAS = createMockAppleScript();
    const mockIT = createMockITerm2Bridge();
    const asPath = require.resolve('../applescript-bridge');
    const itPath = require.resolve('../iterm2-bridge');

    require.cache[asPath] = { id: asPath, filename: asPath, loaded: true, exports: mockAS };
    require.cache[itPath] = {
      id: itPath, filename: itPath, loaded: true,
      exports: {
        ITerm2Bridge: function() { return mockIT; },
        checkAvailability: async () => ({ available: true, installed: true, running: true, pythonAPI: true }),
      },
    };

    const { TerminalController } = require('../terminal-controller');
    const controller = new TerminalController({ policy: { provider: 'auto' } });
    const { provider } = await controller.start();
    assert.strictEqual(provider, 'iterm2');
    await controller.stop();
  });

  await test('start is idempotent', async () => {
    const { controller } = setupController('applescript');
    await controller.start();
    const { provider } = await controller.start(); // Second call
    assert.strictEqual(provider, 'applescript');
    await controller.stop();
  });
}

// ============================================================================
// TAB REGISTRY TESTS
// ============================================================================

async function testRegistry() {
  console.log('\n── Tab Registry ──');

  await test('openTab adds entry to registry', async () => {
    const { controller } = setupController('applescript');
    await controller.start();

    const entry = await controller.openTab({
      command: 'echo hello',
      taskId: 'task-1',
      role: 'frontend',
      title: 'pilot-task-1',
    });

    assert.ok(entry.tabId);
    assert.strictEqual(entry.taskId, 'task-1');
    assert.strictEqual(entry.role, 'frontend');
    assert.strictEqual(entry.state, 'starting');
    assert.strictEqual(entry.provider, 'applescript');

    const stored = controller.getTab(entry.tabId);
    assert.strictEqual(stored.taskId, 'task-1');

    await controller.stop();
  });

  await test('closeTab removes from registry', async () => {
    const { controller } = setupController('applescript');
    await controller.start();

    const entry = await controller.openTab({ command: 'echo', taskId: 'task-2' });
    assert.strictEqual(controller.getAllTabs().length, 1);

    await controller.closeTab(entry.tabId);
    assert.strictEqual(controller.getAllTabs().length, 0);
    assert.strictEqual(controller.getTab(entry.tabId), undefined);

    await controller.stop();
  });

  await test('findByTaskId returns matching entry', async () => {
    const { controller } = setupController('applescript');
    await controller.start();

    await controller.openTab({ command: 'a', taskId: 'task-a', role: 'frontend' });
    await controller.openTab({ command: 'b', taskId: 'task-b', role: 'backend' });

    const found = controller.findByTaskId('task-b');
    assert.ok(found);
    assert.strictEqual(found.taskId, 'task-b');
    assert.strictEqual(found.role, 'backend');

    assert.strictEqual(controller.findByTaskId('task-z'), undefined);

    await controller.stop();
  });

  await test('findByRole returns matching entries', async () => {
    const { controller } = setupController('applescript');
    await controller.start();

    await controller.openTab({ command: 'a', taskId: 't1', role: 'frontend' });
    await controller.openTab({ command: 'b', taskId: 't2', role: 'frontend' });
    await controller.openTab({ command: 'c', taskId: 't3', role: 'backend' });

    const frontends = controller.findByRole('frontend');
    assert.strictEqual(frontends.length, 2);

    const backends = controller.findByRole('backend');
    assert.strictEqual(backends.length, 1);

    await controller.stop();
  });

  await test('getAllTabs returns all entries', async () => {
    const { controller } = setupController('applescript');
    await controller.start();

    await controller.openTab({ command: 'a', taskId: 't1' });
    await controller.openTab({ command: 'b', taskId: 't2' });
    await controller.openTab({ command: 'c', taskId: 't3' });

    assert.strictEqual(controller.getAllTabs().length, 3);

    await controller.stop();
  });
}

// ============================================================================
// SYNC LOOP TESTS
// ============================================================================

async function testSync() {
  console.log('\n── Sync Loop ──');

  await test('sync updates state from provider', async () => {
    const { controller, mockAS } = setupController('applescript');
    await controller.start();

    const entry = await controller.openTab({ command: 'a', taskId: 't1' });
    assert.strictEqual(entry.state, 'starting');

    // Simulate provider returning 'working' state
    mockAS._tabs.get(entry.tabId).state = 'working';

    const result = await controller.sync();
    assert.strictEqual(result.updated, 1);

    const updated = controller.getTab(entry.tabId);
    assert.strictEqual(updated.state, 'working');

    await controller.stop();
  });

  await test('sync removes closed tabs', async () => {
    const { controller, mockAS } = setupController('applescript');
    await controller.start();

    const entry = await controller.openTab({ command: 'a', taskId: 't1' });

    // Simulate tab being closed externally
    mockAS._tabs.delete(entry.tabId);

    const result = await controller.sync();
    assert.strictEqual(result.removed, 1);
    assert.strictEqual(controller.getAllTabs().length, 0);

    await controller.stop();
  });

  await test('sync detects orphaned tabs', async () => {
    const { controller, mockAS } = setupController('applescript');
    await controller.start();

    // Add a tab directly to the mock (orphaned — not in registry)
    mockAS._tabs.set('terminal:99:orphan', { title: 'orphan', state: 'idle' });

    const result = await controller.sync();
    assert.strictEqual(result.orphaned, 1);

    await controller.stop();
  });

  await test('sync handles no tabs gracefully', async () => {
    const { controller } = setupController('applescript');
    await controller.start();

    const result = await controller.sync();
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.removed, 0);

    await controller.stop();
  });
}

// ============================================================================
// HIGH-LEVEL OPERATIONS TESTS
// ============================================================================

async function testHighLevelOps() {
  console.log('\n── High-Level Operations ──');

  await test('scaleAgents opens tabs to reach target', async () => {
    const { controller } = setupController('applescript');
    await controller.start();

    const result = await controller.scaleAgents(3, {
      buildCommand: (i) => `agent ${i}`,
      role: 'worker',
    });

    assert.strictEqual(result.opened, 3);
    assert.strictEqual(result.closed, 0);
    assert.strictEqual(controller.getAllTabs().length, 3);

    await controller.stop();
  });

  await test('scaleAgents closes excess tabs', async () => {
    const { controller } = setupController('applescript');
    await controller.start();

    await controller.openTab({ command: 'a', taskId: 't1', role: 'agent' });
    await controller.openTab({ command: 'b', taskId: 't2', role: 'agent' });
    await controller.openTab({ command: 'c', taskId: 't3', role: 'agent' });

    const result = await controller.scaleAgents(1, {});
    assert.strictEqual(result.closed, 2);
    assert.strictEqual(result.opened, 0);
    assert.strictEqual(controller.getAllTabs().length, 1);

    await controller.stop();
  });

  await test('scaleAgents preserves pm tabs', async () => {
    const { controller } = setupController('applescript');
    await controller.start();

    await controller.openTab({ command: 'pm', taskId: 'pm-1', role: 'pm' });
    await controller.openTab({ command: 'a', taskId: 't1', role: 'agent' });

    // Scale to 0 agents — pm tab should remain
    const result = await controller.scaleAgents(0, {});
    assert.strictEqual(result.closed, 1);
    assert.strictEqual(controller.getAllTabs().length, 1);
    assert.strictEqual(controller.getAllTabs()[0].role, 'pm');

    await controller.stop();
  });

  await test('autoApprove sends yes to tab', async () => {
    const { controller, mockAS } = setupController('applescript');
    await controller.start();

    const entry = await controller.openTab({ command: 'a', taskId: 't1' });

    let sentCommand = null;
    const origSend = mockAS.sendToTab;
    mockAS.sendToTab = async (tabId, cmd) => { sentCommand = cmd; };

    await controller.autoApprove(entry.tabId);
    assert.strictEqual(sentCommand, 'yes');

    mockAS.sendToTab = origSend;
    await controller.stop();
  });

  await test('answerQuestion sends answer to tab', async () => {
    const { controller, mockAS } = setupController('applescript');
    await controller.start();

    const entry = await controller.openTab({ command: 'a', taskId: 't1' });

    let sentCommand = null;
    mockAS.sendToTab = async (tabId, cmd) => { sentCommand = cmd; };

    await controller.answerQuestion(entry.tabId, 'option-2');
    assert.strictEqual(sentCommand, 'option-2');

    await controller.stop();
  });

  await test('checkpointRespawn sends checkpoint command', async () => {
    const { controller, mockAS } = setupController('applescript');
    await controller.start();

    const entry = await controller.openTab({ command: 'a', taskId: 't1' });

    let sentCommand = null;
    mockAS.sendToTab = async (tabId, cmd) => { sentCommand = cmd; };

    await controller.checkpointRespawn(entry.tabId);
    assert.strictEqual(sentCommand, '/pilot-checkpoint');

    await controller.stop();
  });

  await test('broadcastToAll sends to all tabs', async () => {
    const { controller, mockAS } = setupController('applescript');
    await controller.start();

    await controller.openTab({ command: 'a', taskId: 't1' });
    await controller.openTab({ command: 'b', taskId: 't2' });
    await controller.openTab({ command: 'c', taskId: 't3', role: 'pm' });

    let sendCount = 0;
    mockAS.sendToTab = async () => { sendCount++; };

    const sent = await controller.broadcastToAll('halt');
    assert.strictEqual(sent, 3);
    assert.strictEqual(sendCount, 3);

    await controller.stop();
  });

  await test('broadcastToAll excludes specified role', async () => {
    const { controller, mockAS } = setupController('applescript');
    await controller.start();

    await controller.openTab({ command: 'a', taskId: 't1', role: 'agent' });
    await controller.openTab({ command: 'b', taskId: 't2', role: 'agent' });
    await controller.openTab({ command: 'c', taskId: 't3', role: 'pm' });

    let sendCount = 0;
    mockAS.sendToTab = async () => { sendCount++; };

    const sent = await controller.broadcastToAll('halt', { excludeRole: 'pm' });
    assert.strictEqual(sent, 2);

    await controller.stop();
  });
}

// ============================================================================
// MONITORING TESTS
// ============================================================================

async function testMonitoring() {
  console.log('\n── Monitoring ──');

  await test('getGroundTruth returns state for all tabs', async () => {
    const { controller, mockAS } = setupController('applescript');
    await controller.start();

    const e1 = await controller.openTab({ command: 'a', taskId: 't1', role: 'frontend' });
    const e2 = await controller.openTab({ command: 'b', taskId: 't2', role: 'backend' });

    mockAS._tabs.get(e1.tabId).state = 'working';
    mockAS._tabs.get(e2.tabId).state = 'error';

    const truth = await controller.getGroundTruth();
    assert.strictEqual(truth.length, 2);

    const t1 = truth.find(t => t.taskId === 't1');
    assert.strictEqual(t1.state, 'working');
    assert.strictEqual(t1.role, 'frontend');

    const t2 = truth.find(t => t.taskId === 't2');
    assert.strictEqual(t2.state, 'error');

    await controller.stop();
  });

  await test('getGroundTruth marks unreachable tabs', async () => {
    const { controller, mockAS } = setupController('applescript');
    await controller.start();

    const entry = await controller.openTab({ command: 'a', taskId: 't1' });

    // Simulate tab being externally closed (detectState will throw)
    mockAS._tabs.delete(entry.tabId);

    const truth = await controller.getGroundTruth();
    assert.strictEqual(truth[0].state, 'unreachable');

    await controller.stop();
  });

  await test('detectStalled finds stalled tabs', async () => {
    const { controller } = setupController('applescript');
    await controller.start();

    const entry = await controller.openTab({ command: 'a', taskId: 't1' });

    // Simulate state being old
    const tab = controller.getTab(entry.tabId);
    tab.stateChangedAt = Date.now() - 10 * 60 * 1000; // 10 min ago
    tab.state = 'working'; // Not complete

    const stalled = controller.detectStalled();
    assert.strictEqual(stalled.length, 1);
    assert.strictEqual(stalled[0].taskId, 't1');

    await controller.stop();
  });

  await test('detectStalled ignores complete tabs', async () => {
    const { controller } = setupController('applescript');
    await controller.start();

    const entry = await controller.openTab({ command: 'a', taskId: 't1' });
    const tab = controller.getTab(entry.tabId);
    tab.stateChangedAt = Date.now() - 10 * 60 * 1000;
    tab.state = 'complete';

    const stalled = controller.detectStalled();
    assert.strictEqual(stalled.length, 0);

    await controller.stop();
  });

  await test('detectStalled uses custom threshold', async () => {
    const { controller } = setupController('applescript');
    await controller.start();

    const entry = await controller.openTab({ command: 'a', taskId: 't1' });
    const tab = controller.getTab(entry.tabId);
    tab.stateChangedAt = Date.now() - 2000; // 2s ago
    tab.state = 'working';

    // 1s threshold — should be stalled
    const stalled = controller.detectStalled(1000);
    assert.strictEqual(stalled.length, 1);

    // 5s threshold — should not be stalled
    const notStalled = controller.detectStalled(5000);
    assert.strictEqual(notStalled.length, 0);

    await controller.stop();
  });

  await test('getTabMetrics returns aggregate stats', async () => {
    const { controller, mockAS } = setupController('applescript');
    await controller.start();

    const e1 = await controller.openTab({ command: 'a', taskId: 't1', role: 'frontend' });
    const e2 = await controller.openTab({ command: 'b', taskId: 't2', role: 'backend' });
    const e3 = await controller.openTab({ command: 'c', taskId: 't3', role: 'frontend' });

    // Update states via registry
    controller.getTab(e1.tabId).state = 'working';
    controller.getTab(e2.tabId).state = 'idle';
    controller.getTab(e3.tabId).state = 'working';

    const metrics = controller.getTabMetrics();
    assert.strictEqual(metrics.total, 3);
    assert.strictEqual(metrics.byState.working, 2);
    assert.strictEqual(metrics.byState.idle, 1);
    assert.strictEqual(metrics.byRole.frontend, 2);
    assert.strictEqual(metrics.byRole.backend, 1);

    await controller.stop();
  });
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================

async function runAll() {
  console.log('Terminal Controller — Phase 6.3 Tests\n');

  await testProviderDetection();
  await testRegistry();
  await testSync();
  await testHighLevelOps();
  await testMonitoring();

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const { name, error } of failures) {
      console.log(`\n  ✗ ${name}`);
      console.log(`    ${error.stack || error.message}`);
    }
  }

  console.log(`${'═'.repeat(50)}`);
  process.exit(failed > 0 ? 1 : 0);
}

runAll();
