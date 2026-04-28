/**
 * Tests for GET/POST /api/pm-mode — Sprint 4 T4 (M1.5)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/pm-hub-mode.test.js
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
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mode-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/orchestrator'), { recursive: true });
  fs.writeFileSync(
    path.join(testDir, '.claude/pilot/agent-registry.json'),
    JSON.stringify({ agents: {} }, null, 2)
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
  console.log('\n=== Hub PM Mode Endpoint Tests ===\n');

  await test('GET /api/pm-mode returns default mode initially', async () => {
    const { PmHub } = require('../pm-hub');
    const hub = new PmHub(testDir, { port: 0 });
    await hub.start();
    try {
      const r = await httpRequest('GET', '/api/pm-mode', hub.port);
      assert.strictEqual(r.statusCode, 200);
      assert.strictEqual(r.body.mode, 'strict_rules');
      assert.deepStrictEqual(r.body.valid_modes.sort(), ['free_chat', 'off', 'strict_rules'].sort());
    } finally { hub.stop(); }
  });

  await test('POST /api/pm-mode sets a new mode and GET reflects it', async () => {
    const { PmHub } = require('../pm-hub');
    const hub = new PmHub(testDir, { port: 0 });
    await hub.start();
    try {
      const post = await httpRequest('POST', '/api/pm-mode', hub.port, { mode: 'free_chat' });
      assert.strictEqual(post.statusCode, 200);
      assert.strictEqual(post.body.success, true);
      assert.strictEqual(post.body.mode, 'free_chat');

      const get = await httpRequest('GET', '/api/pm-mode', hub.port);
      assert.strictEqual(get.body.mode, 'free_chat');
    } finally { hub.stop(); }
  });

  await test('POST /api/pm-mode rejects invalid mode → 400', async () => {
    const { PmHub } = require('../pm-hub');
    const hub = new PmHub(testDir, { port: 0 });
    await hub.start();
    try {
      const r = await httpRequest('POST', '/api/pm-mode', hub.port, { mode: 'wrong' });
      assert.strictEqual(r.statusCode, 400);
      assert.strictEqual(r.body.success, false);
    } finally { hub.stop(); }
  });

  await test('POST /api/pm-mode missing body → 400', async () => {
    const { PmHub } = require('../pm-hub');
    const hub = new PmHub(testDir, { port: 0 });
    await hub.start();
    try {
      const r = await httpRequest('POST', '/api/pm-mode', hub.port, {});
      assert.strictEqual(r.statusCode, 400);
    } finally { hub.stop(); }
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
})();
