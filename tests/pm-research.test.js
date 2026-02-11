#!/usr/bin/env node

/**
 * Verification tests for PM Auto-Research (Phase 3.2)
 * Run: node tests/pm-research.test.js
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
const TMP_DIR = path.join(require('os').tmpdir(), 'pilot-pm-research-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

// Create minimal directory structure
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/memory/channels'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.claude/pilot/memory/schemas'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, 'work/research'), { recursive: true });

// Copy memory index and schemas
fs.copyFileSync(
  path.join(ORIG_CWD, '.claude/pilot/memory/index.json'),
  path.join(TMP_DIR, '.claude/pilot/memory/index.json')
);
fs.copyFileSync(
  path.join(ORIG_CWD, '.claude/pilot/memory/schemas/research-findings.schema.json'),
  path.join(TMP_DIR, '.claude/pilot/memory/schemas/research-findings.schema.json')
);

// Switch to temp dir
process.chdir(TMP_DIR);

// Now require the module (it reads from cwd)
const pmResearch = require(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/pm-research'));

// =============================================================================
// TESTS: classifyTaskComplexity
// =============================================================================

console.log('\n=== classifyTaskComplexity ===');

test('returns S for null task', () => {
  assert(pmResearch.classifyTaskComplexity(null) === 'S');
});

test('returns S for trivial task', () => {
  const result = pmResearch.classifyTaskComplexity({ title: 'Fix typo', description: 'small' });
  assert(result === 'S', `Expected S, got ${result}`);
});

test('returns M for medium task with keyword', () => {
  const result = pmResearch.classifyTaskComplexity({
    title: 'Add search feature',
    description: 'Implement full-text search with filtering and pagination'
  });
  assert(result === 'M', `Expected M, got ${result}`);
});

test('returns L for large task with architecture keyword', () => {
  const result = pmResearch.classifyTaskComplexity({
    title: 'Build authentication system',
    description: 'Design and implement complete authentication architecture with OAuth integration, JWT tokens, and session management for the entire platform'
  });
  assert(result === 'L', `Expected L, got ${result}`);
});

test('returns L for very long description', () => {
  const result = pmResearch.classifyTaskComplexity({
    title: 'Big task',
    description: 'x'.repeat(400)
  });
  assert(result === 'L', `Expected L for long desc, got ${result}`);
});

// =============================================================================
// TESTS: checkResearchCache
// =============================================================================

console.log('\n=== checkResearchCache ===');

test('returns null when no channel data exists', () => {
  const result = pmResearch.checkResearchCache('nonexistent-task');
  assert(result === null, `Expected null, got ${JSON.stringify(result)}`);
});

test('returns null when task not in findings', () => {
  // Seed channel with a different task's findings
  const memory = require(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/memory'));
  memory.publish('research-findings', {
    findings: [{ task_id: 'other-task', ts: new Date().toISOString(), summary: 'Other research' }],
    tech_decisions: []
  }, { agent: 'pm' });

  const result = pmResearch.checkResearchCache('my-task');
  assert(result === null, `Expected null, got ${JSON.stringify(result)}`);
});

test('returns cached findings when task exists', () => {
  const memory = require(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/memory'));
  memory.publish('research-findings', {
    findings: [
      { task_id: 'other-task', ts: new Date().toISOString(), summary: 'Other' },
      { task_id: 'my-task', ts: new Date().toISOString(), summary: 'My research', complexity: 'M' }
    ],
    tech_decisions: []
  }, { agent: 'pm' });

  const result = pmResearch.checkResearchCache('my-task');
  assert(result !== null, 'Expected cached findings');
  assert(result.task_id === 'my-task', `Expected my-task, got ${result.task_id}`);
  assert(result.complexity === 'M', `Expected M, got ${result.complexity}`);
});

// =============================================================================
// TESTS: runAutoResearch
// =============================================================================

console.log('\n=== runAutoResearch ===');

// Create a minimal codebase structure for research to find
fs.mkdirSync(path.join(TMP_DIR, 'src'), { recursive: true });
fs.writeFileSync(path.join(TMP_DIR, 'src/auth.js'), 'function authenticate(user) { return true; }');
fs.writeFileSync(path.join(TMP_DIR, 'src/router.js'), 'function route(path) { return handler; }');

test('produces findings with required fields', () => {
  const task = {
    id: 'test-001',
    title: 'Add authentication middleware',
    description: 'Create auth middleware that validates JWT tokens'
  };
  const findings = pmResearch.runAutoResearch(task, TMP_DIR);

  assert(findings.task_id === 'test-001', `Expected test-001, got ${findings.task_id}`);
  assert(findings.ts, 'Missing timestamp');
  assert(findings.summary, 'Missing summary');
  assert(typeof findings.complexity === 'string', 'Missing complexity');
  assert(Array.isArray(findings.recommendations), 'Missing recommendations');
  assert(Array.isArray(findings.technologies), 'Missing technologies');
  assert(Array.isArray(findings.relevant_files), 'Missing relevant_files');
  assert(Array.isArray(findings.patterns), 'Missing patterns');
});

test('detects technologies from task description', () => {
  const task = {
    id: 'test-002',
    title: 'Implement OAuth login',
    description: 'Add OAuth and JWT authentication using Node.js'
  };
  const findings = pmResearch.runAutoResearch(task, TMP_DIR);
  const techNames = findings.technologies.map(t => t.name);
  assert(techNames.includes('oauth'), `Expected oauth in ${techNames}`);
  assert(techNames.includes('jwt'), `Expected jwt in ${techNames}`);
});

test('saves research to shared memory channel', () => {
  const memory = require(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/memory'));
  const channelData = memory.read('research-findings');

  assert(channelData.data.findings.length > 0, 'No findings in channel');
  const testFinding = channelData.data.findings.find(f => f.task_id === 'test-001');
  assert(testFinding, 'test-001 findings not in channel');
});

test('saves research to work/research/ file', () => {
  const files = fs.readdirSync(path.join(TMP_DIR, 'work/research'));
  const researchFile = files.find(f => f.startsWith('test-001'));
  assert(researchFile, `No research file for test-001, found: ${files}`);

  const content = fs.readFileSync(path.join(TMP_DIR, 'work/research', researchFile), 'utf8');
  assert(content.includes('# Research:'), 'Missing title header');
  assert(content.includes('**Task**: test-001'), 'Missing task ID');
  assert(content.includes('## Summary'), 'Missing Summary section');
  assert(content.includes('## Recommendations'), 'Missing Recommendations section');
});

// =============================================================================
// TESTS: buildResearchContext
// =============================================================================

console.log('\n=== buildResearchContext ===');

test('returns null for unknown task', () => {
  const result = pmResearch.buildResearchContext('unknown-task-xyz');
  assert(result === null, `Expected null, got ${JSON.stringify(result)}`);
});

test('returns compact context for researched task', () => {
  const ctx = pmResearch.buildResearchContext('test-001');
  assert(ctx !== null, 'Expected context');
  assert(ctx.complexity, 'Missing complexity');
  assert(ctx.summary, 'Missing summary');
  assert(Array.isArray(ctx.recommendations), 'Missing recommendations');
});

test('context fits within size limit', () => {
  const ctx = pmResearch.buildResearchContext('test-001');
  const size = JSON.stringify(ctx).length;
  assert(size <= pmResearch.MAX_CONTEXT_SIZE, `Context too large: ${size} > ${pmResearch.MAX_CONTEXT_SIZE}`);
});

// =============================================================================
// TESTS: recordTechDecision & queryPatternLibrary
// =============================================================================

console.log('\n=== Pattern Library ===');

test('records and retrieves tech decision', () => {
  pmResearch.recordTechDecision({
    name: 'vitest',
    reason: 'Fast test runner with ESM support',
    task_id: 'test-003',
    alternatives_considered: ['jest', 'mocha']
  });

  const results = pmResearch.queryPatternLibrary(['vitest', 'test']);
  assert(results.length > 0, 'Expected pattern library results');
  const vitestResult = results.find(r => r.type === 'tech_decision' && r.data.name === 'vitest');
  assert(vitestResult, 'Expected vitest decision in results');
});

test('queryPatternLibrary returns empty for no matches', () => {
  const results = pmResearch.queryPatternLibrary(['zzz_no_match_xyz']);
  assert(results.length === 0, `Expected 0 results, got ${results.length}`);
});

// =============================================================================
// TESTS: Integration — _taskScan with research
// =============================================================================

console.log('\n=== Integration ===');

test('PmLoop loads with pm-research integration', () => {
  // Just verify the module loads without error
  const { PmLoop } = require(path.join(ORIG_CWD, '.claude/pilot/hooks/lib/pm-loop'));
  const loop = new PmLoop(TMP_DIR, { dryRun: true });
  assert(loop.getStats().running === false, 'Expected not running');
});

// =============================================================================
// CLEANUP
// =============================================================================

process.chdir(ORIG_CWD);
fs.rmSync(TMP_DIR, { recursive: true, force: true });

// =============================================================================
// SUMMARY
// =============================================================================

console.log(`\n${'='.repeat(60)}`);
console.log(`PM Auto-Research Tests: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
