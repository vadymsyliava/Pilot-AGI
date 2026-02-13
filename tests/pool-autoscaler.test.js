'use strict';

/**
 * Tests for Phase 5.4: Dynamic Agent Pool Scaling
 *
 * Covers:
 * - Pool autoscaler: scale-up, scale-down, hold decisions
 * - Resource monitor: CPU, memory, pressure detection
 * - Policy loading and defaults
 * - Scaling decision audit trail
 * - Min/max bound enforcement
 * - Cooldown behavior
 * - PM loop integration
 *
 * Run: node --test tests/pool-autoscaler.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================================
// TEST SETUP
// ============================================================================

let TEST_ROOT;
const POOL_STATE_DIR = '.claude/pilot/state/pool';

function freshModule(modulePath) {
  const fullPath = require.resolve(modulePath);
  delete require.cache[fullPath];
  return require(fullPath);
}

function createTestRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-pool-'));
  fs.mkdirSync(path.join(dir, POOL_STATE_DIR), { recursive: true });
  return dir;
}

// Default test policy
function defaultPolicy(overrides = {}) {
  return {
    min: overrides.min ?? 1,
    max: overrides.max ?? 12,
    scale_up: {
      queue_ratio: 2.0,
      priority_idle_threshold: 0,
      deadline_hours: 2,
      ...(overrides.scale_up || {})
    },
    scale_down: {
      idle_cooldown_minutes: 5,
      budget_threshold_pct: 90,
      cpu_threshold_pct: 80,
      memory_threshold_pct: 85,
      ...(overrides.scale_down || {})
    },
    evaluation_interval_seconds: 60
  };
}

// ============================================================================
// RESOURCE MONITOR TESTS
// ============================================================================

describe('resource-monitor', () => {
  it('getSystemResources returns expected shape', () => {
    const monitor = freshModule('../.claude/pilot/hooks/lib/resource-monitor');
    const resources = monitor.getSystemResources();
    assert.ok(typeof resources.cpuPct === 'number');
    assert.ok(typeof resources.memPct === 'number');
    assert.ok(typeof resources.processCount === 'number');
    assert.ok(Array.isArray(resources.loadAvg));
    assert.ok(resources.cpuPct >= 0 && resources.cpuPct <= 100);
    assert.ok(resources.memPct >= 0 && resources.memPct <= 100);
  });

  it('getCpuUsage returns number between 0 and 100', () => {
    const monitor = freshModule('../.claude/pilot/hooks/lib/resource-monitor');
    const cpu = monitor.getCpuUsage();
    assert.ok(cpu >= 0 && cpu <= 100, `CPU ${cpu}% should be 0-100`);
  });

  it('getMemoryUsage returns number between 0 and 100', () => {
    const monitor = freshModule('../.claude/pilot/hooks/lib/resource-monitor');
    const mem = monitor.getMemoryUsage();
    assert.ok(mem >= 0 && mem <= 100, `Memory ${mem}% should be 0-100`);
  });

  it('isUnderPressure returns false when below thresholds', () => {
    const monitor = freshModule('../.claude/pilot/hooks/lib/resource-monitor');
    const result = monitor.isUnderPressure({
      cpuThresholdPct: 100,
      memoryThresholdPct: 100
    });
    assert.strictEqual(result, false);
  });

  it('isUnderPressure returns true when thresholds are 0', () => {
    const monitor = freshModule('../.claude/pilot/hooks/lib/resource-monitor');
    const result = monitor.isUnderPressure({
      cpuThresholdPct: 0,
      memoryThresholdPct: 0
    });
    assert.strictEqual(result, true);
  });

  it('getClaudeProcessCount returns a non-negative number', () => {
    const monitor = freshModule('../.claude/pilot/hooks/lib/resource-monitor');
    const count = monitor.getClaudeProcessCount();
    assert.ok(count >= 0);
  });
});

// ============================================================================
// POOL AUTOSCALER TESTS
// ============================================================================

describe('pool-autoscaler', () => {
  beforeEach(() => {
    TEST_ROOT = createTestRoot();
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  function getAutoscaler() {
    return freshModule('../.claude/pilot/hooks/lib/pool-autoscaler');
  }

  describe('evaluateScaling', () => {
    it('scale-up on high queue depth', () => {
      const autoscaler = getAutoscaler();
      const state = { active: 2, idle: 0, pending: 6, budget_remaining_pct: 80, cpu_pct: 50, mem_pct: 60 };

      const decision = autoscaler.evaluateScaling(state, {
        projectRoot: TEST_ROOT,
        policy: defaultPolicy(),
        state: {}
      });
      assert.strictEqual(decision.action, 'scale_up');
      assert.ok(decision.reason.includes('Queue ratio'));
      assert.strictEqual(decision.targetCount, 3);
    });

    it('scale-up when no idle agents and tasks pending', () => {
      const autoscaler = getAutoscaler();
      const state = { active: 3, idle: 0, pending: 1, budget_remaining_pct: 80, cpu_pct: 50, mem_pct: 60 };

      const decision = autoscaler.evaluateScaling(state, {
        projectRoot: TEST_ROOT,
        policy: defaultPolicy(),
        state: {}
      });
      assert.strictEqual(decision.action, 'scale_up');
      assert.ok(decision.reason.includes('idle agents'));
    });

    it('scale-up when no agents and tasks pending', () => {
      const autoscaler = getAutoscaler();
      const state = { active: 0, idle: 0, pending: 3, budget_remaining_pct: 100, cpu_pct: 10, mem_pct: 30 };

      const decision = autoscaler.evaluateScaling(state, {
        projectRoot: TEST_ROOT,
        policy: defaultPolicy(),
        state: {}
      });
      assert.strictEqual(decision.action, 'scale_up');
      assert.ok(decision.reason.includes('No agents running'));
    });

    it('scale-down on empty queue after cooldown', () => {
      const autoscaler = getAutoscaler();
      const state = { active: 2, idle: 1, pending: 0, budget_remaining_pct: 80, cpu_pct: 50, mem_pct: 60 };

      const decision = autoscaler.evaluateScaling(state, {
        projectRoot: TEST_ROOT,
        policy: defaultPolicy(),
        state: { last_pending_at: Date.now() - (10 * 60 * 1000) }
      });
      assert.strictEqual(decision.action, 'scale_down');
      assert.ok(decision.reason.includes('No pending tasks'));
      assert.strictEqual(decision.targetCount, 2);
    });

    it('scale-down on budget threshold', () => {
      const autoscaler = getAutoscaler();
      const state = { active: 3, idle: 1, pending: 2, budget_remaining_pct: 5, cpu_pct: 50, mem_pct: 60 };

      const decision = autoscaler.evaluateScaling(state, {
        projectRoot: TEST_ROOT,
        policy: defaultPolicy(),
        state: {}
      });
      assert.strictEqual(decision.action, 'scale_down');
      assert.ok(decision.reason.includes('Budget'));
      assert.strictEqual(decision.targetCount, 1);
    });

    it('scale-down on CPU pressure', () => {
      const autoscaler = getAutoscaler();
      const state = { active: 3, idle: 1, pending: 2, budget_remaining_pct: 80, cpu_pct: 85, mem_pct: 60 };

      const decision = autoscaler.evaluateScaling(state, {
        projectRoot: TEST_ROOT,
        policy: defaultPolicy(),
        state: {}
      });
      assert.strictEqual(decision.action, 'scale_down');
      assert.ok(decision.reason.includes('CPU pressure'));
      assert.strictEqual(decision.targetCount, 3);
    });

    it('scale-down on memory pressure', () => {
      const autoscaler = getAutoscaler();
      const state = { active: 2, idle: 1, pending: 2, budget_remaining_pct: 80, cpu_pct: 50, mem_pct: 90 };

      const decision = autoscaler.evaluateScaling(state, {
        projectRoot: TEST_ROOT,
        policy: defaultPolicy(),
        state: {}
      });
      assert.strictEqual(decision.action, 'scale_down');
      assert.ok(decision.reason.includes('Memory pressure'));
    });

    it('respects max bound', () => {
      const autoscaler = getAutoscaler();
      const state = { active: 3, idle: 1, pending: 10, budget_remaining_pct: 80, cpu_pct: 50, mem_pct: 60 };

      const decision = autoscaler.evaluateScaling(state, {
        projectRoot: TEST_ROOT,
        policy: defaultPolicy({ max: 4 }),
        state: {}
      });
      assert.strictEqual(decision.action, 'hold');
      assert.ok(decision.reason.includes('pool maximum'));
    });

    it('respects min bound on scale-down', () => {
      const autoscaler = getAutoscaler();
      const state = { active: 2, idle: 1, pending: 0, budget_remaining_pct: 80, cpu_pct: 50, mem_pct: 60 };

      const decision = autoscaler.evaluateScaling(state, {
        projectRoot: TEST_ROOT,
        policy: defaultPolicy({ min: 2 }),
        state: { last_pending_at: Date.now() - (10 * 60 * 1000) }
      });
      assert.strictEqual(decision.action, 'scale_down');
      assert.ok(decision.targetCount >= 2, `targetCount ${decision.targetCount} should be >= min 2`);
    });

    it('cooldown prevents premature scale-down', () => {
      const autoscaler = getAutoscaler();
      const state = { active: 2, idle: 1, pending: 0, budget_remaining_pct: 80, cpu_pct: 50, mem_pct: 60 };

      const decision = autoscaler.evaluateScaling(state, {
        projectRoot: TEST_ROOT,
        policy: defaultPolicy(),
        state: { last_pending_at: Date.now() - (1 * 60 * 1000) } // 1min ago, before 5min cooldown
      });
      assert.strictEqual(decision.action, 'hold');
    });

    it('hold when pool is balanced', () => {
      const autoscaler = getAutoscaler();
      const state = { active: 3, idle: 1, pending: 1, budget_remaining_pct: 80, cpu_pct: 50, mem_pct: 60 };

      const decision = autoscaler.evaluateScaling(state, {
        projectRoot: TEST_ROOT,
        policy: defaultPolicy(),
        state: {}
      });
      assert.strictEqual(decision.action, 'hold');
      assert.ok(decision.reason.includes('balanced'));
    });
  });

  describe('scaling decision audit trail', () => {
    it('recordScalingDecision writes to history file', () => {
      const autoscaler = getAutoscaler();

      autoscaler.recordScalingDecision({
        action: 'scale_up',
        reason: 'test reason',
        targetCount: 4,
        poolState: { active: 3, idle: 0, pending: 8 }
      }, TEST_ROOT);

      const historyPath = path.join(TEST_ROOT, POOL_STATE_DIR, 'scaling-history.jsonl');
      assert.ok(fs.existsSync(historyPath));

      const content = fs.readFileSync(historyPath, 'utf8').trim();
      const entry = JSON.parse(content);
      assert.strictEqual(entry.action, 'scale_up');
      assert.strictEqual(entry.reason, 'test reason');
      assert.strictEqual(entry.target_count, 4);
      assert.deepStrictEqual(entry.pool_state, { active: 3, idle: 0, pending: 8 });
      assert.ok(entry.ts);
    });

    it('getScalingHistory returns recent decisions', () => {
      const autoscaler = getAutoscaler();

      for (let i = 0; i < 5; i++) {
        autoscaler.recordScalingDecision({
          action: i % 2 === 0 ? 'scale_up' : 'scale_down',
          reason: `reason ${i}`,
          targetCount: i + 1
        }, TEST_ROOT);
      }

      const history = autoscaler.getScalingHistory(3, TEST_ROOT);
      assert.strictEqual(history.length, 3);
      assert.strictEqual(history[0].reason, 'reason 2');
      assert.strictEqual(history[2].reason, 'reason 4');
    });

    it('recordScalingDecision updates state file', () => {
      const autoscaler = getAutoscaler();

      autoscaler.recordScalingDecision({
        action: 'scale_up',
        reason: 'test',
        targetCount: 5,
        poolState: { pending: 3 }
      }, TEST_ROOT);

      const state = autoscaler.loadState(TEST_ROOT);
      assert.ok(state !== null);
      assert.strictEqual(state.last_decision.action, 'scale_up');
      assert.ok(state.last_pending_at > 0);
    });
  });

  describe('markPendingTasksSeen', () => {
    it('updates last_pending_at timestamp', () => {
      const autoscaler = getAutoscaler();

      const before = Date.now();
      autoscaler.markPendingTasksSeen(TEST_ROOT);

      const state = autoscaler.loadState(TEST_ROOT);
      assert.ok(state.last_pending_at >= before);
    });
  });

  describe('loadPoolPolicy', () => {
    it('returns defaults when no policy file', () => {
      const autoscaler = getAutoscaler();

      const policy = autoscaler.loadPoolPolicy('/nonexistent');
      assert.strictEqual(policy.min, 1);
      assert.strictEqual(policy.max, 12);
      assert.strictEqual(policy.scale_up.queue_ratio, 2.0);
      assert.strictEqual(policy.scale_down.idle_cooldown_minutes, 5);
      assert.strictEqual(policy.evaluation_interval_seconds, 60);
    });
  });
});

// ============================================================================
// PM LOOP INTEGRATION TESTS
// ============================================================================

describe('pm-loop pool scaling integration', () => {
  beforeEach(() => {
    TEST_ROOT = createTestRoot();
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('PmLoop has pool scaling scan properties', () => {
    for (const key of Object.keys(require.cache)) {
      if (key.includes('pm-loop')) {
        delete require.cache[key];
      }
    }

    const { PmLoop } = require('../.claude/pilot/hooks/lib/pm-loop');
    const loop = new PmLoop(TEST_ROOT, {
      pmSessionId: 'test-pm',
      poolScalingScanIntervalMs: 5000
    });

    assert.strictEqual(loop.lastPoolScalingScan, 0);
    assert.strictEqual(loop.opts.poolScalingScanIntervalMs, 5000);
  });

  it('PmLoop getStats includes pool scaling timestamp', () => {
    for (const key of Object.keys(require.cache)) {
      if (key.includes('pm-loop')) {
        delete require.cache[key];
      }
    }

    const { PmLoop } = require('../.claude/pilot/hooks/lib/pm-loop');
    const loop = new PmLoop(TEST_ROOT, { pmSessionId: 'test-pm' });

    const stats = loop.getStats();
    assert.ok('last_pool_scaling_scan' in stats);
    assert.strictEqual(stats.last_pool_scaling_scan, null);
  });
});
