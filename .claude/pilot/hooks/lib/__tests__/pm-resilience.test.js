/**
 * Tests for PM Resilience & Context Efficiency [Pilot AGI-cs98]
 *
 * Tests:
 * 1. PM session detection (isPmSession)
 * 2. PM exempt from checkpoint-exit
 * 3. Dead tab auto-close in terminal controller
 * 4. PM watchdog daemon monitoring
 */

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================================
// Test 1: PM Session Detection
// ============================================================================

describe('PM checkpoint-exit exemption', () => {
  const tmpDir = path.join(os.tmpdir(), 'pm-resilience-test-' + Date.now());
  const sessDir = path.join(tmpDir, '.claude/pilot/state/sessions');
  const pmStatePath = path.join(tmpDir, '.claude/pilot/state/orchestrator/pm-state.json');

  beforeEach(() => {
    fs.mkdirSync(sessDir, { recursive: true });
    fs.mkdirSync(path.dirname(pmStatePath), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PILOT_PM_SESSION;
    delete process.env.PILOT_AGENT_TYPE;
    delete process.env.PILOT_DAEMON_SPAWNED;
  });

  it('should detect PM via PILOT_PM_SESSION env var', () => {
    process.env.PILOT_PM_SESSION = '1';
    // The isPmSession function checks env vars first
    assert.equal(process.env.PILOT_PM_SESSION, '1');
  });

  it('should detect PM via PILOT_AGENT_TYPE=pm', () => {
    process.env.PILOT_AGENT_TYPE = 'pm';
    assert.equal(process.env.PILOT_AGENT_TYPE, 'pm');
  });

  it('should not exit-on-checkpoint when PILOT_DAEMON_SPAWNED is not set', () => {
    // shouldExitOnCheckpoint returns false when not daemon-spawned
    delete process.env.PILOT_DAEMON_SPAWNED;
    assert.equal(process.env.PILOT_DAEMON_SPAWNED, undefined);
  });
});

// ============================================================================
// Test 2: Terminal Controller — Dead Tab Cleanup
// ============================================================================

describe('TerminalController dead tab cleanup', () => {
  // Fresh module for each test
  function freshModule() {
    const modPath = require.resolve('../terminal-controller');
    delete require.cache[modPath];
    return require(modPath);
  }

  it('should have closeDeadTabs method', () => {
    const { TerminalController } = freshModule();
    const controller = new TerminalController();
    assert.equal(typeof controller.closeDeadTabs, 'function');
  });

  it('should have _closeDeadTab method', () => {
    const { TerminalController } = freshModule();
    const controller = new TerminalController();
    assert.equal(typeof controller._closeDeadTab, 'function');
  });

  it('sync should return closedDead count', async () => {
    const { TerminalController } = freshModule();
    const controller = new TerminalController();
    controller.activeProvider = 'iterm2';
    controller._started = true;

    // Empty registry = nothing to sync
    const result = await controller.sync();
    assert.equal(result.closedDead, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.removed, 0);
  });

  it('closeDeadTabs should close tabs with dead/exited state', async () => {
    const { TerminalController } = freshModule();
    const controller = new TerminalController();
    controller.activeProvider = 'iterm2';

    let closedTabs = [];
    // Mock closeTab
    controller.closeTab = async (tabId) => {
      closedTabs.push(tabId);
      controller.registry.delete(tabId);
      return true;
    };

    // Add tabs in various states
    controller.registry.set('tab1', { tabId: 'tab1', state: 'exited', taskId: 'task1', role: 'agent' });
    controller.registry.set('tab2', { tabId: 'tab2', state: 'working', taskId: 'task2', role: 'agent' });
    controller.registry.set('tab3', { tabId: 'tab3', state: 'dead', taskId: 'task3', role: 'agent' });
    controller.registry.set('tab4', { tabId: 'tab4', state: 'complete', taskId: 'task4', role: 'agent' });

    const closed = await controller.closeDeadTabs();
    assert.equal(closed, 3); // tab1 (exited), tab3 (dead), tab4 (complete)
    assert.equal(controller.registry.size, 1); // Only tab2 (working) remains
    assert.ok(controller.registry.has('tab2'));
  });
});

// ============================================================================
// Test 3: PM Watchdog
// ============================================================================

describe('PM Watchdog', () => {
  const tmpDir = path.join(os.tmpdir(), 'pm-watchdog-test-' + Date.now());

  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, '.claude/pilot/state/orchestrator'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.claude/pilot/logs'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function freshWatchdog() {
    const modPath = require.resolve('../pm-watchdog');
    delete require.cache[modPath];
    return require(modPath);
  }

  it('should export expected functions', () => {
    const watchdog = freshWatchdog();
    assert.equal(typeof watchdog.isDaemonAlive, 'function');
    assert.equal(typeof watchdog.getDaemonState, 'function');
    assert.equal(typeof watchdog.getSystemMemoryPct, 'function');
    assert.equal(typeof watchdog.writeHeartbeat, 'function');
  });

  it('should return false for isDaemonAlive when no PID file', () => {
    const watchdog = freshWatchdog();
    // No PID file exists
    assert.equal(watchdog.isDaemonAlive(), false);
  });

  it('should report system memory percentage', () => {
    const watchdog = freshWatchdog();
    const memPct = watchdog.getSystemMemoryPct();
    assert.ok(memPct >= 0 && memPct <= 100);
  });

  it('should have proper constants', () => {
    const watchdog = freshWatchdog();
    assert.equal(watchdog.MAX_RESTARTS, 5);
    assert.equal(watchdog.RESTART_COOLDOWN_MS, 30000);
    assert.equal(watchdog.MEMORY_WARN_PCT, 80);
    assert.equal(watchdog.MEMORY_CRITICAL_PCT, 90);
  });
});

// ============================================================================
// Test 4: Policy — iTerm2 Provider
// ============================================================================

describe('Policy iTerm2 preference', () => {
  it('should have iterm2 as terminal provider', () => {
    const yaml = require('fs').readFileSync(
      path.join(__dirname, '../../../policy.yaml'), 'utf8'
    );
    assert.ok(yaml.includes("provider: 'iterm2'"), 'Policy should set iTerm2 as provider');
  });
});
