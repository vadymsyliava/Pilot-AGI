#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const TEST_ROOTS = [
  path.join(ROOT, '.claude', 'pilot', 'hooks', 'lib', '__tests__'),
  path.join(ROOT, 'tests'),
];

function collectTestFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

const testFiles = TEST_ROOTS
  .flatMap(collectTestFiles)
  .sort()
  .map((file) => path.relative(ROOT, file));

if (testFiles.length === 0) {
  console.error('No test files found.');
  process.exit(1);
}

let failed = 0;

for (const file of testFiles) {
  const result = spawnSync(process.execPath, ['--test', file], {
    stdio: 'inherit',
  });

  if ((result.status ?? 1) !== 0) {
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`\n${failed} test file(s) failed.`);
  process.exit(1);
}
