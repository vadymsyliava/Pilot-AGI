/**
 * Canonical Pattern Registry — Phase 8.7 (Pilot AGI-80xy)
 *
 * Project-specific pattern definitions. One canonical way per concept.
 * Auto-learns patterns from consistent usage. Detects conflicts.
 *
 * Storage: .claude/pilot/registry/patterns.json
 *
 * Categories: naming, file_structure, imports, error_handling, state_management, other
 */

const fs = require('fs');
const path = require('path');

const PATTERNS_FILE = '.claude/pilot/registry/patterns.json';
const CATEGORIES = ['naming', 'file_structure', 'imports', 'error_handling', 'state_management', 'other'];
const AUTO_LEARN_THRESHOLD = 3; // usages before auto-registering as canonical

// =============================================================================
// CORE — LOAD / SAVE
// =============================================================================

function getPatternsPath() {
  return path.join(process.cwd(), PATTERNS_FILE);
}

function loadPatterns() {
  const filePath = getPatternsPath();
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return [];
  }
}

function savePatterns(patterns) {
  const dir = path.dirname(getPatternsPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = getPatternsPath();
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(patterns, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// =============================================================================
// ID GENERATION
// =============================================================================

let _idSeq = 0;

function generateId() {
  const ts = Date.now().toString(36);
  const seq = (_idSeq++).toString(36);
  return `P-${ts}-${seq}`;
}

// =============================================================================
// REGISTER PATTERN
// =============================================================================

/**
 * Register a canonical pattern.
 *
 * @param {object} pattern
 * @param {string} pattern.name - Human-readable pattern name (e.g. "camelCase variables")
 * @param {string} pattern.category - One of CATEGORIES
 * @param {string} pattern.purpose - What this pattern solves (used for conflict detection)
 * @param {string} pattern.rule - The canonical rule (e.g. "Use camelCase for all local variables")
 * @param {string[]} [pattern.examples] - Code examples
 * @param {string[]} [pattern.source_refs] - File paths where pattern is used
 * @param {boolean} [pattern.auto_learned] - Whether auto-learned from usage
 * @returns {{ success, id?, error?, conflict? }}
 */
function registerPattern(pattern) {
  if (!pattern || !pattern.name) {
    return { success: false, error: 'name is required' };
  }
  if (!pattern.category || !CATEGORIES.includes(pattern.category)) {
    return { success: false, error: `invalid category. Valid: ${CATEGORIES.join(', ')}` };
  }
  if (!pattern.purpose) {
    return { success: false, error: 'purpose is required (used for conflict detection)' };
  }

  const patterns = loadPatterns();

  // Check for exact name duplicate
  const nameDup = patterns.find(p => p.name.toLowerCase() === pattern.name.toLowerCase());
  if (nameDup) {
    return { success: false, error: `pattern already exists: "${nameDup.name}" (${nameDup.id})`, duplicate: nameDup };
  }

  // Check for purpose conflict (same purpose, different pattern)
  const conflict = detectConflict(patterns, pattern);
  if (conflict) {
    return {
      success: false,
      error: `conflicting pattern for same purpose: "${conflict.name}" (${conflict.id})`,
      conflict
    };
  }

  const entry = {
    id: generateId(),
    name: pattern.name,
    category: pattern.category,
    purpose: pattern.purpose,
    rule: pattern.rule || '',
    examples: pattern.examples || [],
    source_refs: pattern.source_refs || [],
    usage_count: pattern.auto_learned ? 1 : 0,
    auto_learned: pattern.auto_learned || false,
    canonical: !pattern.auto_learned, // manual = canonical immediately
    created_at: new Date().toISOString()
  };

  patterns.push(entry);
  savePatterns(patterns);

  return { success: true, id: entry.id };
}

// =============================================================================
// UPDATE PATTERN
// =============================================================================

/**
 * Update an existing pattern.
 */
function updatePattern(id, updates) {
  if (!id) return { success: false, error: 'id required' };

  const patterns = loadPatterns();
  const idx = patterns.findIndex(p => p.id === id);
  if (idx === -1) return { success: false, error: 'pattern not found' };

  // Check name uniqueness if name is being changed
  if (updates.name && updates.name.toLowerCase() !== patterns[idx].name.toLowerCase()) {
    const nameDup = patterns.find(p => p.id !== id && p.name.toLowerCase() === updates.name.toLowerCase());
    if (nameDup) return { success: false, error: `duplicate name: "${nameDup.name}"` };
  }

  const allowed = ['name', 'category', 'purpose', 'rule', 'examples', 'source_refs', 'canonical'];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      patterns[idx][key] = updates[key];
    }
  }
  patterns[idx].updated_at = new Date().toISOString();

  savePatterns(patterns);
  return { success: true };
}

// =============================================================================
// REMOVE PATTERN
// =============================================================================

function removePattern(id) {
  if (!id) return { success: false, error: 'id required' };

  const patterns = loadPatterns();
  const idx = patterns.findIndex(p => p.id === id);
  if (idx === -1) return { success: false, error: 'pattern not found' };

  patterns.splice(idx, 1);
  savePatterns(patterns);
  return { success: true };
}

// =============================================================================
// LOOKUP
// =============================================================================

/**
 * Find patterns by category.
 */
function findByCategory(category) {
  if (!CATEGORIES.includes(category)) return [];
  return loadPatterns().filter(p => p.category === category);
}

/**
 * Find patterns by purpose (fuzzy match).
 */
function findByPurpose(purpose) {
  if (!purpose) return [];
  const lower = purpose.toLowerCase();
  return loadPatterns().filter(p =>
    p.purpose.toLowerCase().includes(lower) || lower.includes(p.purpose.toLowerCase())
  );
}

/**
 * Find pattern by name (exact or similar).
 */
function findByName(name) {
  if (!name) return [];
  const patterns = loadPatterns();
  const lower = name.toLowerCase();

  const exact = patterns.filter(p => p.name.toLowerCase() === lower);
  if (exact.length > 0) return exact;

  // Fuzzy match using word overlap
  return patterns.filter(p => {
    const pWords = p.name.toLowerCase().split(/[\s_-]+/);
    const qWords = lower.split(/[\s_-]+/);
    const overlap = pWords.filter(w => qWords.includes(w)).length;
    return overlap > 0 && overlap >= Math.min(pWords.length, qWords.length) * 0.5;
  });
}

/**
 * Get a pattern by ID.
 */
function getById(id) {
  if (!id) return null;
  return loadPatterns().find(p => p.id === id) || null;
}

/**
 * List all patterns.
 */
function listAll() {
  return loadPatterns();
}

/**
 * List only canonical patterns (confirmed as the one right way).
 */
function listCanonical() {
  return loadPatterns().filter(p => p.canonical);
}

// =============================================================================
// USAGE TRACKING & AUTO-LEARNING
// =============================================================================

/**
 * Record a usage of a pattern. If usage_count reaches AUTO_LEARN_THRESHOLD
 * for an auto-learned pattern, it becomes canonical.
 *
 * @param {string} id - Pattern ID
 * @param {string} [sourceRef] - File path where pattern was observed
 * @returns {{ success, became_canonical? }}
 */
function recordUsage(id, sourceRef) {
  if (!id) return { success: false, error: 'id required' };

  const patterns = loadPatterns();
  const idx = patterns.findIndex(p => p.id === id);
  if (idx === -1) return { success: false, error: 'pattern not found' };

  patterns[idx].usage_count = (patterns[idx].usage_count || 0) + 1;

  if (sourceRef && !patterns[idx].source_refs.includes(sourceRef)) {
    patterns[idx].source_refs.push(sourceRef);
  }

  let becameCanonical = false;
  if (!patterns[idx].canonical && patterns[idx].usage_count >= AUTO_LEARN_THRESHOLD) {
    patterns[idx].canonical = true;
    becameCanonical = true;
  }

  savePatterns(patterns);
  return { success: true, became_canonical: becameCanonical };
}

/**
 * Observe a pattern usage by purpose. If the purpose matches an existing
 * pattern, record usage. If not, create a new auto-learned pattern candidate.
 *
 * @param {object} observation - { purpose, category, name?, rule?, source_ref? }
 * @returns {{ success, action, pattern_id? }}
 */
function observe(observation) {
  if (!observation || !observation.purpose) {
    return { success: false, error: 'purpose required' };
  }

  const purpose = observation.purpose;
  const matching = findByPurpose(purpose);

  if (matching.length > 0) {
    // Found existing pattern — record usage
    const best = matching[0];
    const result = recordUsage(best.id, observation.source_ref);
    return {
      success: true,
      action: result.became_canonical ? 'promoted' : 'usage_recorded',
      pattern_id: best.id
    };
  }

  // No matching pattern — create auto-learned candidate
  const name = observation.name || purpose;
  const category = observation.category || 'other';
  if (!CATEGORIES.includes(category)) {
    return { success: false, error: `invalid category: ${category}` };
  }

  const result = registerPattern({
    name,
    category,
    purpose,
    rule: observation.rule || '',
    source_refs: observation.source_ref ? [observation.source_ref] : [],
    auto_learned: true
  });

  if (!result.success) return result;

  return {
    success: true,
    action: 'created_candidate',
    pattern_id: result.id
  };
}

// =============================================================================
// CONFLICT DETECTION
// =============================================================================

/**
 * Detect if a new pattern conflicts with existing ones.
 * Conflict = same purpose in the same category.
 */
function detectConflict(patterns, newPattern) {
  const purposeLower = (newPattern.purpose || '').toLowerCase();
  const catLower = (newPattern.category || '').toLowerCase();

  for (const p of patterns) {
    if (p.category.toLowerCase() !== catLower) continue;

    // Exact purpose match
    if (p.purpose.toLowerCase() === purposeLower) return p;

    // High word overlap in purpose
    const pWords = p.purpose.toLowerCase().split(/[\s_-]+/).filter(w => w.length > 2);
    const nWords = purposeLower.split(/[\s_-]+/).filter(w => w.length > 2);
    if (pWords.length === 0 || nWords.length === 0) continue;

    const overlap = pWords.filter(w => nWords.includes(w)).length;
    const ratio = overlap / Math.max(pWords.length, nWords.length);
    if (ratio >= 0.7) return p;
  }

  return null;
}

/**
 * Get all conflicts in the registry (for audit).
 */
function getAllConflicts() {
  const patterns = loadPatterns();
  const conflicts = [];

  for (let i = 0; i < patterns.length; i++) {
    for (let j = i + 1; j < patterns.length; j++) {
      if (patterns[i].category !== patterns[j].category) continue;

      const pWords = patterns[i].purpose.toLowerCase().split(/[\s_-]+/).filter(w => w.length > 2);
      const nWords = patterns[j].purpose.toLowerCase().split(/[\s_-]+/).filter(w => w.length > 2);
      if (pWords.length === 0 || nWords.length === 0) continue;

      const overlap = pWords.filter(w => nWords.includes(w)).length;
      const ratio = overlap / Math.max(pWords.length, nWords.length);

      if (ratio >= 0.7 || patterns[i].purpose.toLowerCase() === patterns[j].purpose.toLowerCase()) {
        conflicts.push({
          pattern_a: patterns[i],
          pattern_b: patterns[j],
          category: patterns[i].category,
          overlap_ratio: ratio
        });
      }
    }
  }

  return conflicts;
}

// =============================================================================
// CONTEXT BUILDER
// =============================================================================

/**
 * Build pattern context for agent session start.
 * Returns only canonical patterns, grouped by category.
 */
function buildContext() {
  const canonical = listCanonical();
  if (canonical.length === 0) return null;

  const grouped = {};
  for (const p of canonical) {
    if (!grouped[p.category]) grouped[p.category] = [];
    grouped[p.category].push({
      name: p.name,
      rule: p.rule,
      usage_count: p.usage_count
    });
  }

  return {
    total_canonical: canonical.length,
    categories: grouped
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // CRUD
  registerPattern,
  updatePattern,
  removePattern,

  // Lookup
  findByCategory,
  findByPurpose,
  findByName,
  getById,
  listAll,
  listCanonical,

  // Usage tracking
  recordUsage,
  observe,

  // Conflict detection
  detectConflict,
  getAllConflicts,

  // Context
  buildContext,

  // Constants
  CATEGORIES,
  AUTO_LEARN_THRESHOLD
};
