/**
 * Cross-Project Knowledge Base (Phase 5.8)
 *
 * Shared knowledge across projects at ~/.pilot-agi/knowledge/.
 * Stores anonymized learnings: decomposition templates, failure modes,
 * tech decisions, and cost benchmarks.
 *
 * Directory structure:
 *   ~/.pilot-agi/knowledge/
 *     decomposition-templates/   Successful decomposition patterns
 *     failure-modes/             Common failure patterns and fixes
 *     tech-decisions/            Technology choices and rationale
 *     cost-benchmarks/           Token cost per task type
 *     index.json                 Master index of all knowledge
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// =============================================================================
// CONSTANTS
// =============================================================================

const KNOWLEDGE_TYPES = ['decomposition-templates', 'failure-modes', 'tech-decisions', 'cost-benchmarks'];
const DEFAULT_KNOWLEDGE_PATH = path.join(os.homedir(), '.pilot-agi', 'knowledge');
const INDEX_FILE = 'index.json';
const MAX_ENTRIES_PER_TYPE_DEFAULT = 500;
const PRUNE_AFTER_DAYS_DEFAULT = 90;

// =============================================================================
// PATH HELPERS
// =============================================================================

/**
 * Get the knowledge base root directory.
 * @param {object} [opts] - { knowledgePath }
 * @returns {string}
 */
function getKnowledgeDir(opts) {
  return (opts && opts.knowledgePath) || DEFAULT_KNOWLEDGE_PATH;
}

function getTypeDir(type, opts) {
  return path.join(getKnowledgeDir(opts), type);
}

function getIndexPath(opts) {
  return path.join(getKnowledgeDir(opts), INDEX_FILE);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// =============================================================================
// ATOMIC FILE OPS
// =============================================================================

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    // Corrupted file — start fresh
  }
  return null;
}

function writeJSON(filePath, data) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

// =============================================================================
// INDEX MANAGEMENT
// =============================================================================

/**
 * Load the master index.
 * @param {object} [opts]
 * @returns {{ entries: object[], updated_at: string|null }}
 */
function loadIndex(opts) {
  const idx = readJSON(getIndexPath(opts));
  return idx || { entries: [], updated_at: null };
}

/**
 * Save the master index.
 * @param {object} index
 * @param {object} [opts]
 */
function saveIndex(index, opts) {
  index.updated_at = new Date().toISOString();
  writeJSON(getIndexPath(opts), index);
}

// =============================================================================
// ANONYMIZATION
// =============================================================================

/**
 * Hash a project name for anonymization.
 * @param {string} projectName
 * @returns {string} SHA-256 hex (first 12 chars)
 */
function hashProject(projectName) {
  if (!projectName) return 'unknown';
  return crypto.createHash('sha256').update(projectName).digest('hex').slice(0, 12);
}

/**
 * Anonymize content by stripping file paths, project names, and sensitive data.
 * @param {object} content - Knowledge content object
 * @param {string} [sourceProject] - Project name to hash
 * @param {string} [level] - "full" | "partial" | "none"
 * @returns {object} Anonymized content
 */
