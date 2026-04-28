/**
 * Tests for orchestrator.sendTaskToAgent — Sprint 3 T3 (M1.5)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/orchestrator-dispatch.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const orchestrator = require('../orchestrator');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dispatch-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/messages'), { recursive: true });
  fs.writeFileSync(
    path.join(testDir, '.claude/pilot/agent-registry.json'),
    JSON.stringify({
      agents: { frontend: { name: 'Frontend' }, backend: { name: 'Backend' } }
    }, null, 2)
  );
  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  setup();
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push(`  ✗ ${name}\n    ${e.stack || e.message}`);
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  } finally {
    teardown();
  }
}

// Stub `session` module — only the bits sendTaskToAgent uses.
function makeStubSession(agents) {
  return {
    getAvailableAgents: () => agents
  };
}

console.log('\n=== Orchestrator Dispatch Tests ===\n');

test('errors when role missing', () => {
  const r = orchestrator.sendTaskToAgent(null, { id: 't1' }, 'pm-1', {
    _session: makeStubSession([])
  });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /role is required/);
});

test('errors when task.id missing', () => {
  const r = orchestrator.sendTaskToAgent('frontend', {}, 'pm-1', {
    _session: makeStubSession([])
  });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /task.id is required/);
});

test('returns "no idle agent" when none of the requested role available', () => {
  const r = orchestrator.sendTaskToAgent('frontend', { id: 't1' }, 'pm-1', {
    _session: makeStubSession([
      { session_id: 's-be', role: 'backend', agent_name: 'be-1' }
    ])
  });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /No idle agent with role "frontend"/);
  assert.strictEqual(r.role, 'frontend');
});

test('picks the first idle agent of the requested role', () => {
  // sendTaskToAgent delegates to assignTask internally, which writes to
  // the messaging bus + bd. We assert it returned success and routed to
  // the first frontend agent (s-fe), not the second (s-fe2) or backend.
  const r = orchestrator.sendTaskToAgent(
    'frontend',
    { id: 't1', title: 'Style the button', priority: 'high' },
    'pm-1',
    {
      _session: makeStubSession([
        { session_id: 's-fe', role: 'frontend', agent_name: 'fe-1' },
        { session_id: 's-fe2', role: 'frontend', agent_name: 'fe-2' },
        { session_id: 's-be', role: 'backend', agent_name: 'be-1' }
      ])
    }
  );
  // success or false, but `role`/agent selection happened — verify the
  // routing chose the right candidate before delegating.
  assert.strictEqual(r.assigned_to, 's-fe',
    'expected first frontend agent, got ' + (r.assigned_to || r.error));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
