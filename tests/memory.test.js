#!/usr/bin/env node

/**
 * Verification tests for Shared Memory Layer (Phase 2.2)
 * Run: node tests/memory.test.js
 */

const memory = require('../.claude/pilot/hooks/lib/memory');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS: ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL: ' + name + ' - ' + e.message);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

console.log('=== Shared Memory Layer Tests ===\n');

// 1. Index loading
test('loadIndex returns valid index', () => {
  const index = memory.loadIndex();
  assert(index.version === 1, 'version should be 1');
  assert(index.channels['design-tokens'], 'should have design-tokens channel');
  assert(index.channels['api-types'], 'should have api-types channel');
  assert(index.channels['component-registry'], 'should have component-registry channel');
});

// 2. List channels
test('listChannels returns all channels', () => {
  const channels = memory.listChannels();
  assert(channels.length === 4, 'should have 4 channels (including pm-decisions)');
  assert(channels.includes('design-tokens'), 'should include design-tokens');
});

// 3. Channel info
test('getChannelInfo returns metadata', () => {
  const info = memory.getChannelInfo('design-tokens');
  assert(info !== null, 'should return info');
  assert(info.publisher === 'design', 'publisher should be design');
  assert(info.consumers.includes('frontend'), 'should include frontend consumer');
});

test('getChannelInfo returns null for unknown channel', () => {
  const info = memory.getChannelInfo('nonexistent');
  assert(info === null, 'should return null');
});

// 4. Read seeded design-tokens
test('read design-tokens returns seeded data', () => {
  const data = memory.read('design-tokens');
  assert(data !== null, 'should return data');
  assert(data.data.colors, 'should have colors');
  assert(data.data.spacing, 'should have spacing');
  assert(data.data.typography, 'should have typography');
});

// 5. Read summary (token-efficient)
test('readSummary returns summary without full data', () => {
  const summary = memory.readSummary('design-tokens');
  assert(summary !== null, 'should return summary');
  assert(summary.summary !== null, 'should have summary text');
  assert(summary.data === undefined, 'should NOT include full data');
  assert(summary.version, 'should have version');
});

// 6. Read nonexistent channel
test('read returns null for nonexistent channel', () => {
  const data = memory.read('nonexistent');
  assert(data === null, 'should return null');
});

// 7. Publish with schema validation
test('publish writes data and bumps version', () => {
  const currentData = memory.read('design-tokens');
  const currentVersion = currentData ? currentData.version : 0;

  const result = memory.publish('design-tokens', {
    colors: { primary: '#000000', secondary: '#ffffff', accent: '#ff0000', background: '#fff', foreground: '#000' },
    spacing: { '1': '0.25rem' },
    typography: { fontFamily: 'Mono', sizes: { base: '1rem' }, weights: { normal: 400 } }
  }, { agent: 'design', sessionId: 'S-test', summary: 'Updated colors to dark theme' });

  assert(result.version === currentVersion + 1, 'version should be bumped');
  assert(result.publishedBy === 'design', 'publishedBy should be design');

  // Verify it persisted
  const readBack = memory.read('design-tokens');
  assert(readBack.version === result.version, 'read-back version should match');
  assert(readBack.data.colors.primary === '#000000', 'data should be updated');
});

// 8. Schema validation rejects invalid data
test('publish rejects data missing required fields', () => {
  let threw = false;
  try {
    memory.publish('design-tokens', {
      colors: { primary: '#000' }
      // missing spacing and typography
    }, { agent: 'design' });
  } catch (e) {
    threw = true;
    assert(e.message.includes('Schema validation failed'), 'should mention schema validation');
  }
  assert(threw, 'should have thrown');
});

// 9. Per-agent memory
test('setAgentMemory and getAgentMemory round-trip', () => {
  memory.setAgentMemory('frontend', 'preferences', { theme: 'dark', framework: 'next' });
  const prefs = memory.getAgentMemory('frontend', 'preferences');
  assert(prefs.theme === 'dark', 'should store and retrieve preferences');
  assert(prefs.framework === 'next', 'should store framework');
});

test('getAgentMemory returns null for nonexistent', () => {
  const result = memory.getAgentMemory('nonexistent-agent', 'nonexistent-key');
  assert(result === null, 'should return null');
});

// 10. Discoveries (append-only)
test('recordDiscovery and getDiscoveries work', () => {
  // Clear any existing discoveries
  const discoveryPath = path.join(process.cwd(), '.claude/pilot/memory/agents/backend/discoveries.jsonl');
  if (fs.existsSync(discoveryPath)) {
    fs.unlinkSync(discoveryPath);
  }

  memory.recordDiscovery('backend', { type: 'api_pattern', detail: 'REST endpoints use /api/v1 prefix' });
  memory.recordDiscovery('backend', { type: 'db_pattern', detail: 'Uses Prisma ORM with PostgreSQL' });
  const discoveries = memory.getDiscoveries('backend');
  assert(discoveries.length === 2, 'should have 2 discoveries, got ' + discoveries.length);
  assert(discoveries[0].type === 'api_pattern', 'first discovery should be api_pattern');
  assert(discoveries[1].type === 'db_pattern', 'second discovery should be db_pattern');
});

// 11. Event stream integration
test('publish emits memory_published event to sessions.jsonl', () => {
  const eventFile = path.join(process.cwd(), 'runs/sessions.jsonl');

  if (fs.existsSync(eventFile)) {
    const content = fs.readFileSync(eventFile, 'utf8');
    const lines = content.trim().split('\n');
    const lastEvents = lines.slice(-10).map(l => {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
    const memEvents = lastEvents.filter(e => e.type === 'memory_published');
    assert(memEvents.length > 0, 'should have memory_published events');
    assert(memEvents[0].channel === 'design-tokens', 'event should reference design-tokens channel');
  }
});

// 12. Atomic write safety
test('atomicWrite creates file that can be read back', () => {
  const testPath = path.join(process.cwd(), '.claude/pilot/memory/agents/_test_atomic.json');
  memory.atomicWrite(testPath, { test: true, ts: Date.now() });

  const readBack = JSON.parse(fs.readFileSync(testPath, 'utf8'));
  assert(readBack.test === true, 'should read back correctly');

  // Cleanup
  fs.unlinkSync(testPath);
});

console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed > 0 ? 1 : 0);
