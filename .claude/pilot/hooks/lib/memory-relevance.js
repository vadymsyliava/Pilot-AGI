/**
 * Memory Relevance Scorer — Phase 5.7
 *
 * Scores memory entries 0.0–1.0 based on:
 *   - Recency: exponential decay from last access/update
 *   - Frequency: access count relative to total accesses
 *   - Similarity: overlap between entry tags/files and current task context
 *   - Links: cross-references from other entries/channels
 *
 * Configurable weights in policy.yaml under memory.relevance_weights.
 */

const fs = require('fs');
const path = require('path');

// =============================================================================
// DEFAULTS
// =============================================================================

const DEFAULT_WEIGHTS = {
  recency: 0.30,
  frequency: 0.25,
  similarity: 0.25,
  links: 0.20
};

// Half-life for recency decay (7 days in milliseconds)
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

// =============================================================================
// WEIGHT LOADING
// =============================================================================

/**
 * Load relevance weights from policy.yaml.
 * Falls back to defaults if not configured.
 *
 * @param {object} [policy] - Pre-loaded policy object (avoids re-reading file)
 * @returns {{ recency: number, frequency: number, similarity: number, links: number }}
 */
function loadWeights(policy) {
  if (!policy) {
    try {
      const { loadPolicy } = require('./policy');
      policy = loadPolicy();
    } catch (e) {
      return { ...DEFAULT_WEIGHTS };
    }
  }

  const configured = policy.memory && policy.memory.relevance_weights;
  if (!configured) return { ...DEFAULT_WEIGHTS };

  return {
    recency: typeof configured.recency === 'number' ? configured.recency : DEFAULT_WEIGHTS.recency,
    frequency: typeof configured.frequency === 'number' ? configured.frequency : DEFAULT_WEIGHTS.frequency,
    similarity: typeof configured.similarity === 'number' ? configured.similarity : DEFAULT_WEIGHTS.similarity,
    links: typeof configured.links === 'number' ? configured.links : DEFAULT_WEIGHTS.links
  };
}

// =============================================================================
// INDIVIDUAL SCORERS
// =============================================================================

/**
 * Score recency using exponential decay.
 * Score = 2^(-age / halfLife)
 * - Just updated → ~1.0
 * - 7 days old → ~0.5
 * - 14 days old → ~0.25
 *
 * @param {string|Date} lastAccessed - ISO timestamp or Date of last access
 * @param {number} [now] - Current time in ms (default: Date.now())
 * @returns {number} 0.0–1.0
 */
function scoreRecency(lastAccessed, now) {
  if (!lastAccessed) return 0;
  now = now || Date.now();

  const accessTime = typeof lastAccessed === 'string' ? new Date(lastAccessed).getTime() : lastAccessed.getTime();
  if (isNaN(accessTime)) return 0;

  const ageMs = Math.max(0, now - accessTime);
  return Math.pow(2, -ageMs / RECENCY_HALF_LIFE_MS);
}

/**
 * Score frequency based on access count relative to total.
 * Uses logarithmic scaling to avoid runaway scores for hot entries.
 * Score = log(1 + accessCount) / log(1 + maxAccessCount)
 *
 * @param {number} accessCount - Number of times this entry was accessed
 * @param {number} maxAccessCount - Highest access count across all entries
 * @returns {number} 0.0–1.0
 */
