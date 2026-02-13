/**
 * Decomposition Pattern Library (Phase 5.5)
 *
 * Stores successful decomposition templates indexed by task type.
 * Provides fuzzy matching to reuse proven decomposition strategies.
 *
 * State files:
 *   .claude/pilot/state/decomposition-patterns/library.json — pattern templates
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const PATTERNS_DIR = '.claude/pilot/state/decomposition-patterns';
const LIBRARY_FILE = 'library.json';
const MAX_PATTERNS_PER_TYPE_DEFAULT = 50;

// Task type classification keywords
const TYPE_KEYWORDS = {
  feature: ['feature', 'implement', 'add', 'create', 'build', 'new', 'introduce'],
  bugfix: ['fix', 'bug', 'repair', 'resolve', 'patch', 'correct', 'issue'],
  refactor: ['refactor', 'migrate', 'redesign', 'replace', 'upgrade', 'move', 'rename', 'restructure'],
  test: ['test', 'spec', 'coverage', 'e2e', 'unit test', 'integration test'],
  docs: ['doc', 'documentation', 'readme', 'guide', 'tutorial', 'comment'],
  infra: ['infra', 'ci', 'cd', 'deploy', 'docker', 'pipeline', 'hook', 'config', 'devops']
};

// ============================================================================
// PATH HELPERS
// ============================================================================

function getPatternsDir() {
  return path.join(process.cwd(), PATTERNS_DIR);
}

function getLibraryPath() {
  return path.join(getPatternsDir(), LIBRARY_FILE);
}

function ensureDir() {
  const dir = getPatternsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// ATOMIC FILE OPS
// ============================================================================

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
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

// ============================================================================
// TASK TYPE CLASSIFICATION
// ============================================================================

/**
 * Classify task type from description/title.
 *
 * @param {string} text - Task title + description
 * @returns {string} - "feature"|"bugfix"|"refactor"|"test"|"docs"|"infra"
 */
function classifyTaskType(text) {
  if (!text) return 'feature';
  const lower = text.toLowerCase();

  let bestType = 'feature';
  let bestScore = 0;

  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    const hits = keywords.filter(kw => lower.includes(kw)).length;
    const score = keywords.length > 0 ? hits / keywords.length : 0;
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }

  return bestType;
}

// ============================================================================
// PATTERN LIBRARY
// ============================================================================

/**
 * Load the pattern library.
 *
 * @returns {{ patterns: object[] }}
 */
function loadLibrary() {
  const lib = readJSON(getLibraryPath());
  return lib || { patterns: [], updated_at: null };
}

/**
 * Save the pattern library.
 *
 * @param {object} library
 */
function saveLibrary(library) {
  ensureDir();
  library.updated_at = new Date().toISOString();
  writeJSON(getLibraryPath(), library);
}

/**
 * Find a matching pattern for a task description.
 * Uses fuzzy keyword matching + task type.
 *
 * @param {string} taskDescription - Task title + description text
 * @param {object} [opts] - { min_success_rate: number, min_match_score: number }
 * @returns {{ pattern: object, match_score: number } | null}
 */
function findPattern(taskDescription, opts) {
  if (!taskDescription) return null;
  const options = opts || {};
  const minSuccessRate = options.min_success_rate || 0.7;
  const minMatchScore = options.min_match_score || 0.5;

  const library = loadLibrary();
  if (library.patterns.length === 0) return null;

  const taskType = classifyTaskType(taskDescription);
  const taskWords = extractKeywords(taskDescription);

  let bestMatch = null;
  let bestScore = 0;

  for (const pattern of library.patterns) {
    // Type must match
    if (pattern.type !== taskType) continue;

    // Success rate filter
    if (pattern.success_rate < minSuccessRate) continue;

    // Keyword matching
    const patternWords = pattern.keywords || [];
    const overlap = taskWords.filter(w => patternWords.includes(w)).length;
    const matchScore = patternWords.length > 0
      ? overlap / Math.max(patternWords.length, taskWords.length)
      : 0;

    if (matchScore >= minMatchScore && matchScore > bestScore) {
      bestScore = matchScore;
      bestMatch = pattern;
    }
  }

  if (!bestMatch) return null;

  return {
    pattern: bestMatch,
    match_score: Math.round(bestScore * 100) / 100
  };
}

/**
 * Record a successful decomposition as a pattern template.
 *
 * @param {string} taskId - Parent task ID
 * @param {object} decomposition - {
 *   task_title: string,
 *   task_description: string,
 *   task_type: string,
 *   subtasks: object[],
 *   domain: string
 * }
 * @param {object} outcome - {
 *   success: boolean,
 *   overall_accuracy: number,
 *   stuck_count: number,
 *   rework_count: number
 * }
 * @param {number} [maxPatternsPerType] - Max patterns per type before pruning
 */
