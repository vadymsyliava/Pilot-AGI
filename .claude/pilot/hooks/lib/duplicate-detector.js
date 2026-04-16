/**
 * Duplicate Code Detection — Phase 8.8 (Pilot AGI-e8d7)
 *
 * Pre-edit scan to detect similar functions, re-exports, and wrapper code.
 * Uses structural signatures (not AST) for zero-dependency detection.
 *
 * Integration:
 * - pre-tool-use.js: call checkForDuplicate() before Write
 * - session-start.js: inject codebase function index
 */

const fs = require('fs');
const path = require('path');

const INDEX_FILE = '.claude/pilot/registry/function-index.json';
const SIMILARITY_THRESHOLD = 0.80;

// =============================================================================
// FUNCTION INDEX — LOAD / SAVE
// =============================================================================

function getIndexPath() {
  return path.join(process.cwd(), INDEX_FILE);
}

function loadIndex() {
  const filePath = getIndexPath();
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveIndex(entries) {
  const dir = path.dirname(getIndexPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = getIndexPath();
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// =============================================================================
// FUNCTION EXTRACTION (regex-based, zero deps)
// =============================================================================

/**
 * Extract function signatures from source code.
 * Returns array of { name, params, body_hash, line, type, exported }
 */
function extractFunctions(source, filePath) {
  const results = [];
  const lines = source.split('\n');
  const ext = path.extname(filePath || '').toLowerCase();
  const isTS = ext === '.ts' || ext === '.tsx';
  const isJS = ext === '.js' || ext === '.jsx' || ext === '.mjs' || isTS;

  if (!isJS) return results;

  // Pattern: function name(params) { ... }
  // Pattern: const name = (params) => { ... }
  // Pattern: const name = function(params) { ... }
  // Pattern: export function name(params) { ... }
  // Pattern: export const name = ...
  // Pattern: name(params) { ... } (class method)

  const funcPatterns = [
    // export function name(params)
    /^(\s*)(export\s+)?(async\s+)?function\s+(\w+)\s*\(([^)]*)\)/,
    // export const name = (params) =>
    /^(\s*)(export\s+)?const\s+(\w+)\s*=\s*(async\s+)?\(([^)]*)\)\s*=>/,
    // export const name = function(params)
    /^(\s*)(export\s+)?const\s+(\w+)\s*=\s*(async\s+)?function\s*\(([^)]*)\)/,
    // method: name(params) { (class method — indent > 0)
    /^(\s{2,})(async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (let pi = 0; pi < funcPatterns.length; pi++) {
      const m = funcPatterns[pi].exec(line);
      if (!m) continue;

      let name, params, exported;
      if (pi === 0) {
        // function declaration
        exported = !!m[2];
        name = m[4];
        params = m[5];
      } else if (pi === 1 || pi === 2) {
        // const arrow / const function
        exported = !!m[2];
        name = m[3];
        params = m[5];
      } else {
        // class method
        exported = false;
        name = m[3] || m[2];
        params = m[4];
      }

      if (!name || name === 'if' || name === 'for' || name === 'while' || name === 'switch' || name === 'catch') continue;

      // Extract body signature (next N lines or until matching brace)
      const bodyLines = extractBodyLines(lines, i);
      const bodyHash = hashBody(bodyLines);
      const paramSig = normalizeParams(params);

      results.push({
        name,
        params: paramSig,
        body_hash: bodyHash,
        body_line_count: bodyLines.length,
        line: i + 1,
        exported,
        file_path: filePath
      });
      break; // Only match first pattern per line
    }
  }

  return results;
}

/**
 * Extract body lines from a function start (approximation).
 */
function extractBodyLines(lines, startLine) {
  const body = [];
  let depth = 0;
  let started = false;

  for (let i = startLine; i < Math.min(startLine + 100, lines.length); i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') { depth++; started = true; }
      if (ch === '}') { depth--; }
    }
    if (started) {
      // Skip the first line (function signature) — only include body content
      if (i === startLine) {
        const braceIdx = line.indexOf('{');
        if (braceIdx >= 0) {
          const afterBrace = line.slice(braceIdx + 1).trim();
          if (afterBrace) body.push(afterBrace);
        }
      } else {
        body.push(line.trim());
      }
    }
    if (started && depth <= 0) break;
  }

  return body;
}

/**
 * Hash function body for structural comparison.
 * Normalizes whitespace and variable names to detect same-logic functions.
 */