function scoreFrequency(accessCount, maxAccessCount) {
  if (!accessCount || accessCount <= 0) return 0;
  if (!maxAccessCount || maxAccessCount <= 0) return 0;

  const numerator = Math.log(1 + accessCount);
  const denominator = Math.log(1 + maxAccessCount);
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * Score task similarity based on overlap between entry metadata and task context.
 * Computes Jaccard-like similarity over tags and files.
 *
 * @param {object} entry - Memory entry with optional tags[] and files[]
 * @param {object} taskContext - Current task context with optional tags[] and files[]
 * @returns {number} 0.0–1.0
 */
function scoreSimilarity(entry, taskContext) {
  if (!entry || !taskContext) return 0;

  const entryTags = new Set((entry.tags || []).map(t => t.toLowerCase()));
  const entryFiles = new Set((entry.files || []).map(f => f.toLowerCase()));
  const taskTags = new Set((taskContext.tags || []).map(t => t.toLowerCase()));
  const taskFiles = new Set((taskContext.files || []).map(f => f.toLowerCase()));

  let tagScore = 0;
  let fileScore = 0;

  // Tag overlap (Jaccard)
  if (entryTags.size > 0 || taskTags.size > 0) {
    const intersection = [...entryTags].filter(t => taskTags.has(t)).length;
    const union = new Set([...entryTags, ...taskTags]).size;
    tagScore = union > 0 ? intersection / union : 0;
  }

  // File overlap (Jaccard)
  if (entryFiles.size > 0 || taskFiles.size > 0) {
    const intersection = [...entryFiles].filter(f => taskFiles.has(f)).length;
    const union = new Set([...entryFiles, ...taskFiles]).size;
    fileScore = union > 0 ? intersection / union : 0;
  }

  // Weight tags and files equally when both exist
  const hasTagData = entryTags.size > 0 || taskTags.size > 0;
  const hasFileData = entryFiles.size > 0 || taskFiles.size > 0;

  if (hasTagData && hasFileData) return (tagScore + fileScore) / 2;
  if (hasTagData) return tagScore;
  if (hasFileData) return fileScore;
  return 0;
}

/**
 * Score links based on how many other entries reference this entry.
 * Normalized against the maximum link count.
 *
 * @param {number} linkCount - Number of inbound references to this entry
 * @param {number} maxLinkCount - Highest link count across all entries
 * @returns {number} 0.0–1.0
 */
function scoreLinks(linkCount, maxLinkCount) {
  if (!linkCount || linkCount <= 0) return 0;
  if (!maxLinkCount || maxLinkCount <= 0) return 0;

  return Math.min(1.0, linkCount / maxLinkCount);
}

// =============================================================================
// COMPOSITE SCORING
// =============================================================================

/**
 * Compute composite relevance score for a single entry.
 *
 * @param {object} entry - Memory entry
 * @param {object} context - { taskContext, maxAccessCount, maxLinkCount, now }
 * @param {object} [weights] - Weight overrides
 * @returns {number} 0.0–1.0
 */
function scoreEntry(entry, context, weights) {
  const w = weights || loadWeights();
  const now = context.now || Date.now();

  const recency = scoreRecency(entry.lastAccessed || entry.updatedAt || entry.publishedAt, now);
  const frequency = scoreFrequency(entry.accessCount || 0, context.maxAccessCount || 1);
  const similarity = scoreSimilarity(entry, context.taskContext || {});
  const links = scoreLinks(entry.linkCount || 0, context.maxLinkCount || 1);

  const score = (w.recency * recency) +
                (w.frequency * frequency) +
                (w.similarity * similarity) +
                (w.links * links);

  return {
    score: Math.min(1.0, Math.max(0.0, score)),
    breakdown: { recency, frequency, similarity, links }
  };
}

// =============================================================================
// BATCH SCORING
// =============================================================================

/**
 * Score and sort a list of memory entries by relevance.
 * Returns entries sorted by score descending, each augmented with .relevance.
 *
 * @param {Array} entries - Array of memory entries
 * @param {object} [taskContext] - Current task context { tags: [], files: [] }
 * @param {object} [opts] - { policy, now, limit }
 * @returns {Array} Scored entries sorted by relevance (descending)
 */
function scoreEntries(entries, taskContext, opts = {}) {
  if (!entries || entries.length === 0) return [];

  const weights = loadWeights(opts.policy);
  const now = opts.now || Date.now();

  // Compute normalization factors
  const maxAccessCount = entries.reduce((max, e) => Math.max(max, e.accessCount || 0), 0);
  const maxLinkCount = entries.reduce((max, e) => Math.max(max, e.linkCount || 0), 0);

  const context = {
    taskContext: taskContext || {},
    maxAccessCount: Math.max(1, maxAccessCount),
    maxLinkCount: Math.max(1, maxLinkCount),
    now
  };

  const scored = entries.map(entry => {
    const result = scoreEntry(entry, context, weights);
    return {
      ...entry,
      relevance: result.score,
      relevanceBreakdown: result.breakdown
    };
  });

  // Sort by relevance descending
  scored.sort((a, b) => b.relevance - a.relevance);

  // Apply limit if requested
  if (opts.limit && opts.limit > 0) {
    return scored.slice(0, opts.limit);
  }

  return scored;
}

/**
 * Score entries from a channel file.
 * Reads the channel, extracts data entries, scores them.
 *
 * @param {string} channel - Channel name
 * @param {object} [taskContext] - Task context for similarity scoring
 * @param {object} [opts] - { cwd, policy, now, limit }
 * @returns {Array} Scored entries
 */
function scoreChannel(channel, taskContext, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const channelPath = path.join(cwd, '.claude/pilot/memory/channels', `${channel}.json`);

  if (!fs.existsSync(channelPath)) return [];

  try {
    const envelope = JSON.parse(fs.readFileSync(channelPath, 'utf8'));
    const data = envelope.data;

    // Channel data may be an array of entries or an object with entries
    let entries;
    if (Array.isArray(data)) {
      entries = data;
    } else if (data && typeof data === 'object') {
      // Look for the first array property in data
      const arrayKey = Object.keys(data).find(k => Array.isArray(data[k]));
      entries = arrayKey ? data[arrayKey] : [data];
    } else {
      return [];
    }

    // Augment entries with channel metadata if missing timestamps
    entries = entries.map(entry => ({
      ...entry,
      _channel: channel,
      lastAccessed: entry.lastAccessed || entry.updatedAt || entry.ts || envelope.publishedAt,
      updatedAt: entry.updatedAt || entry.ts || envelope.publishedAt
    }));

    return scoreEntries(entries, taskContext, opts);
  } catch (e) {
    return [];
  }
}

/**
 * Score entries from all channels.
 *
 * @param {object} [taskContext] - Task context for similarity scoring
 * @param {object} [opts] - { cwd, policy, now, limit }
 * @returns {Array} Scored entries across all channels, sorted by relevance
 */
function scoreAllChannels(taskContext, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const channelsDir = path.join(cwd, '.claude/pilot/memory/channels');

  if (!fs.existsSync(channelsDir)) return [];

  try {
    const files = fs.readdirSync(channelsDir).filter(f => f.endsWith('.json'));
    let allEntries = [];

    for (const file of files) {
      const channel = file.replace('.json', '');
      const entries = scoreChannel(channel, taskContext, { ...opts, limit: 0 });
      allEntries.push(...entries);
    }

    // Re-sort all entries across channels
    allEntries.sort((a, b) => b.relevance - a.relevance);

    if (opts.limit && opts.limit > 0) {
      return allEntries.slice(0, opts.limit);
    }

    return allEntries;
  } catch (e) {
    return [];
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Weight management
  loadWeights,
  DEFAULT_WEIGHTS,

  // Individual scorers
  scoreRecency,
  scoreFrequency,
  scoreSimilarity,
  scoreLinks,

  // Composite scoring
  scoreEntry,
  scoreEntries,

  // Channel-level scoring
  scoreChannel,
  scoreAllChannels,

  // Constants
  RECENCY_HALF_LIFE_MS
};
