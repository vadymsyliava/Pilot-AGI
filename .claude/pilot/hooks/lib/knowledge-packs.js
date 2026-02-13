/**
 * Knowledge Packs — Export/Import (Phase 5.8)
 *
 * Shareable knowledge packs: bundle selected knowledge into a JSON file,
 * import packs into the global knowledge base, and validate pack integrity.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PACK_SCHEMA_VERSION = '1.0';

// =============================================================================
// EXPORT
// =============================================================================

/**
 * Export knowledge entries into a shareable pack file.
 *
 * @param {string[]} [types] - Knowledge types to include (null = all)
 * @param {string} outputPath - File path for the pack
 * @param {object} [opts] - { knowledgePath }
 * @returns {{ path: string, entries: number, size: number }}
 */
function exportPack(types, outputPath, opts) {
  opts = opts || {};
  const knowledge = require('./cross-project-knowledge');
  const index = knowledge.loadIndex(opts);

  let entries = index.entries;
  if (types && types.length > 0) {
    entries = entries.filter(e => types.includes(e.type));
  }

  // Load full entry data
  const fullEntries = [];
  for (const indexEntry of entries) {
    const typeDir = path.join(
      (opts.knowledgePath || knowledge.DEFAULT_KNOWLEDGE_PATH),
      indexEntry.type
    );
    const entryPath = path.join(typeDir, `${indexEntry.id}.json`);
    try {
      if (fs.existsSync(entryPath)) {
        const data = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
        fullEntries.push(data);
      }
    } catch (e) {
      // Skip corrupted entries
    }
  }

  const pack = {
    schema_version: PACK_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    entry_count: fullEntries.length,
    checksum: _computeChecksum(fullEntries),
    entries: fullEntries
  };

  // Ensure output directory exists
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const content = JSON.stringify(pack, null, 2);
  fs.writeFileSync(outputPath, content);

  return {
    path: outputPath,
    entries: fullEntries.length,
    size: Buffer.byteLength(content)
  };
}

// =============================================================================
// IMPORT
// =============================================================================

/**
 * Import a knowledge pack into the global knowledge base.
 *
 * @param {string} packPath - Path to the pack file
 * @param {object} [opts] - { knowledgePath }
 * @returns {{ imported: number, skipped: number, errors: number }}
 */
function importPack(packPath, opts) {
  opts = opts || {};

  // Validate first
  const validation = validatePack(packPath);
  if (!validation.valid) {
    return { imported: 0, skipped: 0, errors: 1, issues: validation.issues };
  }

  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  const knowledge = require('./cross-project-knowledge');

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const entry of pack.entries) {
    try {
      if (!entry.type || !entry.content) {
        errors++;
        continue;
      }

      const result = knowledge.publishKnowledge(
        entry.type,
        entry.content,
        null, // No source project for imports
        {
          knowledgePath: opts.knowledgePath || undefined,
          anonymizeLevel: 'none' // Already anonymized in pack
        }
      );

      if (result.deduplicated) {
        skipped++;
      } else if (result.excluded) {
        skipped++;
      } else {
        imported++;
      }
    } catch (e) {
      errors++;
    }
  }

  return { imported, skipped, errors };
}

// =============================================================================
// VALIDATION
// =============================================================================

/**
 * Validate a knowledge pack file.
 *
 * @param {string} packPath - Path to the pack file
 * @returns {{ valid: boolean, issues: string[] }}
 */
function validatePack(packPath) {
  const issues = [];

  // Check file exists
  if (!fs.existsSync(packPath)) {
    return { valid: false, issues: ['Pack file does not exist'] };
  }

  // Parse JSON
  let pack;
  try {
    pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  } catch (e) {
    return { valid: false, issues: [`Invalid JSON: ${e.message}`] };
  }

  // Check schema version
  if (!pack.schema_version) {
    issues.push('Missing schema_version');
  } else if (pack.schema_version !== PACK_SCHEMA_VERSION) {
    issues.push(`Unsupported schema version: ${pack.schema_version} (expected ${PACK_SCHEMA_VERSION})`);
  }

  // Check entries
  if (!Array.isArray(pack.entries)) {
    issues.push('Missing or invalid entries array');
    return { valid: false, issues };
  }

  // Check entry count matches
  if (pack.entry_count !== undefined && pack.entry_count !== pack.entries.length) {
    issues.push(`Entry count mismatch: declared ${pack.entry_count}, found ${pack.entries.length}`);
  }

  // Verify checksum
  if (pack.checksum) {
    const computed = _computeChecksum(pack.entries);
    if (computed !== pack.checksum) {
      issues.push('Checksum mismatch — pack may be corrupted or tampered with');
    }
  }

  // Validate each entry
  const knowledge = require('./cross-project-knowledge');
  const validTypes = knowledge.KNOWLEDGE_TYPES;

  for (let i = 0; i < pack.entries.length; i++) {
    const entry = pack.entries[i];

    if (!entry.type) {
      issues.push(`Entry ${i}: missing type`);
    } else if (!validTypes.includes(entry.type)) {
      issues.push(`Entry ${i}: invalid type '${entry.type}'`);
    }

    if (!entry.content || typeof entry.content !== 'object') {
      issues.push(`Entry ${i}: missing or invalid content`);
    }

    if (!entry.id) {
      issues.push(`Entry ${i}: missing id`);
    }
  }

  return { valid: issues.length === 0, issues };
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Compute a checksum over entries for integrity verification.
 * @param {object[]} entries
 * @returns {string} SHA-256 hex
 */
function _computeChecksum(entries) {
  const content = JSON.stringify(entries.map(e => ({
    id: e.id,
    type: e.type,
    content: e.content
  })));
  return crypto.createHash('sha256').update(content).digest('hex');
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  exportPack,
  importPack,
  validatePack,

  // Constants
  PACK_SCHEMA_VERSION
};
