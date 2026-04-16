/**
 * Dead Code & Legacy Detector — Phase 8.9 (Pilot AGI-t7d1)
 *
 * Detects unused exports, backward-compat shims, stale TODOs,
 * and deprecated patterns that have canonical replacements.
 *
 * Zero external dependencies — regex-based scanning.
 */

const fs = require('fs');
const path = require('path');

const REPORT_FILE = '.claude/pilot/registry/dead-code-report.json';
const STALE_TODO_DAYS = 14;

// =============================================================================
// UNUSED EXPORT DETECTION
// =============================================================================

/**
 * Find exports in a file that are not imported anywhere in the project.
 *
 * @param {string} filePath - File to check exports for
 * @param {string} projectRoot - Project root directory
 * @param {object} opts - { sourceFiles?: string[] }
 * @returns {Array<{ name, line, type }>}
 */
function findUnusedExports(filePath, projectRoot, opts) {
  opts = opts || {};
  if (!filePath || !projectRoot) return [];

  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  if (!fs.existsSync(fullPath)) return [];

  const source = fs.readFileSync(fullPath, 'utf8');
  const exports = extractExports(source);
  if (exports.length === 0) return [];

  // Get all source files to search for imports
  const sourceFiles = opts.sourceFiles || discoverSourceFiles(projectRoot);
  const relPath = path.relative(projectRoot, fullPath);

  const unused = [];
  for (const exp of exports) {
    const isUsed = sourceFiles.some(sf => {
      if (sf === relPath) return false; // Skip self
      const sfFull = path.join(projectRoot, sf);
      if (!fs.existsSync(sfFull)) return false;

      const sfSource = fs.readFileSync(sfFull, 'utf8');
      return isImported(exp.name, sfSource, relPath);
    });

    if (!isUsed) {
      unused.push(exp);
    }
  }

  return unused;
}

/**
 * Extract named exports from source code.
 */
function extractExports(source) {
  const exports = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // export function name
    const funcMatch = line.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
    if (funcMatch) {
      exports.push({ name: funcMatch[1], line: i + 1, type: 'function' });
      continue;
    }

    // export const/let/var name
    const constMatch = line.match(/^export\s+(?:const|let|var)\s+(\w+)/);
    if (constMatch) {
      exports.push({ name: constMatch[1], line: i + 1, type: 'variable' });
      continue;
    }

    // export class name
    const classMatch = line.match(/^export\s+class\s+(\w+)/);
    if (classMatch) {
      exports.push({ name: classMatch[1], line: i + 1, type: 'class' });
      continue;
    }

    // export { name1, name2 }
    const namedMatch = line.match(/^export\s*\{([^}]+)\}/);
    if (namedMatch && !line.includes('from')) {
      const names = namedMatch[1].split(',').map(n => {
        const parts = n.trim().split(/\s+as\s+/);
        return parts[parts.length - 1].trim();
      });
      for (const name of names) {
        if (name) exports.push({ name, line: i + 1, type: 'named' });
      }
    }
  }

  return exports;
}

/**
 * Check if a name is imported in source code.
 */
function isImported(name, source, fromPath) {
  // Direct name usage (import { name } or require... or just referenced)
  const nameRegex = new RegExp(`\\b${escapeRegex(name)}\\b`);
  return nameRegex.test(source);
}

// =============================================================================
// BACKWARD-COMPAT SHIM DETECTION
// =============================================================================

/**
 * Detect backward-compatibility patterns in source code.
 *
 * @param {string} source - Source code
 * @param {string} filePath - File path
 * @returns {Array<{ type, line, description }>}
 */
function detectBackwardCompat(source, filePath) {
  const results = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Renamed unused variables with underscore prefix
    // const _oldName = newName;
    if (/^(?:const|let|var)\s+_\w+\s*=\s*\w+/.test(trimmed) &&
        !trimmed.includes('function') && !trimmed.includes('=>')) {
      results.push({
        type: 'renamed_unused',
        line: i + 1,
        description: `Possible renamed variable with underscore prefix: ${trimmed.slice(0, 60)}`
      });
    }

    // "// removed" or "// deprecated" comments
    if (/\/\/\s*(removed|deprecated|legacy|backward.?compat|compat.?shim)/i.test(trimmed)) {
      results.push({
        type: 'legacy_comment',
        line: i + 1,
        description: `Legacy/deprecated comment: ${trimmed.slice(0, 60)}`
      });
    }

    // Re-export aliases: export { newName as oldName }
    if (/^export\s*\{[^}]*\bas\b/.test(trimmed) && !trimmed.includes('from')) {
      results.push({
        type: 'compat_alias',
        line: i + 1,
        description: `Re-export alias (possible compat shim): ${trimmed.slice(0, 60)}`
      });
    }
  }

  return results;
}

// =============================================================================
// STALE TODO/FIXME DETECTION
// =============================================================================

/**
 * Find TODO/FIXME/HACK comments in source code.
 *
 * @param {string} source - Source code
 * @param {string} filePath - File path
 * @param {object} opts - { staleDays? }
 * @returns {Array<{ type, line, text, stale }>}
 */
