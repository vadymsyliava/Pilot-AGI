/**
 * Naming Consistency Enforcer — Phase 8.11 (Pilot AGI-11kb)
 *
 * Cross-layer consistency: DB to API to Component to Page use same terminology.
 * Name registry maps concepts to canonical names across all layers.
 * Auto-detect inconsistencies by cross-referencing registry domains.
 */

const fs = require('fs');
const path = require('path');

const NAME_MAP_FILE = '.claude/pilot/registry/name-map.json';

// =============================================================================
// NAME MAP — LOAD / SAVE
// =============================================================================

function getNameMapPath() {
  return path.join(process.cwd(), NAME_MAP_FILE);
}

function loadNameMap() {
  const filePath = getNameMapPath();
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveNameMap(map) {
  const dir = path.dirname(getNameMapPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = getNameMapPath();
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(map, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// =============================================================================
// CONCEPT → CANONICAL NAME MAPPING
// =============================================================================

/**
 * Register a canonical name for a concept across layers.
 *
 * @param {string} concept - The concept identifier (e.g. "user", "product")
 * @param {object} names - Layer-specific names: { database, api, component, page }
 * @returns {{ success, error? }}
 */
function registerConcept(concept, names) {
  if (!concept) return { success: false, error: 'concept required' };
  if (!names || typeof names !== 'object') return { success: false, error: 'names object required' };

  const map = loadNameMap();
  map[concept.toLowerCase()] = {
    canonical: concept,
    database: names.database || null,
    api: names.api || null,
    component: names.component || null,
    page: names.page || null,
    updated_at: new Date().toISOString()
  };

  saveNameMap(map);
  return { success: true };
}

/**
 * Get the canonical name mapping for a concept.
 */
function getConcept(concept) {
  if (!concept) return null;
  const map = loadNameMap();
  return map[concept.toLowerCase()] || null;
}

/**
 * Remove a concept mapping.
 */
function removeConcept(concept) {
  if (!concept) return { success: false, error: 'concept required' };
  const map = loadNameMap();
  const key = concept.toLowerCase();
  if (!map[key]) return { success: false, error: 'concept not found' };
  delete map[key];
  saveNameMap(map);
  return { success: true };
}

/**
 * List all concept mappings.
 */
function listConcepts() {
  return loadNameMap();
}

// =============================================================================
// INCONSISTENCY DETECTION
// =============================================================================

/**
 * Detect naming inconsistencies across the project registry.
 * Cross-references all registry domains to find mismatched terminology.
 *
 * @param {object} opts - { projectRoot? }
 * @returns {Array<{ concept, inconsistencies: Array }>}
 */
function detectInconsistencies(opts) {
  opts = opts || {};

  let registry;
  try {
    registry = require('./project-registry');
  } catch (e) {
    return [];
  }

  const results = [];
  const conceptGroups = buildConceptGroups(registry);

  for (const [concept, group] of Object.entries(conceptGroups)) {
    const baseNames = extractBaseNames(group);
    if (baseNames.size <= 1) continue; // All consistent

    // Found inconsistency — different base names for same concept
    const inconsistencies = [];
    for (const entry of group) {
      inconsistencies.push({
        domain: entry.domain,
        name: entry.name,
        base_name: normalizeToBase(entry.name),
        file_path: entry.file_path
      });
    }

    results.push({
      concept,
      base_names: [...baseNames],
      inconsistencies,
      suggestion: `Use consistent naming: pick one of [${[...baseNames].join(', ')}]`
    });
  }

  return results;
}

/**
 * Build groups of related entries across domains.
 * Groups entries that share a root concept (e.g. "user" groups: users table, /users API, UserList component).
 */
function buildConceptGroups(registry) {
  const groups = {};
  const domains = ['pages', 'components', 'apis', 'database'];

  for (const domain of domains) {
    const entries = registry.listAll(domain);
    for (const entry of entries) {
      const base = normalizeToBase(entry.name);
      if (!base) continue;

      if (!groups[base]) groups[base] = [];
      groups[base].push({ ...entry, domain });
    }
  }

  // Only return groups that span multiple domains
  const multiDomain = {};
  for (const [base, entries] of Object.entries(groups)) {
    const domains = new Set(entries.map(e => e.domain));
    if (domains.size > 1) {
      multiDomain[base] = entries;
    }
  }

  return multiDomain;
}

/**
 * Extract unique base names from a group.
 */
function extractBaseNames(group) {
  const bases = new Set();
  for (const entry of group) {
    bases.add(normalizeToBase(entry.name));
  }
  return bases;
}

// =============================================================================
// NAME NORMALIZATION
// =============================================================================

/**
 * Normalize a name to its base concept.
 * "UserList" → "user", "users" → "user", "/api/users" → "user"
 * "ProductCard" → "product", "products" → "product"
 */
function normalizeToBase(name) {
  if (!name) return '';

  // Remove common prefixes/suffixes
  let cleaned = name
    .replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/i, '') // HTTP method prefix
    .replace(/^\/api\//, '') // API prefix
    .replace(/^\//, '') // Leading slash
    .replace(/\/:?\w+$/g, '') // URL params like /:id
    .trim();

  // Split camelCase/PascalCase
  cleaned = cleaned
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

  // Take the first word (the noun/concept)
  const words = cleaned.toLowerCase().split(/[\s_\-/]+/).filter(w => w.length > 0);

  // Remove common suffixes: List, Card, Page, View, Controller, Service, Schema, Model, Table
  const suffixes = ['list', 'card', 'page', 'view', 'controller', 'service', 'schema', 'model', 'table', 'route', 'handler', 'form', 'detail', 'item'];

  if (words.length > 1) {
    const lastWord = words[words.length - 1];
    if (suffixes.includes(lastWord)) {
      words.pop();
    }
  }

  // Singularize simple cases
  const base = words.join('');
  return singularize(base);
}

/**
 * Simple singularization (handles common English plurals).
 */
function singularize(word) {
  if (!word) return word;

  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('zes')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);

  return word;
}

// =============================================================================
// CHECK BEFORE WRITE
// =============================================================================

/**
 * Check if a new name being used is consistent with existing naming.
 *
 * @param {string} name - The name being used
 * @param {string} domain - Which layer: database, apis, components, pages
 * @returns {{ consistent, suggestion? }}
 */
function checkNameConsistency(name, domain) {
  if (!name || !domain) return { consistent: true };

  const base = normalizeToBase(name);
  const nameMap = loadNameMap();

  // Check if this concept has a registered canonical form
  const mapping = nameMap[base];
  if (mapping && mapping[domain]) {
    const expected = mapping[domain];
    if (name !== expected) {
      return {
        consistent: false,
        suggestion: `Use "${expected}" instead of "${name}" for consistency with the "${base}" concept`
      };
    }
  }

  return { consistent: true };
}

// =============================================================================
// AUTO-LEARN FROM REGISTRY
// =============================================================================

/**
 * Auto-populate the name map from the current project registry.
 * Scans all domains and groups entries by base concept.
 */
function autoLearnFromRegistry() {
  let registry;
  try {
    registry = require('./project-registry');
  } catch (e) {
    return { learned: 0 };
  }

  const groups = buildConceptGroups(registry);
  const map = loadNameMap();
  let learned = 0;

  for (const [base, entries] of Object.entries(groups)) {
    if (map[base]) continue; // Already mapped

    const concept = {
      canonical: base,
      updated_at: new Date().toISOString()
    };

    for (const entry of entries) {
      const domainKey = domainToLayer(entry.domain);
      if (domainKey) {
        concept[domainKey] = entry.name;
      }
    }

    map[base] = concept;
    learned++;
  }

  if (learned > 0) {
    saveNameMap(map);
  }

  return { learned };
}

function domainToLayer(domain) {
  const mapping = {
    pages: 'page',
    components: 'component',
    apis: 'api',
    database: 'database'
  };
  return mapping[domain] || null;
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Concept mapping
  registerConcept,
  getConcept,
  removeConcept,
  listConcepts,

  // Inconsistency detection
  detectInconsistencies,
  buildConceptGroups,
  checkNameConsistency,

  // Auto-learning
  autoLearnFromRegistry,

  // Normalization
  normalizeToBase,
  singularize
};
