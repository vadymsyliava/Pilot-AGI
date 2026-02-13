/**
 * Tests for Registry Auto-Discovery Scanner — Phase 8.5 (Pilot AGI-wu4r)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/registry-scanner.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regscan-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/registry'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModule() {
  const modPaths = ['../registry-scanner', '../project-registry'];
  for (const modPath of modPaths) {
    try { delete require.cache[require.resolve(modPath)]; } catch (e) {}
  }
  return require('../registry-scanner');
}

function writeFile(relPath, content) {
  const fullPath = path.join(testDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content || '');
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  setup();
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (e) {
    console.error(`  \u2717 ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  } finally {
    teardown();
  }
}

console.log('\n=== Registry Scanner Tests ===\n');

// --- detectFramework ---

test('detectFramework detects Next.js', () => {
  const scanner = freshModule();
  writeFile('package.json', JSON.stringify({
    dependencies: { next: '14.0.0', react: '18.0.0' }
  }));
  const fw = scanner.detectFramework(testDir);
  assert.strictEqual(fw.framework, 'nextjs');
  assert.strictEqual(fw.hasPages, true);
  assert.strictEqual(fw.hasAPI, true);
});

test('detectFramework detects React', () => {
  const scanner = freshModule();
  writeFile('package.json', JSON.stringify({
    dependencies: { react: '18.0.0', 'react-router-dom': '6.0.0' }
  }));
  const fw = scanner.detectFramework(testDir);
  assert.strictEqual(fw.framework, 'react');
  assert.strictEqual(fw.hasPages, true);
});

test('detectFramework detects Express', () => {
  const scanner = freshModule();
  writeFile('package.json', JSON.stringify({
    dependencies: { express: '4.18.0' }
  }));
  const fw = scanner.detectFramework(testDir);
  assert.strictEqual(fw.framework, 'express');
  assert.strictEqual(fw.hasAPI, true);
});

test('detectFramework detects TypeScript', () => {
  const scanner = freshModule();
  writeFile('package.json', JSON.stringify({
    dependencies: { react: '18.0.0' },
    devDependencies: { typescript: '5.0.0' }
  }));
  const fw = scanner.detectFramework(testDir);
  assert.strictEqual(fw.language, 'typescript');
});

test('detectFramework detects Prisma', () => {
  const scanner = freshModule();
  writeFile('package.json', JSON.stringify({
    dependencies: { '@prisma/client': '5.0.0' }
  }));
  const fw = scanner.detectFramework(testDir);
  assert.strictEqual(fw.hasDB, true);
  assert.strictEqual(fw.details.orm, 'prisma');
});

test('detectFramework detects Mongoose', () => {
  const scanner = freshModule();
  writeFile('package.json', JSON.stringify({
    dependencies: { mongoose: '7.0.0' }
  }));
  const fw = scanner.detectFramework(testDir);
  assert.strictEqual(fw.hasDB, true);
  assert.strictEqual(fw.details.orm, 'mongoose');
});

test('detectFramework returns null for unknown project', () => {
  const scanner = freshModule();
  const fw = scanner.detectFramework(testDir);
  assert.strictEqual(fw.framework, null);
});

// --- scanPages ---

test('scanPages finds Next.js pages', () => {
  const scanner = freshModule();
  writeFile('app/page.tsx', 'export default function Home() {}');
  writeFile('app/about/page.tsx', 'export default function About() {}');
  writeFile('app/layout.tsx', 'export default function Layout() {}');

  const pages = scanner.scanPages(testDir, 'nextjs');
  assert.ok(pages.length >= 2);
  assert.ok(pages.some(p => p.name === 'app' || p.name === 'index'));
  assert.ok(pages.some(p => p.name === 'about'));
});

test('scanPages finds React pages', () => {
  const scanner = freshModule();
  writeFile('src/pages/Home.tsx', 'export default function Home() {}');
  writeFile('src/pages/About.tsx', 'export default function About() {}');

  const pages = scanner.scanPages(testDir, 'react');
  assert.strictEqual(pages.length, 2);
});

test('scanPages returns empty for no pages', () => {
  const scanner = freshModule();
  const pages = scanner.scanPages(testDir, 'react');
  assert.strictEqual(pages.length, 0);
});

// --- scanComponents ---

test('scanComponents finds React components', () => {
  const scanner = freshModule();
  writeFile('src/components/Button.tsx', 'export default function Button() {}');
  writeFile('src/components/Input.tsx', 'export default function Input() {}');
  writeFile('src/components/Button.test.tsx', 'test("button", () => {})');

  const comps = scanner.scanComponents(testDir);
  assert.strictEqual(comps.length, 2); // excludes .test. file
  assert.ok(comps.some(c => c.name === 'Button'));
  assert.ok(comps.some(c => c.name === 'Input'));
});

test('scanComponents handles index files', () => {
  const scanner = freshModule();
  writeFile('src/components/Card/index.tsx', 'export default function Card() {}');

  const comps = scanner.scanComponents(testDir);
  assert.strictEqual(comps.length, 1);
  assert.strictEqual(comps[0].name, 'Card');
});

// --- scanAPIs ---

test('scanAPIs finds Next.js API routes', () => {
  const scanner = freshModule();
  writeFile('app/api/users/route.ts', 'export async function GET() {}');
  writeFile('app/api/posts/route.ts', 'export async function GET() {}');

  const apis = scanner.scanAPIs(testDir, 'nextjs');
  assert.strictEqual(apis.length, 2);
});

test('scanAPIs finds Express route files', () => {
  const scanner = freshModule();
  writeFile('src/routes/users.ts', 'router.get("/users")');
  writeFile('src/routes/posts.ts', 'router.get("/posts")');

  const apis = scanner.scanAPIs(testDir, 'express');
  assert.ok(apis.length >= 2);
});

// --- scanDatabase ---

test('scanDatabase finds Prisma models', () => {
  const scanner = freshModule();
  writeFile('prisma/schema.prisma', `
    model User {
      id Int @id
      name String
    }
    model Post {
      id Int @id
      title String
    }
  `);

  const dbs = scanner.scanDatabase(testDir);
  assert.strictEqual(dbs.length, 2);
  assert.ok(dbs.some(d => d.name === 'User'));
  assert.ok(dbs.some(d => d.name === 'Post'));
  assert.strictEqual(dbs[0].type, 'prisma_model');
});

test('scanDatabase finds Drizzle tables', () => {
  const scanner = freshModule();
  writeFile('src/db/schema/users.ts', `
    export const users = pgTable('users', {
      id: serial('id').primaryKey(),
    });
  `);

  const dbs = scanner.scanDatabase(testDir);
  assert.strictEqual(dbs.length, 1);
  assert.strictEqual(dbs[0].name, 'users');
  assert.strictEqual(dbs[0].type, 'drizzle_table');
});

test('scanDatabase finds Mongoose models', () => {
  const scanner = freshModule();
  writeFile('src/models/User.js', `
    const userSchema = new Schema({ name: String });
    module.exports = mongoose.model('User', userSchema);
  `);

  const dbs = scanner.scanDatabase(testDir);
  assert.strictEqual(dbs.length, 1);
  assert.strictEqual(dbs[0].name, 'User');
  assert.strictEqual(dbs[0].type, 'mongoose_model');
});

test('scanDatabase returns empty for no schemas', () => {
  const scanner = freshModule();
  const dbs = scanner.scanDatabase(testDir);
  assert.strictEqual(dbs.length, 0);
});

// --- fullScan ---

test('fullScan registers discovered entries', () => {
  const scanner = freshModule();
  writeFile('package.json', JSON.stringify({
    dependencies: { next: '14.0.0', react: '18.0.0', '@prisma/client': '5.0.0' }
  }));
  writeFile('app/page.tsx', 'export default function Home() {}');
  writeFile('src/components/Button.tsx', 'export default function Button() {}');
  writeFile('app/api/users/route.ts', 'export async function GET() {}');
  writeFile('prisma/schema.prisma', 'model User { id Int @id }');

  const result = scanner.fullScan({ projectRoot: testDir });
  assert.strictEqual(result.framework.framework, 'nextjs');
  assert.ok(result.registered.pages >= 1);
  assert.ok(result.registered.components >= 1);
  assert.ok(result.registered.apis >= 1);
  assert.ok(result.registered.database >= 1);
});

test('fullScan dryRun does not write to registry', () => {
  const scanner = freshModule();
  writeFile('package.json', JSON.stringify({ dependencies: { react: '18.0.0' } }));
  writeFile('src/components/Button.tsx', 'export default function Button() {}');

  const result = scanner.fullScan({ projectRoot: testDir, dryRun: true });
  assert.ok(result.registered.components >= 1);

  // Registry should still be empty
  try { delete require.cache[require.resolve('../project-registry')]; } catch (e) {}
  const registry = require('../project-registry');
  assert.strictEqual(registry.listAll('components').length, 0);
});

test('fullScan skips duplicates on second run', () => {
  const scanner = freshModule();
  writeFile('package.json', JSON.stringify({ dependencies: { react: '18.0.0' } }));
  writeFile('src/components/Button.tsx', 'export default function Button() {}');

  scanner.fullScan({ projectRoot: testDir });
  const result2 = scanner.fullScan({ projectRoot: testDir });
  assert.ok(result2.skipped.components >= 1);
  assert.strictEqual(result2.registered.components, 0);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
