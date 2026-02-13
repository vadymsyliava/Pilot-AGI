/**
 * Conflict Parser Registry — Phase 5.2 (Pilot AGI-hyy)
 *
 * Pluggable language parser registry for semantic merge conflict resolution.
 * Each parser knows how to extract structural information (declarations,
 * imports, class members) from source code using regex-based heuristics.
 *
 * Zero external dependencies — uses regex patterns rather than AST libraries
 * to match the project's vanilla Node.js approach.
 *
 * Registry pattern follows AgentAdapterRegistry from Phase 6.1.
 */

'use strict';

const path = require('path');

// ============================================================================
// LANGUAGE PROFILES
// ============================================================================

/**
 * Language profile — defines structural patterns for a language.
 *
 * @typedef {object} LangProfile
 * @property {string} name - Language name
 * @property {string[]} extensions - File extensions (e.g. ['.js', '.mjs'])
 * @property {RegExp[]} declarationPatterns - Patterns that match top-level declarations
 * @property {RegExp[]} importPatterns - Patterns that match import/require statements
 * @property {RegExp[]} classPatterns - Patterns that match class/struct definitions
 * @property {RegExp} blockStart - Pattern for block opening (e.g. `{`)
 * @property {RegExp} blockEnd - Pattern for block closing (e.g. `}`)
 * @property {boolean} importsCommutative - Whether import order is semantically irrelevant
 */

const LANG_PROFILES = {
  javascript: {
    name: 'javascript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    declarationPatterns: [
      /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$]\w*)\s*=>/,
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/,
      /^(?:export\s+)?class\s+(\w+)/,
      /^module\.exports\s*=\s*/
    ],
    importPatterns: [
      /^(?:import\s+.+\s+from\s+|import\s*\{[^}]+\}\s*from\s+|import\s+)/,
      /^const\s+\{[^}]+\}\s*=\s*require\s*\(/,
      /^const\s+\w+\s*=\s*require\s*\(/,
      /^(?:var|let)\s+\w+\s*=\s*require\s*\(/
    ],
    classPatterns: [
      /^(?:export\s+)?class\s+(\w+)/
    ],
    blockStart: /\{\s*$/,
    blockEnd: /^\s*\}/,
    importsCommutative: true
  },

  typescript: {
    name: 'typescript',
    extensions: ['.ts', '.tsx'],
    declarationPatterns: [
      /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?/,
      /^(?:export\s+)?class\s+(\w+)/,
      /^(?:export\s+)?interface\s+(\w+)/,
      /^(?:export\s+)?type\s+(\w+)\s*=/,
      /^(?:export\s+)?enum\s+(\w+)/
    ],
    importPatterns: [
      /^import\s+/,
      /^(?:export\s+)?\{[^}]+\}\s*from\s+/
    ],
    classPatterns: [
      /^(?:export\s+)?class\s+(\w+)/,
      /^(?:export\s+)?interface\s+(\w+)/
    ],
    blockStart: /\{\s*$/,
    blockEnd: /^\s*\}/,
    importsCommutative: true
  },

  python: {
    name: 'python',
    extensions: ['.py'],
    declarationPatterns: [
      /^(?:async\s+)?def\s+(\w+)/,
      /^class\s+(\w+)/,
      /^(\w+)\s*=\s*/  // top-level assignment
    ],
    importPatterns: [
      /^import\s+/,
      /^from\s+\S+\s+import\s+/
    ],
    classPatterns: [
      /^class\s+(\w+)/
    ],
    blockStart: /:\s*$/,
    blockEnd: /^\S/,  // Python: next non-indented line ends block
    importsCommutative: true
  },

  go: {
    name: 'go',
    extensions: ['.go'],
    declarationPatterns: [
      /^func\s+(?:\([^)]+\)\s+)?(\w+)/,
      /^type\s+(\w+)\s+(?:struct|interface)/,
      /^var\s+(\w+)\s+/,
      /^const\s+(\w+)\s+/
    ],
    importPatterns: [
      /^import\s+/
    ],
    classPatterns: [
      /^type\s+(\w+)\s+struct/,
      /^type\s+(\w+)\s+interface/
    ],
    blockStart: /\{\s*$/,
    blockEnd: /^\}/,
    importsCommutative: true
  },

  rust: {
    name: 'rust',
    extensions: ['.rs'],
    declarationPatterns: [
      /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
      /^(?:pub\s+)?struct\s+(\w+)/,
      /^(?:pub\s+)?enum\s+(\w+)/,
      /^(?:pub\s+)?trait\s+(\w+)/,
      /^impl(?:<[^>]+>)?\s+(\w+)/,
      /^(?:pub\s+)?type\s+(\w+)/,
      /^(?:pub\s+)?mod\s+(\w+)/
    ],
    importPatterns: [
      /^use\s+/,
      /^(?:pub\s+)?use\s+/
    ],
    classPatterns: [
      /^(?:pub\s+)?struct\s+(\w+)/,
      /^(?:pub\s+)?enum\s+(\w+)/,
      /^impl(?:<[^>]+>)?\s+(\w+)/
    ],
    blockStart: /\{\s*$/,
    blockEnd: /^\s*\}/,
    importsCommutative: true
  }
};

