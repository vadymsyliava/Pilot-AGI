/**
 * Project Registry — Phase 8.4 (Pilot AGI-znbw)
 *
 * Single source of truth for pages, components, APIs, and database
 * collections in the project. Prevents duplicates, enforces canonical naming.
 *
 * Registry: .claude/pilot/registry/
 *   pages.json, components.json, apis.json, database.json
 *
 * Each entry: { id, name, file_path, type, description, created_by, created_at, dependencies[] }
 */

const fs = require('fs');
const path = require('path');

const REGISTRY_DIR = '.claude/pilot/registry';
const DOMAINS = ['pages', 'components', 'apis', 'database'];
const SIMILARITY_THRESHOLD = 0.75;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// =============================================================================
// CORE — LOAD / SAVE
// =============================================================================

function getRegistryPath(domain) {
  return path.join(process.cwd(), REGISTRY_DIR, `${domain}.json`);
}

function loadRegistry(domain) {
  if (!DOMAINS.includes(domain)) return [];
  const filePath = getRegistryPath(domain);
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveRegistry(domain, entries) {
  if (!DOMAINS.includes(domain)) return false;
  ensureDir(path.join(process.cwd(), REGISTRY_DIR));
  const filePath = getRegistryPath(domain);
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
  return true;
}

// =============================================================================
// ID GENERATION
// =============================================================================

let _idSeq = 0;

function generateId(domain) {
  const prefix = domain.charAt(0).toUpperCase();
  const ts = Date.now().toString(36);
  const seq = (_idSeq++).toString(36);
  return `${prefix}-${ts}-${seq}`;
}

// =============================================================================
// REGISTER (CRUD — Create)
// =============================================================================

/**
 * Register an entry in a domain. Checks for duplicates first.
 *
 * @param {string} domain - pages|components|apis|database
 * @param {object} entry - { name, file_path, type?, description?, created_by?, dependencies?[] }
 * @returns {{ success, id?, error?, duplicate? }}
 */
function register(domain, entry) {
  if (!DOMAINS.includes(domain)) {
    return { success: false, error: `invalid domain: ${domain}. Valid: ${DOMAINS.join(', ')}` };
  }
  if (!entry || !entry.name) {
    return { success: false, error: 'name is required' };
  }

  const entries = loadRegistry(domain);

  // Check for duplicates
  const dup = findDuplicate(entries, entry);
  if (dup) {
    return {
      success: false,
      error: `duplicate detected: "${dup.name}" (${dup.id}) at ${dup.file_path}`,
      duplicate: dup
    };
  }

  const newEntry = {
    id: generateId(domain),
    name: entry.name,
    file_path: entry.file_path || null,
    type: entry.type || null,
    description: entry.description || null,
    created_by: entry.created_by || null,
    created_at: new Date().toISOString(),
    dependencies: entry.dependencies || []
  };

  entries.push(newEntry);
  saveRegistry(domain, entries);

  return { success: true, id: newEntry.id };
}

// Convenience wrappers
function registerPage(entry) { return register('pages', entry); }
function registerComponent(entry) { return register('components', entry); }
function registerAPI(entry) { return register('apis', entry); }
function registerCollection(entry) { return register('database', entry); }

// =============================================================================
// UPDATE (CRUD — Update)
// =============================================================================

/**
 * Update an existing registry entry.
 *
 * @param {string} domain - Registry domain
 * @param {string} id - Entry ID
 * @param {object} updates - Fields to update
 * @returns {{ success, error? }}
 */
function update(domain, id, updates) {
  if (!DOMAINS.includes(domain)) return { success: false, error: 'invalid domain' };
  if (!id) return { success: false, error: 'id required' };

  const entries = loadRegistry(domain);
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) return { success: false, error: 'entry not found' };

  // Check name uniqueness if name is being changed
  if (updates.name && updates.name !== entries[idx].name) {
    const dup = findDuplicate(entries.filter(e => e.id !== id), { name: updates.name, file_path: updates.file_path });
    if (dup) return { success: false, error: `duplicate name: "${dup.name}"`, duplicate: dup };
  }

  const allowed = ['name', 'file_path', 'type', 'description', 'dependencies'];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      entries[idx][key] = updates[key];
    }
  }
  entries[idx].updated_at = new Date().toISOString();

  saveRegistry(domain, entries);
  return { success: true };
}

// =============================================================================
// REMOVE (CRUD — Delete)
// =============================================================================

/**
 * Remove an entry from a registry domain.
 *
 * @param {string} domain - Registry domain
 * @param {string} id - Entry ID
 * @returns {{ success, error? }}
 */
function remove(domain, id) {
  if (!DOMAINS.includes(domain)) return { success: false, error: 'invalid domain' };
  if (!id) return { success: false, error: 'id required' };

  const entries = loadRegistry(domain);
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) return { success: false, error: 'entry not found' };

  entries.splice(idx, 1);
  saveRegistry(domain, entries);
  return { success: true };
}