function recordPattern(taskId, decomposition, outcome, maxPatternsPerType) {
  if (!taskId || !decomposition || !outcome) return;
  const maxPerType = maxPatternsPerType || MAX_PATTERNS_PER_TYPE_DEFAULT;

  const library = loadLibrary();
  const taskType = decomposition.task_type || classifyTaskType(
    `${decomposition.task_title || ''} ${decomposition.task_description || ''}`
  );

  const keywords = extractKeywords(
    `${decomposition.task_title || ''} ${decomposition.task_description || ''}`
  );

  // Check if pattern already exists for this task
  const existingIdx = library.patterns.findIndex(p => p.source_task_id === taskId);

  const template = (decomposition.subtasks || []).map(st => ({
    title_template: st.title,
    agent: st.agent,
    priority: st.priority,
    wave: st.wave,
    depends_on_indices: st.depends_on || []
  }));

  const patternEntry = {
    source_task_id: taskId,
    type: taskType,
    keywords,
    domain: decomposition.domain || 'unknown',
    template,
    success_rate: outcome.success ? 1.0 : 0.0,
    usage_count: 1,
    avg_subtasks: template.length,
    avg_accuracy: outcome.overall_accuracy || 0,
    stuck_rate: template.length > 0
      ? (outcome.stuck_count || 0) / template.length : 0,
    last_used: new Date().toISOString(),
    created_at: new Date().toISOString()
  };

  if (existingIdx >= 0) {
    // Update existing pattern with EMA
    const existing = library.patterns[existingIdx];
    existing.usage_count += 1;
    existing.success_rate = ema(existing.success_rate, outcome.success ? 1.0 : 0.0, 0.3);
    existing.avg_accuracy = ema(existing.avg_accuracy, outcome.overall_accuracy || 0, 0.3);
    existing.avg_subtasks = ema(existing.avg_subtasks, template.length, 0.3);
    existing.stuck_rate = ema(existing.stuck_rate, patternEntry.stuck_rate, 0.3);
    existing.last_used = new Date().toISOString();
    // Update template if new decomposition was more successful
    if (outcome.overall_accuracy > existing.avg_accuracy) {
      existing.template = template;
      existing.keywords = keywords;
    }
  } else {
    library.patterns.push(patternEntry);
  }

  // Prune: keep top patterns per type
  pruneLibrary(library, maxPerType);

  saveLibrary(library);
}

/**
 * Get top patterns by success rate for a given type.
 *
 * @param {string} taskType - "feature"|"bugfix"|"refactor"|"test"|"docs"|"infra"
 * @param {number} [limit=5] - Max patterns to return
 * @returns {object[]}
 */
function getTopPatterns(taskType, limit) {
  if (limit === undefined) limit = 5;

  const library = loadLibrary();
  return library.patterns
    .filter(p => p.type === taskType)
    .sort((a, b) => b.success_rate - a.success_rate || b.usage_count - a.usage_count)
    .slice(0, limit);
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Extract keywords from text (lowercase, deduplicated, stop words removed).
 */
function extractKeywords(text) {
  if (!text) return [];

  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
    'under', 'again', 'further', 'then', 'once', 'and', 'but', 'or', 'nor',
    'not', 'so', 'yet', 'both', 'each', 'few', 'more', 'most', 'other',
    'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very',
    'this', 'that', 'these', 'those', 'it', 'its'
  ]);

  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s-_]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  return [...new Set(words)];
}

/**
 * Exponential moving average.
 */
function ema(current, newValue, alpha) {
  return current * (1 - alpha) + newValue * alpha;
}

/**
 * Prune patterns: keep top N per type by success rate.
 */
function pruneLibrary(library, maxPerType) {
  const byType = {};
  for (const p of library.patterns) {
    if (!byType[p.type]) byType[p.type] = [];
    byType[p.type].push(p);
  }

  const kept = [];
  for (const type of Object.keys(byType)) {
    const sorted = byType[type].sort((a, b) =>
      b.success_rate - a.success_rate || b.usage_count - a.usage_count
    );
    kept.push(...sorted.slice(0, maxPerType));
  }

  library.patterns = kept;
}

// ============================================================================
// CLEANUP (for testing)
// ============================================================================

function resetLibrary() {
  const p = getLibraryPath();
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* best effort */ }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Classification
  classifyTaskType,

  // Pattern matching
  findPattern,

  // Pattern recording
  recordPattern,

  // Retrieval
  getTopPatterns,
  loadLibrary,

  // Helpers (exported for testing)
  extractKeywords,

  // Testing helpers
  resetLibrary,
  getLibraryPath,

  // Constants
  PATTERNS_DIR,
  LIBRARY_FILE,
  TYPE_KEYWORDS,
  MAX_PATTERNS_PER_TYPE_DEFAULT
};