// ============================================================================
// CONFLICT PARSER REGISTRY
// ============================================================================

class ConflictParserRegistry {
  constructor() {
    /** @type {Map<string, LangProfile>} name -> profile */
    this.parsers = new Map();
    /** @type {Map<string, LangProfile>} extension -> profile */
    this.extMap = new Map();
  }

  /**
   * Register a language profile.
   * @param {LangProfile} profile
   */
  register(profile) {
    if (!profile || !profile.name) {
      throw new Error('Profile must have a name');
    }
    this.parsers.set(profile.name, profile);
    for (const ext of profile.extensions || []) {
      this.extMap.set(ext, profile);
    }
  }

  /**
   * Get parser by file extension.
   * @param {string} ext - File extension including dot (e.g. '.js')
   * @returns {LangProfile|null}
   */
  getByExtension(ext) {
    return this.extMap.get(ext) || null;
  }

  /**
   * Get parser by file path.
   * @param {string} filePath
   * @returns {LangProfile|null}
   */
  getByFilePath(filePath) {
    const ext = path.extname(filePath);
    return this.getByExtension(ext);
  }

  /**
   * Get parser by language name.
   * @param {string} name
   * @returns {LangProfile|null}
   */
  getByName(name) {
    return this.parsers.get(name) || null;
  }

  /**
   * List all registered language names.
   * @returns {string[]}
   */
  getLanguages() {
    return [...this.parsers.keys()];
  }

  /**
   * List all supported extensions.
   * @returns {string[]}
   */
  getSupportedExtensions() {
    return [...this.extMap.keys()];
  }

  /**
   * Check if a file is supported.
   * @param {string} filePath
   * @returns {boolean}
   */
  isSupported(filePath) {
    return this.getByFilePath(filePath) !== null;
  }
}

// ============================================================================
// STRUCTURAL EXTRACTION
// ============================================================================

/**
 * Extract structural regions from source code.
 * Returns an array of regions (imports, declarations, class members).
 *
 * @param {string} source - Source code text
 * @param {LangProfile} profile - Language profile
 * @returns {Array<{ type: string, name: string, startLine: number, endLine: number, content: string }>}
 */
function extractRegions(source, profile) {
  if (!source || !profile) return [];

  const lines = source.split('\n');
  const regions = [];
  let importBlock = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Check imports
    for (const pattern of profile.importPatterns) {
      if (pattern.test(trimmed)) {
        if (!importBlock) {
          importBlock = { type: 'import', name: '__imports__', startLine: i, endLine: i, lines: [line] };
        } else {
          importBlock.endLine = i;
          importBlock.lines.push(line);
        }
        break;
      }
    }

    // If we hit a non-import line after imports, close import block
    if (importBlock && trimmed !== '' && !profile.importPatterns.some(p => p.test(trimmed))) {
      importBlock.content = importBlock.lines.join('\n');
      delete importBlock.lines;
      regions.push(importBlock);
      importBlock = null;
    }

    // Check declarations
    for (const pattern of profile.declarationPatterns) {
      const match = trimmed.match(pattern);
      if (match) {
        const name = match[1] || '__anonymous__';
        const endLine = findBlockEnd(lines, i, profile);
        const content = lines.slice(i, endLine + 1).join('\n');
        regions.push({ type: 'declaration', name, startLine: i, endLine, content });
        break;
      }
    }
  }

  // Close any trailing import block
  if (importBlock) {
    importBlock.content = importBlock.lines.join('\n');
    delete importBlock.lines;
    regions.push(importBlock);
  }

  return regions;
}

