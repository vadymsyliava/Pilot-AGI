#!/usr/bin/env node

/**
 * Verification tests for Token System (Phase 2.7)
 * Run: node tests/tokens.test.js
 */

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS: ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL: ' + name + ' - ' + e.message);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

// =========================================================================
// 1. Token Validation
// =========================================================================

console.log('=== Token Validation ===\n');

const { validate, loadAllTokens, indexTokenPaths } = require('../design/scripts/validate-tokens');

test('All token files load without errors', () => {
  const { merged, files } = loadAllTokens();
  assert(files.length >= 7, 'Expected at least 7 token files, got ' + files.length);
  assert(Object.keys(merged).length > 0, 'Merged tree should not be empty');
});

test('Token index contains 200+ tokens', () => {
  const { merged } = loadAllTokens();
  const index = indexTokenPaths(merged);
  const count = Object.keys(index).length;
  assert(count >= 200, 'Expected 200+ tokens, got ' + count);
});

test('Validator reports all tokens valid', () => {
  const result = validate();
  assert(result.valid, 'Validation errors: ' + result.errors.map(e => e.message).join('; '));
});

test('Every token has $value and $type', () => {
  const { merged } = loadAllTokens();
  const index = indexTokenPaths(merged);
  for (const [p, t] of Object.entries(index)) {
    assert('$value' in t, p + ' missing $value');
    assert('$type' in t, p + ' missing $type');
  }
});

test('All reference tokens resolve to valid targets', () => {
  const { merged } = loadAllTokens();
  const index = indexTokenPaths(merged);
  const allPaths = new Set(Object.keys(index));

  for (const [p, t] of Object.entries(index)) {
    if (typeof t.$value === 'string' && t.$value.includes('{')) {
      const refs = t.$value.match(/\{([^}]+)\}/g) || [];
      for (const ref of refs) {
        const refPath = ref.slice(1, -1);
        assert(allPaths.has(refPath), p + ' has broken ref: ' + ref);
      }
    }
  }
});

test('No circular references exist', () => {
  const result = validate();
  const circular = result.errors.filter(e => e.type === 'circular_reference');
  assert(circular.length === 0, 'Circular refs: ' + circular.map(e => e.message).join('; '));
});

// =========================================================================
// 2. CSS Generation
// =========================================================================

console.log('\n=== CSS Generation ===\n');

const { generate: generateCSS, hexToHSL } = require('../design/scripts/generate-css');

test('hexToHSL converts correctly', () => {
  assert(hexToHSL('#ffffff') === '0 0% 100%', 'White should be 0 0% 100%');
  assert(hexToHSL('#000000') === '0 0% 0%', 'Black should be 0 0% 0%');
  const blue = hexToHSL('#3b82f6');
  assert(blue.startsWith('217'), 'Blue-500 hue should be ~217, got: ' + blue);
});

test('CSS generator produces output file', () => {
  const result = generateCSS();
  assert(fs.existsSync(result.outputPath), 'Output file should exist');
  assert(result.varCount > 100, 'Expected 100+ CSS vars, got ' + result.varCount);
});

test('CSS contains :root and .dark selectors', () => {
  const result = generateCSS();
  assert(result.css.includes(':root {'), 'Missing :root selector');
  assert(result.css.includes('.dark {'), 'Missing .dark selector');
});

test('CSS colors use HSL format (no commas)', () => {
  const result = generateCSS();
  // shadcn uses "H S% L%" not "H, S%, L%"
  const hslMatch = result.css.match(/--color-primitive-blue-500:\s*(.+?);/);
  assert(hslMatch, 'Missing blue-500 var');
  assert(!hslMatch[1].includes(','), 'HSL should not have commas: ' + hslMatch[1]);
  assert(hslMatch[1].includes('%'), 'HSL should have % signs: ' + hslMatch[1]);
});

test('CSS contains shadcn/ui compatibility aliases', () => {
  const result = generateCSS();
  const aliases = ['--background:', '--foreground:', '--primary:', '--destructive:', '--border:', '--ring:', '--radius:'];
  for (const alias of aliases) {
    assert(result.css.includes(alias), 'Missing shadcn alias: ' + alias);
  }
});