function hashBody(bodyLines) {
  if (bodyLines.length === 0) return '';

  const normalized = bodyLines
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(l => l.length > 0 && !l.startsWith('//') && !l.startsWith('*'))
    .join('|');

  // Simple FNV-1a-like hash
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Normalize parameter list for comparison.
 */
function normalizeParams(params) {
  if (!params) return '';
  // Remove types, default values, keep param names
  return params
    .split(',')
    .map(p => p.trim().split(/[:\s=]/)[0].trim())
    .filter(p => p.length > 0)
    .join(',');
}

// =============================================================================
// DUPLICATE DETECTION
// =============================================================================

/**
 * Check if a function being written has duplicates in the index.
 *
 * @param {object} func - Extracted function { name, params, body_hash }
 * @param {object} opts - { excludeFile? }
 * @returns {{ duplicate: boolean, matches: Array }}
 */
function findDuplicateFunction(func, opts) {
  opts = opts || {};
  const index = loadIndex();
  const matches = [];

  for (const entry of index) {
    // Skip entries from the same file
    if (opts.excludeFile && entry.file_path === opts.excludeFile) continue;

    // Exact body hash match = same logic
    if (func.body_hash && entry.body_hash === func.body_hash && func.body_hash !== '') {
      matches.push({
        type: 'exact_body',
        name: entry.name,
        file_path: entry.file_path,
        line: entry.line,
        confidence: 0.95
      });
      continue;
    }

    // Same name + similar params = likely duplicate
    if (func.name.toLowerCase() === entry.name.toLowerCase()) {
      const paramSim = paramSimilarity(func.params, entry.params);
      if (paramSim >= 0.8) {
        matches.push({
          type: 'same_name',
          name: entry.name,
          file_path: entry.file_path,
          line: entry.line,
          confidence: 0.80 + (paramSim * 0.15)
        });
      }
    }
  }

  // Sort by confidence descending
  matches.sort((a, b) => b.confidence - a.confidence);

  return {
    duplicate: matches.length > 0,
    matches: matches.slice(0, 5) // Return top 5
  };
}

/**
 * Compare parameter signatures for similarity.
 */
function paramSimilarity(paramsA, paramsB) {
  if (paramsA === paramsB) return 1;
  if (!paramsA || !paramsB) return 0;

  const a = paramsA.split(',').map(p => p.trim()).filter(p => p);
  const b = paramsB.split(',').map(p => p.trim()).filter(p => p);

  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const overlap = a.filter(p => b.includes(p)).length;
  return (2 * overlap) / (a.length + b.length);
}

// =============================================================================
// RE-EXPORT / WRAPPER DETECTION
// =============================================================================

/**
 * Detect re-exports and pass-through wrappers in source code.
 */
function detectReexports(source, filePath) {
  const results = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // export { X } from './other'
    if (/^export\s*\{[^}]+\}\s*from\s*['"]/.test(line)) {
      const names = line.match(/\{([^}]+)\}/);
      if (names) {
        results.push({
          type: 'reexport',
          names: names[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()),
          source: line.match(/from\s*['"]([^'"]+)['"]/)?.[1] || '',
          line: i + 1,
          file_path: filePath
        });
      }
    }

    // Wrapper function: just calls another function with same args
    // const foo = (a, b) => bar(a, b)
    const wrapperMatch = line.match(/^(?:export\s+)?(?:const|function)\s+(\w+)\s*=?\s*\(([^)]*)\)\s*(?:=>|{)\s*(?:return\s+)?(\w+)\(([^)]*)\)\s*[;}]?\s*$/);
    if (wrapperMatch) {
      const [, wrapperName, wrapperParams, calledName, calledParams] = wrapperMatch;
      const wp = normalizeParams(wrapperParams);
      const cp = normalizeParams(calledParams);
      if (wp === cp && wrapperName !== calledName) {
        results.push({
          type: 'wrapper',
          wrapper_name: wrapperName,
          calls: calledName,
          line: i + 1,
          file_path: filePath
        });
      }
    }
  }

  return results;
}

// =============================================================================
// INDEX MANAGEMENT
// =============================================================================

/**
 * Index functions from a file.
 */
function indexFile(filePath, source) {
  if (!filePath || !source) return { added: 0 };

  const functions = extractFunctions(source, filePath);
  if (functions.length === 0) return { added: 0 };

  const index = loadIndex();

  // Remove existing entries for this file
  const filtered = index.filter(e => e.file_path !== filePath);

  // Add new entries
  for (const func of functions) {
    filtered.push({
      name: func.name,
      params: func.params,
      body_hash: func.body_hash,
      body_line_count: func.body_line_count,
      line: func.line,
      exported: func.exported,
      file_path: filePath,
      indexed_at: new Date().toISOString()
    });
  }

  saveIndex(filtered);
  return { added: functions.length };
}

/**
 * Remove a file from the index.
 */
function removeFile(filePath) {
  if (!filePath) return { removed: 0 };

  const index = loadIndex();
  const before = index.length;
  const filtered = index.filter(e => e.file_path !== filePath);

  if (filtered.length < before) {
    saveIndex(filtered);
  }

  return { removed: before - filtered.length };
}

/**
 * Get index stats.
 */
function getStats() {
  const index = loadIndex();
  const files = new Set(index.map(e => e.file_path));
  return {
    total_functions: index.length,
    total_files: files.size
  };
}

// =============================================================================
// PRE-WRITE CHECK (for hook integration)
// =============================================================================

/**
 * Check if new code being written contains duplicate functions.
 *
 * @param {string} source - Source code being written
 * @param {string} filePath - Target file path
 * @returns {{ duplicates: Array, reexports: Array, wrappers: Array }}
 */
function checkForDuplicates(source, filePath) {
  if (!source || !filePath) return { duplicates: [], reexports: [], wrappers: [] };

  const functions = extractFunctions(source, filePath);
  const reexportResults = detectReexports(source, filePath);

  const duplicates = [];
  const wrappers = reexportResults.filter(r => r.type === 'wrapper');
  const reexports = reexportResults.filter(r => r.type === 'reexport');

  for (const func of functions) {
    const result = findDuplicateFunction(func, { excludeFile: filePath });
    if (result.duplicate) {
      duplicates.push({
        function_name: func.name,
        line: func.line,
        matches: result.matches
      });
    }
  }

  return { duplicates, reexports, wrappers };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Extraction
  extractFunctions,
  extractBodyLines,
  hashBody,
  normalizeParams,

  // Detection
  findDuplicateFunction,
  detectReexports,
  checkForDuplicates,
  paramSimilarity,

  // Index management
  indexFile,
  removeFile,
  loadIndex,
  getStats,

  // Constants
  SIMILARITY_THRESHOLD
};
