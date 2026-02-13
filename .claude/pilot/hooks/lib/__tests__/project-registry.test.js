/**
 * Tests for Project Registry — Phase 8.4 (Pilot AGI-znbw)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/project-registry.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projreg-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/registry'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModule() {
  try { delete require.cache[require.resolve('../project-registry')]; } catch (e) {}
  return require('../project-registry');
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

console.log('\n=== Project Registry Tests ===\n');

// --- register ---

test('register creates entry in domain', () => {
  const reg = freshModule();
  const r = reg.registerPage({ name: 'HomePage', file_path: 'src/pages/home.tsx' });
  assert.ok(r.success);
  assert.ok(r.id);

  const all = reg.listAll('pages');
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].name, 'HomePage');
  assert.strictEqual(all[0].file_path, 'src/pages/home.tsx');
});

test('register rejects invalid domain', () => {
  const reg = freshModule();
  const r = reg.register('invalid', { name: 'test' });
  assert.strictEqual(r.success, false);
  assert.ok(r.error.includes('invalid domain'));
});

test('register requires name', () => {
  const reg = freshModule();
  const r = reg.registerPage({});
  assert.strictEqual(r.success, false);
  assert.ok(r.error.includes('name'));
});

test('register blocks exact name duplicates', () => {
  const reg = freshModule();
  reg.registerPage({ name: 'HomePage', file_path: 'src/pages/home.tsx' });
  const r = reg.registerPage({ name: 'HomePage', file_path: 'src/pages/home2.tsx' });
  assert.strictEqual(r.success, false);
  assert.ok(r.duplicate);
});

test('register blocks similar name duplicates', () => {
  const reg = freshModule();
  reg.registerComponent({ name: 'UserProfileCard', file_path: 'src/components/UserProfileCard.tsx' });
  const r = reg.registerComponent({ name: 'UserProfileCards', file_path: 'src/components/UserProfileCards.tsx' });
  assert.strictEqual(r.success, false);
  assert.ok(r.duplicate);
});

test('register blocks same file_path duplicates', () => {
  const reg = freshModule();
  reg.registerAPI({ name: 'GetUsers', file_path: 'src/api/users.ts' });
  const r = reg.registerAPI({ name: 'ListUsers', file_path: 'src/api/users.ts' });
  assert.strictEqual(r.success, false);
});

test('register stores all fields', () => {
  const reg = freshModule();
  reg.registerCollection({
    name: 'users',
    file_path: 'prisma/schema.prisma',
    type: 'table',
    description: 'User accounts',
    created_by: 'backend',
    dependencies: ['roles']
  });

  const all = reg.listAll('database');
  assert.strictEqual(all[0].name, 'users');
  assert.strictEqual(all[0].type, 'table');
  assert.strictEqual(all[0].description, 'User accounts');
  assert.strictEqual(all[0].created_by, 'backend');
  assert.deepStrictEqual(all[0].dependencies, ['roles']);
  assert.ok(all[0].created_at);
});

// --- all domain convenience functions ---

test('registerPage/Component/API/Collection all work', () => {
  const reg = freshModule();
  assert.ok(reg.registerPage({ name: 'Home' }).success);
  assert.ok(reg.registerComponent({ name: 'Button' }).success);
  assert.ok(reg.registerAPI({ name: 'GET /users' }).success);
  assert.ok(reg.registerCollection({ name: 'users' }).success);

  assert.strictEqual(reg.listAll('pages').length, 1);
  assert.strictEqual(reg.listAll('components').length, 1);
  assert.strictEqual(reg.listAll('apis').length, 1);
  assert.strictEqual(reg.listAll('database').length, 1);
});

// --- update ---

test('update modifies entry fields', () => {
  const reg = freshModule();
  const r = reg.registerPage({ name: 'HomePage', file_path: 'src/pages/home.tsx' });
  reg.update('pages', r.id, { description: 'Main landing page' });

  const entry = reg.getById('pages', r.id);
  assert.strictEqual(entry.description, 'Main landing page');
  assert.ok(entry.updated_at);
});

test('update rejects duplicate name', () => {
  const reg = freshModule();
  reg.registerPage({ name: 'HomePage' });
  const r2 = reg.registerPage({ name: 'AboutPage' });
  const up = reg.update('pages', r2.id, { name: 'HomePage' });
  assert.strictEqual(up.success, false);
});

test('update rejects invalid domain', () => {
  const reg = freshModule();
  assert.strictEqual(reg.update('invalid', 'id', {}).success, false);
});

test('update rejects missing id', () => {
  const reg = freshModule();
  assert.strictEqual(reg.update('pages', null, {}).success, false);
});

test('update rejects non-existent entry', () => {
  const reg = freshModule();
  assert.strictEqual(reg.update('pages', 'nonexistent', {}).success, false);
});

// --- remove ---

test('remove deletes entry', () => {
  const reg = freshModule();
  const r = reg.registerPage({ name: 'TempPage' });
  assert.strictEqual(reg.listAll('pages').length, 1);

  reg.remove('pages', r.id);
  assert.strictEqual(reg.listAll('pages').length, 0);
});

test('remove rejects non-existent entry', () => {
  const reg = freshModule();
  assert.strictEqual(reg.remove('pages', 'nonexistent').success, false);
});

// --- findByName ---

test('findByName returns exact matches', () => {
  const reg = freshModule();
  reg.registerComponent({ name: 'Button' });
  reg.registerComponent({ name: 'Input' });

  const results = reg.findByName('components', 'Button');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].name, 'Button');
});

test('findByName returns similar matches', () => {
  const reg = freshModule();
  reg.registerComponent({ name: 'UserProfileCard' });

  const results = reg.findByName('components', 'UserProfileCards');
  assert.ok(results.length > 0);
});

test('findByName is case-insensitive', () => {
  const reg = freshModule();
  reg.registerPage({ name: 'HomePage' });

  const results = reg.findByName('pages', 'homepage');
  assert.strictEqual(results.length, 1);
});

// --- findByPath ---

test('findByPath returns matches', () => {
  const reg = freshModule();
  reg.registerPage({ name: 'Home', file_path: 'src/pages/home.tsx' });

  const results = reg.findByPath('pages', 'src/pages/home.tsx');
  assert.strictEqual(results.length, 1);
});

test('findByPath matches partial paths', () => {
  const reg = freshModule();
  reg.registerPage({ name: 'Home', file_path: 'src/pages/home.tsx' });

  const results = reg.findByPath('pages', 'pages/home.tsx');
  assert.strictEqual(results.length, 1);
});

// --- findByPattern ---

test('findByPattern matches regex on name', () => {
  const reg = freshModule();
  reg.registerComponent({ name: 'UserCard' });
  reg.registerComponent({ name: 'UserAvatar' });
  reg.registerComponent({ name: 'Button' });

  const results = reg.findByPattern('components', 'User');
  assert.strictEqual(results.length, 2);
});

test('findByPattern matches regex on file_path', () => {
  const reg = freshModule();
  reg.registerAPI({ name: 'GetUsers', file_path: 'src/api/users.ts' });
  reg.registerAPI({ name: 'GetPosts', file_path: 'src/api/posts.ts' });

  const results = reg.findByPattern('apis', 'users');
  assert.strictEqual(results.length, 1);
});

// --- getById ---

test('getById returns entry', () => {
  const reg = freshModule();
  const r = reg.registerPage({ name: 'Home' });
  const entry = reg.getById('pages', r.id);
  assert.ok(entry);
  assert.strictEqual(entry.name, 'Home');
});

test('getById returns null for missing entry', () => {
  const reg = freshModule();
  assert.strictEqual(reg.getById('pages', 'nonexistent'), null);
});

// --- searchAll ---

test('searchAll searches across all domains', () => {
  const reg = freshModule();
  reg.registerPage({ name: 'UserProfile', file_path: 'src/pages/user.tsx' });
  reg.registerComponent({ name: 'UserCard', file_path: 'src/components/UserCard.tsx' });
  reg.registerAPI({ name: 'GET /users', file_path: 'src/api/users.ts' });
  reg.registerCollection({ name: 'users', file_path: 'prisma/schema.prisma' });

  const results = reg.searchAll('user');
  assert.ok(results.pages && results.pages.length > 0);
  assert.ok(results.components && results.components.length > 0);
  assert.ok(results.apis && results.apis.length > 0);
  assert.ok(results.database && results.database.length > 0);
});

// --- findCrossDomainDuplicate ---

test('findCrossDomainDuplicate detects same name across domains', () => {
  const reg = freshModule();
  reg.registerCollection({ name: 'users' });

  const dup = reg.findCrossDomainDuplicate('users');
  assert.ok(dup);
  assert.strictEqual(dup.domain, 'database');
  assert.strictEqual(dup.entry.name, 'users');
});

test('findCrossDomainDuplicate returns null when no match', () => {
  const reg = freshModule();
  assert.strictEqual(reg.findCrossDomainDuplicate('nonexistent'), null);
});

// --- buildSummary ---

test('buildSummary returns compact overview', () => {
  const reg = freshModule();
  reg.registerPage({ name: 'Home' });
  reg.registerPage({ name: 'About' });
  reg.registerComponent({ name: 'Button' });

  const summary = reg.buildSummary();
  assert.strictEqual(summary.pages.count, 2);
  assert.ok(summary.pages.names.includes('Home'));
  assert.strictEqual(summary.components.count, 1);
  assert.strictEqual(summary.apis.count, 0);
  assert.strictEqual(summary.database.count, 0);
});

// --- getStats ---

test('getStats returns counts', () => {
  const reg = freshModule();
  reg.registerPage({ name: 'Home' });
  reg.registerComponent({ name: 'Button' });
  reg.registerAPI({ name: 'GET /health' });

  const stats = reg.getStats();
  assert.strictEqual(stats.total, 3);
  assert.strictEqual(stats.by_domain.pages, 1);
  assert.strictEqual(stats.by_domain.components, 1);
  assert.strictEqual(stats.by_domain.apis, 1);
  assert.strictEqual(stats.by_domain.database, 0);
});

// --- similarity ---

test('similarity returns 1 for identical strings', () => {
  const reg = freshModule();
  assert.strictEqual(reg.similarity('hello', 'hello'), 1);
});

test('similarity returns 0 for very different strings', () => {
  const reg = freshModule();
  const sim = reg.similarity('abc', 'xyz');
  assert.ok(sim < 0.3);
});

test('similarity detects close names', () => {
  const reg = freshModule();
  const sim = reg.similarity('userprofilecard', 'userprofilecards');
  assert.ok(sim >= 0.75);
});

// --- edge cases ---

test('listAll returns empty for non-existent registry', () => {
  const reg = freshModule();
  assert.deepStrictEqual(reg.listAll('pages'), []);
});

test('multiple entries in same domain work correctly', () => {
  const reg = freshModule();
  reg.registerPage({ name: 'Home', file_path: 'src/pages/home.tsx' });
  reg.registerPage({ name: 'About', file_path: 'src/pages/about.tsx' });
  reg.registerPage({ name: 'Contact', file_path: 'src/pages/contact.tsx' });

  assert.strictEqual(reg.listAll('pages').length, 3);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