test('Dark mode overrides semantic color vars', () => {
  const result = generateCSS();
  const darkSection = result.css.split('.dark {')[1];
  assert(darkSection, 'Missing dark section');
  assert(darkSection.includes('--color-semantic-'), 'Dark mode should override semantic vars');
});

// =========================================================================
// 3. Tailwind Generation
// =========================================================================

console.log('\n=== Tailwind Generation ===\n');

const { generate: generateTailwind } = require('../design/scripts/generate-tailwind');

test('Tailwind generator produces valid JS', () => {
  const result = generateTailwind();
  assert(fs.existsSync(result.outputPath), 'Output file should exist');
  const config = require(result.outputPath);
  assert(config.extend, 'Config should have extend property');
});

test('Tailwind config has all 13 theme sections', () => {
  const result = generateTailwind();
  const sections = ['colors', 'spacing', 'borderRadius', 'boxShadow', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'screens', 'zIndex', 'transitionDuration', 'transitionTimingFunction'];
  for (const s of sections) {
    assert(result.theme.extend[s], 'Missing section: ' + s);
  }
});

test('Color values use hsl(var()) format', () => {
  const result = generateTailwind();
  const brand = result.theme.extend.colors.brand;
  assert(brand, 'Missing brand color group');
  assert(brand.primary.includes('hsl(var('), 'Brand primary should use hsl(var()): ' + brand.primary);
});

test('Spacing values use var() CSS references', () => {
  const result = generateTailwind();
  const sp = result.theme.extend.spacing;
  assert(sp['4'].includes('var(--spacing-4)'), 'Spacing-4 should reference CSS var');
});

test('Breakpoints use raw values (not CSS vars)', () => {
  const result = generateTailwind();
  const screens = result.theme.extend.screens;
  assert(screens.sm === '640px', 'Breakpoint sm should be raw 640px');
  assert(screens.lg === '1024px', 'Breakpoint lg should be raw 1024px');
});

test('shadcn/ui color aliases present', () => {
  const result = generateTailwind();
  const c = result.theme.extend.colors;
  assert(c.primary && c.primary.DEFAULT, 'Missing primary.DEFAULT');
  assert(c.secondary && c.secondary.DEFAULT, 'Missing secondary.DEFAULT');
  assert(c.destructive && c.destructive.DEFAULT, 'Missing destructive.DEFAULT');
  assert(c.background, 'Missing background alias');
  assert(c.border, 'Missing border alias');
});

test('Border radius has DEFAULT (shadcn/ui)', () => {
  const result = generateTailwind();
  assert(result.theme.extend.borderRadius.DEFAULT === 'var(--radius)', 'Missing DEFAULT radius');
});

// =========================================================================
// 4. Memory Publish Round-trip
// =========================================================================

console.log('\n=== Memory Publish Round-trip ===\n');

const memory = require('../.claude/pilot/hooks/lib/memory');
const { publish } = require('../design/scripts/publish-tokens');

test('Publish succeeds and returns envelope', () => {
  const { envelope } = publish();
  assert(envelope.channel === 'design-tokens', 'Wrong channel');
  assert(envelope.version >= 1, 'Version should be >= 1');
  assert(envelope.publishedBy === 'design', 'Publisher should be design');
});

test('Published data has all 8 categories', () => {
  const data = memory.read('design-tokens');
  const cats = ['colors', 'spacing', 'typography', 'shadows', 'radii', 'breakpoints', 'zIndex', 'animation'];
  for (const c of cats) {
    assert(data.data[c], 'Missing category: ' + c);
  }
});

test('Published tokens use DTCG format', () => {
  const data = memory.read('design-tokens');
  // Spot check a primitive color
  const blue = data.data.colors.primitive && data.data.colors.primitive.blue;
  assert(blue, 'Missing colors.primitive.blue');
  const blue500 = blue['500'];
  assert(blue500 && blue500.$value && blue500.$type === 'color', 'Blue-500 should have $value and $type');
});

test('Schema validation passes for published data', () => {
  const data = memory.read('design-tokens');
  const v = memory.validateAgainstSchema('design-tokens', data.data);
  assert(v.valid, 'Schema errors: ' + v.errors.join(', '));
});

// =========================================================================
// Summary
// =========================================================================

console.log('\n' + '='.repeat(40));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