function anonymize(content, sourceProject, level) {
  if (level === 'none') return { ...content };

  const result = JSON.parse(JSON.stringify(content));

  // Strip absolute file paths
  const pathRegex = /(?:\/(?:Users|home|var|tmp|opt|etc)\/[^\s"',]+)/g;
  const windowsPathRegex = /(?:[A-Z]:\\[^\s"',]+)/g;

  const sensitivePatterns = [
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/gi, // emails
    /\b(?:sk-|pk-|ghp_|gho_|glpat-|xoxb-|xoxp-)[A-Za-z0-9_-]+\b/g, // API keys
    /\bpassword\s*[:=]\s*['"][^'"]+['"]/gi, // passwords
    /\bsecret\s*[:=]\s*['"][^'"]+['"]/gi, // secrets
    /\btoken\s*[:=]\s*['"][^'"]+['"]/gi, // tokens
  ];

  function scrub(obj) {
    if (typeof obj === 'string') {
      let val = obj;
      val = val.replace(pathRegex, '<path>');
      val = val.replace(windowsPathRegex, '<path>');

      if (level === 'full') {
        for (const pat of sensitivePatterns) {
          val = val.replace(pat, '<redacted>');
        }
        // Replace project name if provided (only match whole word, min 3 chars)
        if (sourceProject && sourceProject.length >= 3) {
          const escaped = sourceProject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          val = val.replace(new RegExp('\\b' + escaped + '\\b', 'gi'), '<project>');
        }
      }
      return val;
    }
    if (Array.isArray(obj)) {
      return obj.map(scrub);
    }
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = scrub(v);
      }
      return out;
    }
    return obj;
  }

  return scrub(result);
}

// =============================================================================
// DEDUPLICATION
// =============================================================================

/**
 * Check if a knowledge entry is a duplicate of existing entries.
 * Uses keyword overlap similarity.
 * @param {object} entry - New entry
 * @param {object[]} existing - Existing entries of same type
 * @param {number} [threshold=0.8] - Similarity threshold for dedup
 * @returns {object|null} Matching entry or null
 */
function findDuplicate(entry, existing, threshold) {
  threshold = threshold || 0.8;

  const entryKeywords = extractKeywords(JSON.stringify(entry.content));
  if (entryKeywords.length === 0) return null;

  for (const ex of existing) {
    const exKeywords = extractKeywords(JSON.stringify(ex.content));
    if (exKeywords.length === 0) continue;

    const overlap = entryKeywords.filter(w => exKeywords.includes(w)).length;
    const similarity = overlap / Math.max(entryKeywords.length, exKeywords.length);

    if (similarity >= threshold) {
      return ex;
    }
  }

  return null;
}

/**
 * Extract keywords from text.
 */
function extractKeywords(text) {
  if (!text) return [];

  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'and',
    'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'each', 'this',
    'that', 'these', 'those', 'it', 'its', 'true', 'false', 'null'
  ]);

  return [...new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s-_]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w))
  )];
}

// =============================================================================
// KNOWLEDGE OPERATIONS
// =============================================================================

/**
 * Publish a knowledge entry to the global knowledge base.
 *
 * @param {string} type - One of KNOWLEDGE_TYPES
 * @param {object} content - Knowledge content
 * @param {string} [sourceProject] - Project name (will be hashed)
 * @param {object} [opts] - { knowledgePath, anonymizeLevel, excludePatterns }
 * @returns {{ id: string, type: string, deduplicated: boolean }}
 */
function publishKnowledge(type, content, sourceProject, opts) {
  opts = opts || {};

  if (!KNOWLEDGE_TYPES.includes(type)) {
    throw new Error(`Invalid knowledge type: ${type}. Must be one of: ${KNOWLEDGE_TYPES.join(', ')}`);
  }

  const knowledgeDir = getKnowledgeDir(opts);
  const typeDir = getTypeDir(type, opts);
  ensureDir(typeDir);

  // Check exclude patterns
  const contentStr = JSON.stringify(content);
  const excludePatterns = opts.excludePatterns || [];
  for (const pattern of excludePatterns) {
    const regex = new RegExp(pattern.replace(/\*/g, '.*'), 'i');
    if (regex.test(contentStr)) {
      return { id: null, type, deduplicated: false, excluded: true };
    }
  }

  // Anonymize
  const anonymizeLevel = opts.anonymizeLevel || 'full';
  const anonymized = anonymize(content, sourceProject, anonymizeLevel);

  // Load index and check for duplicates
  const index = loadIndex(opts);
  const typeEntries = index.entries.filter(e => e.type === type);

  const duplicate = findDuplicate({ content: anonymized }, typeEntries.map(e => {
    const entryPath = path.join(typeDir, `${e.id}.json`);
    const data = readJSON(entryPath);
    return data || { content: {} };
  }));

  if (duplicate) {
    // Update usage count of existing entry
    const existingIdx = index.entries.findIndex(e => e.id === duplicate.id);
    if (existingIdx >= 0) {
      index.entries[existingIdx].usage_count = (index.entries[existingIdx].usage_count || 0) + 1;
      index.entries[existingIdx].updated_at = new Date().toISOString();
      saveIndex(index, opts);
    }
    return { id: duplicate.id, type, deduplicated: true };
  }

  // Create new entry
  const id = crypto.randomBytes(8).toString('hex');
  const entry = {
    id,
    type,
    content: anonymized,
    source_project_hash: hashProject(sourceProject),
    created_at: new Date().toISOString(),
    usage_count: 0,
    relevance_score: 1.0
  };

  // Write entry file
  writeJSON(path.join(typeDir, `${id}.json`), entry);

  // Update index
  index.entries.push({
    id,
    type,
    source_project_hash: entry.source_project_hash,
    created_at: entry.created_at,
    usage_count: 0,
    relevance_score: 1.0,
    keywords: extractKeywords(JSON.stringify(anonymized)).slice(0, 20)
  });
  saveIndex(index, opts);

  return { id, type, deduplicated: false };
}

