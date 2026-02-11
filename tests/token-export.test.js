#!/usr/bin/env node

/**
 * Tests for Cross-Platform Token Export (Phase 2.9)
 * Run: node tests/token-export.test.js
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
// 1. iOS Export
// =========================================================================

console.log('=== iOS Export ===\n');

const { generate: generateIOS, hexToRGBComponents, remToPt } = require('../design/scripts/export-ios');

test('hexToRGBComponents converts white correctly', () => {
  const { r, g, b } = hexToRGBComponents('#ffffff');
  assert(r === 1, 'Red should be 1, got ' + r);
  assert(g === 1, 'Green should be 1, got ' + g);
  assert(b === 1, 'Blue should be 1, got ' + b);
});

test('hexToRGBComponents converts black correctly', () => {
  const { r, g, b } = hexToRGBComponents('#000000');
  assert(r === 0, 'Red should be 0, got ' + r);
  assert(g === 0, 'Green should be 0, got ' + g);
  assert(b === 0, 'Blue should be 0, got ' + b);
});

test('hexToRGBComponents handles 3-char hex', () => {
  const { r, g, b } = hexToRGBComponents('#fff');
  assert(r === 1 && g === 1 && b === 1, 'Should handle 3-char hex');
});

test('remToPt converts rem values', () => {
  assert(remToPt('1rem') === 16, '1rem should be 16pt');
  assert(remToPt('0.75rem') === 12, '0.75rem should be 12pt');
  assert(remToPt('2.25rem') === 36, '2.25rem should be 36pt');
});

test('remToPt handles px values', () => {
  assert(remToPt('640px') === 640, '640px should be 640pt');
  assert(remToPt('1px') === 1, '1px should be 1pt');
});

test('remToPt handles zero', () => {
  assert(remToPt('0') === 0, '0 should be 0pt');
});

test('iOS generator produces 3 Swift files', () => {
  const result = generateIOS();
  assert(result.files.length === 3, 'Expected 3 files, got ' + result.files.length);
  result.files.forEach(f => {
    assert(fs.existsSync(f), 'File should exist: ' + f);
    assert(f.endsWith('.swift'), 'File should be .swift: ' + f);
  });
});

test('Colors.swift contains SwiftUI import', () => {
  const result = generateIOS();
  assert(result.colors.includes('import SwiftUI'), 'Missing SwiftUI import');
});

test('Colors.swift has semantic colors with light/dark', () => {
  const result = generateIOS();
  assert(result.colors.includes('static let brandPrimary'), 'Missing brandPrimary');
  assert(result.colors.includes('light:'), 'Missing light mode');
  assert(result.colors.includes('dark:'), 'Missing dark mode');
});

test('Colors.swift has primitive color groups', () => {
  const result = generateIOS();
  assert(result.colors.includes('enum Primitive'), 'Missing Primitive enum');
  assert(result.colors.includes('enum Blue'), 'Missing Blue enum');
  assert(result.colors.includes('enum Gray'), 'Missing Gray enum');
});

test('Typography.swift has font sizes in pt', () => {
  const result = generateIOS();
  assert(result.typography.includes('fontSizeBase: CGFloat = 16'), 'Missing base font size');
  assert(result.typography.includes('fontSizeSm: CGFloat = 14'), 'Missing sm font size');
});

test('Typography.swift has font weights', () => {
  const result = generateIOS();
  assert(result.typography.includes('fontWeightBold: Font.Weight = .bold'), 'Missing bold weight');
  assert(result.typography.includes('fontWeightNormal: Font.Weight = .regular'), 'Missing normal weight');
});

test('Typography.swift has composite presets', () => {
  const result = generateIOS();
  assert(result.typography.includes('static let headingH1'), 'Missing h1 preset');
  assert(result.typography.includes('Font.system(size:'), 'Missing Font.system usage');
});

test('Spacing.swift has spacing values', () => {
  const result = generateIOS();
  assert(result.spacing.includes('sp4: CGFloat = 16'), 'Missing sp4 = 16');
  assert(result.spacing.includes('sp8: CGFloat = 32'), 'Missing sp8 = 32');
});

test('Spacing.swift has border radius', () => {
  const result = generateIOS();
  assert(result.spacing.includes('struct AppRadius'), 'Missing AppRadius struct');
  assert(result.spacing.includes('lg: CGFloat'), 'Missing lg radius');
});

test('Spacing.swift has shadow definitions', () => {
  const result = generateIOS();
  assert(result.spacing.includes('struct AppShadow'), 'Missing AppShadow struct');
  assert(result.spacing.includes('static let md'), 'Missing md shadow');
});

// =========================================================================
// 2. Android Export
// =========================================================================

console.log('\n=== Android Export ===\n');

const { generate: generateAndroid, remToDp, remToSp } = require('../design/scripts/export-android');

test('remToDp converts rem to dp', () => {
  assert(remToDp('1rem') === '16dp', '1rem should be 16dp, got ' + remToDp('1rem'));
  assert(remToDp('0.5rem') === '8dp', '0.5rem should be 8dp');
  assert(remToDp('0') === '0dp', '0 should be 0dp');
});

test('remToDp handles px values', () => {
  assert(remToDp('640px') === '640dp', '640px should be 640dp');
});

test('remToSp converts rem to sp', () => {
  assert(remToSp('1rem') === '16sp', '1rem should be 16sp');
  assert(remToSp('0.875rem') === '14sp', '0.875rem should be 14sp');
});

test('Android generator produces 4 XML files', () => {
  const result = generateAndroid();
  assert(result.files.length === 4, 'Expected 4 files, got ' + result.files.length);
  result.files.forEach(f => {
    assert(fs.existsSync(f), 'File should exist: ' + f);
    assert(f.endsWith('.xml'), 'File should be .xml: ' + f);
  });
});

test('colors.xml is valid XML structure', () => {
  const result = generateAndroid();
  assert(result.colors.startsWith('<?xml version="1.0"'), 'Missing XML declaration');
  assert(result.colors.includes('<resources>'), 'Missing <resources> tag');
  assert(result.colors.includes('</resources>'), 'Missing closing </resources>');
});

test('colors.xml has primitive colors with hex values', () => {
  const result = generateAndroid();
  assert(result.colors.includes('color_primitive_blue_500'), 'Missing blue_500');
  assert(result.colors.includes('#3B82F6'), 'Missing blue-500 hex value');
});

test('colors.xml has semantic colors', () => {
  const result = generateAndroid();
  assert(result.colors.includes('color_semantic_brand_primary'), 'Missing brand primary');
  assert(result.colors.includes('color_semantic_state_error'), 'Missing state error');
});

test('colors-night.xml has dark mode overrides', () => {
  const result = generateAndroid();
  assert(result.nightColors.includes('values-night'), 'Missing night mode comment');
  assert(result.nightColors.includes('color_semantic_brand_primary'), 'Missing dark brand primary');
  assert(result.nightColors.includes('#60A5FA'), 'Missing dark blue-400 value');
});

test('dimens.xml has spacing in dp', () => {
  const result = generateAndroid();
  assert(result.dimens.includes('<dimen name="spacing_4">16dp</dimen>'), 'Missing spacing_4 = 16dp');
  assert(result.dimens.includes('<dimen name="spacing_8">32dp</dimen>'), 'Missing spacing_8 = 32dp');
});

test('dimens.xml has border radius', () => {
  const result = generateAndroid();
  assert(result.dimens.includes('<dimen name="radius_lg">'), 'Missing radius_lg');
});

test('dimens.xml has font sizes in sp', () => {
  const result = generateAndroid();
  assert(result.dimens.includes('<dimen name="font_size_base">16sp</dimen>'), 'Missing font_size_base');
  assert(result.dimens.includes('<dimen name="font_size_sm">14sp</dimen>'), 'Missing font_size_sm');
});

test('type.xml has font families', () => {
  const result = generateAndroid();
  assert(result.type.includes('font_family_sans'), 'Missing font_family_sans');
  assert(result.type.includes('Inter'), 'Missing Inter font');
});

test('type.xml has font weights as integers', () => {
  const result = generateAndroid();
  assert(result.type.includes('<integer name="font_weight_bold">700</integer>'), 'Missing bold weight');
  assert(result.type.includes('<integer name="font_weight_normal">400</integer>'), 'Missing normal weight');
});

test('type.xml has animation durations', () => {
  const result = generateAndroid();
  assert(result.type.includes('<integer name="duration_fast">150</integer>'), 'Missing fast duration');
  assert(result.type.includes('<integer name="duration_normal">300</integer>'), 'Missing normal duration');
});

// =========================================================================
// 3. Unified Export Runner
// =========================================================================

console.log('\n=== Unified Export ===\n');

const { exportAll } = require('../design/scripts/export-all');

test('exportAll generates all platforms without errors', () => {
  const { results, errors } = exportAll();
  assert(errors.length === 0, 'Errors: ' + errors.map(e => e.platform + ': ' + e.error).join('; '));
  assert(results.css, 'Missing CSS results');
  assert(results.tailwind, 'Missing Tailwind results');
  assert(results.ios, 'Missing iOS results');
  assert(results.android, 'Missing Android results');
});

test('exportAll CSS has 100+ variables', () => {
  const { results } = exportAll();
  assert(results.css.vars > 100, 'Expected 100+ CSS vars, got ' + results.css.vars);
});

test('exportAll iOS has 3 files', () => {
  const { results } = exportAll();
  assert(results.ios.files.length === 3, 'Expected 3 iOS files');
});

test('exportAll Android has 4 files', () => {
  const { results } = exportAll();
  assert(results.android.files.length === 4, 'Expected 4 Android files');
});

// =========================================================================
// 4. Existing Tests Still Pass
// =========================================================================

console.log('\n=== Existing Token System ===\n');

const { validate } = require('../design/scripts/validate-tokens');

test('Token validation still passes', () => {
  const result = validate();
  assert(result.valid, 'Validation errors: ' + result.errors.map(e => e.message).join('; '));
});

test('Existing CSS generation still works', () => {
  const { generate: generateCSS } = require('../design/scripts/generate-css');
  const result = generateCSS();
  assert(result.varCount > 100, 'CSS vars should still be 100+');
});

// =========================================================================
// Summary
// =========================================================================

console.log('\n' + '='.repeat(40));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

if (require.main === module) {
  process.exit(failed > 0 ? 1 : 0);
}
