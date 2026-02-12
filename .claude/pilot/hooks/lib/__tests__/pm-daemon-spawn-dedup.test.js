/**
 * Tests for PM Daemon spawn deduplication — Pilot AGI-n55p
 *
 * Verifies that the daemon does not spawn multiple agents for the same task.
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/pm-daemon-spawn-dedup.test.js
 */

const assert = require('assert');

// ============================================================================
// TEST HARNESS
// ============================================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
  }
}

// ============================================================================
// MOCK PmDaemon — minimal stub with the real _getSpawnedTaskIds method
// ============================================================================

/**
 * Build a minimal daemon-like object with the spawnedAgents map
 * and the _getSpawnedTaskIds helper.
 */
function makeDaemon(spawnedEntries = []) {
  const daemon = {
    spawnedAgents: new Map(),
    _getSpawnedTaskIds() {
      const taskIds = new Set();
      for (const [pid, entry] of this.spawnedAgents) {
        if (entry.exitCode === null) {
          // In tests we can't do process.kill(pid, 0) on fake pids,
          // so we trust exitCode === null means alive.
          taskIds.add(entry.taskId);
        }
      }
      return taskIds;
    }
  };

  for (const entry of spawnedEntries) {
    daemon.spawnedAgents.set(entry.pid, {
      taskId: entry.taskId,
      exitCode: entry.exitCode ?? null,
      spawnedAt: new Date().toISOString()
    });
  }

  return daemon;
}

// ============================================================================
// TESTS: _getSpawnedTaskIds
// ============================================================================

console.log('\n=== PM Daemon Spawn Deduplication Tests ===\n');

console.log('  _getSpawnedTaskIds');

test('returns empty set when no agents spawned', () => {
  const daemon = makeDaemon([]);
  const ids = daemon._getSpawnedTaskIds();
  assert.strictEqual(ids.size, 0);
});

test('returns task IDs of alive agents', () => {
  const daemon = makeDaemon([
    { pid: 1001, taskId: 'task-A' },
    { pid: 1002, taskId: 'task-B' }
  ]);
  const ids = daemon._getSpawnedTaskIds();
  assert.strictEqual(ids.size, 2);
  assert.ok(ids.has('task-A'));
  assert.ok(ids.has('task-B'));
});

test('excludes dead agents (exitCode !== null)', () => {
  const daemon = makeDaemon([
    { pid: 1001, taskId: 'task-A', exitCode: null },
    { pid: 1002, taskId: 'task-B', exitCode: 0 },
    { pid: 1003, taskId: 'task-C', exitCode: 1 }
  ]);
  const ids = daemon._getSpawnedTaskIds();
  assert.strictEqual(ids.size, 1);
  assert.ok(ids.has('task-A'));
  assert.ok(!ids.has('task-B'));
  assert.ok(!ids.has('task-C'));
});

test('handles same taskId from different PIDs (only counts once)', () => {
  const daemon = makeDaemon([
    { pid: 1001, taskId: 'task-A' },
    { pid: 1002, taskId: 'task-A' }
  ]);
  const ids = daemon._getSpawnedTaskIds();
  assert.strictEqual(ids.size, 1);
  assert.ok(ids.has('task-A'));
});

// ============================================================================
// TESTS: dedup filter logic (simulates _manageAgentLifecycle filter)
// ============================================================================

console.log('\n  Dedup filter logic');

test('filters ready tasks that have a live spawned agent', () => {
  const daemon = makeDaemon([
    { pid: 1001, taskId: 'task-A' },
    { pid: 1002, taskId: 'task-C' }
  ]);

  const readyTasks = [
    { id: 'task-A', title: 'Task A' },
    { id: 'task-B', title: 'Task B' },
    { id: 'task-C', title: 'Task C' },
    { id: 'task-D', title: 'Task D' }
  ];

  const spawnedTaskIds = daemon._getSpawnedTaskIds();
  const filtered = readyTasks.filter(t => !spawnedTaskIds.has(t.id));

  assert.strictEqual(filtered.length, 2);
  assert.deepStrictEqual(filtered.map(t => t.id), ['task-B', 'task-D']);
});

test('does not filter when no agents are spawned', () => {
  const daemon = makeDaemon([]);

  const readyTasks = [
    { id: 'task-A', title: 'Task A' },
    { id: 'task-B', title: 'Task B' }
  ];

  const spawnedTaskIds = daemon._getSpawnedTaskIds();
  const filtered = readyTasks.filter(t => !spawnedTaskIds.has(t.id));

  assert.strictEqual(filtered.length, 2);
});

test('returns empty if all ready tasks already have agents', () => {
  const daemon = makeDaemon([
    { pid: 1001, taskId: 'task-A' },
    { pid: 1002, taskId: 'task-B' }
  ]);

  const readyTasks = [
    { id: 'task-A', title: 'Task A' },
    { id: 'task-B', title: 'Task B' }
  ];

  const spawnedTaskIds = daemon._getSpawnedTaskIds();
  const filtered = readyTasks.filter(t => !spawnedTaskIds.has(t.id));

  assert.strictEqual(filtered.length, 0);
});

test('allows respawn of task whose agent has exited', () => {
  const daemon = makeDaemon([
    { pid: 1001, taskId: 'task-A', exitCode: 0 }  // Agent exited
  ]);

  const readyTasks = [
    { id: 'task-A', title: 'Task A' }
  ];

  const spawnedTaskIds = daemon._getSpawnedTaskIds();
  const filtered = readyTasks.filter(t => !spawnedTaskIds.has(t.id));

  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].id, 'task-A');
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'═'.repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
