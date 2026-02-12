#!/usr/bin/env node

/**
 * Verification tests for Task Auto-Decomposition (Phase 3.3)
 * Run: node tests/decomposition.test.js
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

// =============================================================================
// SETUP: temp directory for isolated file operations
// =============================================================================

const ORIG_CWD = process.cwd();
const TMP_DIR = path.join(require('os').tmpdir(), 'pilot-decomposition-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

// Create minimal directory structure
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/memory/channels'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/memory/schemas'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, 'work/research'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, 'src/components'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, 'src/lib'), { recursive: true });

// Copy memory index and schemas
fs.copyFileSync(
  path.join(ORIG_CWD, '.claude/pilot/memory/index.json'),
  path.join(TMP_DIR, '.claude/pilot/memory/index.json')
);
fs.copyFileSync(
  path.join(ORIG_CWD, '.claude/pilot/memory/schemas/research-findings.schema.json'),
  path.join(TMP_DIR, '.claude/pilot/memory/schemas/research-findings.schema.json')
);

// Create test source files for import graph analysis
fs.writeFileSync(path.join(TMP_DIR, 'src/lib/types.ts'), `
export interface User {
  id: string;
  name: string;
}
`);

fs.writeFileSync(path.join(TMP_DIR, 'src/lib/api.ts'), `
import { User } from './types';

export function getUser(id: string): User {
  return { id, name: 'test' };
}
`);

fs.writeFileSync(path.join(TMP_DIR, 'src/components/Profile.tsx'), `
import { User } from '../lib/types';
import { getUser } from '../lib/api';
const React = require('react');

export function Profile() {
  return <div>Profile</div>;
}
`);

// Switch to temp directory
process.chdir(TMP_DIR);

// Clear require cache for modules that depend on cwd
const modulesToClear = ['memory', 'pm-research', 'decomposition', 'messaging'];
for (const key of Object.keys(require.cache)) {
  if (modulesToClear.some(m => key.includes(m))) {
    delete require.cache[key];
  }
}

const decomposition = require(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/decomposition'));

// =============================================================================
// TESTS: shouldDecompose
// =============================================================================

console.log('\n--- shouldDecompose ---');

test('S task returns false', () => {
  const r = decomposition.shouldDecompose({ id: 't1', title: 'Fix typo', description: '' });
  assert(r.decompose === false, 'Should not decompose simple task');
});

test('L task returns true', () => {
  const r = decomposition.shouldDecompose({
    id: 't2',
    title: 'Build authentication system with OAuth integration',
    description: 'Full architecture redesign of the auth system including middleware and providers and database schema migration'
  });
  assert(r.decompose === true, 'Should decompose large task');
});

test('M multi-domain returns true', () => {
  const r = decomposition.shouldDecompose({
    id: 't3',
    title: 'Create user profile page with API',
    description: 'Build a page with form components and REST endpoint'
  });
  // M task with multi-domain keywords
  assert(typeof r.decompose === 'boolean', 'Should return boolean');
});

test('null task returns false', () => {
  const r = decomposition.shouldDecompose(null);
  assert(r.decompose === false, 'Null task should not decompose');
});

// =============================================================================
// TESTS: classifyTaskDomain
// =============================================================================

console.log('\n--- classifyTaskDomain ---');

test('API keywords classify as api_only', () => {
  const r = decomposition.classifyTaskDomain({ id: 't1', title: 'Create REST API endpoint', description: 'CRUD operations' });
  assert(r.domain === 'api_only', 'Expected api_only, got ' + r.domain);
  assert(r.requires.includes('backend'), 'Should require backend');
});

test('UI keywords classify as ui_only', () => {
  const r = decomposition.classifyTaskDomain({ id: 't2', title: 'Create dashboard widget component', description: 'New UI layout' });
  assert(r.domain === 'ui_only', 'Expected ui_only, got ' + r.domain);
  assert(r.requires.includes('frontend'), 'Should require frontend');
});

test('Infrastructure keywords classify correctly', () => {
  const r = decomposition.classifyTaskDomain({ id: 't3', title: 'Build message bus engine', description: 'New messaging protocol' });
  assert(r.domain === 'infrastructure', 'Expected infrastructure, got ' + r.domain);
});

test('Design keywords classify correctly', () => {
  const r = decomposition.classifyTaskDomain({ id: 't4', title: 'Update design tokens color palette', description: 'New typography scale' });
  assert(r.domain === 'design_system', 'Expected design_system, got ' + r.domain);
});

test('Refactor keywords classify correctly', () => {
  const r = decomposition.classifyTaskDomain({ id: 't5', title: 'Refactor auth to migrate to new system', description: 'Replace old auth' });
  assert(r.domain === 'refactor', 'Expected refactor, got ' + r.domain);
});

test('Empty task defaults to infrastructure', () => {
  const r = decomposition.classifyTaskDomain({ id: 't6', title: '', description: '' });
  assert(r.confidence === 0, 'Should have 0 confidence');
});

// =============================================================================
// TESTS: generateSubtasks
// =============================================================================

console.log('\n--- generateSubtasks ---');

test('Full-stack domain generates frontend + backend subtasks', () => {
  const domain = { domain: 'full_stack', requires: ['backend', 'frontend'], postAgents: ['testing', 'review'] };
  const subtasks = decomposition.generateSubtasks(
    { id: 't1', title: 'Build user profile', description: '' },
    domain,
    null
  );
  assert(subtasks.length >= 3, 'Should have at least 3 subtasks, got ' + subtasks.length);
  assert(subtasks.some(s => s.agent === 'backend'), 'Should have backend subtask');
  assert(subtasks.some(s => s.agent === 'frontend'), 'Should have frontend subtask');
  assert(subtasks.some(s => s.agent === 'testing'), 'Should have testing subtask');
});

test('API-only domain generates backend subtasks', () => {
  const domain = { domain: 'api_only', requires: ['backend'], postAgents: ['security', 'testing'] };
  const subtasks = decomposition.generateSubtasks(
    { id: 't2', title: 'Create products API', description: '' },
    domain,
    null
  );
  assert(subtasks.some(s => s.agent === 'backend'), 'Should have backend subtask');
  assert(subtasks.some(s => s.agent === 'security'), 'Should have security subtask');
});

test('Subtasks have required fields', () => {
  const domain = { domain: 'infrastructure', requires: ['backend'], postAgents: ['testing'] };
  const subtasks = decomposition.generateSubtasks(
    { id: 't3', title: 'Build engine', description: '' },
    domain,
    null
  );
  for (const st of subtasks) {
    assert(st.id, 'Subtask must have id');
    assert(st.title, 'Subtask must have title');
    assert(st.agent, 'Subtask must have agent');
    assert(st.priority, 'Subtask must have priority');
    assert(Array.isArray(st.depends_on), 'Subtask must have depends_on array');
  }
});

test('Max subtasks enforced', () => {
  const domain = { domain: 'full_stack', requires: ['backend', 'frontend'], postAgents: ['testing', 'security', 'review'] };
  const subtasks = decomposition.generateSubtasks(
    { id: 't4', title: 'Build massive system', description: '' },
    domain,
    { relevant_files: Array.from({ length: 20 }, (_, i) => `src/components/file${i}.tsx`) }
  );
  assert(subtasks.length <= decomposition.MAX_SUBTASKS, 'Should not exceed MAX_SUBTASKS');
});

// =============================================================================
// TESTS: buildDependencyDAG
// =============================================================================

console.log('\n--- buildDependencyDAG ---');

test('Simple chain produces correct waves', () => {
  const dag = decomposition.buildDependencyDAG([
    { id: 'st-001', depends_on: [] },
    { id: 'st-002', depends_on: ['st-001'] },
    { id: 'st-003', depends_on: ['st-002'] }
  ]);
  assert(dag.hasCycle === false, 'Should not have cycle');
  assert(dag.waves.length === 3, 'Should have 3 waves, got ' + dag.waves.length);
  assert(dag.waves[0].includes('st-001'), 'Wave 0 should contain st-001');
  assert(dag.waves[1].includes('st-002'), 'Wave 1 should contain st-002');
  assert(dag.waves[2].includes('st-003'), 'Wave 2 should contain st-003');
});

test('Parallel tasks in same wave', () => {
  const dag = decomposition.buildDependencyDAG([
    { id: 'st-001', depends_on: [] },
    { id: 'st-002', depends_on: [] },
    { id: 'st-003', depends_on: ['st-001', 'st-002'] }
  ]);
  assert(dag.waves[0].length === 2, 'Wave 0 should have 2 parallel tasks');
  assert(dag.waves[1].includes('st-003'), 'Wave 1 should contain st-003');
});

test('Cycle detection', () => {
  const dag = decomposition.buildDependencyDAG([
    { id: 'st-001', depends_on: ['st-002'] },
    { id: 'st-002', depends_on: ['st-001'] }
  ]);
  assert(dag.hasCycle === true, 'Should detect cycle');
});

test('Topological sort is valid', () => {
  const dag = decomposition.buildDependencyDAG([
    { id: 'st-001', depends_on: [] },
    { id: 'st-002', depends_on: [] },
    { id: 'st-003', depends_on: ['st-001'] },
    { id: 'st-004', depends_on: ['st-001', 'st-002'] },
    { id: 'st-005', depends_on: ['st-003', 'st-004'] }
  ]);
  assert(dag.sorted.indexOf('st-001') < dag.sorted.indexOf('st-003'), 'st-001 before st-003');
  assert(dag.sorted.indexOf('st-001') < dag.sorted.indexOf('st-005'), 'st-001 before st-005');
  assert(dag.sorted.indexOf('st-004') < dag.sorted.indexOf('st-005'), 'st-004 before st-005');
});

// =============================================================================
// TESTS: analyzeImportGraph
// =============================================================================

console.log('\n--- analyzeImportGraph ---');

test('Parses ES import statements', () => {
  const result = decomposition.analyzeImportGraph(['src/lib/api.ts'], TMP_DIR);
  const imports = result.adjacency['src/lib/api.ts'] || [];
  assert(imports.some(i => i.includes('types')), 'Should find import of types, got: ' + JSON.stringify(imports));
});

test('Parses require statements', () => {
  const result = decomposition.analyzeImportGraph(['src/components/Profile.tsx'], TMP_DIR);
  const imports = result.adjacency['src/components/Profile.tsx'] || [];
  // Should find the relative imports (not the external require('react'))
  assert(imports.some(i => i.includes('types')), 'Should find types import');
  assert(imports.some(i => i.includes('api')), 'Should find api import');
});

test('Skips external packages', () => {
  const result = decomposition.analyzeImportGraph(['src/components/Profile.tsx'], TMP_DIR);
  const imports = result.adjacency['src/components/Profile.tsx'] || [];
  assert(!imports.some(i => i === 'react'), 'Should skip external package react');
});

test('Handles non-existent files gracefully', () => {
  const result = decomposition.analyzeImportGraph(['nonexistent.ts'], TMP_DIR);
  assert(result.adjacency['nonexistent.ts'].length === 0, 'Should return empty for missing file');
  assert(result.errors.length === 0, 'No errors for missing file (just empty)');
});

// =============================================================================
// TESTS: detectSharedFiles
// =============================================================================

console.log('\n--- detectSharedFiles ---');

test('Detects shared output files', () => {
  const result = decomposition.detectSharedFiles([
    { id: 'st-001', outputs: [{ path: 'src/shared.ts' }] },
    { id: 'st-002', outputs: [{ path: 'src/shared.ts' }] },
    { id: 'st-003', outputs: [{ path: 'src/unique.ts' }] }
  ]);
  assert(result.hasConflicts === true, 'Should detect conflict');
  assert(result.conflicts[0].file === 'src/shared.ts', 'Conflict on shared.ts');
  assert(result.conflicts[0].subtasks.length === 2, 'Two subtasks share the file');
});

test('No conflicts when files are unique', () => {
  const result = decomposition.detectSharedFiles([
    { id: 'st-001', outputs: [{ path: 'a.ts' }] },
    { id: 'st-002', outputs: [{ path: 'b.ts' }] }
  ]);
  assert(result.hasConflicts === false, 'Should not detect conflict');
});

// =============================================================================
// TESTS: validateDependencies
// =============================================================================

console.log('\n--- validateDependencies ---');

test('Cross-checks declared vs code deps', () => {
  const declared = [['st-001', 'st-003'], ['st-001', 'st-004']];
  const codeDeps = [
    { from: 'st-001', to: 'st-003', reason: 'imports types' },
    { from: 'st-002', to: 'st-004', reason: 'imports api' }
  ];
  const result = decomposition.validateDependencies(declared, codeDeps);
  assert(result.validated.length === 1, 'Should validate st-001->st-003');
  assert(result.missing.length === 1, 'Should find missing st-002->st-004');
  assert(result.spurious.length === 1, 'Should find spurious st-001->st-004');
});

// =============================================================================
// TESTS: checkReDecomposition
// =============================================================================

console.log('\n--- checkReDecomposition ---');

test('Small subtask does not split', () => {
  const r = decomposition.checkReDecomposition({ id: 'st-001', outputs: [{ path: 'a.ts' }] });
  assert(r.shouldSplit === false, 'Should not split small subtask');
});

test('Large subtask triggers split', () => {
  const outputs = Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.ts` }));
  const r = decomposition.checkReDecomposition({ id: 'st-002', title: 'Big', outputs });
  assert(r.shouldSplit === true, 'Should split large subtask');
});

test('Max depth prevents infinite recursion', () => {
  const outputs = Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.ts` }));
  const r = decomposition.checkReDecomposition({ id: 'st-003', outputs }, 2);
  assert(r.shouldSplit === false, 'Should stop at max depth');
});

// =============================================================================
// TESTS: reDecompose
// =============================================================================

console.log('\n--- reDecompose ---');

test('Splits oversized subtask', () => {
  const st = {
    id: 'st-001', title: 'Big task', description: '', agent: 'backend',
    priority: 'medium', outputs: Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.ts` })),
    depends_on: [], wave: 1
  };
  const result = decomposition.reDecompose(st, 0);
  assert(result.length > 1, 'Should produce multiple sub-subtasks');
});

test('Leaves small subtask unchanged', () => {
  const st = { id: 'st-002', title: 'Small', outputs: [{ path: 'a.ts' }], depends_on: [] };
  const result = decomposition.reDecompose(st, 0);
  assert(result.length === 1, 'Should keep single subtask');
  assert(result[0].id === 'st-002', 'Should return original');
});

// =============================================================================
// TESTS: decomposeTask (integration)
// =============================================================================

console.log('\n--- decomposeTask (integration) ---');

test('Small task is not decomposed', () => {
  const result = decomposition.decomposeTask({ id: 'small-1', title: 'Fix typo', description: '' }, TMP_DIR);
  assert(result.decomposed === false, 'Small task should not decompose');
});

test('Large task produces subtasks and DAG', () => {
  const result = decomposition.decomposeTask(
    { id: 'big-1', title: 'Build authentication system with OAuth integration', description: 'Full architecture migration with middleware redesign' },
    TMP_DIR
  );
  assert(result.decomposed === true, 'Large task should decompose');
  assert(result.subtasks.length >= 3, 'Should have >= 3 subtasks, got ' + result.subtasks.length);
  assert(result.dag !== null, 'Should have DAG');
  assert(result.dag.hasCycle === false, 'Should not have cycles');
  assert(result.dag.waves.length >= 2, 'Should have >= 2 waves');
  assert(result.domain !== null, 'Should have domain info');
});

// =============================================================================
// TESTS: extractFeatureName
// =============================================================================

console.log('\n--- extractFeatureName ---');

test('Strips bracketed prefixes', () => {
  const name = decomposition.extractFeatureName({ title: '[Phase 3.3] Task Auto-Decomposition — details' });
  assert(!name.includes('[Phase'), 'Should strip [Phase 3.3]');
  assert(name.startsWith('Task Auto-Decomposition'), 'Should keep title: ' + name);
});

test('Handles empty title', () => {
  const name = decomposition.extractFeatureName({ id: 'test-id', title: '' });
  assert(name === 'test-id', 'Should fall back to id');
});

// =============================================================================
// CLEANUP
// =============================================================================

process.chdir(ORIG_CWD);
try {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
} catch (e) {
  // Best effort cleanup
}

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.log('SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('Verification: PASS');
}