// =============================================================================
// LOOKUP (CRUD — Read)
// =============================================================================

/**
 * Find entry by name (exact or similar).
 */
function findByName(domain, name) {
  if (!DOMAINS.includes(domain) || !name) return [];
  const entries = loadRegistry(domain);
  const lower = name.toLowerCase();

  // Exact match first
  const exact = entries.filter(e => e.name.toLowerCase() === lower);
  if (exact.length > 0) return exact;

  // Fuzzy match
  return entries.filter(e => {
    const sim = similarity(e.name.toLowerCase(), lower);
    return sim >= SIMILARITY_THRESHOLD;
  });
}

/**
 * Find entry by file path.
 */
function findByPath(domain, filePath) {
  if (!DOMAINS.includes(domain) || !filePath) return [];
  const entries = loadRegistry(domain);
  const normalized = filePath.replace(/\\/g, '/');

  return entries.filter(e => {
    if (!e.file_path) return false;
    return e.file_path.replace(/\\/g, '/') === normalized ||
           e.file_path.replace(/\\/g, '/').endsWith(normalized) ||
           normalized.endsWith(e.file_path.replace(/\\/g, '/'));
  });
}

/**
 * Find entries matching a pattern (regex on name or file_path).
 */
function findByPattern(domain, pattern) {
  if (!DOMAINS.includes(domain) || !pattern) return [];
  const entries = loadRegistry(domain);
  const regex = new RegExp(pattern, 'i');

  return entries.filter(e =>
    regex.test(e.name) || (e.file_path && regex.test(e.file_path))
  );
}

/**
 * List all entries in a domain.
 */
function listAll(domain) {
  if (!DOMAINS.includes(domain)) return [];
  return loadRegistry(domain);
}

/**
 * Get a single entry by ID.
 */
function getById(domain, id) {
  if (!DOMAINS.includes(domain) || !id) return null;
  const entries = loadRegistry(domain);
  return entries.find(e => e.id === id) || null;
}

/**
 * Search across all domains.
 */
function searchAll(query) {
  if (!query) return {};
  const results = {};
  for (const domain of DOMAINS) {
    const matches = findByPattern(domain, query);
    if (matches.length > 0) {
      results[domain] = matches;
    }
  }
  return results;
}

// =============================================================================
// DUPLICATE DETECTION
// =============================================================================

/**
 * Check if a new entry would be a duplicate.
 */
function findDuplicate(entries, newEntry) {
  const name = (newEntry.name || '').toLowerCase();
  const filePath = (newEntry.file_path || '').replace(/\\/g, '/');

  for (const entry of entries) {
    // Exact name match
    if (entry.name.toLowerCase() === name) return entry;

    // Same file path
    if (filePath && entry.file_path &&
        entry.file_path.replace(/\\/g, '/') === filePath) return entry;

    // High similarity name
    if (similarity(entry.name.toLowerCase(), name) >= SIMILARITY_THRESHOLD) return entry;
  }

  return null;
}

/**
 * Check for duplicates across all domains (cross-domain detection).
 */
function findCrossDomainDuplicate(name) {
  if (!name) return null;
  const lower = name.toLowerCase();

  for (const domain of DOMAINS) {
    const entries = loadRegistry(domain);
    for (const entry of entries) {
      if (entry.name.toLowerCase() === lower) {
        return { domain, entry };
      }
    }
  }
  return null;
}

// =============================================================================
// SUMMARY — for context injection
// =============================================================================

/**
 * Build a compact summary of the registry for agent context.
 */
function buildSummary() {
  const summary = {};
  for (const domain of DOMAINS) {
    const entries = loadRegistry(domain);
    summary[domain] = {
      count: entries.length,
      names: entries.slice(0, 20).map(e => e.name)
    };
  }
  return summary;
}

/**
 * Get registry stats.
 */
function getStats() {
  const stats = { total: 0, by_domain: {} };
  for (const domain of DOMAINS) {
    const count = loadRegistry(domain).length;
    stats.by_domain[domain] = count;
    stats.total += count;
  }
  return stats;
}

// =============================================================================
// STRING SIMILARITY (Dice coefficient)
// =============================================================================

function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const bigram = a.substring(i, i + 2);
    bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
  }

  let intersect = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bigram = b.substring(i, i + 2);
    const count = bigrams.get(bigram) || 0;
    if (count > 0) {
      bigrams.set(bigram, count - 1);
      intersect++;
    }
  }

  return (2.0 * intersect) / (a.length + b.length - 2);
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // CRUD
  register,
  registerPage,
  registerComponent,
  registerAPI,
  registerCollection,
  update,
  remove,

  // Lookup
  findByName,
  findByPath,
  findByPattern,
  listAll,
  getById,
  searchAll,

  // Duplicate detection
  findDuplicate,
  findCrossDomainDuplicate,

  // Summary
  buildSummary,
  getStats,

  // Utilities
  similarity,

  // Constants
  REGISTRY_DIR,
  DOMAINS,
  SIMILARITY_THRESHOLD
};
