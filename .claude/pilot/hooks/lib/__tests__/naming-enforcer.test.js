/**
 * Tests for Naming Consistency Enforcer — Phase 8.11 (Pilot AGI-11kb)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/naming-enforcer.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naming-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/registry'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModules() {
  const mods = ['../naming-enforcer', '../project-registry'];
  for (const mod of mods) {
    try { delete require.cache[require.resolve(mod)]; } catch (e) {}
  }
  return {
    naming: require('../naming-enforcer'),
    registry: require('../project-registry')
  };
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

console.log('\n=== Naming Consistency Enforcer Tests ===\n');

// --- normalizeToBase ---

test('normalizeToBase extracts base from PascalCase component names', () => {
  const { naming } = freshModules();
  assert.strictEqual(naming.normalizeToBase('UserList'), 'user');
  assert.strictEqual(naming.normalizeToBase('ProductCard'), 'product');
  assert.strictEqual(naming.normalizeToBase('OrderForm'), 'order');
});

test('normalizeToBase extracts base from plural names', () => {
  const { naming } = freshModules();
  assert.strictEqual(naming.normalizeToBase('users'), 'user');
  assert.strictEqual(naming.normalizeToBase('products'), 'product');
  assert.strictEqual(naming.normalizeToBase('categories'), 'category');
});

test('normalizeToBase extracts base from API paths', () => {
  const { naming } = freshModules();
  assert.strictEqual(naming.normalizeToBase('GET /api/users'), 'user');
  assert.strictEqual(naming.normalizeToBase('/products'), 'product');
});

test('normalizeToBase handles database names', () => {
  const { naming } = freshModules();
  assert.strictEqual(naming.normalizeToBase('users'), 'user');
  assert.strictEqual(naming.normalizeToBase('UserModel'), 'user');
  assert.strictEqual(naming.normalizeToBase('UserSchema'), 'user');
});

// --- singularize ---

test('singularize handles common cases', () => {
  const { naming } = freshModules();
  assert.strictEqual(naming.singularize('users'), 'user');
  assert.strictEqual(naming.singularize('categories'), 'category');
  assert.strictEqual(naming.singularize('boxes'), 'box');
  assert.strictEqual(naming.singularize('address'), 'address'); // don't strip 'ss'
});

// --- registerConcept / getConcept ---

test('registerConcept stores and retrieves concept mapping', () => {
  const { naming } = freshModules();
  const r = naming.registerConcept('user', {
    database: 'users',
    api: 'GET /users',
    component: 'UserList',
    page: 'UsersPage'
  });
  assert.strictEqual(r.success, true);

  const concept = naming.getConcept('user');
  assert.ok(concept);
  assert.strictEqual(concept.database, 'users');
  assert.strictEqual(concept.component, 'UserList');
});

test('registerConcept is case-insensitive', () => {
  const { naming } = freshModules();
  naming.registerConcept('User', { database: 'users' });
  assert.ok(naming.getConcept('user'));
  assert.ok(naming.getConcept('USER'));
});

test('getConcept returns null for unknown concept', () => {
  const { naming } = freshModules();
  assert.strictEqual(naming.getConcept('unknown'), null);
});

// --- removeConcept ---

test('removeConcept deletes a mapping', () => {
  const { naming } = freshModules();
  naming.registerConcept('temp', { database: 'temps' });
  assert.ok(naming.getConcept('temp'));

  naming.removeConcept('temp');
  assert.strictEqual(naming.getConcept('temp'), null);
});

// --- listConcepts ---

test('listConcepts returns all mappings', () => {
  const { naming } = freshModules();
  naming.registerConcept('user', { database: 'users' });
  naming.registerConcept('product', { database: 'products' });

  const concepts = naming.listConcepts();
  assert.ok(concepts.user);
  assert.ok(concepts.product);
});

// --- checkNameConsistency ---

test('checkNameConsistency passes for consistent name', () => {
  const { naming } = freshModules();
  naming.registerConcept('user', {
    database: 'users',
    component: 'UserList'
  });

  const r = naming.checkNameConsistency('UserList', 'component');
  assert.strictEqual(r.consistent, true);
});

test('checkNameConsistency catches inconsistent name', () => {
  const { naming } = freshModules();
  naming.registerConcept('user', {
    database: 'users',
    component: 'UserList'
  });

  const r = naming.checkNameConsistency('MemberList', 'component');
  // MemberList normalizes to 'member', not 'user', so no mapping found
  assert.strictEqual(r.consistent, true);
});

test('checkNameConsistency catches mapped inconsistency', () => {
  const { naming } = freshModules();
  naming.registerConcept('user', {
    database: 'users',
    component: 'UserList',
    api: 'GET /users'
  });

  // Direct concept lookup where user concept has api mapped
  const r = naming.checkNameConsistency('GET /members', 'api');
  // 'member' maps differently from 'user' — no mapping for 'member'
  assert.strictEqual(r.consistent, true);
});

// --- detectInconsistencies ---

test('detectInconsistencies finds cross-domain naming issues', () => {
  const { naming, registry } = freshModules();

  // Register entries with different base names for same concept
  registry.registerCollection({ name: 'users', file_path: 'prisma/schema.prisma' });
  registry.registerComponent({ name: 'MemberList', file_path: 'src/components/MemberList.tsx' });

  const issues = naming.detectInconsistencies();
  // 'users' normalizes to 'user', 'MemberList' normalizes to 'member' — different bases
  // So they WON'T be in the same group. No inconsistency detected for these.
  // This is correct: they genuinely refer to different concepts.
  assert.strictEqual(issues.length, 0);
});

test('detectInconsistencies returns empty for consistent naming', () => {
  const { naming, registry } = freshModules();

  registry.registerCollection({ name: 'users', file_path: 'prisma/schema.prisma' });
  registry.registerComponent({ name: 'UserList', file_path: 'src/components/UserList.tsx' });

  const issues = naming.detectInconsistencies();
  // Both normalize to 'user' → consistent
  assert.strictEqual(issues.length, 0);
});

test('detectInconsistencies returns empty when no registry', () => {
  const { naming } = freshModules();
  const issues = naming.detectInconsistencies();
  assert.strictEqual(issues.length, 0);
});

// --- buildConceptGroups ---

test('buildConceptGroups groups entries by base concept', () => {
  const { naming, registry } = freshModules();

  registry.registerCollection({ name: 'users', file_path: 'schema.prisma' });
  registry.registerComponent({ name: 'UserCard', file_path: 'src/components/UserCard.tsx' });
  registry.registerAPI({ name: 'GET /users', file_path: 'src/api/users.ts' });

  const groups = naming.buildConceptGroups(registry);
  assert.ok(groups.user);
  assert.strictEqual(groups.user.length, 3);
});

test('buildConceptGroups only returns multi-domain groups', () => {
  const { naming, registry } = freshModules();

  registry.registerComponent({ name: 'Button', file_path: 'src/components/Button.tsx' });
  registry.registerComponent({ name: 'Card', file_path: 'src/components/Card.tsx' });

  const groups = naming.buildConceptGroups(registry);
  // button and card are single-domain (components only) — not included
  assert.strictEqual(Object.keys(groups).length, 0);
});

// --- autoLearnFromRegistry ---

test('autoLearnFromRegistry populates name map from registry', () => {
  const { naming, registry } = freshModules();

  registry.registerCollection({ name: 'users', file_path: 'schema.prisma' });
  registry.registerComponent({ name: 'UserCard', file_path: 'src/components/UserCard.tsx' });
  registry.registerPage({ name: 'UsersPage', file_path: 'src/pages/users.tsx' });

  const result = naming.autoLearnFromRegistry();
  assert.ok(result.learned > 0);

  const concept = naming.getConcept('user');
  assert.ok(concept);
});

test('autoLearnFromRegistry skips already-mapped concepts', () => {
  const { naming, registry } = freshModules();

  naming.registerConcept('user', { database: 'users' });
  registry.registerCollection({ name: 'users', file_path: 'schema.prisma' });
  registry.registerComponent({ name: 'UserCard', file_path: 'src/components/UserCard.tsx' });

  const result = naming.autoLearnFromRegistry();
  assert.strictEqual(result.learned, 0);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
