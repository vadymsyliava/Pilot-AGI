/**
 * Tests for POST /api/dispatch — Sprint 3 T4 (M1.5)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/pm-hub-dispatch.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const assert = require('assert');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dispatch-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/messages'), { recursive: true });
  fs.writeFileSync(
    path.join(testDir, '.claude/pilot/agent-registry.json'),
    JSON.stringify({ agents: { frontend: {}, backend: {} } }, null, 2)
  );
  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function httpRequest(method, urlPath, port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve({ statusCode: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ statusCode: res.statusCode, body: data }); }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  setup();
  try {
    await fn();
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

(async () => {
  console.log('\n=== Hub Dispatch Endpoint Tests ===\n');

  await test('POST /api/dispatch with no body → 400', async () => {
    const { PmHub } = require('../pm-hub');
    const hub = new PmHub(testDir, { port: 0 });
    await hub.start();
    try {
      const r = await httpRequest('POST', '/api/dispatch', hub.port, {});
      assert.strictEqual(r.statusCode, 400);
      assert.match(r.body.error, /role required/);
    } finally {
      hub.stop();
    }
  });

  await test('POST /api/dispatch missing task.id → 400', async () => {
    const { PmHub } = require('../pm-hub');
    const hub = new PmHub(testDir, { port: 0 });
    await hub.start();
    try {
      const r = await httpRequest('POST', '/api/dispatch', hub.port, { role: 'frontend' });
      assert.strictEqual(r.statusCode, 400);
      assert.match(r.body.error, /task\.id required/);
    } finally {
      hub.stop();
    }
  });

  await test('POST /api/dispatch with no idle agent → 409', async () => {
    const { PmHub } = require('../pm-hub');
    const hub = new PmHub(testDir, { port: 0 });
    await hub.start();
    try {
      // No registered agents → orchestrator returns success:false.
      const r = await httpRequest('POST', '/api/dispatch', hub.port, {
        role: 'frontend',
        task: { id: 't1', title: 'do thing' }
      });
      assert.strictEqual(r.statusCode, 409);
      assert.strictEqual(r.body.success, false);
      assert.match(r.body.error, /No idle agent with role "frontend"/);
    } finally {
      hub.stop();
    }
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
})();
