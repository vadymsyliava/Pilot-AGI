/**
 * Internet Best Practice Verification — Phase 7.4 (Pilot AGI-j482)
 *
 * Decision gate that validates technical decisions against web-sourced
 * best practices before implementation. Caches results, tracks citations,
 * and rate-limits searches per task.
 *
 * Flow:
 * 1. Agent proposes a technical decision (library, pattern, approach)
 * 2. Gate checks cache for existing verification
 * 3. If not cached, records a "needs verification" marker
 * 4. Agent (or PM) can verify via web search and record the result
 * 5. Verified practices cached in shared memory for reuse
 *
 * Note: This module doesn't perform web searches itself — it provides
 * the framework for agents to record and consume verified practices.
 * Actual web searching is done by the agent via WebSearch tool.
 */

const fs = require('fs');
const path = require('path');

const PRACTICE_CACHE_DIR = '.claude/pilot/state/practice-cache';
const VERIFICATION_LOG = '.claude/pilot/state/practice-cache/verification-log.jsonl';
const MAX_SEARCHES_PER_TASK = 5;
const CACHE_TTL_DAYS = 30;

// =============================================================================
// SOURCE QUALITY TIERS
// =============================================================================

const SOURCE_QUALITY = {
  OFFICIAL_DOCS: { tier: 1, label: 'official_docs', weight: 1.0 },
  REPUTABLE_BLOG: { tier: 2, label: 'reputable_blog', weight: 0.8 },
  STACK_OVERFLOW: { tier: 3, label: 'stack_overflow', weight: 0.6 },
  COMMUNITY: { tier: 4, label: 'community', weight: 0.4 },
  UNKNOWN: { tier: 5, label: 'unknown', weight: 0.3 }
};

/**
 * Classify a URL's source quality tier.
 */
function classifySource(url) {
  if (!url) return SOURCE_QUALITY.UNKNOWN;

  const lower = url.toLowerCase();

  // Official docs
  const officialDomains = [
    'docs.', 'developer.', 'nodejs.org', 'typescriptlang.org',
    'react.dev', 'nextjs.org', 'vitejs.dev', 'tailwindcss.com',
    'prisma.io/docs', 'zod.dev', 'github.com', 'mdn.', 'w3.org',
    'postgresql.org/docs', 'redis.io/docs', 'docker.com/docs'
  ];
  if (officialDomains.some(d => lower.includes(d))) {
    return SOURCE_QUALITY.OFFICIAL_DOCS;
  }

  // Reputable blogs / platforms
  const reputableDomains = [
    'blog.', 'engineering.', 'medium.com', 'dev.to',
    'css-tricks.com', 'smashingmagazine.com', 'web.dev',
    'kentcdodds.com', 'tkdodo.eu', 'joshwcomeau.com'
  ];
  if (reputableDomains.some(d => lower.includes(d))) {
    return SOURCE_QUALITY.REPUTABLE_BLOG;
  }

  // Stack Overflow
  if (lower.includes('stackoverflow.com') || lower.includes('stackexchange.com')) {
    return SOURCE_QUALITY.STACK_OVERFLOW;
  }

  // Community sources
  if (lower.includes('reddit.com') || lower.includes('twitter.com') || lower.includes('x.com')) {
    return SOURCE_QUALITY.COMMUNITY;
  }

  return SOURCE_QUALITY.UNKNOWN;
}

// =============================================================================
// PRACTICE CACHE
// =============================================================================