/**
 * Query the knowledge base.
 *
 * @param {string} type - Knowledge type to query (or null for all)
 * @param {string[]} keywords - Search keywords
 * @param {number} [limit=10] - Maximum results
 * @param {object} [opts] - { knowledgePath }
 * @returns {object[]} Matching knowledge entries sorted by relevance
 */
function queryKnowledge(type, keywords, limit, opts) {
  limit = limit || 10;
  opts = opts || {};

  const index = loadIndex(opts);
  let candidates = index.entries;

  // Filter by type if specified
  if (type) {
    candidates = candidates.filter(e => e.type === type);
  }

  // Score each candidate by keyword overlap
  const searchKeywords = (keywords || []).map(k => k.toLowerCase());

  const scored = candidates.map(entry => {
    const entryKeywords = (entry.keywords || []).map(k => k.toLowerCase());
    let score = 0;

    if (searchKeywords.length > 0 && entryKeywords.length > 0) {
      const overlap = searchKeywords.filter(k => entryKeywords.includes(k)).length;
      score = overlap / Math.max(searchKeywords.length, entryKeywords.length);
    }

    // Boost by usage count (logarithmic)
    const usageBoost = Math.log(1 + (entry.usage_count || 0)) / 10;
    score += usageBoost;

    return { ...entry, _score: score };
  });

  // Sort by score descending
  scored.sort((a, b) => b._score - a._score);

  // Load full entries for top results
  const results = [];
  for (const item of scored.slice(0, limit)) {
    if (item._score <= 0 && searchKeywords.length > 0) break;

    const typeDir = getTypeDir(item.type, opts);
    const entryData = readJSON(path.join(typeDir, `${item.id}.json`));
    if (entryData) {
      results.push({ ...entryData, _score: item._score });
    }
  }

  return results;
}

/**
 * Get knowledge base statistics.
 *
 * @param {object} [opts] - { knowledgePath }
 * @returns {{ total: number, byType: object, topUsed: object[] }}
 */
function getKnowledgeStats(opts) {
  const index = loadIndex(opts);
  const byType = {};

  for (const type of KNOWLEDGE_TYPES) {
    byType[type] = 0;
  }

  for (const entry of index.entries) {
    byType[entry.type] = (byType[entry.type] || 0) + 1;
  }

  // Top 5 most used
  const topUsed = [...index.entries]
    .sort((a, b) => (b.usage_count || 0) - (a.usage_count || 0))
    .slice(0, 5)
    .map(e => ({ id: e.id, type: e.type, usage_count: e.usage_count || 0 }));

  return {
    total: index.entries.length,
    byType,
    topUsed
  };
}

