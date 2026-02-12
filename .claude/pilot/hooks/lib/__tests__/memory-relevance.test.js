/**
 * Tests for Memory Relevance Scorer & Consolidation — Phase 5.7
 *
 * Test groups:
 *   1. loadWeights — defaults, from policy, partial policy, missing policy
 *   2. scoreRecency — just updated, 7 days, 14 days, null/invalid input
 *   3. scoreFrequency — zero, max, log scaling, null inputs
 *   4. scoreSimilarity — tag/file overlap, both, no overlap, empty, case insensitive
 *   5. scoreLinks — zero, max, above max capped, null
 *   6. scoreEntry — composite, weights, fallback to updatedAt
 *   7. scoreEntries — batch, sorting, limit
 *   8. scoreChannel — reads file, missing channel, object data
 *   9. scoreAllChannels — multiple channels, sorting, limit
 *  10. loadSummarizationConfig — defaults, from policy
 *  11. getTargetState — full→summary, summary→archived, above threshold, no timestamp
 *  12. summarizeEntry — key fields, truncation, _state
 *  13. archiveEntry — creates dir, writes JSONL, appends
 *  14. consolidate — full pipeline, below min, dryRun
 *  15. readArchive — reads JSONL, missing file, limit
 *  16. loadBudgetConfig — defaults, from policy
 *  17. loadEvictionConfig — defaults, from policy
 *  18. getChannelBudget — default, overridden
 *  19. checkBudget — under, trigger, over
 *  20. evict — keeps top, archives evicted, dryRun
 *  21. getChannelMemoryStats — entry count, utilization, archive count
 *  22. getAllMemoryStats — multiple channels, totals
 *  23. getRelevantMemory — tiered loading from memory.js
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/memory-relevance.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// ============================================================================
// TEST INFRASTRUCTURE
// ============================================================================

let testDir;
let originalCwd;

function setup(policyExtra = '') {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-relevance-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/memory/channels'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/memory/archive'), { recursive: true });

  const policyContent = `
memory:
  relevance_weights:
    recency: 0.30
    frequency: 0.25
    similarity: 0.25
    links: 0.20
  budgets:
    default: 100
    overrides:
      decisions: 50
      patterns: 150
  summarization:
    full_fidelity_threshold: 0.6
    summary_after_days: 7
    archive_after_days: 30
    max_summary_length: 500
    min_entries_for_consolidation: 20
  loading:
    relevance_threshold: 0.3
    max_entries_per_load: 20
    max_total_per_load: 50
    tier_thresholds:
      full: 0.7
      summary: 0.3
  eviction:
    strategy: lru
    trigger_pct: 90
    target_pct: 75
${policyExtra}
`;
  fs.mkdirSync(path.join(testDir, '.claude/pilot'), { recursive: true });
  fs.writeFileSync(path.join(testDir, '.claude/pilot/policy.yaml'), policyContent);

  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModule(modName) {
  const modPaths = [
    '../memory-relevance',
    '../memory',
    '../policy',
    '../session',
    '../messaging'
  ];
  for (const modPath of modPaths) {
    try {
      const resolved = require.resolve(modPath);
      delete require.cache[resolved];
    } catch (e) { /* not loaded */ }
  }
  if (modName === 'memory') return require('../memory');
  return require('../memory-relevance');
}

/**
 * Write a channel JSON file in the expected envelope format.
 */
function writeChannel(channel, entries, publishedAt) {
  publishedAt = publishedAt || '2026-01-15T00:00:00.000Z';
  const envelope = {
    channel,
    version: 1,
    publishedBy: 'test',
    publishedAt,
    data: entries
  };
  const channelPath = path.join(testDir, '.claude/pilot/memory/channels', `${channel}.json`);
  fs.writeFileSync(channelPath, JSON.stringify(envelope));
}

/**
 * Write a channel JSON file with object data (non-array).
 */
function writeChannelObject(channel, dataObj, publishedAt) {
  publishedAt = publishedAt || '2026-01-15T00:00:00.000Z';
  const envelope = {
    channel,
    version: 1,
    publishedBy: 'test',
    publishedAt,
    data: dataObj
  };
  const channelPath = path.join(testDir, '.claude/pilot/memory/channels', `${channel}.json`);
  fs.writeFileSync(channelPath, JSON.stringify(envelope));
}

// Fixed timestamps for deterministic tests
const NOW = new Date('2026-02-01T12:00:00.000Z').getTime();
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

// ============================================================================
// TESTS
// ============================================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  if (!test._customSetup) {
    setup();
  }
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${e.message}`);
  } finally {
    teardown();
    test._customSetup = false;
  }
}

function testWithPolicy(name, policyExtra, fn) {
  setup(policyExtra);
  test._customSetup = true;
  test(name, fn);
}

console.log('\nMemory Relevance Tests\n');

// ============================================================================
// 1. loadWeights
// ============================================================================

console.log('--- loadWeights ---');

test('loadWeights returns defaults when no memory section in policy', () => {
  fs.writeFileSync(path.join(testDir, '.claude/pilot/policy.yaml'), 'approval:\n  auto: 0.85\n');
  const mr = freshModule();
  const w = mr.loadWeights();
  assert.strictEqual(w.recency, 0.30);
  assert.strictEqual(w.frequency, 0.25);
  assert.strictEqual(w.similarity, 0.25);
  assert.strictEqual(w.links, 0.20);
});

test('loadWeights reads from policy.yaml', () => {
  const mr = freshModule();
  const w = mr.loadWeights();
  assert.strictEqual(w.recency, 0.30);
  assert.strictEqual(w.frequency, 0.25);
  assert.strictEqual(w.similarity, 0.25);
  assert.strictEqual(w.links, 0.20);
});

testWithPolicy('loadWeights reads custom weights from policy', `
  relevance_weights:
    recency: 0.40
    frequency: 0.10
    similarity: 0.30
    links: 0.20