function findTodos(source, filePath, opts) {
  opts = opts || {};
  const staleDays = opts.staleDays || STALE_TODO_DAYS;
  const results = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/\/\/\s*(TODO|FIXME|HACK|XXX|TEMP)[\s:]*(.*)$/i) ||
                  line.match(/\/\*\s*(TODO|FIXME|HACK|XXX|TEMP)[\s:]*(.*)$/i);

    if (match) {
      const type = match[1].toUpperCase();
      const text = match[2].trim();

      // Check if there's a date in the comment
      const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
      let stale = false;
      if (dateMatch) {
        const todoDate = new Date(dateMatch[1]);
        const now = new Date();
        const daysDiff = (now - todoDate) / (1000 * 60 * 60 * 24);
        stale = daysDiff > staleDays;
      }

      results.push({
        type,
        line: i + 1,
        text: text.slice(0, 100),
        stale,
        file_path: filePath
      });
    }
  }

  return results;
}

// =============================================================================
// DEPRECATED PATTERN DETECTION
// =============================================================================

/**
 * Check source code for patterns that have canonical replacements.
 *
 * @param {string} source - Source code
 * @param {string} filePath - File path
 * @returns {Array<{ pattern, line, replacement, confidence }>}
 */
function findDeprecatedPatterns(source, filePath) {
  const results = [];

  // Only try to load canonical-patterns if available
  let canonicalPatterns;
  try {
    canonicalPatterns = require('./canonical-patterns');
  } catch (e) {
    return results; // No canonical patterns module available
  }

  const canonical = canonicalPatterns.listCanonical();
  if (canonical.length === 0) return results;

  const lines = source.split('\n');

  // Check for anti-patterns that conflict with canonical rules
  for (const pattern of canonical) {
    if (!pattern.rule) continue;

    // Simple heuristic: check if the rule mentions specific patterns to avoid
    const avoidMatch = pattern.rule.match(/(?:avoid|don't use|never use|instead of)\s+["`']?(\w+)/i);
    if (avoidMatch) {
      const avoidTerm = avoidMatch[1];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(avoidTerm)) {
          results.push({
            pattern: pattern.name,
            line: i + 1,
            replacement: pattern.rule,
            confidence: 0.5 // Low confidence — heuristic-based
          });
        }
      }
    }
  }

  return results;
}

// =============================================================================
// FULL SCAN
// =============================================================================

/**
 * Run a full dead code scan on a file.
 *
 * @param {string} filePath - File to scan
 * @param {string} projectRoot - Project root
 * @param {object} opts - { sourceFiles?, staleDays? }
 * @returns {object} Scan results
 */
function scanFile(filePath, projectRoot, opts) {
  opts = opts || {};
  projectRoot = projectRoot || process.cwd();

  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  if (!fs.existsSync(fullPath)) return { error: 'file not found' };

  const source = fs.readFileSync(fullPath, 'utf8');

  return {
    file_path: filePath,
    unused_exports: findUnusedExports(filePath, projectRoot, opts),
    backward_compat: detectBackwardCompat(source, filePath),
    todos: findTodos(source, filePath, opts),
    deprecated_patterns: findDeprecatedPatterns(source, filePath)
  };
}

/**
 * Calculate a quality score penalty based on dead code findings.
 * Returns a penalty value (0 to 1) where 0 = no issues, 1 = max penalty.
 */
function calculatePenalty(scanResult) {
  let penalty = 0;

  if (scanResult.unused_exports) {
    penalty += Math.min(scanResult.unused_exports.length * 0.05, 0.3);
  }
  if (scanResult.backward_compat) {
    penalty += Math.min(scanResult.backward_compat.length * 0.1, 0.3);
  }
  if (scanResult.todos) {
    const staleTodos = scanResult.todos.filter(t => t.stale);
    penalty += Math.min(staleTodos.length * 0.05, 0.2);
  }
  if (scanResult.deprecated_patterns) {
    penalty += Math.min(scanResult.deprecated_patterns.length * 0.05, 0.2);
  }

  return Math.min(penalty, 1);
}

// =============================================================================
// REPORT MANAGEMENT
// =============================================================================

/**
 * Save a scan report.
 */
function saveReport(report) {
  const dir = path.dirname(path.join(process.cwd(), REPORT_FILE));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(process.cwd(), REPORT_FILE);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');
}

/**
 * Load the last scan report.
 */
function loadReport() {
  const filePath = path.join(process.cwd(), REPORT_FILE);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Discover JS/TS source files in the project (shallow, fast).
 */
function discoverSourceFiles(projectRoot) {
  const files = [];
  const extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs'];
  const skipDirs = ['node_modules', '.git', 'dist', 'build', '.next', '.claude'];

  function walk(dir, depth) {
    if (depth > 5) return; // Limit depth
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      if (skipDirs.includes(entry.name)) continue;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (extensions.includes(path.extname(entry.name).toLowerCase())) {
        files.push(path.relative(projectRoot, full));
      }
    }
  }

  walk(projectRoot, 0);
  return files;
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Core detection
  findUnusedExports,
  extractExports,
  detectBackwardCompat,
  findTodos,
  findDeprecatedPatterns,

  // Scanning
  scanFile,
  calculatePenalty,
  discoverSourceFiles,

  // Reports
  saveReport,
  loadReport,

  // Constants
  STALE_TODO_DAYS
};