/**
 * Prune old and unused knowledge entries.
 *
 * @param {number} [maxAgeDays] - Remove entries older than this
 * @param {number} [maxEntriesPerType] - Keep at most this many per type
 * @param {object} [opts] - { knowledgePath }
 * @returns {{ pruned: number, remaining: number }}
 */
function pruneKnowledge(maxAgeDays, maxEntriesPerType, opts) {
  maxAgeDays = maxAgeDays || PRUNE_AFTER_DAYS_DEFAULT;
  maxEntriesPerType = maxEntriesPerType || MAX_ENTRIES_PER_TYPE_DEFAULT;
  opts = opts || {};

  const index = loadIndex(opts);
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  let pruned = 0;

  // Remove old entries
  const filtered = index.entries.filter(entry => {
    if (entry.created_at && entry.created_at < cutoff && (entry.usage_count || 0) === 0) {
      // Delete entry file
      const typeDir = getTypeDir(entry.type, opts);
      const entryPath = path.join(typeDir, `${entry.id}.json`);
      try { if (fs.existsSync(entryPath)) fs.unlinkSync(entryPath); } catch (e) { /* best effort */ }
      pruned++;
      return false;
    }
    return true;
  });

  // Enforce per-type limits
  const byType = {};
  for (const entry of filtered) {
    if (!byType[entry.type]) byType[entry.type] = [];
    byType[entry.type].push(entry);
  }

  const kept = [];
  for (const [type, entries] of Object.entries(byType)) {
    // Sort by usage_count desc, then created_at desc
    entries.sort((a, b) => (b.usage_count || 0) - (a.usage_count || 0) ||
      (b.created_at || '').localeCompare(a.created_at || ''));

    const toKeep = entries.slice(0, maxEntriesPerType);
    const toRemove = entries.slice(maxEntriesPerType);

    kept.push(...toKeep);

    for (const entry of toRemove) {
      const typeDir = getTypeDir(type, opts);
      const entryPath = path.join(typeDir, `${entry.id}.json`);
      try { if (fs.existsSync(entryPath)) fs.unlinkSync(entryPath); } catch (e) { /* best effort */ }
      pruned++;
    }
  }

  index.entries = kept;
  saveIndex(index, opts);

  return { pruned, remaining: kept.length };
}

/**
 * Record usage of a knowledge entry (increment usage_count).
 *
 * @param {string} knowledgeId - Entry ID
 * @param {object} [opts] - { knowledgePath }
 */
function recordUsage(knowledgeId, opts) {
  opts = opts || {};
  const index = loadIndex(opts);
  const entry = index.entries.find(e => e.id === knowledgeId);
  if (!entry) return;

  entry.usage_count = (entry.usage_count || 0) + 1;
  entry.last_used = new Date().toISOString();
  saveIndex(index, opts);

  // Also update the entry file
  const typeDir = getTypeDir(entry.type, opts);
  const entryPath = path.join(typeDir, `${entry.id}.json`);
  const entryData = readJSON(entryPath);
  if (entryData) {
    entryData.usage_count = entry.usage_count;
    entryData.last_used = entry.last_used;
    writeJSON(entryPath, entryData);
  }
}

/**
 * Reset the knowledge base (for testing).
 * @param {object} [opts]
 */
function resetKnowledge(opts) {
  const dir = getKnowledgeDir(opts);
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) { /* best effort */ }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Core operations
  publishKnowledge,
  queryKnowledge,
  getKnowledgeStats,
  pruneKnowledge,
  recordUsage,

  // Anonymization
  anonymize,
  hashProject,

  // Deduplication
  findDuplicate,
  extractKeywords,

  // Index
  loadIndex,

  // Testing
  resetKnowledge,

  // Constants
  KNOWLEDGE_TYPES,
  DEFAULT_KNOWLEDGE_PATH,
  MAX_ENTRIES_PER_TYPE_DEFAULT,
  PRUNE_AFTER_DAYS_DEFAULT
};