`, () => {
  const mr = freshModule();
  const w = mr.loadWeights();
  assert.strictEqual(w.recency, 0.40);
  assert.strictEqual(w.frequency, 0.10);
  assert.strictEqual(w.similarity, 0.30);
  assert.strictEqual(w.links, 0.20);
});

test('loadWeights handles partial policy — fills defaults for missing keys', () => {
  const mr = freshModule();
  const w = mr.loadWeights({ memory: { relevance_weights: { recency: 0.50 } } });
  assert.strictEqual(w.recency, 0.50);
  assert.strictEqual(w.frequency, 0.25);
  assert.strictEqual(w.similarity, 0.25);
  assert.strictEqual(w.links, 0.20);
});

test('loadWeights returns defaults when policy file missing', () => {
  fs.unlinkSync(path.join(testDir, '.claude/pilot/policy.yaml'));
  const mr = freshModule();
  const w = mr.loadWeights();
  assert.strictEqual(w.recency, mr.DEFAULT_WEIGHTS.recency);
  assert.strictEqual(w.frequency, mr.DEFAULT_WEIGHTS.frequency);
  assert.strictEqual(w.similarity, mr.DEFAULT_WEIGHTS.similarity);
  assert.strictEqual(w.links, mr.DEFAULT_WEIGHTS.links);
});

test('loadWeights returns defaults with pre-loaded empty policy', () => {
  const mr = freshModule();
  const w = mr.loadWeights({});
  assert.strictEqual(w.recency, mr.DEFAULT_WEIGHTS.recency);
  assert.strictEqual(w.links, mr.DEFAULT_WEIGHTS.links);
});

// ============================================================================
// 2. scoreRecency
// ============================================================================

console.log('--- scoreRecency ---');

test('scoreRecency: just updated returns ~1.0', () => {
  const mr = freshModule();
  const score = mr.scoreRecency(new Date(NOW).toISOString(), NOW);
  assert.ok(Math.abs(score - 1.0) < 0.01, `expected ~1.0, got ${score}`);
});

test('scoreRecency: 7 days old returns ~0.5', () => {
  const mr = freshModule();
  const sevenDaysAgo = new Date(NOW - SEVEN_DAYS_MS).toISOString();
  const score = mr.scoreRecency(sevenDaysAgo, NOW);
  assert.ok(Math.abs(score - 0.5) < 0.01, `expected ~0.5, got ${score}`);
});

test('scoreRecency: 14 days old returns ~0.25', () => {
  const mr = freshModule();
  const fourteenDaysAgo = new Date(NOW - 14 * ONE_DAY_MS).toISOString();
  const score = mr.scoreRecency(fourteenDaysAgo, NOW);
  assert.ok(Math.abs(score - 0.25) < 0.01, `expected ~0.25, got ${score}`);
});

test('scoreRecency: null input returns 0', () => {
  const mr = freshModule();
  assert.strictEqual(mr.scoreRecency(null, NOW), 0);
});

test('scoreRecency: undefined input returns 0', () => {
  const mr = freshModule();
  assert.strictEqual(mr.scoreRecency(undefined, NOW), 0);
});

test('scoreRecency: invalid date string returns 0', () => {
  const mr = freshModule();
  assert.strictEqual(mr.scoreRecency('not-a-date', NOW), 0);
});

test('scoreRecency: accepts Date object', () => {
  const mr = freshModule();
  const score = mr.scoreRecency(new Date(NOW), NOW);
  assert.ok(Math.abs(score - 1.0) < 0.01, `expected ~1.0, got ${score}`);
});

test('scoreRecency: very old entry returns near 0', () => {
  const mr = freshModule();
  const veryOld = new Date(NOW - 365 * ONE_DAY_MS).toISOString();
  const score = mr.scoreRecency(veryOld, NOW);
  assert.ok(score < 0.001, `expected near 0, got ${score}`);
});

test('scoreRecency: decreases monotonically with age', () => {
  const mr = freshModule();
  const s1 = mr.scoreRecency(new Date(NOW - 1 * ONE_DAY_MS).toISOString(), NOW);
  const s2 = mr.scoreRecency(new Date(NOW - 5 * ONE_DAY_MS).toISOString(), NOW);
  const s3 = mr.scoreRecency(new Date(NOW - 30 * ONE_DAY_MS).toISOString(), NOW);
  assert.ok(s1 > s2 && s2 > s3, `Expected monotonic decrease: ${s1} > ${s2} > ${s3}`);
});

// ============================================================================
// 3. scoreFrequency
// ============================================================================

console.log('--- scoreFrequency ---');

test('scoreFrequency: zero access count returns 0', () => {
  const mr = freshModule();
  assert.strictEqual(mr.scoreFrequency(0, 10), 0);
});

test('scoreFrequency: equal to max returns 1.0', () => {
  const mr = freshModule();
  const score = mr.scoreFrequency(10, 10);
  assert.ok(Math.abs(score - 1.0) < 0.001, `expected 1.0, got ${score}`);
});

test('scoreFrequency: log scaling — middle count gives compressed score', () => {
  const mr = freshModule();
  const score = mr.scoreFrequency(5, 10);
  const expected = Math.log(6) / Math.log(11);
  assert.ok(Math.abs(score - expected) < 0.001, `expected ~${expected}, got ${score}`);
});

test('scoreFrequency: null accessCount returns 0', () => {
  const mr = freshModule();
  assert.strictEqual(mr.scoreFrequency(null, 10), 0);
});

test('scoreFrequency: null maxAccessCount returns 0', () => {
  const mr = freshModule();
  assert.strictEqual(mr.scoreFrequency(5, null), 0);
});

test('scoreFrequency: negative count returns 0', () => {
  const mr = freshModule();
  assert.strictEqual(mr.scoreFrequency(-1, 10), 0);
});

test('scoreFrequency: zero maxAccessCount returns 0', () => {
  const mr = freshModule();
  assert.strictEqual(mr.scoreFrequency(5, 0), 0);
});

test('scoreFrequency: log scaling shows diminishing returns', () => {
  const mr = freshModule();
  const s1 = mr.scoreFrequency(1, 100);
  const s10 = mr.scoreFrequency(10, 100);
  const s50 = mr.scoreFrequency(50, 100);
  const gap1 = s10 - s1;
  const gap2 = s50 - s10;
  assert.ok(gap1 > gap2, 'Expected diminishing returns with log scaling');
});

// ============================================================================
// 4. scoreSimilarity
// ============================================================================

console.log('--- scoreSimilarity ---');

test('scoreSimilarity: tag overlap (Jaccard)', () => {
  const mr = freshModule();
  const entry = { tags: ['auth', 'login', 'security'] };
  const context = { tags: ['auth', 'security', 'oauth'] };
  const score = mr.scoreSimilarity(entry, context);
  // Intersection: auth, security (2). Union: auth, login, security, oauth (4). Jaccard = 2/4 = 0.5
  assert.ok(Math.abs(score - 0.5) < 0.001, `expected 0.5, got ${score}`);
});

test('scoreSimilarity: file overlap (Jaccard)', () => {
  const mr = freshModule();
  const entry = { files: ['src/auth.js', 'src/login.js'] };
  const context = { files: ['src/auth.js', 'src/register.js'] };
  const score = mr.scoreSimilarity(entry, context);
  // Intersection: auth.js (1). Union: auth.js, login.js, register.js (3). Jaccard = 1/3
  assert.ok(Math.abs(score - 1 / 3) < 0.001, `expected ~0.333, got ${score}`);
});

test('scoreSimilarity: both tag and file overlap averaged', () => {
  const mr = freshModule();
  const entry = { tags: ['auth', 'login'], files: ['src/auth.js'] };
  const context = { tags: ['auth'], files: ['src/auth.js'] };
  // tagScore: intersection=1 (auth), union=2 (auth, login) = 0.5
  // fileScore: intersection=1, union=1 = 1.0
  // average: (0.5 + 1.0) / 2 = 0.75
  const score = mr.scoreSimilarity(entry, context);
  assert.ok(Math.abs(score - 0.75) < 0.001, `expected 0.75, got ${score}`);
});

test('scoreSimilarity: no overlap returns 0', () => {
  const mr = freshModule();
  const entry = { tags: ['frontend'], files: ['src/ui.js'] };
  const context = { tags: ['backend'], files: ['src/api.js'] };
  assert.strictEqual(mr.scoreSimilarity(entry, context), 0);
});

test('scoreSimilarity: empty inputs returns 0', () => {
  const mr = freshModule();
  assert.strictEqual(mr.scoreSimilarity({}, {}), 0);
});

test('scoreSimilarity: null entry returns 0', () => {
  const mr = freshModule();
  assert.strictEqual(mr.scoreSimilarity(null, { tags: ['a'] }), 0);
});

test('scoreSimilarity: null taskContext returns 0', () => {
  const mr = freshModule();
  assert.strictEqual(mr.scoreSimilarity({ tags: ['a'] }, null), 0);
});

test('scoreSimilarity: case insensitive matching', () => {
  const mr = freshModule();
  const entry = { tags: ['Auth', 'LOGIN'] };
  const context = { tags: ['auth', 'login'] };
  const score = mr.scoreSimilarity(entry, context);
  assert.ok(Math.abs(score - 1.0) < 0.001, `expected 1.0, got ${score}`);
});

test('scoreSimilarity: tags only (no files) returns tag score alone', () => {
  const mr = freshModule();
  const entry = { tags: ['a', 'b'] };
  const context = { tags: ['a'] };
  // Jaccard: intersection=1, union=2 = 0.5
  const score = mr.scoreSimilarity(entry, context);
  assert.ok(Math.abs(score - 0.5) < 0.001, `expected 0.5, got ${score}`);
});

test('scoreSimilarity: files only (no tags) returns file score alone', () => {
  const mr = freshModule();
  const entry = { files: ['a.js', 'b.js'] };
  const context = { files: ['a.js'] };
  // Jaccard: intersection=1, union=2 = 0.5
  const score = mr.scoreSimilarity(entry, context);
  assert.ok(Math.abs(score - 0.5) < 0.001, `expected 0.5, got ${score}`);
});

// ============================================================================
// 5. scoreLinks
// ============================================================================

console.log('--- scoreLinks ---');

test('scoreLinks: zero linkCount returns 0', () => {
  const mr = freshModule();
  assert.strictEqual(mr.scoreLinks(0, 10), 0);
});

test('scoreLinks: equal to max returns 1.0', () => {
  const mr = freshModule();
  assert.strictEqual(mr.scoreLinks(10, 10), 1.0);
});

test('scoreLinks: above max capped at 1.0', () => {
  const mr = freshModule();
  assert.strictEqual(mr.scoreLinks(15, 10), 1.0);
});

test('scoreLinks: null linkCount returns 0', () => {
  const mr = freshModule();
  assert.strictEqual(mr.scoreLinks(null, 10), 0);
});

test('scoreLinks: null maxLinkCount returns 0', () => {
  const mr = freshModule();
  assert.strictEqual(mr.scoreLinks(5, null), 0);
});

test('scoreLinks: half of max returns 0.5', () => {
  const mr = freshModule();
  assert.strictEqual(mr.scoreLinks(5, 10), 0.5);
});

test('scoreLinks: proportional score for 3/6', () => {
  const mr = freshModule();
  assert.strictEqual(mr.scoreLinks(3, 6), 0.5);
});

// ============================================================================
// 6. scoreEntry (composite)
// ============================================================================

console.log('--- scoreEntry ---');

test('scoreEntry: composite score uses all factors', () => {
  const mr = freshModule();
  const entry = {
    lastAccessed: new Date(NOW).toISOString(),
    accessCount: 10,
    linkCount: 5,
    tags: ['auth'],
    files: ['src/auth.js']
  };
  const context = {
    taskContext: { tags: ['auth'], files: ['src/auth.js'] },
    maxAccessCount: 10,
    maxLinkCount: 10,
    now: NOW
  };
  const weights = { recency: 0.25, frequency: 0.25, similarity: 0.25, links: 0.25 };
  const result = mr.scoreEntry(entry, context, weights);
  assert.ok(typeof result.score === 'number', 'should return numeric score');
  assert.ok(result.score >= 0 && result.score <= 1, `score should be 0-1, got ${result.score}`);
  assert.ok(result.breakdown, 'should have breakdown');
  assert.ok(typeof result.breakdown.recency === 'number');
  assert.ok(typeof result.breakdown.frequency === 'number');
  assert.ok(typeof result.breakdown.similarity === 'number');
  assert.ok(typeof result.breakdown.links === 'number');
});

test('scoreEntry: weight application yields ~1.0 for perfect entry', () => {
  const mr = freshModule();
  const entry = {
    lastAccessed: new Date(NOW).toISOString(),
    accessCount: 10,
    linkCount: 10,
    tags: ['auth'],
    files: ['src/auth.js']
  };
  const context = {
    taskContext: { tags: ['auth'], files: ['src/auth.js'] },
    maxAccessCount: 10,
    maxLinkCount: 10,
    now: NOW
  };
  const weights = { recency: 0.25, frequency: 0.25, similarity: 0.25, links: 0.25 };
  const result = mr.scoreEntry(entry, context, weights);
  assert.ok(Math.abs(result.score - 1.0) < 0.01, `expected ~1.0, got ${result.score}`);
});

test('scoreEntry: falls back to updatedAt when lastAccessed missing', () => {
  const mr = freshModule();
  const entry = {
    updatedAt: new Date(NOW).toISOString(),
    accessCount: 0,
    linkCount: 0
  };
  const context = { taskContext: {}, maxAccessCount: 1, maxLinkCount: 1, now: NOW };
  const weights = { recency: 1.0, frequency: 0, similarity: 0, links: 0 };
  const result = mr.scoreEntry(entry, context, weights);
  assert.ok(result.breakdown.recency > 0.9, `expected high recency from updatedAt, got ${result.breakdown.recency}`);
});

test('scoreEntry: score clamped between 0 and 1', () => {
  const mr = freshModule();
  const entry = { lastAccessed: new Date(NOW).toISOString(), accessCount: 100, linkCount: 100 };
  const context = { taskContext: {}, maxAccessCount: 1, maxLinkCount: 1, now: NOW };
  const weights = { recency: 0.5, frequency: 0.5, similarity: 0, links: 0 };
  const result = mr.scoreEntry(entry, context, weights);
  assert.ok(result.score <= 1.0, `score should be clamped to 1.0, got ${result.score}`);
  assert.ok(result.score >= 0.0, `score should be >= 0, got ${result.score}`);
});

test('scoreEntry: recent+relevant entry beats old+irrelevant entry', () => {
  const mr = freshModule();
  const ctx = { taskContext: { tags: ['memory'] }, maxAccessCount: 10, maxLinkCount: 5, now: NOW };
  const recent = mr.scoreEntry(
    { lastAccessed: new Date(NOW).toISOString(), accessCount: 10, tags: ['memory'], linkCount: 5 }, ctx
  );
  const old = mr.scoreEntry(
    { lastAccessed: new Date(NOW - 60 * ONE_DAY_MS).toISOString(), accessCount: 0, tags: ['other'], linkCount: 0 }, ctx
  );
  assert.ok(recent.score > old.score, `Recent ${recent.score} should beat old ${old.score}`);
});

// ============================================================================
// 7. scoreEntries (batch)
// ============================================================================

console.log('--- scoreEntries ---');

test('scoreEntries: batch scoring returns scored entries', () => {
  const mr = freshModule();
  const entries = [
    { id: 'a', lastAccessed: new Date(NOW).toISOString(), accessCount: 5 },
    { id: 'b', lastAccessed: new Date(NOW - 7 * ONE_DAY_MS).toISOString(), accessCount: 2 },
    { id: 'c', lastAccessed: new Date(NOW - 14 * ONE_DAY_MS).toISOString(), accessCount: 1 }
  ];
  const result = mr.scoreEntries(entries, {}, { now: NOW });
  assert.strictEqual(result.length, 3);
  assert.ok(result[0].relevance !== undefined, 'should have relevance');
  assert.ok(result[0].relevanceBreakdown !== undefined, 'should have breakdown');
});

test('scoreEntries: sorted by relevance descending', () => {
  const mr = freshModule();
  const entries = [
    { id: 'old', lastAccessed: new Date(NOW - 30 * ONE_DAY_MS).toISOString(), accessCount: 1 },
    { id: 'new', lastAccessed: new Date(NOW).toISOString(), accessCount: 10 },
    { id: 'mid', lastAccessed: new Date(NOW - 3 * ONE_DAY_MS).toISOString(), accessCount: 5 }
  ];
  const result = mr.scoreEntries(entries, {}, { now: NOW });
  assert.strictEqual(result[0].id, 'new');
  assert.ok(result[0].relevance >= result[1].relevance, 'first should have highest score');
  assert.ok(result[1].relevance >= result[2].relevance, 'second should be >= third');
});

test('scoreEntries: limit application', () => {
  const mr = freshModule();
  const entries = Array.from({ length: 10 }, (_, i) => ({
    id: `e${i}`,
    lastAccessed: new Date(NOW - i * ONE_DAY_MS).toISOString(),
    accessCount: 10 - i
  }));
  const result = mr.scoreEntries(entries, {}, { now: NOW, limit: 3 });
  assert.strictEqual(result.length, 3);
});

test('scoreEntries: empty array returns empty', () => {
  const mr = freshModule();
  assert.deepStrictEqual(mr.scoreEntries([], {}), []);
});

test('scoreEntries: null entries returns empty', () => {
  const mr = freshModule();
  assert.deepStrictEqual(mr.scoreEntries(null, {}), []);
});

test('scoreEntries: preserves original entry properties', () => {
  const mr = freshModule();
  const entries = [
    { id: 'p1', custom: 'data', lastAccessed: new Date(NOW).toISOString(), accessCount: 1 }
  ];
  const result = mr.scoreEntries(entries, {}, { now: NOW });
  assert.strictEqual(result[0].id, 'p1');
  assert.strictEqual(result[0].custom, 'data');
});

// ============================================================================
// 8. scoreChannel
// ============================================================================

console.log('--- scoreChannel ---');

test('scoreChannel: reads channel file and scores entries', () => {
  const mr = freshModule();
  writeChannel('decisions', [
    { id: 'd1', lastAccessed: new Date(NOW).toISOString(), accessCount: 5, tags: ['auth'] },
    { id: 'd2', lastAccessed: new Date(NOW - 10 * ONE_DAY_MS).toISOString(), accessCount: 2, tags: ['db'] }
  ]);
  const result = mr.scoreChannel('decisions', { tags: ['auth'] }, { cwd: testDir, now: NOW });
  assert.strictEqual(result.length, 2);
  assert.ok(result[0].relevance >= result[1].relevance, 'should be sorted by relevance');
  assert.strictEqual(result[0]._channel, 'decisions');
});

test('scoreChannel: handles missing channel file', () => {
  const mr = freshModule();
  const result = mr.scoreChannel('nonexistent', {}, { cwd: testDir });
  assert.deepStrictEqual(result, []);
});

test('scoreChannel: handles object data format', () => {
  const mr = freshModule();
  writeChannelObject('config', {
    entries: [
      { id: 'c1', tags: ['config'], accessCount: 3 },
      { id: 'c2', tags: ['settings'], accessCount: 1 }
    ]
  }, '2026-01-20T00:00:00.000Z');
  const result = mr.scoreChannel('config', {}, { cwd: testDir, now: NOW });
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0]._channel, 'config');
});

test('scoreChannel: augments entries with envelope timestamp when missing', () => {
  const mr = freshModule();
  writeChannel('patterns', [
    { id: 'p1', tags: ['pattern'] }
  ], '2026-01-25T00:00:00.000Z');
  const result = mr.scoreChannel('patterns', {}, { cwd: testDir, now: NOW });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].lastAccessed, '2026-01-25T00:00:00.000Z');
});

test('scoreChannel: handles single object data (no array key)', () => {
  const mr = freshModule();
  writeChannelObject('singleton', { id: 's1', tags: ['solo'], accessCount: 1 });
  const result = mr.scoreChannel('singleton', {}, { cwd: testDir, now: NOW });
  assert.strictEqual(result.length, 1);
});

test('scoreChannel: malformed JSON returns empty', () => {
  const mr = freshModule();
  const channelPath = path.join(testDir, '.claude/pilot/memory/channels/bad.json');
  fs.writeFileSync(channelPath, '{ invalid json }}}');
  const result = mr.scoreChannel('bad', {}, { cwd: testDir });
  assert.deepStrictEqual(result, []);
});

// ============================================================================
// 9. scoreAllChannels
// ============================================================================

console.log('--- scoreAllChannels ---');

test('scoreAllChannels: scores across multiple channels', () => {
  const mr = freshModule();
  writeChannel('ch-alpha', [
    { id: 'a1', lastAccessed: new Date(NOW).toISOString(), accessCount: 10 }
  ]);
  writeChannel('ch-beta', [
    { id: 'b1', lastAccessed: new Date(NOW - 5 * ONE_DAY_MS).toISOString(), accessCount: 3 }
  ]);
  const result = mr.scoreAllChannels({}, { cwd: testDir, now: NOW });
  assert.strictEqual(result.length, 2);
  assert.ok(result[0].relevance >= result[1].relevance, 'should be globally sorted');
});

test('scoreAllChannels: sorting across channels by relevance', () => {
  const mr = freshModule();
  writeChannel('alpha', [
    { id: 'a1', lastAccessed: new Date(NOW - 20 * ONE_DAY_MS).toISOString(), accessCount: 1 }
  ]);
  writeChannel('beta', [
    { id: 'b1', lastAccessed: new Date(NOW).toISOString(), accessCount: 10 }
  ]);
  const result = mr.scoreAllChannels({}, { cwd: testDir, now: NOW });
  assert.strictEqual(result[0].id, 'b1', 'beta entry should be first (more recent, higher access)');
});

test('scoreAllChannels: limit applied after merge', () => {
  const mr = freshModule();
  writeChannel('lim-a', Array.from({ length: 5 }, (_, i) => ({
    id: `la${i}`, lastAccessed: new Date(NOW - i * ONE_DAY_MS).toISOString(), accessCount: 5 - i
  })));
  writeChannel('lim-b', Array.from({ length: 5 }, (_, i) => ({
    id: `lb${i}`, lastAccessed: new Date(NOW - i * ONE_DAY_MS).toISOString(), accessCount: 5 - i
  })));
  const result = mr.scoreAllChannels({}, { cwd: testDir, now: NOW, limit: 3 });
  assert.strictEqual(result.length, 3);
});

test('scoreAllChannels: empty channels dir returns empty', () => {
  const mr = freshModule();
  const result = mr.scoreAllChannels({}, { cwd: testDir, now: NOW });
  assert.deepStrictEqual(result, []);
});

test('scoreAllChannels: missing channels dir returns empty', () => {
  const mr = freshModule();
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-channels-'));
  const result = mr.scoreAllChannels({}, { cwd: emptyDir });
  assert.deepStrictEqual(result, []);
  fs.rmSync(emptyDir, { recursive: true, force: true });
});

// ============================================================================
// 10. loadSummarizationConfig
// ============================================================================

console.log('--- loadSummarizationConfig ---');

test('loadSummarizationConfig: returns defaults from policy', () => {
  const mr = freshModule();
  const config = mr.loadSummarizationConfig();
  assert.strictEqual(config.full_fidelity_threshold, 0.6);
  assert.strictEqual(config.summary_after_days, 7);
  assert.strictEqual(config.archive_after_days, 30);
  assert.strictEqual(config.max_summary_length, 500);
  assert.strictEqual(config.min_entries_for_consolidation, 20);
});

test('loadSummarizationConfig: accepts pre-loaded policy object', () => {
  const mr = freshModule();
  const config = mr.loadSummarizationConfig({
    memory: { summarization: { summary_after_days: 3 } }
  });
  assert.strictEqual(config.summary_after_days, 3);
  assert.strictEqual(config.full_fidelity_threshold, 0.6);
});

test('loadSummarizationConfig: falls back to defaults with no policy', () => {
  const mr = freshModule();
  const config = mr.loadSummarizationConfig({});
  assert.strictEqual(config.full_fidelity_threshold, 0.6);
  assert.strictEqual(config.summary_after_days, 7);
});

// ============================================================================
// 11. getTargetState
// ============================================================================

console.log('--- getTargetState ---');

test('getTargetState: full to summary transition', () => {
  const mr = freshModule();
  const config = { full_fidelity_threshold: 0.6, summary_after_days: 7, archive_after_days: 30 };
  const entry = {
    _state: 'full',
    relevance: 0.3,
    lastAccessed: new Date(NOW - 10 * ONE_DAY_MS).toISOString()
  };
  assert.strictEqual(mr.getTargetState(entry, config, NOW), 'summary');
});

test('getTargetState: summary to archived transition', () => {
  const mr = freshModule();
  const config = { full_fidelity_threshold: 0.6, summary_after_days: 7, archive_after_days: 30 };
  const entry = {
    _state: 'summary',
    relevance: 0.2,
    lastAccessed: new Date(NOW - 35 * ONE_DAY_MS).toISOString()
  };
  assert.strictEqual(mr.getTargetState(entry, config, NOW), 'archived');
});

test('getTargetState: above threshold stays full', () => {
  const mr = freshModule();
  const config = { full_fidelity_threshold: 0.6, summary_after_days: 7, archive_after_days: 30 };
  const entry = {
    _state: 'full',
    relevance: 0.8,
    lastAccessed: new Date(NOW - 10 * ONE_DAY_MS).toISOString()
  };
  assert.strictEqual(mr.getTargetState(entry, config, NOW), null);
});

test('getTargetState: no timestamp returns null', () => {
  const mr = freshModule();
  const config = { full_fidelity_threshold: 0.6, summary_after_days: 7, archive_after_days: 30 };
  const entry = { _state: 'full', relevance: 0.3 };
  assert.strictEqual(mr.getTargetState(entry, config, NOW), null);
});

test('getTargetState: recent low-relevance entry stays full', () => {
  const mr = freshModule();
  const config = { full_fidelity_threshold: 0.6, summary_after_days: 7, archive_after_days: 30 };
  const entry = {
    _state: 'full',
    relevance: 0.3,
    lastAccessed: new Date(NOW - 2 * ONE_DAY_MS).toISOString()
  };
  assert.strictEqual(mr.getTargetState(entry, config, NOW), null);
});

test('getTargetState: default state is full when _state missing', () => {
  const mr = freshModule();
  const config = { full_fidelity_threshold: 0.6, summary_after_days: 7, archive_after_days: 30 };
  const entry = {
    relevance: 0.2,
    lastAccessed: new Date(NOW - 10 * ONE_DAY_MS).toISOString()
  };
  assert.strictEqual(mr.getTargetState(entry, config, NOW), 'summary');
});

test('getTargetState: invalid date returns null', () => {
  const mr = freshModule();
  const config = { full_fidelity_threshold: 0.6, summary_after_days: 7, archive_after_days: 30 };
  const entry = { _state: 'full', relevance: 0.2, lastAccessed: 'not-a-date' };
  assert.strictEqual(mr.getTargetState(entry, config, NOW), null);
});

test('getTargetState: summary stays summary when not old enough for archive', () => {
  const mr = freshModule();
  const config = { full_fidelity_threshold: 0.6, summary_after_days: 7, archive_after_days: 30 };
  const entry = {
    _state: 'summary',
    relevance: 0.1,
    lastAccessed: new Date(NOW - 15 * ONE_DAY_MS).toISOString()
  };
  assert.strictEqual(mr.getTargetState(entry, config, NOW), null);
});

// ============================================================================
// 12. summarizeEntry
// ============================================================================

console.log('--- summarizeEntry ---');

test('summarizeEntry: preserves key fields', () => {
  const mr = freshModule();
  const entry = {
    id: 'e1',
    _channel: 'decisions',
    tags: ['auth'],
    files: ['src/auth.js'],
    type: 'decision',
    action: 'approved',
    task_id: 'task-1',
    accessCount: 5,
    linkCount: 3,
    description: 'Made auth decision',
    reason: 'Security improvement'
  };
  const result = mr.summarizeEntry(entry, 500);
  assert.strictEqual(result.id, 'e1');
  assert.strictEqual(result._channel, 'decisions');
  assert.deepStrictEqual(result.tags, ['auth']);
  assert.strictEqual(result.type, 'decision');
  assert.strictEqual(result.accessCount, 5);
  assert.strictEqual(result.linkCount, 3);
});

test('summarizeEntry: truncates long text', () => {
  const mr = freshModule();
  const longText = 'A'.repeat(1000);
  const entry = { id: 'e2', description: longText, lastAccessed: '2026-01-15T00:00:00.000Z' };
  const result = mr.summarizeEntry(entry, 100);
  assert.ok(result.summary.length <= 100, `summary should be <= 100 chars, got ${result.summary.length}`);
  assert.ok(result.summary.endsWith('...'), 'truncated summary should end with ...');
});

test('summarizeEntry: sets _state to summary', () => {
  const mr = freshModule();
  const entry = { id: 'e3', description: 'test', lastAccessed: '2026-01-15T00:00:00.000Z' };
  const result = mr.summarizeEntry(entry, 500);
  assert.strictEqual(result._state, 'summary');
});

test('summarizeEntry: includes _summarizedAt and _originalKeys', () => {
  const mr = freshModule();
  const entry = { id: 'e4', description: 'test', custom: 'value', lastAccessed: '2026-01-15T00:00:00.000Z' };
  const result = mr.summarizeEntry(entry, 500);
  assert.ok(result._summarizedAt, 'should have _summarizedAt');
  assert.ok(Array.isArray(result._originalKeys), '_originalKeys should be array');
  assert.ok(result._originalKeys.includes('id'));
  assert.ok(result._originalKeys.includes('description'));
  assert.ok(result._originalKeys.includes('custom'));
});

test('summarizeEntry: concatenates multiple text fields with separator', () => {
  const mr = freshModule();
  const entry = {
    id: 'e5',
    reason: 'Because reasons',
    description: 'Something happened',
    lastAccessed: '2026-01-15T00:00:00.000Z'
  };
  const result = mr.summarizeEntry(entry, 500);
  assert.ok(result.summary.includes('Because reasons'), 'should include reason');
  assert.ok(result.summary.includes('Something happened'), 'should include description');
  assert.ok(result.summary.includes(' | '), 'should use | separator');
});

test('summarizeEntry: defaults maxLength to 500', () => {
  const mr = freshModule();
  const longText = 'B'.repeat(800);
  const entry = { id: 'e6', description: longText, lastAccessed: '2026-01-15T00:00:00.000Z' };
  const result = mr.summarizeEntry(entry);
  assert.ok(result.summary.length <= 500, `should default to 500 max, got ${result.summary.length}`);
});

// ============================================================================
// 13. archiveEntry
// ============================================================================

console.log('--- archiveEntry ---');

test('archiveEntry: creates archive directory', () => {
  const mr = freshModule();
  const entry = { id: 'ae1', _state: 'summary', summary: 'test' };
  mr.archiveEntry(entry, 'new-channel', testDir);
  const archiveDir = path.join(testDir, '.claude/pilot/memory/archive/new-channel');
  assert.ok(fs.existsSync(archiveDir), 'archive dir should exist');
});

test('archiveEntry: writes JSONL with archived state', () => {
  const mr = freshModule();
  const entry = { id: 'ae2', _state: 'summary', summary: 'test entry' };
  mr.archiveEntry(entry, 'arch-write', testDir);
  const archivePath = path.join(testDir, '.claude/pilot/memory/archive/arch-write/entries.jsonl');
  assert.ok(fs.existsSync(archivePath), 'entries.jsonl should exist');
  const content = fs.readFileSync(archivePath, 'utf8').trim();
  const parsed = JSON.parse(content);
  assert.strictEqual(parsed.id, 'ae2');
  assert.strictEqual(parsed._state, 'archived');
  assert.ok(parsed._archivedAt, 'should have _archivedAt');
  assert.strictEqual(parsed._sourceChannel, 'arch-write');
});

test('archiveEntry: appends multiple entries', () => {
  const mr = freshModule();
  mr.archiveEntry({ id: 'ae3', summary: 'first' }, 'append-ch', testDir);
  mr.archiveEntry({ id: 'ae4', summary: 'second' }, 'append-ch', testDir);
  const archivePath = path.join(testDir, '.claude/pilot/memory/archive/append-ch/entries.jsonl');
  const lines = fs.readFileSync(archivePath, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(JSON.parse(lines[0]).id, 'ae3');
  assert.strictEqual(JSON.parse(lines[1]).id, 'ae4');
});

test('archiveEntry: returns metadata', () => {
  const mr = freshModule();
  const result = mr.archiveEntry({ id: 'ae5', summary: 'test' }, 'meta-ch', testDir);
  assert.strictEqual(result.id, 'ae5');
  assert.strictEqual(result.channel, 'meta-ch');
  assert.ok(result.archivedAt, 'should have archivedAt');
  assert.ok(result.archivePath, 'should have archivePath');
});

// ============================================================================
// 14. consolidate
// ============================================================================

console.log('--- consolidate ---');

test('consolidate: runs full pipeline on eligible entries', () => {
  const mr = freshModule();
  const entries = Array.from({ length: 25 }, (_, i) => ({
    id: `ce${i}`,
    _state: 'full',
    relevance: i < 5 ? 0.9 : (i < 15 ? 0.4 : 0.1),
    lastAccessed: new Date(NOW - (i < 5 ? 2 : (i < 15 ? 10 : 40)) * ONE_DAY_MS).toISOString(),
    description: `Entry ${i} description`,
    accessCount: 25 - i
  }));
  const result = mr.consolidate(entries, 'consolidate-ch', { now: NOW, cwd: testDir });
  assert.ok(result.kept.length > 0, 'should keep some entries');
  assert.ok(result.summarized.length > 0 || result.archived.length > 0, 'should process some entries');
  assert.strictEqual(result.kept.length + result.archived.length, entries.length);
});

test('consolidate: below min entries skips processing', () => {
  const mr = freshModule();
  const entries = Array.from({ length: 5 }, (_, i) => ({
    id: `cs${i}`,
    relevance: 0.1,
    lastAccessed: new Date(NOW - 40 * ONE_DAY_MS).toISOString()
  }));
  const result = mr.consolidate(entries, 'skip-ch', { now: NOW, cwd: testDir });
  assert.strictEqual(result.kept.length, 5, 'all entries should be kept');
  assert.strictEqual(result.summarized.length, 0);
  assert.strictEqual(result.archived.length, 0);
});

test('consolidate: dryRun mode does not write archives', () => {
  const mr = freshModule();
  const entries = Array.from({ length: 25 }, (_, i) => ({
    id: `cd${i}`,
    _state: 'summary',
    relevance: 0.1,
    lastAccessed: new Date(NOW - 40 * ONE_DAY_MS).toISOString(),
    description: `Entry ${i}`
  }));
  const result = mr.consolidate(entries, 'dryrun-ch', { now: NOW, cwd: testDir, dryRun: true });
  const archivePath = path.join(testDir, '.claude/pilot/memory/archive/dryrun-ch/entries.jsonl');
  assert.ok(!fs.existsSync(archivePath), 'archive should not be written in dryRun mode');
  assert.ok(result.archived.length > 0, 'should report archived entries in dry run');
});

test('consolidate: high relevance entries are kept as-is', () => {
  const mr = freshModule();
  const entries = Array.from({ length: 25 }, (_, i) => ({
    id: `ck${i}`,
    _state: 'full',
    relevance: 0.9,
    lastAccessed: new Date(NOW - 2 * ONE_DAY_MS).toISOString(),
    description: `Entry ${i}`
  }));
  const result = mr.consolidate(entries, 'keep-ch', { now: NOW, cwd: testDir });
  assert.strictEqual(result.kept.length, 25);
  assert.strictEqual(result.summarized.length, 0);
  assert.strictEqual(result.archived.length, 0);
});

test('consolidate: archives old summary entries', () => {
  const mr = freshModule();
  const entries = Array.from({ length: 25 }, (_, i) => ({
    id: `ca${i}`,
    _state: 'summary',
    relevance: 0.2,
    lastAccessed: new Date(NOW - 35 * ONE_DAY_MS).toISOString(),
    description: `Old summarized entry ${i}`
  }));
  const result = mr.consolidate(entries, 'arch-ch', { now: NOW, cwd: testDir });
  assert.ok(result.archived.length > 0, 'should archive old summary entries');
  const archivePath = path.join(testDir, '.claude/pilot/memory/archive/arch-ch/entries.jsonl');
  assert.ok(fs.existsSync(archivePath), 'archive file should exist');
});

// ============================================================================
// 15. readArchive
// ============================================================================

console.log('--- readArchive ---');

test('readArchive: reads JSONL entries', () => {
  const mr = freshModule();
  mr.archiveEntry({ id: 'ra1', summary: 'first' }, 'read-arch', testDir);
  mr.archiveEntry({ id: 'ra2', summary: 'second' }, 'read-arch', testDir);
  const entries = mr.readArchive('read-arch', { cwd: testDir });
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].id, 'ra1');
  assert.strictEqual(entries[1].id, 'ra2');
});

test('readArchive: handles missing file', () => {
  const mr = freshModule();
  const entries = mr.readArchive('nonexistent', { cwd: testDir });
  assert.deepStrictEqual(entries, []);
});

test('readArchive: applies limit (returns last N entries)', () => {
  const mr = freshModule();
  for (let i = 0; i < 10; i++) {
    mr.archiveEntry({ id: `rl${i}`, summary: `entry ${i}` }, 'limit-arch', testDir);
  }
  const entries = mr.readArchive('limit-arch', { cwd: testDir, limit: 3 });
  assert.strictEqual(entries.length, 3);
  assert.strictEqual(entries[0].id, 'rl7');
  assert.strictEqual(entries[2].id, 'rl9');
});

test('readArchive: handles empty file', () => {
  const mr = freshModule();
  const archiveDir = path.join(testDir, '.claude/pilot/memory/archive/empty-arch');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, 'entries.jsonl'), '');
  const entries = mr.readArchive('empty-arch', { cwd: testDir });
  assert.deepStrictEqual(entries, []);
});

test('readArchive: handles malformed JSONL lines gracefully', () => {
  const mr = freshModule();
  const archiveDir = path.join(testDir, '.claude/pilot/memory/archive/bad-jsonl');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, 'entries.jsonl'),
    '{"id":"ok1"}\n{bad json}\n{"id":"ok2"}\n');
  const entries = mr.readArchive('bad-jsonl', { cwd: testDir });
  assert.strictEqual(entries.length, 2, 'should skip bad lines');
  assert.strictEqual(entries[0].id, 'ok1');
  assert.strictEqual(entries[1].id, 'ok2');
});

// ============================================================================
// 16. loadBudgetConfig
// ============================================================================

console.log('--- loadBudgetConfig ---');

test('loadBudgetConfig: returns defaults from policy', () => {
  const mr = freshModule();
  const config = mr.loadBudgetConfig();
  assert.strictEqual(config.default, 100);
  assert.strictEqual(config.overrides.decisions, 50);
  assert.strictEqual(config.overrides.patterns, 150);
});

test('loadBudgetConfig: accepts pre-loaded policy', () => {
  const mr = freshModule();
  const config = mr.loadBudgetConfig({ memory: { budgets: { default: 200 } } });
  assert.strictEqual(config.default, 200);
});

test('loadBudgetConfig: falls back to defaults with empty policy', () => {
  const mr = freshModule();
  const config = mr.loadBudgetConfig({});
  assert.strictEqual(config.default, 100);
  assert.deepStrictEqual(config.overrides, {});
});

// ============================================================================
// 17. loadEvictionConfig
// ============================================================================

console.log('--- loadEvictionConfig ---');

test('loadEvictionConfig: returns defaults from policy', () => {
  const mr = freshModule();
  const config = mr.loadEvictionConfig();
  assert.strictEqual(config.strategy, 'lru');
  assert.strictEqual(config.trigger_pct, 90);
  assert.strictEqual(config.target_pct, 75);
});

test('loadEvictionConfig: accepts pre-loaded policy', () => {
  const mr = freshModule();
  const config = mr.loadEvictionConfig({ memory: { eviction: { trigger_pct: 85 } } });
  assert.strictEqual(config.trigger_pct, 85);
  assert.strictEqual(config.strategy, 'lru');
});

test('loadEvictionConfig: falls back to defaults with empty policy', () => {
  const mr = freshModule();
  const config = mr.loadEvictionConfig({});
  assert.strictEqual(config.strategy, 'lru');
  assert.strictEqual(config.trigger_pct, 90);
  assert.strictEqual(config.target_pct, 75);
});

// ============================================================================
// 18. getChannelBudget
// ============================================================================

console.log('--- getChannelBudget ---');

test('getChannelBudget: returns default budget for unknown channel', () => {
  const mr = freshModule();
  const budget = mr.getChannelBudget('unknown');
  assert.strictEqual(budget, 100);
});

test('getChannelBudget: returns overridden budget', () => {
  const mr = freshModule();
  assert.strictEqual(mr.getChannelBudget('decisions'), 50);
  assert.strictEqual(mr.getChannelBudget('patterns'), 150);
});

test('getChannelBudget: falls back to default when no override for channel', () => {
  const mr = freshModule();
  const policy = { memory: { budgets: { default: 200, overrides: { decisions: 50 } } } };
  const budget = mr.getChannelBudget('other-channel', policy);
  assert.strictEqual(budget, 200);
});

// ============================================================================
// 19. checkBudget
// ============================================================================

console.log('--- checkBudget ---');

test('checkBudget: under budget returns overBudget false', () => {
  const mr = freshModule();
  const result = mr.checkBudget('unknown', 10);
  assert.strictEqual(result.overBudget, false);
  assert.strictEqual(result.budget, 100);
  assert.strictEqual(result.count, 10);
});

test('checkBudget: at trigger threshold returns overBudget true', () => {
  const mr = freshModule();
  // Default budget=100, trigger_pct=90, threshold=90
  const result = mr.checkBudget('unknown', 90);
  assert.strictEqual(result.overBudget, true);
  assert.strictEqual(result.triggerThreshold, 90);
});

test('checkBudget: over budget returns overBudget true', () => {
  const mr = freshModule();
  const result = mr.checkBudget('unknown', 110);
  assert.strictEqual(result.overBudget, true);
});

test('checkBudget: just below trigger threshold returns overBudget false', () => {
  const mr = freshModule();
  const result = mr.checkBudget('unknown', 89);
  assert.strictEqual(result.overBudget, false);
});

test('checkBudget: uses channel-specific budget', () => {
  const mr = freshModule();
  // decisions budget = 50, trigger at 90% = 45
  const result = mr.checkBudget('decisions', 45);
  assert.strictEqual(result.overBudget, true);
  assert.strictEqual(result.budget, 50);
});

// ============================================================================
// 20. evict
// ============================================================================

console.log('--- evict ---');

test('evict: keeps top entries by relevance', () => {
  const mr = freshModule();
  // Default budget=100, target_pct=75 -> target=75
  const entries = Array.from({ length: 100 }, (_, i) => ({
    id: `ev${i}`,
    relevance: 1 - (i / 100),
    description: `Entry ${i}`,
    lastAccessed: new Date(NOW - i * ONE_DAY_MS).toISOString()
  }));
  const result = mr.evict(entries, 'unknown', { cwd: testDir, now: NOW });
  assert.strictEqual(result.kept.length, 75);
  assert.strictEqual(result.evicted.length, 25);
  assert.strictEqual(result.budget, 100);
  assert.strictEqual(result.targetCount, 75);
});

test('evict: archives evicted entries', () => {
  const mr = freshModule();
  const entries = Array.from({ length: 100 }, (_, i) => ({
    id: `ea${i}`,
    relevance: 1 - (i / 100),
    description: `Entry ${i}`,
    lastAccessed: new Date(NOW).toISOString()
  }));
  mr.evict(entries, 'evict-arch', { cwd: testDir, now: NOW });
  const archivePath = path.join(testDir, '.claude/pilot/memory/archive/evict-arch/entries.jsonl');
  assert.ok(fs.existsSync(archivePath), 'archive should be written');
  const lines = fs.readFileSync(archivePath, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 25);
});

test('evict: dryRun mode does not write archives', () => {
  const mr = freshModule();
  const entries = Array.from({ length: 100 }, (_, i) => ({
    id: `ed${i}`,
    relevance: 1 - (i / 100),
    description: `Entry ${i}`
  }));
  const result = mr.evict(entries, 'dry-evict', { cwd: testDir, dryRun: true });
  const archivePath = path.join(testDir, '.claude/pilot/memory/archive/dry-evict/entries.jsonl');
  assert.ok(!fs.existsSync(archivePath), 'archive should not be written in dryRun');
  assert.strictEqual(result.evicted.length, 25);
});

test('evict: no eviction needed when entries below target', () => {
  const mr = freshModule();
  const entries = Array.from({ length: 10 }, (_, i) => ({
    id: `en${i}`,
    relevance: 0.5
  }));
  const result = mr.evict(entries, 'unknown', { cwd: testDir });
  assert.strictEqual(result.kept.length, 10);
  assert.strictEqual(result.evicted.length, 0);
});

test('evict: evicted entries have _state archived', () => {
  const mr = freshModule();
  const entries = Array.from({ length: 100 }, (_, i) => ({
    id: `es${i}`,
    relevance: 1 - (i / 100),
    description: `Entry ${i}`
  }));
  const result = mr.evict(entries, 'state-ch', { cwd: testDir });
  for (const evicted of result.evicted) {
    assert.strictEqual(evicted._state, 'archived');
  }
});

// ============================================================================
// 21. getChannelMemoryStats
// ============================================================================

console.log('--- getChannelMemoryStats ---');

test('getChannelMemoryStats: returns entry count', () => {
  const mr = freshModule();
  writeChannel('stats-count', [{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
  const stats = mr.getChannelMemoryStats('stats-count', { cwd: testDir });
  assert.strictEqual(stats.entryCount, 3);
  assert.strictEqual(stats.channel, 'stats-count');
});

test('getChannelMemoryStats: returns utilization percentage', () => {
  const mr = freshModule();
  writeChannel('stats-util', Array.from({ length: 50 }, (_, i) => ({ id: `u${i}` })));
  const stats = mr.getChannelMemoryStats('stats-util', { cwd: testDir });
  // 50 entries / 100 budget = 50%
  assert.strictEqual(stats.utilizationPct, 50);
  assert.strictEqual(stats.budget, 100);
});

test('getChannelMemoryStats: returns archive count', () => {
  const mr = freshModule();
  writeChannel('stats-arch', [{ id: 'sa1' }]);
  mr.archiveEntry({ id: 'archived1', summary: 'a' }, 'stats-arch', testDir);
  mr.archiveEntry({ id: 'archived2', summary: 'b' }, 'stats-arch', testDir);
  const stats = mr.getChannelMemoryStats('stats-arch', { cwd: testDir });
  assert.strictEqual(stats.archiveCount, 2);
});

test('getChannelMemoryStats: missing channel returns zero counts', () => {
  const mr = freshModule();
  const stats = mr.getChannelMemoryStats('missing', { cwd: testDir });
  assert.strictEqual(stats.entryCount, 0);
  assert.strictEqual(stats.archiveCount, 0);
});

test('getChannelMemoryStats: overBudget flag correct', () => {
  const mr = freshModule();
  const policy = { memory: { budgets: { default: 10 }, eviction: { trigger_pct: 90 } } };
  writeChannel('over-budget', Array.from({ length: 10 }, (_, i) => ({ id: `ob${i}` })));
  const stats = mr.getChannelMemoryStats('over-budget', { cwd: testDir, policy });
  assert.strictEqual(stats.overBudget, true);
});

test('getChannelMemoryStats: handles object data format', () => {
  const mr = freshModule();
  writeChannelObject('obj-stats', { items: [{ id: 'o1' }, { id: 'o2' }] });
  const stats = mr.getChannelMemoryStats('obj-stats', { cwd: testDir });
  assert.strictEqual(stats.entryCount, 2);
});

// ============================================================================
// 22. getAllMemoryStats
// ============================================================================

console.log('--- getAllMemoryStats ---');

test('getAllMemoryStats: multiple channels', () => {
  const mr = freshModule();
  writeChannel('all-a', [{ id: 'a1' }, { id: 'a2' }]);
  writeChannel('all-b', [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }]);
  const stats = mr.getAllMemoryStats({ cwd: testDir });
  assert.strictEqual(stats.channels.length, 2);
  assert.strictEqual(stats.totalEntries, 5);
});

test('getAllMemoryStats: totals include archives', () => {
  const mr = freshModule();
  writeChannel('total-a', [{ id: '1' }]);
  writeChannel('total-b', [{ id: '2' }, { id: '3' }]);
  mr.archiveEntry({ id: 'ar1', summary: 'x' }, 'total-a', testDir);
  const stats = mr.getAllMemoryStats({ cwd: testDir });
  assert.strictEqual(stats.totalEntries, 3);
  assert.strictEqual(stats.totalArchived, 1);
  assert.strictEqual(stats.totalBudget, 200);
});

test('getAllMemoryStats: empty channels dir returns zeros', () => {
  const mr = freshModule();
  const stats = mr.getAllMemoryStats({ cwd: testDir });
  assert.strictEqual(stats.channels.length, 0);
  assert.strictEqual(stats.totalEntries, 0);
  assert.strictEqual(stats.totalBudget, 0);
  assert.strictEqual(stats.totalArchived, 0);
});

test('getAllMemoryStats: no channels dir returns zeros', () => {
  const mr = freshModule();
  fs.rmSync(path.join(testDir, '.claude/pilot/memory/channels'), { recursive: true, force: true });
  const stats = mr.getAllMemoryStats({ cwd: testDir });
  assert.deepStrictEqual(stats, { channels: [], totalEntries: 0, totalBudget: 0, totalArchived: 0 });
});

// ============================================================================
// 23. getRelevantMemory (tiered loading from memory.js)
// ============================================================================

console.log('--- getRelevantMemory (tiered loading) ---');

test('getRelevantMemory: scores and filters by threshold', () => {
  const memory = freshModule('memory');
  writeChannel('rel-test', [
    { id: 'd1', lastAccessed: new Date(NOW).toISOString(), accessCount: 10, tags: ['auth'], files: ['src/auth.js'] },
    { id: 'd2', lastAccessed: new Date(NOW - 30 * ONE_DAY_MS).toISOString(), accessCount: 1, tags: ['old'] }
  ]);
  const result = memory.getRelevantMemory(
    { tags: ['auth'], files: ['src/auth.js'] },
    50,
    { cwd: testDir }
  );
  assert.ok(Array.isArray(result), 'should return array');
  for (const entry of result) {
    assert.ok(entry.relevance >= 0.3, `entry ${entry.id} relevance ${entry.relevance} should be >= threshold 0.3`);
  }
});

test('getRelevantMemory: applies tier labels (full/summary)', () => {
  const memory = freshModule('memory');
  writeChannel('tier-test', [
    { id: 't1', lastAccessed: new Date(NOW).toISOString(), accessCount: 10, tags: ['auth'], files: ['src/auth.js'] },
    { id: 't2', lastAccessed: new Date(NOW - 5 * ONE_DAY_MS).toISOString(), accessCount: 3, tags: ['auth'] }
  ]);
  const result = memory.getRelevantMemory(
    { tags: ['auth'], files: ['src/auth.js'] },
    50,
    { cwd: testDir }
  );
  for (const entry of result) {
    assert.ok(
      entry._tier === 'full' || entry._tier === 'summary',
      `entry ${entry.id} should have valid tier label, got ${entry._tier}`
    );
  }
});

test('getRelevantMemory: respects max limit', () => {
  const memory = freshModule('memory');
  writeChannel('many-entries', Array.from({ length: 20 }, (_, i) => ({
    id: `m${i}`,
    lastAccessed: new Date(NOW - i * ONE_DAY_MS).toISOString(),
    accessCount: 20 - i,
    tags: ['test']
  })));
  const result = memory.getRelevantMemory({ tags: ['test'] }, 5, { cwd: testDir });
  assert.ok(result.length <= 5, `should respect limit of 5, got ${result.length}`);
});

test('getRelevantMemory: returns empty for no channels', () => {
  const memory = freshModule('memory');
  const result = memory.getRelevantMemory({ tags: ['auth'] }, 50, { cwd: testDir });
  assert.deepStrictEqual(result, []);
});

test('getRelevantMemory: high-relevance entries get full tier', () => {
  const memory = freshModule('memory');
  writeChannel('high-rel', [
    { id: 'hr1', lastAccessed: new Date(NOW).toISOString(), accessCount: 10, tags: ['auth'], files: ['src/auth.js'] }
  ]);
  const policy = {
    memory: {
      loading: { relevance_threshold: 0.1, max_total_per_load: 50, tier_thresholds: { full: 0.5, summary: 0.2 } },
      relevance_weights: { recency: 0.50, frequency: 0.25, similarity: 0.15, links: 0.10 }
    }
  };
  const result = memory.getRelevantMemory(
    { tags: ['auth'], files: ['src/auth.js'] },
    50,
    { cwd: testDir, policy }
  );
  assert.ok(result.length >= 1, 'should return at least one entry');
  assert.strictEqual(result[0]._tier, 'full', 'high-relevance entry should be full tier');
});

// ============================================================================
// Additional edge cases and constants
// ============================================================================

console.log('--- Additional edge cases ---');

test('DEFAULT_WEIGHTS constant has correct values', () => {
  const mr = freshModule();
  assert.strictEqual(mr.DEFAULT_WEIGHTS.recency, 0.30);
  assert.strictEqual(mr.DEFAULT_WEIGHTS.frequency, 0.25);
  assert.strictEqual(mr.DEFAULT_WEIGHTS.similarity, 0.25);
  assert.strictEqual(mr.DEFAULT_WEIGHTS.links, 0.20);
});

test('RECENCY_HALF_LIFE_MS is 7 days', () => {
  const mr = freshModule();
  assert.strictEqual(mr.RECENCY_HALF_LIFE_MS, 7 * 24 * 60 * 60 * 1000);
});

test('STATE constants are correct', () => {
  const mr = freshModule();
  assert.strictEqual(mr.STATE_FULL, 'full');
  assert.strictEqual(mr.STATE_SUMMARY, 'summary');
  assert.strictEqual(mr.STATE_ARCHIVED, 'archived');
});

test('MS_PER_DAY constant is correct', () => {
  const mr = freshModule();
  assert.strictEqual(mr.MS_PER_DAY, 24 * 60 * 60 * 1000);
});

test('ARCHIVE_DIR constant is correct', () => {
  const mr = freshModule();
  assert.strictEqual(mr.ARCHIVE_DIR, '.claude/pilot/memory/archive');
});

// ============================================================================
// RESULTS
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
