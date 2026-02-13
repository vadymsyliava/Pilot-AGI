/**
 * Tests for Internet Best Practice Verification — Phase 7.4 (Pilot AGI-j482)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/best-practice-gate.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpgate-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/practice-cache'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/souls'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/sessions'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot'), { recursive: true });
  fs.writeFileSync(path.join(testDir, '.claude/pilot/agent-registry.json'), JSON.stringify({
    agents: { frontend: { name: 'Frontend', capabilities: ['styling'] } }
  }, null, 2));

  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModule() {
  const modPaths = ['../best-practice-gate', '../souls', '../policy', '../session', '../memory', '../messaging'];
  for (const modPath of modPaths) {
    try { delete require.cache[require.resolve(modPath)]; } catch (e) {}
  }
  return require('../best-practice-gate');
}

function freshSouls() {
  try { delete require.cache[require.resolve('../souls')]; } catch (e) {}
  return require('../souls');
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  setup();
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  } finally {
    teardown();
  }
}

console.log('\n=== Best Practice Gate Tests ===\n');

// --- classifySource ---

test('classifySource identifies official docs', () => {
  const bp = freshModule();
  assert.strictEqual(bp.classifySource('https://react.dev/reference/react').tier, 1);
  assert.strictEqual(bp.classifySource('https://docs.github.com/en/rest').tier, 1);
  assert.strictEqual(bp.classifySource('https://nodejs.org/api/fs.html').tier, 1);
});

test('classifySource identifies reputable blogs', () => {
  const bp = freshModule();
  assert.strictEqual(bp.classifySource('https://blog.vercel.com/post').tier, 2);
  assert.strictEqual(bp.classifySource('https://dev.to/user/article').tier, 2);
});

test('classifySource identifies Stack Overflow', () => {
  const bp = freshModule();
  assert.strictEqual(bp.classifySource('https://stackoverflow.com/questions/123').tier, 3);
});

test('classifySource identifies community sources', () => {
  const bp = freshModule();
  assert.strictEqual(bp.classifySource('https://reddit.com/r/webdev').tier, 4);
});

test('classifySource returns unknown for unrecognized', () => {
  const bp = freshModule();
  assert.strictEqual(bp.classifySource('https://random-site.xyz/post').tier, 5);
  assert.strictEqual(bp.classifySource(null).tier, 5);
});

// --- cachePractice / getCachedPractice ---

test('cachePractice stores and getCachedPractice retrieves', () => {
  const bp = freshModule();
  bp.cachePractice('state management for React', {
    recommendation: 'Use Zustand for simple state, Redux for complex',
    sources: [{ url: 'https://react.dev/learn/managing-state' }]
  });

  const cached = bp.getCachedPractice('state management for React');
  assert.ok(cached);
  assert.ok(cached.recommendation.includes('Zustand'));
  assert.strictEqual(cached.sources.length, 1);
  assert.strictEqual(cached.sources[0].quality.tier, 1);
});

test('getCachedPractice returns null for uncached topic', () => {
  const bp = freshModule();
  assert.strictEqual(bp.getCachedPractice('nonexistent topic'), null);
});

test('getCachedPractice returns null for expired cache', () => {
  const bp = freshModule();
  // Write directly with old date
  const key = bp.cacheKey('old topic');
  const dir = path.join(process.cwd(), bp.PRACTICE_CACHE_DIR);
  const oldDate = new Date(Date.now() - (bp.CACHE_TTL_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(
    path.join(dir, `${key}.json`),
    JSON.stringify({ topic: 'old topic', cached_at: oldDate, recommendation: 'old' })
  );

  assert.strictEqual(bp.getCachedPractice('old topic'), null);
});

// --- cacheKey ---

test('cacheKey normalizes topic strings', () => {
  const bp = freshModule();
  assert.strictEqual(bp.cacheKey('State Management for React'), 'state-management-for-react');
  assert.strictEqual(bp.cacheKey('Use Zod!!! vs Yup???'), 'use-zod-vs-yup');
});

// --- Rate limiting ---

test('recordSearch tracks per-task counts', () => {
  const bp = freshModule();
  const r1 = bp.recordSearch('T-001');
  assert.ok(r1.allowed);
  assert.strictEqual(r1.count, 1);

  const r2 = bp.recordSearch('T-001');
  assert.ok(r2.allowed);
  assert.strictEqual(r2.count, 2);
});

test('recordSearch enforces MAX_SEARCHES_PER_TASK', () => {
  const bp = freshModule();
  for (let i = 0; i < bp.MAX_SEARCHES_PER_TASK; i++) {
    bp.recordSearch('T-002');
  }
  const result = bp.recordSearch('T-002');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.count, bp.MAX_SEARCHES_PER_TASK);
});

test('getSearchCount returns 0 for new task', () => {
  const bp = freshModule();
  assert.strictEqual(bp.getSearchCount('T-new'), 0);
});

// --- checkDecision ---

test('checkDecision returns cached data if available', () => {
  const bp = freshModule();
  bp.cachePractice('testing library choice', {
    recommendation: 'Use Vitest for unit tests',
    sources: [{ url: 'https://vitejs.dev/guide/' }]
  });

  const result = bp.checkDecision('testing library choice', 'T-001');
  assert.ok(result.verified);
  assert.ok(result.cached);
  assert.ok(result.data.recommendation.includes('Vitest'));
});

test('checkDecision returns needs_search if not cached', () => {
  const bp = freshModule();
  const result = bp.checkDecision('orm choice for node', 'T-001');
  assert.strictEqual(result.verified, false);
  assert.strictEqual(result.needs_search, true);
  assert.strictEqual(result.rate_limited, false);
});

test('checkDecision returns rate_limited when exceeded', () => {
  const bp = freshModule();
  for (let i = 0; i < bp.MAX_SEARCHES_PER_TASK; i++) {
    bp.recordSearch('T-003');
  }

  const result = bp.checkDecision('any topic', 'T-003');
  assert.strictEqual(result.rate_limited, true);
  assert.strictEqual(result.searches_remaining, 0);
});

test('checkDecision requires topic', () => {
  const bp = freshModule();
  const result = bp.checkDecision(null, 'T-001');
  assert.strictEqual(result.verified, false);
});

// --- recordVerification ---

test('recordVerification caches and writes citation to soul', () => {
  const bp = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  const result = bp.recordVerification(
    'form validation library',
    'T-001',
    'frontend',
    {
      recommendation: 'Use Zod for schema validation',
      sources: [{ url: 'https://zod.dev', title: 'Zod Documentation' }]
    }
  );

  assert.ok(result.success);
  assert.ok(result.cached);
  assert.ok(result.confidence > 0);

  // Check cache
  const cached = bp.getCachedPractice('form validation library');
  assert.ok(cached);

  // Check soul has citation
  const soul = souls.loadSoul('frontend');
  assert.ok(soul.decision_rules.some(r => r.area === 'best-practice' && r.rule.includes('Zod')));
});

test('recordVerification requires topic and recommendation', () => {
  const bp = freshModule();
  assert.strictEqual(bp.recordVerification(null, 'T-001', 'frontend', {}).success, false);
  assert.strictEqual(bp.recordVerification('topic', 'T-001', 'frontend', {}).success, false);
});

// --- calculateConfidence ---

test('calculateConfidence scores based on source quality', () => {
  const bp = freshModule();

  const highConf = bp.calculateConfidence([
    { url: 'https://react.dev/docs' },
    { url: 'https://nodejs.org/api' }
  ]);
  assert.ok(highConf >= 0.9);

  const medConf = bp.calculateConfidence([
    { url: 'https://dev.to/article' }
  ]);
  assert.ok(medConf >= 0.5 && medConf < 0.9);

  const lowConf = bp.calculateConfidence([
    { url: 'https://some-unknown-site.xyz/post' }
  ]);
  assert.ok(lowConf < 0.5);
});

test('calculateConfidence returns 0.5 for no sources', () => {
  const bp = freshModule();
  assert.strictEqual(bp.calculateConfidence([]), 0.5);
});

// --- checkContradiction ---

test('checkContradiction detects potential contradictions', () => {
  const bp = freshModule();
  bp.cachePractice('css approach', {
    recommendation: 'Use CSS Modules for component scoping',
    sources: [{ url: 'https://nextjs.org/docs' }]
  });

  const result = bp.checkContradiction('css approach', 'Avoid CSS Modules, use Tailwind instead');
  assert.ok(result);
  assert.ok(result.contradicts);
});

test('checkContradiction returns null for uncached topic', () => {
  const bp = freshModule();
  assert.strictEqual(bp.checkContradiction('unknown topic', 'any approach'), null);
});

test('checkContradiction returns no contradiction for similar approach', () => {
  const bp = freshModule();
  bp.cachePractice('testing framework', {
    recommendation: 'Use Vitest for fast unit testing',
    sources: [{ url: 'https://vitest.dev' }]
  });

  const result = bp.checkContradiction('testing framework', 'Use Vitest for unit testing');
  assert.ok(result);
  assert.strictEqual(result.contradicts, false);
});

// --- listCachedPractices ---

test('listCachedPractices returns all cached items', () => {
  const bp = freshModule();
  bp.cachePractice('topic 1', { recommendation: 'rec 1', sources: [] });
  bp.cachePractice('topic 2', { recommendation: 'rec 2', sources: [{ url: 'https://x.com' }] });

  const list = bp.listCachedPractices();
  assert.strictEqual(list.length, 2);
  assert.ok(list.some(l => l.topic === 'topic 1'));
  assert.ok(list.some(l => l.topic === 'topic 2'));
});

// --- getVerificationLog ---

test('getVerificationLog tracks verifications', () => {
  const bp = freshModule();
  const souls = freshSouls();
  souls.initializeSoul('frontend');

  bp.recordVerification('topic A', 'T-001', 'frontend', {
    recommendation: 'Use X',
    sources: [{ url: 'https://docs.example.com' }]
  });

  const log = bp.getVerificationLog();
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].topic, 'topic A');
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
