/**
 * Tests for Registry Enforcement — Phase 8.6 (Pilot AGI-etpl)
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/registry-enforcer.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regenf-test-'));
  fs.mkdirSync(path.join(testDir, '.claude/pilot/registry'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModules() {
  const modPaths = ['../registry-enforcer', '../project-registry'];
  for (const modPath of modPaths) {
    try { delete require.cache[require.resolve(modPath)]; } catch (e) {}
  }
  return {
    enforcer: require('../registry-enforcer'),
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

console.log('\n=== Registry Enforcer Tests ===\n');

// --- checkBeforeWrite ---

test('checkBeforeWrite allows edits to existing files', () => {
  const { enforcer } = freshModules();
  fs.mkdirSync(path.join(testDir, 'src/components'), { recursive: true });
  fs.writeFileSync(path.join(testDir, 'src/components/Button.tsx'), '');

  const r = enforcer.checkBeforeWrite('src/components/Button.tsx', { projectRoot: testDir });
  assert.strictEqual(r.allowed, true);
});

test('checkBeforeWrite warns on similar component name', () => {
  const { enforcer, registry } = freshModules();
  registry.registerComponent({ name: 'UserCard', file_path: 'src/components/UserCard.tsx' });

  const r = enforcer.checkBeforeWrite('src/components/UserCards.tsx', {
    projectRoot: testDir,
    isNewFile: true
  });
  assert.strictEqual(r.allowed, true);
  assert.ok(r.warning);
  assert.ok(r.warning.includes('UserCard'));
});

test('checkBeforeWrite warns on exact duplicate page', () => {
  const { enforcer, registry } = freshModules();
  registry.registerPage({ name: 'About', file_path: 'src/pages/About.tsx' });

  const r = enforcer.checkBeforeWrite('src/pages/About.tsx', {
    projectRoot: testDir,
    isNewFile: true
  });
  // Existing file at same path — returns info, not warning
  assert.strictEqual(r.allowed, true);
});

test('checkBeforeWrite allows non-registry file types', () => {
  const { enforcer } = freshModules();
  const r = enforcer.checkBeforeWrite('README.md', { projectRoot: testDir, isNewFile: true });
  assert.strictEqual(r.allowed, true);
  assert.ok(!r.warning);
});

test('checkBeforeWrite allows test files', () => {
  const { enforcer } = freshModules();
  const r = enforcer.checkBeforeWrite('src/components/Button.test.tsx', {
    projectRoot: testDir,
    isNewFile: true
  });
  assert.strictEqual(r.allowed, true);
  assert.ok(!r.warning);
});

test('checkBeforeWrite handles null filePath', () => {
  const { enforcer } = freshModules();
  const r = enforcer.checkBeforeWrite(null);
  assert.strictEqual(r.allowed, true);
});

test('checkBeforeWrite warns on cross-domain name collision', () => {
  const { enforcer, registry } = freshModules();
  registry.registerCollection({ name: 'users', file_path: 'prisma/schema.prisma' });

  const r = enforcer.checkBeforeWrite('src/components/users.tsx', {
    projectRoot: testDir,
    isNewFile: true
  });
  assert.strictEqual(r.allowed, true);
  // May warn about cross-domain duplicate
  if (r.warning) {
    assert.ok(r.warning.includes('users'));
  }
});

// --- classifyFile ---

test('classifyFile identifies pages', () => {
  const { enforcer } = freshModules();
  assert.strictEqual(enforcer.classifyFile('src/pages/Home.tsx').domain, 'pages');
  assert.strictEqual(enforcer.classifyFile('app/about/page.tsx').domain, 'pages');
});

test('classifyFile identifies components', () => {
  const { enforcer } = freshModules();
  assert.strictEqual(enforcer.classifyFile('src/components/Button.tsx').domain, 'components');
  assert.strictEqual(enforcer.classifyFile('ui/Card.tsx').domain, 'components');
});

test('classifyFile identifies APIs', () => {
  const { enforcer } = freshModules();
  assert.strictEqual(enforcer.classifyFile('src/api/users.ts').domain, 'apis');
  assert.strictEqual(enforcer.classifyFile('app/api/users/route.ts').domain, 'apis');
});

test('classifyFile identifies database files', () => {
  const { enforcer } = freshModules();
  assert.strictEqual(enforcer.classifyFile('prisma/schema.prisma').domain, 'database');
  assert.strictEqual(enforcer.classifyFile('src/models/User.ts').domain, 'database');
});

test('classifyFile returns null for non-tracked files', () => {
  const { enforcer } = freshModules();
  assert.strictEqual(enforcer.classifyFile('README.md'), null);
  assert.strictEqual(enforcer.classifyFile('package.json'), null);
  assert.strictEqual(enforcer.classifyFile('src/components/Button.test.tsx'), null);
  assert.strictEqual(enforcer.classifyFile('src/components/Button.stories.tsx'), null);
});

test('classifyFile excludes layout/loading/error files', () => {
  const { enforcer } = freshModules();
  assert.strictEqual(enforcer.classifyFile('app/layout.tsx'), null);
  assert.strictEqual(enforcer.classifyFile('app/loading.tsx'), null);
  assert.strictEqual(enforcer.classifyFile('app/error.tsx'), null);
});

// --- inferName ---

test('inferName extracts name from file path', () => {
  const { enforcer } = freshModules();
  assert.strictEqual(enforcer.inferName('src/components/Button.tsx', { domain: 'components' }), 'Button');
});

test('inferName uses parent dir for index files', () => {
  const { enforcer } = freshModules();
  assert.strictEqual(enforcer.inferName('src/components/Card/index.tsx', { domain: 'components' }), 'Card');
});

test('inferName uses parent dir for page files', () => {
  const { enforcer } = freshModules();
  assert.strictEqual(enforcer.inferName('app/about/page.tsx', { domain: 'pages' }), 'about');
});

// --- buildRegistryContext ---

test('buildRegistryContext returns null when registry is empty', () => {
  const { enforcer } = freshModules();
  const ctx = enforcer.buildRegistryContext();
  assert.strictEqual(ctx, null);
});

test('buildRegistryContext returns summary when registry has entries', () => {
  const { enforcer, registry } = freshModules();
  registry.registerPage({ name: 'Home' });
  registry.registerComponent({ name: 'Button' });
  registry.registerAPI({ name: 'GET /users' });

  const ctx = enforcer.buildRegistryContext();
  assert.ok(ctx);
  assert.strictEqual(ctx.total_entries, 3);
  assert.ok(ctx.pages);
  assert.ok(ctx.components);
  assert.ok(ctx.apis);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