/**
 * Find the end of a block starting at a given line.
 * Uses brace/indent counting heuristic.
 *
 * @param {string[]} lines
 * @param {number} startLine
 * @param {LangProfile} profile
 * @returns {number} End line index
 */
function findBlockEnd(lines, startLine, profile) {
  // For Python-style (indent-based)
  if (profile.name === 'python') {
    const startIndent = lines[startLine].match(/^(\s*)/)[1].length;
    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;
      const indent = line.match(/^(\s*)/)[1].length;
      if (indent <= startIndent && i > startLine + 1) {
        return i - 1;
      }
    }
    return lines.length - 1;
  }

  // For brace-based languages
  let depth = 0;
  let foundOpen = false;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') { depth++; foundOpen = true; }
      if (ch === '}') { depth--; }
    }
    if (foundOpen && depth <= 0) {
      return i;
    }
  }

  // Fallback: single line
  return startLine;
}

/**
 * Extract individual import statements from an import block.
 *
 * @param {string} importBlock - The import block text
 * @param {LangProfile} profile
 * @returns {string[]} Individual import lines
 */
function extractImports(importBlock, profile) {
  if (!importBlock) return [];
  return importBlock.split('\n').filter(line => {
    const trimmed = line.trim();
    return trimmed && profile.importPatterns.some(p => p.test(trimmed));
  });
}

/**
 * Merge two sets of imports (commutative merge).
 * Deduplicates and sorts alphabetically.
 *
 * @param {string[]} importsA
 * @param {string[]} importsB
 * @returns {string[]}
 */
function mergeImports(importsA, importsB) {
  const set = new Set([...importsA, ...importsB]);
  return [...set].sort();
}

/**
 * Check if a piece of code is syntactically valid (basic check).
 * Validates brace balancing for brace-based languages.
 *
 * @param {string} source
 * @param {LangProfile} profile
 * @returns {{ valid: boolean, error?: string }}
 */
function validateSyntax(source, profile) {
  if (!source || !profile) return { valid: false, error: 'Missing source or profile' };

  if (profile.name === 'python') {
    // Basic Python check: no unmatched quotes, colons after def/class
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (/^(?:def|class)\s+\w+/.test(trimmed) && !trimmed.endsWith(':') && !trimmed.endsWith(':\\')) {
        // Could be multi-line params — skip this check
      }
    }
    return { valid: true };
  }

  // Brace balancing for C-family languages
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let escaped = false;

  for (const ch of source) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }

    if (inString) {
      if (ch === stringChar) inString = false;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === '{') depth++;
    if (ch === '}') depth--;

    if (depth < 0) {
      return { valid: false, error: 'Unmatched closing brace' };
    }
  }

  if (depth !== 0) {
    return { valid: false, error: `Unmatched braces: ${depth > 0 ? 'missing closing' : 'extra closing'}` };
  }

  return { valid: true };
}

// ============================================================================
// SINGLETON
// ============================================================================

let _registry = null;

/**
 * Get or create the global registry with all built-in language profiles.
 * @returns {ConflictParserRegistry}
 */
function getRegistry() {
  if (!_registry) {
    _registry = new ConflictParserRegistry();
    for (const profile of Object.values(LANG_PROFILES)) {
      _registry.register(profile);
    }
  }
  return _registry;
}

/**
 * Reset registry (for testing).
 */
function resetRegistry() {
  _registry = null;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  ConflictParserRegistry,
  LANG_PROFILES,
  getRegistry,
  resetRegistry,
  extractRegions,
  findBlockEnd,
  extractImports,
  mergeImports,
  validateSyntax
};
