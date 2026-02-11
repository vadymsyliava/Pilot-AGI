#!/usr/bin/env node

/**
 * Component Token Audit
 *
 * Scans project source files for hardcoded visual values that should
 * use design tokens instead. Reports violations with file, line, and
 * suggested token replacement.
 *
 * Runs against the user's project codebase, not Pilot AGI internals.
 *
 * Usage: node design/scripts/audit-tokens.js [dir] [--json] [--fix-hints]
 *   dir        Directory to scan (default: src/)
 *   --json     Output as JSON
 *   --fix-hints  Include suggested token replacements
 *
 * Exit code: 0 = clean, 1 = violations found
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Patterns that indicate hardcoded values
// ---------------------------------------------------------------------------

const VIOLATION_PATTERNS = [
  {
    id: 'hex-color',
    description: 'Hardcoded hex color',
    regex: /(?:color|bg|background|border|fill|stroke|shadow)[\s:="'-]*(?:#[0-9a-fA-F]{3,8})\b/g,
    category: 'color',
    severity: 'error'
  },
  {
    id: 'rgb-color',
    description: 'Hardcoded rgb/rgba color',
    regex: /(?:color|bg|background|border|fill|stroke)[\s:="'-]*rgba?\(\s*\d+/g,
    category: 'color',
    severity: 'error'
  },
  {
    id: 'hsl-inline',
    description: 'Hardcoded hsl/hsla color (not via var())',
    regex: /(?<!var\()hsla?\(\s*\d+/g,
    category: 'color',
    severity: 'warning'
  },
  {
    id: 'px-spacing',
    description: 'Hardcoded pixel spacing',
    regex: /[mp][trblxy]?-\[\d+px\]/g,
    category: 'spacing',
    severity: 'warning'
  },
  {
    id: 'px-font-size',
    description: 'Hardcoded font size',
    regex: /(?:font-size|text-)\[?\d+px\]?/g,
    category: 'typography',
    severity: 'error'
  },
  {
    id: 'inline-style-color',
    description: 'Inline style with color value',
    regex: /style=\{[^}]*(?:color|background|borderColor)\s*:\s*['"][^'"]*['"]/g,
    category: 'color',
    severity: 'error'
  },
  {
    id: 'css-named-color',
    description: 'Named CSS color in style prop',
    regex: /(?:color|background|backgroundColor|borderColor)\s*:\s*['"](?:red|blue|green|white|black|gray|grey|orange|yellow|purple|pink|cyan|magenta)['"](?!\))/gi,
    category: 'color',
    severity: 'error'
  }
];

// Files to scan
const SCAN_EXTENSIONS = new Set(['.tsx', '.jsx', '.ts', '.js', '.css', '.scss']);

// Directories and files to skip
const SKIP_PATTERNS = [
  'node_modules',
  '.next',
  'dist',
  'build',
  '.git',
  'design/tokens',     // Token definition files are allowed
  'design/scripts',    // Generator scripts are allowed
  'design/generated',  // Generated output is allowed
  '.claude',
  'tests',
  '__tests__',
  '.test.',
  '.spec.'
];

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

function shouldSkip(filePath) {
  return SKIP_PATTERNS.some(p => filePath.includes(p));
}

function scanDirectory(dir) {
  const files = [];

  function walk(d) {
    if (!fs.existsSync(d)) return;

    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (shouldSkip(full)) continue;

      if (entry.isDirectory()) {
        walk(full);
      } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(full);
      }
    }
  }

  walk(dir);
  return files;
}

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip comment lines
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

    for (const pattern of VIOLATION_PATTERNS) {
      pattern.regex.lastIndex = 0;

      let match;
      while ((match = pattern.regex.exec(line)) !== null) {
        violations.push({
          file: filePath,
          line: lineNum,
          column: match.index + 1,
          match: match[0],
          rule: pattern.id,
          description: pattern.description,
          category: pattern.category,
          severity: pattern.severity
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Token lookup for suggestions
// ---------------------------------------------------------------------------

function loadTokenIndex() {
  try {
    const { loadAllTokens, indexTokenPaths } = require('./validate-tokens');
    const { merged } = loadAllTokens();
    return indexTokenPaths(merged);
  } catch (e) {
    return null;
  }
}

function suggestToken(violation, tokenIndex) {
  if (!tokenIndex) return null;

  if (violation.category === 'color') {
    const hexMatch = violation.match.match(/#[0-9a-fA-F]{3,8}/);
    if (hexMatch) {
      const hex = hexMatch[0].toLowerCase();
      for (const [tokenPath, token] of Object.entries(tokenIndex)) {
        if (token.$type === 'color' && token.$value &&
            typeof token.$value === 'string' &&
            token.$value.toLowerCase() === hex) {
          return `var(--${tokenPath.replace(/\./g, '-')})`;
        }
      }
      return 'Use a design token CSS variable (e.g., var(--color-semantic-brand-primary))';
    }
  }

  if (violation.category === 'spacing') {
    return 'Use a spacing token class (e.g., m-4, p-8) mapped to design tokens';
  }

  if (violation.category === 'typography') {
    return 'Use a typography token class (e.g., text-sm, text-lg) mapped to design tokens';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function formatReport(violations, fixHints, tokenIndex) {
  if (violations.length === 0) {
    return 'Design token audit: CLEAN\nNo hardcoded values found.';
  }

  const byFile = {};
  for (const v of violations) {
    const rel = path.relative(process.cwd(), v.file);
    if (!byFile[rel]) byFile[rel] = [];
    byFile[rel].push(v);
  }

  const lines = [];
  lines.push(`Design token audit: ${violations.length} violation(s) found\n`);

  const errorCount = violations.filter(v => v.severity === 'error').length;
  const warnCount = violations.filter(v => v.severity === 'warning').length;
  lines.push(`  Errors:   ${errorCount}`);
  lines.push(`  Warnings: ${warnCount}\n`);

  for (const [file, fileViolations] of Object.entries(byFile)) {
    lines.push(`${file}:`);
    for (const v of fileViolations) {
      const icon = v.severity === 'error' ? 'x' : '!';
      lines.push(`  [${icon}] L${v.line}:${v.column} ${v.description}: ${v.match}`);
      if (fixHints) {
        const suggestion = suggestToken(v, tokenIndex);
        if (suggestion) {
          lines.push(`      -> ${suggestion}`);
        }
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function audit(scanDir, options = {}) {
  const dir = scanDir || path.join(process.cwd(), 'src');
  const files = scanDirectory(dir);
  const allViolations = [];

  for (const file of files) {
    const violations = scanFile(file);
    allViolations.push(...violations);
  }

  return {
    clean: allViolations.length === 0,
    scannedFiles: files.length,
    violations: allViolations,
    errorCount: allViolations.filter(v => v.severity === 'error').length,
    warningCount: allViolations.filter(v => v.severity === 'warning').length
  };
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const fixHints = args.includes('--fix-hints');
  const scanDir = args.find(a => !a.startsWith('--'));

  const result = audit(scanDir);

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const tokenIndex = fixHints ? loadTokenIndex() : null;
    console.log(formatReport(result.violations, fixHints, tokenIndex));
    console.log(`Scanned ${result.scannedFiles} files`);
  }

  process.exit(result.clean ? 0 : 1);
}

module.exports = { audit, scanFile, scanDirectory, VIOLATION_PATTERNS };
