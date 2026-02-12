#!/usr/bin/env node

/**
 * Design Token Validator
 *
 * Validates all token files against W3C DTCG rules:
 * 1. Type checking — every token has a valid $type
 * 2. Reference resolution — all {path.to.token} refs resolve
 * 3. Circular reference detection
 * 4. Naming convention enforcement
 *
 * Usage: node design/scripts/validate-tokens.js [--json]
 * Exit code: 0 = valid, 1 = errors found
 */

const fs = require('fs');
const path = require('path');

const TOKENS_DIR = path.join(__dirname, '..', 'tokens');

const VALID_TYPES = new Set([
  'color', 'dimension', 'fontFamily', 'fontWeight',
  'duration', 'cubicBezier', 'number',
  'shadow', 'typography', 'border'
]);

// ---------------------------------------------------------------------------
// Load all token files into a merged tree
// ---------------------------------------------------------------------------

function loadAllTokens() {
  const files = fs.readdirSync(TOKENS_DIR).filter(f => f.endsWith('.json'));
  const merged = {};
  const fileMap = {};

  for (const file of files) {
    const filePath = path.join(TOKENS_DIR, file);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    fileMap[file] = data;
    deepMerge(merged, data);
  }

  return { merged, fileMap, files };
}

function deepMerge(target, source) {
  for (const [key, val] of Object.entries(source)) {
    if (key.startsWith('$')) continue;
    if (val && typeof val === 'object' && !Array.isArray(val) && !('$value' in val)) {
      if (!target[key]) target[key] = {};
      deepMerge(target[key], val);
    } else {
      target[key] = val;
    }
  }
}

// ---------------------------------------------------------------------------
// Build token path index
// ---------------------------------------------------------------------------

function indexTokenPaths(obj, prefix) {
  const paths = {};

  function walk(node, p) {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      if ('$value' in node) {
        paths[p] = node;
      } else {
        for (const [k, v] of Object.entries(node)) {
          if (k.startsWith('$')) continue;
          walk(v, p ? p + '.' + k : k);
        }
      }
    }
  }

  walk(obj, prefix || '');
  return paths;
}

// ---------------------------------------------------------------------------
// Validation checks
// ---------------------------------------------------------------------------

function validateTypes(tokenIndex) {
  const errors = [];

  for (const [tokenPath, token] of Object.entries(tokenIndex)) {
    if (!('$type' in token)) {
      errors.push({
        path: tokenPath,
        type: 'missing_type',
        message: `Token "${tokenPath}" is missing $type`
      });
    } else if (!VALID_TYPES.has(token.$type)) {
      errors.push({
        path: tokenPath,
        type: 'invalid_type',
        message: `Token "${tokenPath}" has unknown $type "${token.$type}"`
      });
    }
  }

  return errors;
}

function extractRefs(value) {
  const refs = [];

  if (typeof value === 'string') {
    const re = /\{([^}]+)\}/g;
    let m;
    while ((m = re.exec(value)) !== null) {
      refs.push(m[1]);
    }
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const v of Object.values(value)) {
      refs.push(...extractRefs(v));
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      refs.push(...extractRefs(item));
    }
  }

  return refs;
}

function validateReferences(tokenIndex) {
  const errors = [];
  const allPaths = new Set(Object.keys(tokenIndex));

  for (const [tokenPath, token] of Object.entries(tokenIndex)) {
    const refs = extractRefs(token.$value);

    for (const ref of refs) {
      if (!allPaths.has(ref)) {
        errors.push({
          path: tokenPath,
          type: 'broken_reference',
          message: `Token "${tokenPath}" references "{${ref}}" which does not exist`
        });
      }
    }
  }

  return errors;
}

function validateCircularRefs(tokenIndex) {
  const errors = [];
  const allPaths = new Set(Object.keys(tokenIndex));

  // Build adjacency: token -> tokens it references
  const graph = {};
  for (const [tokenPath, token] of Object.entries(tokenIndex)) {
    const refs = extractRefs(token.$value).filter(r => allPaths.has(r));
    if (refs.length > 0) {
      graph[tokenPath] = refs;
    }
  }

  // DFS cycle detection
  const visited = new Set();
  const inStack = new Set();

  function dfs(node, chain) {
    if (inStack.has(node)) {
      const cycle = chain.slice(chain.indexOf(node));
      cycle.push(node);
      errors.push({
        path: node,
        type: 'circular_reference',
        message: `Circular reference detected: ${cycle.join(' -> ')}`
      });
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);

    for (const neighbor of (graph[node] || [])) {
      dfs(neighbor, [...chain, node]);
    }

    inStack.delete(node);
  }

  for (const node of Object.keys(graph)) {
    if (!visited.has(node)) {
      dfs(node, []);
    }
  }

  return errors;
}

function validateNaming(tokenIndex) {
  const errors = [];
  const nameRe = /^[a-zA-Z0-9_$.-]+$/;

  for (const tokenPath of Object.keys(tokenIndex)) {
    const segments = tokenPath.split('.');
    for (const seg of segments) {
      if (!nameRe.test(seg)) {
        errors.push({
          path: tokenPath,
          type: 'invalid_name',
          message: `Token path segment "${seg}" contains invalid characters`
        });
        break;
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function validate() {
  const { merged, files } = loadAllTokens();
  const tokenIndex = indexTokenPaths(merged);
  const tokenCount = Object.keys(tokenIndex).length;

  const allErrors = [
    ...validateTypes(tokenIndex),
    ...validateReferences(tokenIndex),
    ...validateCircularRefs(tokenIndex),
    ...validateNaming(tokenIndex)
  ];

  return {
    valid: allErrors.length === 0,
    tokenCount,
    files,
    errors: allErrors
  };
}

// CLI entry point
if (require.main === module) {
  const jsonMode = process.argv.includes('--json');
  const result = validate();

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Token files: ${result.files.join(', ')}`);
    console.log(`Total tokens: ${result.tokenCount}`);

    if (result.valid) {
      console.log('\nAll checks passed:');
      console.log('  [x] Type checking');
      console.log('  [x] Reference resolution');
      console.log('  [x] No circular references');
      console.log('  [x] Naming conventions');
      console.log('\nResult: VALID');
    } else {
      console.log(`\nErrors (${result.errors.length}):`);
      for (const err of result.errors) {
        console.log(`  [${err.type}] ${err.message}`);
      }
      console.log('\nResult: INVALID');
    }
  }

  process.exit(result.valid ? 0 : 1);
}

module.exports = { validate, loadAllTokens, indexTokenPaths, extractRefs };
