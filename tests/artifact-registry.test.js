#!/usr/bin/env node

/**
 * Verification tests for Artifact Registry (Phase 4.7)
 * Tests: artifact-registry.js (manifests, artifact I/O, dependency resolution, progress)
 *
 * Run: node tests/artifact-registry.test.js
 *
 * Part of Phase 4.7 (Pilot AGI-y1l)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

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

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg || 'assertDeepEqual'}: expected ${e}, got ${a}`);
  }
}

// =============================================================================
// SETUP: temp directory for isolated file operations
// =============================================================================

const ORIG_CWD = process.cwd();
const TMP_DIR = path.join(os.tmpdir(), 'pilot-artifact-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/state/artifacts'), { recursive: true });

// Fresh module load
function freshModule() {
  const modPath = require.resolve('../.claude/pilot/hooks/lib/artifact-registry');
  delete require.cache[modPath];
  return require(modPath);
}

// =============================================================================
// TEST: Manifest Operations
// =============================================================================

console.log('\n=== Manifest Operations ===');

test('getManifest returns empty manifest when none exists', () => {
  const registry = freshModule();
  const manifest = registry.getManifest('nonexistent-task', TMP_DIR);
  assertDeepEqual(manifest.outputs, []);
  assertDeepEqual(manifest.inputs, []);
});

test('declareOutputs creates manifest with outputs', () => {
  const registry = freshModule();
  registry.declareOutputs('task-A', [
    { name: 'api-contract.json', description: 'REST API endpoints' },
    { name: 'types.ts', description: 'TypeScript types' }
  ], TMP_DIR);

  const manifest = registry.getManifest('task-A', TMP_DIR);
  assertEqual(manifest.outputs.length, 2);
  assertEqual(manifest.outputs[0].name, 'api-contract.json');
  assertEqual(manifest.outputs[1].name, 'types.ts');
  assert(manifest.declared_at, 'should have declared_at');
});

test('declareOutputs is additive (no duplicates)', () => {
  const registry = freshModule();
  registry.declareOutputs('task-A', [
    { name: 'api-contract.json' },  // already exists
    { name: 'schema.sql' }          // new
  ], TMP_DIR);

  const manifest = registry.getManifest('task-A', TMP_DIR);
  assertEqual(manifest.outputs.length, 3);
  assertEqual(manifest.outputs[2].name, 'schema.sql');
});

test('declareInputs creates input dependencies', () => {
  const registry = freshModule();
  registry.declareInputs('task-B', [
    { taskId: 'task-A', name: 'api-contract.json' },
    { taskId: 'task-A', name: 'types.ts' }
  ], TMP_DIR);

  const manifest = registry.getManifest('task-B', TMP_DIR);
  assertEqual(manifest.inputs.length, 2);
  assertEqual(manifest.inputs[0].taskId, 'task-A');
  assertEqual(manifest.inputs[0].name, 'api-contract.json');
});

test('declareInputs is additive (no duplicates)', () => {
  const registry = freshModule();
  registry.declareInputs('task-B', [
    { taskId: 'task-A', name: 'api-contract.json' },  // already exists
    { taskId: 'task-C', name: 'data.csv' }             // new
  ], TMP_DIR);

  const manifest = registry.getManifest('task-B', TMP_DIR);
  assertEqual(manifest.inputs.length, 3);
  assertEqual(manifest.inputs[2].taskId, 'task-C');
});

// =============================================================================
// TEST: Artifact I/O
// =============================================================================

console.log('\n=== Artifact I/O ===');

test('publishArtifact writes string content', () => {
  const registry = freshModule();
  registry.publishArtifact('task-A', 'api-contract.json', '{"endpoints": ["/users"]}', TMP_DIR);

  const content = registry.readArtifact('task-A', 'api-contract.json', TMP_DIR);
  assertEqual(content, '{"endpoints": ["/users"]}');
});

test('publishArtifact serializes objects to JSON', () => {
  const registry = freshModule();
  registry.publishArtifact('task-A', 'types.ts', { User: { id: 'number' } }, TMP_DIR);

  const content = registry.readArtifact('task-A', 'types.ts', TMP_DIR);
  const parsed = JSON.parse(content);
  assertEqual(parsed.User.id, 'number');
});

test('publishArtifact auto-declares in manifest', () => {
  const registry = freshModule();
  registry.publishArtifact('task-new', 'readme.md', '# Hello', TMP_DIR);

  const manifest = registry.getManifest('task-new', TMP_DIR);
  assertEqual(manifest.outputs.length, 1);
  assertEqual(manifest.outputs[0].name, 'readme.md');
});

test('readArtifact returns null for missing artifact', () => {
  const registry = freshModule();
  const content = registry.readArtifact('task-A', 'nonexistent.txt', TMP_DIR);
  assertEqual(content, null);
});

test('listArtifacts returns published files', () => {
  const registry = freshModule();
  const artifacts = registry.listArtifacts('task-A', TMP_DIR);
  assert(artifacts.includes('api-contract.json'), 'should include api-contract.json');
  assert(artifacts.includes('types.ts'), 'should include types.ts');
});

test('listArtifacts returns empty array for unknown task', () => {
  const registry = freshModule();
  const artifacts = registry.listArtifacts('unknown-task', TMP_DIR);
  assertEqual(artifacts.length, 0);
});

// =============================================================================
// TEST: Dependency Resolution
// =============================================================================

console.log('\n=== Dependency Resolution ===');

test('checkArtifactsReady returns true when no inputs declared', () => {
  const registry = freshModule();
  const ready = registry.checkArtifactsReady('task-A', TMP_DIR);
  assertEqual(ready, true);
});

test('checkArtifactsReady returns true when all inputs available', () => {
  const registry = freshModule();
  // task-B needs api-contract.json and types.ts from task-A
  // Both were published above
  const ready = registry.checkArtifactsReady('task-B', TMP_DIR);
  // task-B also has input from task-C:data.csv which doesn't exist
  assertEqual(ready, false);
});

test('getBlockingArtifacts returns missing inputs', () => {
  const registry = freshModule();
  const blocking = registry.getBlockingArtifacts('task-B', TMP_DIR);
  // task-C:data.csv is missing
  assertEqual(blocking.length, 1);
  assertEqual(blocking[0].taskId, 'task-C');
  assertEqual(blocking[0].name, 'data.csv');
});

test('getBlockingArtifacts returns empty when all inputs available', () => {
  const registry = freshModule();
  // Publish the missing artifact
  registry.publishArtifact('task-C', 'data.csv', 'id,name\n1,Alice', TMP_DIR);

  const blocking = registry.getBlockingArtifacts('task-B', TMP_DIR);
  assertEqual(blocking.length, 0);
});

test('checkArtifactsReady returns true after all inputs published', () => {
  const registry = freshModule();
  const ready = registry.checkArtifactsReady('task-B', TMP_DIR);
  assertEqual(ready, true);
});

// =============================================================================
// TEST: Progress Tracking
// =============================================================================

console.log('\n=== Progress Tracking ===');

test('recordProgress appends entries', () => {
  const registry = freshModule();
  registry.recordProgress('task-A', 'step-1', 'started', TMP_DIR);
  registry.recordProgress('task-A', 'step-1', 'completed', TMP_DIR);
  registry.recordProgress('task-A', 'step-2', 'started', TMP_DIR);

  const progress = registry.getProgress('task-A', TMP_DIR);
  assertEqual(progress.length, 3);
  assertEqual(progress[0].step, 'step-1');
  assertEqual(progress[0].status, 'started');
  assertEqual(progress[1].status, 'completed');
  assertEqual(progress[2].step, 'step-2');
  assert(progress[0].ts, 'should have timestamp');
});

test('getProgress returns empty for unknown task', () => {
  const registry = freshModule();
  const progress = registry.getProgress('unknown-task', TMP_DIR);
  assertEqual(progress.length, 0);
});

// =============================================================================
// TEST: Cleanup
// =============================================================================

console.log('\n=== Cleanup ===');

test('cleanupArtifacts removes task directory', () => {
  const registry = freshModule();
  // Verify directory exists
  const dir = path.join(TMP_DIR, registry.ARTIFACTS_DIR, 'task-new');
  assert(fs.existsSync(dir), 'directory should exist before cleanup');

  registry.cleanupArtifacts('task-new', TMP_DIR);
  assert(!fs.existsSync(dir), 'directory should not exist after cleanup');
});

test('cleanupArtifacts is safe for nonexistent task', () => {
  const registry = freshModule();
  // Should not throw
  registry.cleanupArtifacts('nonexistent-task', TMP_DIR);
});

// =============================================================================
// TEST: Integration — E2E Flow
// =============================================================================

console.log('\n=== Integration: E2E Flow ===');

test('E2E: Task A produces → Task B consumes → ready check passes', () => {
  const registry = freshModule();

  // Clean slate
  registry.cleanupArtifacts('e2e-backend', TMP_DIR);
  registry.cleanupArtifacts('e2e-frontend', TMP_DIR);

  // Backend task declares its outputs
  registry.declareOutputs('e2e-backend', [
    { name: 'api-spec.json', description: 'OpenAPI spec' },
    { name: 'db-schema.sql', description: 'Database schema' }
  ], TMP_DIR);

  // Frontend task declares its inputs
  registry.declareInputs('e2e-frontend', [
    { taskId: 'e2e-backend', name: 'api-spec.json' },
    { taskId: 'e2e-backend', name: 'db-schema.sql' }
  ], TMP_DIR);

  // Frontend is NOT ready yet (backend hasn't published)
  assertEqual(registry.checkArtifactsReady('e2e-frontend', TMP_DIR), false);
  const blocking1 = registry.getBlockingArtifacts('e2e-frontend', TMP_DIR);
  assertEqual(blocking1.length, 2);

  // Backend publishes first artifact
  registry.publishArtifact('e2e-backend', 'api-spec.json', {
    openapi: '3.0.0',
    paths: { '/users': { get: {} } }
  }, TMP_DIR);

  // Still not ready (db-schema missing)
  assertEqual(registry.checkArtifactsReady('e2e-frontend', TMP_DIR), false);
  const blocking2 = registry.getBlockingArtifacts('e2e-frontend', TMP_DIR);
  assertEqual(blocking2.length, 1);
  assertEqual(blocking2[0].name, 'db-schema.sql');

  // Backend publishes second artifact
  registry.publishArtifact('e2e-backend', 'db-schema.sql',
    'CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT);', TMP_DIR);

  // Now frontend is ready
  assertEqual(registry.checkArtifactsReady('e2e-frontend', TMP_DIR), true);
  assertEqual(registry.getBlockingArtifacts('e2e-frontend', TMP_DIR).length, 0);

  // Frontend can read the artifacts
  const apiSpec = registry.readArtifact('e2e-backend', 'api-spec.json', TMP_DIR);
  assert(apiSpec.includes('/users'), 'should contain API path');

  const dbSchema = registry.readArtifact('e2e-backend', 'db-schema.sql', TMP_DIR);
  assert(dbSchema.includes('CREATE TABLE'), 'should contain SQL');

  // Backend progress tracking
  registry.recordProgress('e2e-backend', 'api-spec', 'completed', TMP_DIR);
  registry.recordProgress('e2e-backend', 'db-schema', 'completed', TMP_DIR);
  const progress = registry.getProgress('e2e-backend', TMP_DIR);
  assertEqual(progress.length, 2);

  // Cleanup
  registry.cleanupArtifacts('e2e-backend', TMP_DIR);
  registry.cleanupArtifacts('e2e-frontend', TMP_DIR);
});

// =============================================================================
// TEARDOWN
// =============================================================================

try {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
} catch { /* ignore */ }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
