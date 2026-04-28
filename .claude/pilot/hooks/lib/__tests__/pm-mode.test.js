/**
 * Tests for PM mode flag — Sprint 4 T1 (M1.5)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/pm-mode.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { getPmMode, setPmMode, isValidMode, VALID_MODES, DEFAULT_MODE } = require('../pm-mode');

let testDir;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-mode-'));
}

function teardown() {
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

console.log('\n=== PM Mode Tests ===\n');

test('default mode is strict_rules', () => {
  assert.strictEqual(DEFAULT_MODE, 'strict_rules');
  assert.strictEqual(getPmMode(testDir), 'strict_rules');
});

test('VALID_MODES list', () => {
  assert.deepStrictEqual(VALID_MODES.sort(), ['free_chat', 'off', 'strict_rules'].sort());
});

test('isValidMode accepts known values', () => {
  for (const m of VALID_MODES) assert.strictEqual(isValidMode(m), true);
});

test('isValidMode rejects junk', () => {
  for (const m of ['', 'STRICT', 'on', null, undefined, 1, {}]) {
    assert.strictEqual(isValidMode(m), false, `should reject ${JSON.stringify(m)}`);
  }
});

test('setPmMode persists and getPmMode reads back', () => {
  const r1 = setPmMode(testDir, 'free_chat');
  assert.strictEqual(r1.success, true);
  assert.strictEqual(r1.mode, 'free_chat');
  assert.strictEqual(getPmMode(testDir), 'free_chat');

  const r2 = setPmMode(testDir, 'off');
  assert.strictEqual(r2.success, true);
  assert.strictEqual(getPmMode(testDir), 'off');
});

test('setPmMode rejects invalid value', () => {
  const r = setPmMode(testDir, 'wrong');
  assert.strictEqual(r.success, false);
  assert.match(r.error, /Invalid mode/);
  assert.strictEqual(getPmMode(testDir), DEFAULT_MODE);
});

test('malformed pm-mode.json → falls back to default', () => {
  const filePath = path.join(testDir, '.claude/pilot/state/orchestrator/pm-mode.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{ corrupt');
  assert.strictEqual(getPmMode(testDir), DEFAULT_MODE);
});

test('written file has expected shape', () => {
  setPmMode(testDir, 'free_chat');
  const filePath = path.join(testDir, '.claude/pilot/state/orchestrator/pm-mode.json');
  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.strictEqual(stored.version, 1);
  assert.strictEqual(stored.mode, 'free_chat');
  assert.ok(stored.updatedAt);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
