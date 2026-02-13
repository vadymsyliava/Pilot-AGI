/**
 * Registry Enforcement — Phase 8.6 (Pilot AGI-etpl)
 *
 * Checks the project registry before file creation/edits to prevent
 * duplicate pages, components, APIs, and database entities.
 *
 * Integration:
 * - pre-tool-use.js: call checkBeforeWrite(filePath) on Edit/Write
 * - session-start.js: call buildRegistryContext() for agent context
 */

const fs = require('fs');
const path = require('path');

// =============================================================================
// PRE-WRITE CHECK
// =============================================================================

/**
 * Check if a file write could create a duplicate registry entry.
 *
 * @param {string} filePath - File being created/edited
 * @param {object} opts - { projectRoot?, isNewFile? }
 * @returns {{ allowed, warning?, suggestion? }}
 */
function checkBeforeWrite(filePath, opts) {
  if (!filePath) return { allowed: true };
  opts = opts || {};
  const projectRoot = opts.projectRoot || process.cwd();

  // Only check new file creation, not edits to existing files
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  if (fs.existsSync(fullPath) && !opts.isNewFile) {
    return { allowed: true };
  }

  const relPath = path.isAbsolute(filePath)
    ? path.relative(projectRoot, filePath)
    : filePath;

  let registry;
  try {
    registry = require('./project-registry');
  } catch (e) {
    return { allowed: true }; // Registry not available
  }

  // Determine what type of file is being created
  const fileType = classifyFile(relPath);
  if (!fileType) return { allowed: true }; // Not a registry-trackable file type

  // Check for path duplicates across the relevant domain
  const pathMatches = registry.findByPath(fileType.domain, relPath);
  if (pathMatches.length > 0) {
    return {
      allowed: true, // Editing existing registered file is OK
      info: 'File is registered in project registry'
    };
  }

  // Infer a name from the file path
  const inferredName = inferName(relPath, fileType);

  // Check for name duplicates
  if (inferredName) {
    const nameMatches = registry.findByName(fileType.domain, inferredName);
    if (nameMatches.length > 0) {
      const existing = nameMatches[0];
      return {
        allowed: true, // Don't block — warn instead
        warning: `Similar ${fileType.domain} entry exists: "${existing.name}" at ${existing.file_path}`,
        suggestion: `Consider using the existing ${fileType.label} instead of creating a new one.`,
        existing: { name: existing.name, file_path: existing.file_path, domain: fileType.domain }
      };
    }

    // Cross-domain check
    const crossDup = registry.findCrossDomainDuplicate(inferredName);
    if (crossDup) {
      return {
        allowed: true,
        warning: `Name "${inferredName}" already exists in ${crossDup.domain}: "${crossDup.entry.name}" at ${crossDup.entry.file_path}`,
        suggestion: 'Use consistent naming across pages, components, APIs, and database.'
      };
    }
  }

  return { allowed: true };
}

// =============================================================================
// CONTEXT BUILDER — for session-start injection
// =============================================================================

/**
 * Build registry context for agent session start.
 *
 * @param {object} opts - { projectRoot? }
 * @returns {object|null} Registry summary for context injection
 */
function buildRegistryContext(opts) {
  opts = opts || {};

  let registry;
  try {
    registry = require('./project-registry');
  } catch (e) {
    return null;
  }

  const stats = registry.getStats();
  if (stats.total === 0) return null;

  const summary = registry.buildSummary();

  return {
    total_entries: stats.total,
    pages: summary.pages.count > 0 ? summary.pages : undefined,
    components: summary.components.count > 0 ? summary.components : undefined,
    apis: summary.apis.count > 0 ? summary.apis : undefined,
    database: summary.database.count > 0 ? summary.database : undefined
  };
}

// =============================================================================
// FILE CLASSIFICATION
// =============================================================================

/**
 * Classify a file path into a registry domain.
 */
function classifyFile(relPath) {
  const normalized = relPath.replace(/\\/g, '/');

  // Skip test/config/build files
  if (/\.(test|spec|stories)\.(tsx?|jsx?|vue|svelte)$/.test(normalized)) return null;
  if (/\.(config|rc)\.(ts|js|mjs|json)$/.test(normalized)) return null;
  if (normalized.includes('node_modules/')) return null;
  if (normalized.includes('__tests__/')) return null;

  // Pages
  if (/^(src\/)?(app|pages)\//.test(normalized) && /\.(tsx|jsx|vue|svelte)$/.test(normalized)) {
    // Exclude layout/loading/error files
    if (/\/(layout|loading|error|not-found)\.(tsx|jsx|ts|js)$/.test(normalized)) return null;
    return { domain: 'pages', label: 'page' };
  }

  // Components
  if (/^(src\/)?(components|ui)\//.test(normalized) && /\.(tsx|jsx|vue|svelte)$/.test(normalized)) {
    return { domain: 'components', label: 'component' };
  }

  // APIs
  if (/^(src\/)?(api|routes)\//.test(normalized) && /\.(ts|js|mjs)$/.test(normalized)) {
    return { domain: 'apis', label: 'API endpoint' };
  }
  if (/^(src\/)?app\/api\//.test(normalized) && /route\.(ts|js)$/.test(normalized)) {
    return { domain: 'apis', label: 'API route' };
  }

  // Database
  if (/schema\.prisma$/.test(normalized)) return { domain: 'database', label: 'database schema' };
  if (/^(src\/)?(db|models|schema)\//.test(normalized) && /\.(ts|js)$/.test(normalized)) {
    return { domain: 'database', label: 'database model' };
  }

  return null;
}

/**
 * Infer a name from a file path.
 */
function inferName(relPath, fileType) {
  const parsed = path.parse(relPath);

  if (parsed.name === 'page' || parsed.name === 'route' || parsed.name === 'index') {
    // Use parent directory name
    const parts = path.dirname(relPath).split(path.sep);
    return parts[parts.length - 1] || null;
  }

  return parsed.name || null;
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  checkBeforeWrite,
  buildRegistryContext,
  classifyFile,
  inferName
};
