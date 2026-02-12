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
// SUMMARIZATION PIPELINE — Phase 5.7 (f6e.2)
// =============================================================================

// Entry states
const STATE_FULL = 'full';
const STATE_SUMMARY = 'summary';
const STATE_ARCHIVED = 'archived';

const ARCHIVE_DIR = '.claude/pilot/memory/archive';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Load summarization config from policy.
 *
 * @param {object} [policy] - Pre-loaded policy object
 * @returns {object} Summarization config
 */
function loadSummarizationConfig(policy) {
  if (!policy) {
    try {
      const { loadPolicy } = require('./policy');
      policy = loadPolicy();
    } catch (e) {
      // fall through to defaults
    }
  }

  const defaults = {
    full_fidelity_threshold: 0.6,
    summary_after_days: 7,
    archive_after_days: 30,
    max_summary_length: 500,
    min_entries_for_consolidation: 20
  };

  const configured = policy && policy.memory && policy.memory.summarization;
  if (!configured) return defaults;

  return {
    full_fidelity_threshold: typeof configured.full_fidelity_threshold === 'number'
      ? configured.full_fidelity_threshold : defaults.full_fidelity_threshold,
    summary_after_days: typeof configured.summary_after_days === 'number'
      ? configured.summary_after_days : defaults.summary_after_days,
    archive_after_days: typeof configured.archive_after_days === 'number'
      ? configured.archive_after_days : defaults.archive_after_days,
    max_summary_length: typeof configured.max_summary_length === 'number'
      ? configured.max_summary_length : defaults.max_summary_length,
    min_entries_for_consolidation: typeof configured.min_entries_for_consolidation === 'number'
      ? configured.min_entries_for_consolidation : defaults.min_entries_for_consolidation
  };
}

/**
 * Determine the lifecycle state an entry should transition to.
 *
 * @param {object} entry - Memory entry (must have relevance score and lastAccessed)
 * @param {object} config - Summarization config
 * @param {number} [now] - Current time ms
 * @returns {string|null} Target state ('summary', 'archived') or null (no change)
 */
function getTargetState(entry, config, now) {
  now = now || Date.now();
  const currentState = entry._state || STATE_FULL;
  const lastAccessed = entry.lastAccessed || entry.updatedAt || entry.ts;
  if (!lastAccessed) return null;

  const accessTime = new Date(lastAccessed).getTime();
  if (isNaN(accessTime)) return null;

  const ageDays = (now - accessTime) / MS_PER_DAY;
  const belowThreshold = typeof entry.relevance === 'number'
    && entry.relevance < config.full_fidelity_threshold;

  if (currentState === STATE_FULL && belowThreshold && ageDays >= config.summary_after_days) {
    return STATE_SUMMARY;
  }

  if (currentState === STATE_SUMMARY && belowThreshold && ageDays >= config.archive_after_days) {
    return STATE_ARCHIVED;
  }

  return null;
}

/**
 * Summarize an entry using truncation + key extraction.
 * No LLM — deterministic extraction.
 *
 * @param {object} entry - Full memory entry
 * @param {number} maxLength - Maximum summary character length
 * @returns {object} Summarized entry
 */
function summarizeEntry(entry, maxLength) {
  maxLength = maxLength || 500;

  // Extract key fields to preserve
  const keyFields = {};
  const preserveKeys = ['id', '_channel', 'tags', 'files', 'type', 'action',
    'decision', 'error_type', 'task_id', 'accessCount', 'linkCount'];

  for (const key of preserveKeys) {
    if (entry[key] !== undefined) {
      keyFields[key] = entry[key];
    }
  }

  // Build summary text from significant string fields
  const textParts = [];
  const textKeys = ['reason', 'description', 'summary', 'context', 'resolution', 'content'];
  for (const key of textKeys) {
    if (typeof entry[key] === 'string' && entry[key].length > 0) {
      textParts.push(entry[key]);
    }
  }

  let summaryText = textParts.join(' | ');
  if (summaryText.length > maxLength) {
    summaryText = summaryText.slice(0, maxLength - 3) + '...';
  }

  return {
    ...keyFields,
    _state: STATE_SUMMARY,
    _summarizedAt: new Date().toISOString(),
    _originalKeys: Object.keys(entry).filter(k => !k.startsWith('_')),
    summary: summaryText,
    lastAccessed: entry.lastAccessed || entry.updatedAt || entry.ts,
    updatedAt: entry.updatedAt || entry.ts
  };
}