function getCacheDir() {
  return path.join(process.cwd(), PRACTICE_CACHE_DIR);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Generate a cache key from a decision topic.
 */
function cacheKey(topic) {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/**
 * Look up a cached best practice verification.
 * Returns null if not cached or expired.
 */
function getCachedPractice(topic) {
  const key = cacheKey(topic);
  const filePath = path.join(getCacheDir(), `${key}.json`);

  if (!fs.existsSync(filePath)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    // Check TTL
    const age = (Date.now() - new Date(data.cached_at).getTime()) / (1000 * 60 * 60 * 24);
    if (age > CACHE_TTL_DAYS) {
      return null; // Expired
    }

    return data;
  } catch (e) {
    return null;
  }
}

/**
 * Cache a verified best practice.
 *
 * @param {string} topic - Decision topic (e.g., "state management library for React")
 * @param {object} verification - { recommendation, sources[], contradiction?, confidence }
 */
function cachePractice(topic, verification) {
  const dir = getCacheDir();
  ensureDir(dir);

  const key = cacheKey(topic);
  const filePath = path.join(dir, `${key}.json`);

  const record = {
    topic,
    key,
    cached_at: new Date().toISOString(),
    recommendation: verification.recommendation,
    sources: (verification.sources || []).map(s => ({
      url: s.url,
      title: s.title || null,
      quality: classifySource(s.url)
    })),
    contradiction: verification.contradiction || null,
    confidence: verification.confidence || 0.7,
    hit_count: 0
  };

  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);

  return record;
}

/**
 * Record a cache hit (for usage tracking).
 */
function recordCacheHit(topic) {
  const key = cacheKey(topic);
  const filePath = path.join(getCacheDir(), `${key}.json`);

  if (!fs.existsSync(filePath)) return;

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.hit_count = (data.hit_count || 0) + 1;
    data.last_hit = new Date().toISOString();
    const tmpPath = filePath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    // Best effort
  }
}

// =============================================================================
// RATE LIMITING
// =============================================================================

/**
 * Check how many web searches have been used for a task.
 */
function getSearchCount(taskId) {
  const logPath = path.join(getCacheDir(), 'search-counts.json');

  if (!fs.existsSync(logPath)) return 0;

  try {
    const counts = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    return counts[taskId] || 0;
  } catch (e) {
    return 0;
  }
}

/**
 * Increment search count for a task. Returns whether the search is allowed.
 */
function recordSearch(taskId) {
  const dir = getCacheDir();
  ensureDir(dir);
  const logPath = path.join(dir, 'search-counts.json');

  let counts = {};
  if (fs.existsSync(logPath)) {
    try {
      counts = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    } catch (e) {
      counts = {};
    }
  }

  const current = counts[taskId] || 0;
  if (current >= MAX_SEARCHES_PER_TASK) {
    return { allowed: false, count: current, limit: MAX_SEARCHES_PER_TASK };
  }

  counts[taskId] = current + 1;
  const tmpPath = logPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(counts, null, 2), 'utf8');
  fs.renameSync(tmpPath, logPath);

  return { allowed: true, count: current + 1, limit: MAX_SEARCHES_PER_TASK };
}

// =============================================================================
// DECISION GATE
// =============================================================================

/**
 * Check if a technical decision needs verification.
 * Returns verification result from cache, or a "needs verification" marker.
 *
 * @param {string} topic - Decision topic
 * @param {string} taskId - Current task ID (for rate limiting)
 * @returns {{ verified, cached, data?, needs_search?, rate_limited? }}
 */
function checkDecision(topic, taskId) {
  if (!topic) {
    return { verified: false, error: 'topic required' };
  }

  // Check cache first
  const cached = getCachedPractice(topic);
  if (cached) {
    recordCacheHit(topic);
    return {
      verified: true,
      cached: true,
      data: {
        recommendation: cached.recommendation,
        sources: cached.sources,
        contradiction: cached.contradiction,
        confidence: cached.confidence
      }
    };
  }

  // Not cached — check rate limit
  const searchCount = getSearchCount(taskId);
  if (searchCount >= MAX_SEARCHES_PER_TASK) {
    return {
      verified: false,
      cached: false,
      needs_search: true,
      rate_limited: true,
      searches_remaining: 0
    };
  }

  return {
    verified: false,
    cached: false,
    needs_search: true,
    rate_limited: false,
    searches_remaining: MAX_SEARCHES_PER_TASK - searchCount
  };
}

/**
 * Record a verification result after web search.
 * Caches the practice and writes a citation to the soul.
 *
 * @param {string} topic - Decision topic
 * @param {string} taskId - Task that triggered the search
 * @param {string} role - Agent role (for soul citation)
 * @param {object} result - { recommendation, sources[], contradiction? }
 */
