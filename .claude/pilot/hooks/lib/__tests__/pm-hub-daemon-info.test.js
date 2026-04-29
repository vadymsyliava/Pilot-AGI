/**
 * Tests for GET /api/daemon-info — R3 (2026-04-28)
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
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-daemon-info-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(testDir, '.claude/pilot/agent-registry.json'),
    JSON.stringify({ agents: {} })
  );
  originalCwd = process.cwd();
  process.chdir(testDir);
}
function teardown() { process.chdir(originalCwd); fs.rmSync(testDir, { recursive: true, force: true }); }

function get(path, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ statusCode: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

let passed = 0, failed = 0; const failures = [];
async function test(name, fn) {
  setup();
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; failures.push(name + ': ' + e.message); console.error('  ✗ ' + name); console.error('    ' + e.message); }
  finally { teardown(); }
}

(async () => {
  console.log('\n=== R3: /api/daemon-info ===\n');

  await test('returns pid + port + ready + protocol_version', async () => {
    const { PmHub } = require('../pm-hub');
    const hub = new PmHub(testDir, { port: 0 });
    await hub.start();
    try {
      const r = await get('/api/daemon-info', hub.port);
      assert.strictEqual(r.statusCode, 200);
      assert.strictEqual(r.body.pid, process.pid);
      assert.strictEqual(r.body.port, hub.port);
      assert.strictEqual(r.body.ready, true);
      assert.strictEqual(r.body.protocol_version, 1);
      assert.ok(r.body.uptime_ms >= 0);
      assert.ok(r.body.started_at_ms > 0);
      assert.strictEqual(r.body.project_root, testDir);
    } finally { hub.stop(); }
  });

  await test('uptime_ms increases over time', async () => {
    const { PmHub } = require('../pm-hub');
    const hub = new PmHub(testDir, { port: 0 });
    await hub.start();
    try {
      const r1 = await get('/api/daemon-info', hub.port);
      await new Promise(r => setTimeout(r, 30));
      const r2 = await get('/api/daemon-info', hub.port);
      assert.ok(r2.body.uptime_ms > r1.body.uptime_ms,
        `expected uptime to grow: ${r1.body.uptime_ms} → ${r2.body.uptime_ms}`);
    } finally { hub.stop(); }
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  if (failed > 0) { console.error(failures.join('\n')); process.exit(1); }
})();