/**
 * Archive an entry — move it to the archive directory.
 *
 * @param {object} entry - Entry to archive (should be in 'summary' state)
 * @param {string} channel - Source channel name
 * @param {string} [cwd] - Working directory
 * @returns {object} Archived entry metadata
 */
function archiveEntry(entry, channel, cwd) {
  cwd = cwd || process.cwd();
  const archiveDir = path.join(cwd, ARCHIVE_DIR, channel);

  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const archivedEntry = {
    ...entry,
    _state: STATE_ARCHIVED,
    _archivedAt: new Date().toISOString(),
    _sourceChannel: channel
  };

  // Append to channel archive file (JSONL)
  const archivePath = path.join(archiveDir, 'entries.jsonl');
  fs.appendFileSync(archivePath, JSON.stringify(archivedEntry) + '\n');

  return {
    id: entry.id || entry._channel,
    channel,
    archivedAt: archivedEntry._archivedAt,
    archivePath
  };
}

/**
 * Run consolidation pass on a list of scored entries.
 * Transitions entries through full → summary → archived based on config rules.
 *
 * @param {Array} scoredEntries - Entries with .relevance scores
 * @param {string} channel - Channel name (for archiving)
 * @param {object} [opts] - { policy, now, cwd, dryRun }
 * @returns {{ kept: Array, summarized: Array, archived: Array }}
 */
function consolidate(scoredEntries, channel, opts = {}) {
  const config = loadSummarizationConfig(opts.policy);
  const now = opts.now || Date.now();
  const cwd = opts.cwd || process.cwd();
  const dryRun = opts.dryRun || false;

  if (scoredEntries.length < config.min_entries_for_consolidation) {
    return { kept: scoredEntries, summarized: [], archived: [] };
  }

  const kept = [];
  const summarized = [];
  const archived = [];

  for (const entry of scoredEntries) {
    const target = getTargetState(entry, config, now);

    if (target === STATE_ARCHIVED) {
      if (!dryRun) {
        archiveEntry(entry, channel, cwd);
      }
      archived.push(entry);
    } else if (target === STATE_SUMMARY) {
      const summary = summarizeEntry(entry, config.max_summary_length);
      summarized.push(summary);
      kept.push(summary);
    } else {
      kept.push(entry);
    }
  }

  return { kept, summarized, archived };
}

/**
 * Read archived entries for a channel.
 *
 * @param {string} channel - Channel name
 * @param {object} [opts] - { cwd, limit }
 * @returns {Array} Archived entries
 */
function readArchive(channel, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const archivePath = path.join(cwd, ARCHIVE_DIR, channel, 'entries.jsonl');

  if (!fs.existsSync(archivePath)) return [];

  try {
    const content = fs.readFileSync(archivePath, 'utf8').trim();
    if (!content) return [];

    let entries = content.split('\n').map(line => {
      try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(Boolean);

    if (opts.limit && opts.limit > 0) {
      entries = entries.slice(-opts.limit);
    }

    return entries;
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

  // Summarization pipeline
  loadSummarizationConfig,
  getTargetState,
  summarizeEntry,
  archiveEntry,
  consolidate,
  readArchive,

  // Constants
  RECENCY_HALF_LIFE_MS,
  STATE_FULL,
  STATE_SUMMARY,
  STATE_ARCHIVED,
  ARCHIVE_DIR,
  MS_PER_DAY
};