function recordVerification(topic, taskId, role, result) {
  if (!topic || !result || !result.recommendation) {
    return { success: false, error: 'topic and result.recommendation required' };
  }

  // Record the search against rate limit
  const rateResult = recordSearch(taskId);

  // Cache the practice
  const confidence = calculateConfidence(result.sources || []);
  const cached = cachePractice(topic, {
    ...result,
    confidence
  });

  // Write citation to soul as a decision rule (if high confidence)
  if (role && confidence >= 0.6) {
    try {
      const souls = require('./souls');
      const citation = result.sources && result.sources.length > 0
        ? ` [source: ${result.sources[0].url || result.sources[0].title || 'web'}]`
        : '';
      souls.addDecisionRule(role, 'best-practice', `${result.recommendation}${citation}`, confidence);
    } catch (e) {
      // Soul not available
    }
  }

  // Append to verification log
  appendVerificationLog({
    topic,
    task_id: taskId,
    role,
    recommendation: result.recommendation,
    sources: result.sources,
    contradiction: result.contradiction,
    confidence,
    timestamp: new Date().toISOString()
  });

  return {
    success: true,
    cached: true,
    confidence,
    rate_limit: rateResult,
    contradiction: result.contradiction || null
  };
}

// =============================================================================
// CONTRADICTION DETECTION
// =============================================================================

/**
 * Check if a proposed approach contradicts cached best practices.
 *
 * @param {string} topic - The decision area
 * @param {string} proposedApproach - What the agent wants to do
 * @returns {{ contradicts, cached_recommendation?, sources? } | null}
 */
function checkContradiction(topic, proposedApproach) {
  const cached = getCachedPractice(topic);
  if (!cached) return null;

  // Simple keyword overlap check between recommendation and proposal
  const recWords = new Set(
    cached.recommendation.toLowerCase().split(/\s+/).filter(w => w.length > 3)
  );
  const propWords = new Set(
    proposedApproach.toLowerCase().split(/\s+/).filter(w => w.length > 3)
  );

  // Check for negation words that might indicate contradiction
  const negations = ['not', 'avoid', 'never', 'instead', 'rather', 'better'];
  const hasNegation = negations.some(n =>
    proposedApproach.toLowerCase().includes(n) &&
    cached.recommendation.toLowerCase().includes(n) === false
  );

  // Check if proposal mentions something different from recommendation
  const overlap = [...recWords].filter(w => propWords.has(w)).length;
  const similarity = recWords.size > 0 ? overlap / recWords.size : 0;

  if (hasNegation || similarity < 0.2) {
    return {
      contradicts: true,
      cached_recommendation: cached.recommendation,
      sources: cached.sources
    };
  }

  return { contradicts: false };
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Calculate confidence based on source quality.
 */
function calculateConfidence(sources) {
  if (!sources || sources.length === 0) return 0.5;

  const qualities = sources.map(s => {
    const quality = classifySource(s.url);
    return quality.weight;
  });

  // Average quality weight, boosted by number of sources
  const avgWeight = qualities.reduce((a, b) => a + b, 0) / qualities.length;
  const sourceBoost = Math.min(0.2, sources.length * 0.05);

  return Math.min(1.0, Math.round((avgWeight + sourceBoost) * 100) / 100);
}

function appendVerificationLog(entry) {
  const dir = getCacheDir();
  ensureDir(dir);
  const logPath = path.join(process.cwd(), VERIFICATION_LOG);
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

/**
 * List all cached practices.
 */
function listCachedPractices() {
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && f !== 'search-counts.json')
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return {
          topic: data.topic,
          recommendation: data.recommendation,
          confidence: data.confidence,
          sources: (data.sources || []).length,
          hit_count: data.hit_count || 0,
          cached_at: data.cached_at
        };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Get verification log entries.
 */
function getVerificationLog(limit) {
  const logPath = path.join(process.cwd(), VERIFICATION_LOG);
  if (!fs.existsSync(logPath)) return [];

  try {
    const entries = fs.readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));

    return limit ? entries.slice(-limit) : entries;
  } catch (e) {
    return [];
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Decision gate
  checkDecision,
  recordVerification,
  checkContradiction,

  // Cache
  getCachedPractice,
  cachePractice,
  listCachedPractices,
  cacheKey,

  // Rate limiting
  getSearchCount,
  recordSearch,

  // Source quality
  classifySource,
  calculateConfidence,

  // Logging
  getVerificationLog,

  // Constants
  SOURCE_QUALITY,
  MAX_SEARCHES_PER_TASK,
  CACHE_TTL_DAYS,
  PRACTICE_CACHE_DIR
};
