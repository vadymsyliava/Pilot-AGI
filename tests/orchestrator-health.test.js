/**
 * Smoke tests for orchestrator health check with lockfile-based liveness
 */
const orchestrator = require('../.claude/pilot/hooks/lib/orchestrator');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  PASS:', name);
    passed++;
  } catch (e) {
    console.log('  FAIL:', name, '-', e.message);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

console.log('Orchestrator Health Check Tests');
console.log('='.repeat(40));

test('getAgentHealth returns array', () => {
  const health = orchestrator.getAgentHealth();
  assert(Array.isArray(health), 'Should return array');
});

test('getAgentHealth includes process_alive field', () => {
  const health = orchestrator.getAgentHealth();
  for (const h of health) {
    assert(typeof h.process_alive === 'boolean',
      `process_alive should be boolean for ${h.session_id}, got ${typeof h.process_alive}`);
  }
});

test('getAgentHealth detects live sessions as healthy', () => {
  const health = orchestrator.getAgentHealth();
  const liveOnes = health.filter(h => h.process_alive);
  for (const h of liveOnes) {
    assert(h.status !== 'dead', `Live session ${h.session_id} should not be dead`);
  }
});

test('getStaleAgents returns array', () => {
  const stale = orchestrator.getStaleAgents();
  assert(Array.isArray(stale), 'Should return array');
});

test('handleStaleAgents runs without error', () => {
  const results = orchestrator.handleStaleAgents('S-test-pm');
  assert(Array.isArray(results), 'Should return array');
});

test('getStaleAgents only returns dead/stale/unresponsive', () => {
  const stale = orchestrator.getStaleAgents();
  const validStatuses = ['dead', 'stale', 'unresponsive'];
  for (const a of stale) {
    assert(validStatuses.includes(a.status),
      `Unexpected status: ${a.status}`);
  }
});

console.log('='.repeat(40));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
