#!/usr/bin/env node

/**
 * Unified Token Export Runner
 *
 * Regenerates all platform outputs from design tokens:
 *   - Web:     CSS custom properties + Tailwind config
 *   - iOS:     SwiftUI Color/Font/Spacing files
 *   - Android: XML resource files (colors, dimens, type)
 *
 * Usage: node design/scripts/export-all.js
 */

const path = require('path');

function exportAll() {
  const results = {};
  const errors = [];

  // Web: CSS
  try {
    const { generate: generateCSS } = require('./generate-css');
    const css = generateCSS();
    results.css = { file: path.basename(css.outputPath), vars: css.varCount };
  } catch (e) {
    errors.push({ platform: 'css', error: e.message });
  }

  // Web: Tailwind
  try {
    const { generate: generateTailwind } = require('./generate-tailwind');
    const tw = generateTailwind();
    results.tailwind = { file: path.basename(tw.outputPath), keys: tw.keyCount };
  } catch (e) {
    errors.push({ platform: 'tailwind', error: e.message });
  }

  // iOS
  try {
    const { generate: generateIOS } = require('./export-ios');
    const ios = generateIOS();
    results.ios = { dir: 'ios/', files: ios.files.map(f => path.basename(f)) };
  } catch (e) {
    errors.push({ platform: 'ios', error: e.message });
  }

  // Android
  try {
    const { generate: generateAndroid } = require('./export-android');
    const android = generateAndroid();
    results.android = { dir: 'android/', files: android.files.map(f => path.basename(f)) };
  } catch (e) {
    errors.push({ platform: 'android', error: e.message });
  }

  return { results, errors };
}

if (require.main === module) {
  console.log('Exporting design tokens to all platforms...\n');

  const { results, errors } = exportAll();

  if (results.css) {
    console.log(`  Web (CSS):     ${results.css.file} (${results.css.vars} variables)`);
  }
  if (results.tailwind) {
    console.log(`  Web (Tailwind): ${results.tailwind.file} (${results.tailwind.keys} keys)`);
  }
  if (results.ios) {
    console.log(`  iOS:           ${results.ios.files.join(', ')}`);
  }
  if (results.android) {
    console.log(`  Android:       ${results.android.files.join(', ')}`);
  }

  if (errors.length > 0) {
    console.log('\nErrors:');
    errors.forEach(e => console.log(`  [${e.platform}] ${e.error}`));
    process.exit(1);
  }

  console.log('\nAll platforms exported successfully.');
}

module.exports = { exportAll };
