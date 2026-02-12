/**
 * Tests for PM Knowledge Base & PM Brain — Phase 5.0
 *
 * Tests:
 * - PmKnowledgeBase: constructor, gather, caching, _cap, recordDecision
 * - PmBrain: constructor, ask, rate limiting, prompt building, thread management
 *
 * Run: node .claude/pilot/hooks/lib/__tests__/pm-knowledge-base-brain.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// ============================================================================
// TEST INFRASTRUCTURE
// ============================================================================

let testDir;
let originalCwd;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-kb-brain-test-'));

  // work/ directory
  fs.mkdirSync(path.join(testDir, 'work/sprints'), { recursive: true });
  fs.mkdirSync(path.join(testDir, 'work/plans'), { recursive: true });

  // state directories
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/escalations'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/orchestrator'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/state/artifacts/T1'), { recursive: true });
  fs.mkdirSync(path.join(testDir, '.claude/pilot/memory/channels'), { recursive: true });

  // PROJECT_BRIEF.md
  fs.writeFileSync(path.join(testDir, 'work/PROJECT_BRIEF.md'),
    '# Test Project Alpha\n\nA brief description of the test project.\nIt does many useful things.\n');

  // ROADMAP.md
  fs.writeFileSync(path.join(testDir, 'work/ROADMAP.md'),
    '# Roadmap\n\n' +
    '## Milestone 5 — Cloud Sync\nStatus: Active\n\n' +
    '### Phase 5.1 Knowledge Base\nStatus: Active\n\n' +
    '### Phase 5.2 Brain Module\nStatus: Planned\n');

  // Sprint file
  fs.writeFileSync(path.join(testDir, 'work/sprints/sprint-1.md'),
    '# Sprint 1\n\nGoals:\n- Build knowledge base\n- Build brain module\n');

  // Plan file
  fs.writeFileSync(path.join(testDir, 'work/plans/T1.md'),
    '# Plan for T1\n\nStep 1: Do thing\nStep 2: Do other thing\n');

  // Escalation log
  fs.writeFileSync(path.join(testDir, '.claude/pilot/state/escalations/log.jsonl'),
    '{"event":"drift","level":"warning","ts":"2026-01-01T00:00:00Z"}\n' +
    '{"event":"budget_exceeded","level":"block","ts":"2026-01-02T00:00:00Z"}\n');

  // PM action log
  fs.writeFileSync(path.join(testDir, '.claude/pilot/state/orchestrator/action-log.jsonl'),
    '{"action":"assign_task","taskId":"T1","agentId":"agent-1","ts":"2026-01-01T00:00:00Z"}\n' +
    '{"action":"escalate","taskId":"T2","reason":"timeout","ts":"2026-01-02T00:00:00Z"}\n');

  // Artifact manifest
  fs.writeFileSync(path.join(testDir, '.claude/pilot/state/artifacts/T1/manifest.json'),
    JSON.stringify({ taskId: 'T1', outputs: [{ name: 'result.json', type: 'json' }] }));

  originalCwd = process.cwd();
  process.chdir(testDir);
}

function teardown() {
  process.chdir(originalCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
}

function freshModules() {
  // Clear require cache for modules under test and their transitive deps
  const modPaths = [
    '../pm-knowledge-base',
    '../pm-brain',
    '../session',
    '../memory',
    '../messaging',
    '../cost-tracker',
    '../artifact-registry',
    '../policy',
    '../pm-decisions'
  ];
  for (const modPath of modPaths) {
    try {
      const resolved = require.resolve(modPath);
      delete require.cache[resolved];
    } catch (e) { /* not loaded */ }
  }
  const KB = require('../pm-knowledge-base');
  const Brain = require('../pm-brain');
  return { KB, Brain };
}

// ============================================================================
// TESTS
// ============================================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  setup();
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${e.message}`);
  } finally {
    teardown();
  }
}

// ============================================================================
// PM KNOWLEDGE BASE TESTS
// ============================================================================

console.log('\nPM Knowledge Base Tests\n');

// --- Constructor ---

test('PmKnowledgeBase: creates instance with projectRoot', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  assert.strictEqual(kb.projectRoot, testDir);
  assert.deepStrictEqual(kb._cache, {});
});

// --- gather() ---

test('gather: returns all expected keys', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const result = kb.gather();
  const expectedKeys = [
    'projectName', 'productBrief', 'currentMilestone', 'currentPhase',
    'sprintPlan', 'activePlans', 'recentDecisions', 'relevantResearch',
    'taskDecompositions', 'workingContext', 'escalationHistory',
    'budgetUsedToday', 'artifacts', 'pmActionLog', 'activeAgents',
    'tasksInProgress', 'tasksBlocked', 'taskSummary', 'agentPlan'
  ];
  for (const key of expectedKeys) {
    assert.ok(key in result, `Missing key: ${key}`);
  }
});

test('gather: projectName extracted from PROJECT_BRIEF.md first heading', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const result = kb.gather();
  assert.strictEqual(result.projectName, 'Test Project Alpha');
});

test('gather: productBrief contains brief content', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const result = kb.gather();
  assert.ok(result.productBrief.includes('Test Project Alpha'));
  assert.ok(result.productBrief.includes('brief description'));
});

test('gather: currentMilestone extracted from ROADMAP.md', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const result = kb.gather();
  // The regex captures the text after "## Milestone " before the newline
  // that is followed by "Status: Active"
  assert.ok(result.currentMilestone.includes('5'), `Expected milestone with "5", got: ${result.currentMilestone}`);
});

test('gather: currentPhase extracted from ROADMAP.md', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const result = kb.gather();
  assert.ok(result.currentPhase.includes('5.1'), `Expected phase with "5.1", got: ${result.currentPhase}`);
});

test('gather: sprintPlan reads from most recent sprint file', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const result = kb.gather();
  assert.ok(result.sprintPlan.includes('Sprint 1'), `Sprint plan should contain sprint content, got: ${result.sprintPlan}`);
  assert.ok(result.sprintPlan.includes('Build knowledge base'));
});

test('gather: activePlans reads plan files', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const result = kb.gather();
  assert.ok(result.activePlans.includes('T1.md') || result.activePlans.includes('Plan for T1'),
    `activePlans should reference T1 plan, got: ${result.activePlans}`);
});

test('gather: escalationHistory reads from escalation log', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const result = kb.gather();
  assert.ok(Array.isArray(result.escalationHistory), 'escalationHistory should be array');
  assert.strictEqual(result.escalationHistory.length, 2);
  assert.strictEqual(result.escalationHistory[0].event, 'drift');
  assert.strictEqual(result.escalationHistory[1].event, 'budget_exceeded');
});

test('gather: pmActionLog reads from action log', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const result = kb.gather();
  assert.ok(Array.isArray(result.pmActionLog), 'pmActionLog should be array');
  assert.strictEqual(result.pmActionLog.length, 2);
  assert.strictEqual(result.pmActionLog[0].action, 'assign_task');
  assert.strictEqual(result.pmActionLog[1].action, 'escalate');
});

test('gather: artifacts reads manifests from artifact dirs', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const result = kb.gather();
  // artifact-registry module is not available, so fallback reads manifest files directly
  assert.ok(Array.isArray(result.artifacts), 'artifacts should be array');
  // The kb tries getArtifactRegistry() first. If unavailable, it reads manifest.json files.
  // Since artifact-registry won't load in test, it falls back to the directory scan.
  assert.strictEqual(result.artifacts.length, 1);
  assert.strictEqual(result.artifacts[0].taskId, 'T1');
});

test('gather: agentPlan reads task-specific plan when taskId provided', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const result = kb.gather({ taskId: 'T1' });
  assert.ok(result.agentPlan.includes('Plan for T1'), `agentPlan should contain T1 plan, got: ${result.agentPlan}`);
});

test('gather: agentPlan is empty string when no taskId', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const result = kb.gather();
  assert.strictEqual(result.agentPlan, '');
});

test('gather: taskSummary returns string (may be unavailable if bd not found)', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const result = kb.gather();
  assert.strictEqual(typeof result.taskSummary, 'string');
  // bd command likely unavailable in test env
  assert.strictEqual(result.taskSummary, 'Task graph unavailable');
});

test('gather: budgetUsedToday returns N/A when cost-tracker unavailable', () => {
  // Make cost-tracker unresolvable by poisoning require.cache before
  // pm-knowledge-base's lazy getter runs. We pre-load the module path, then
  // delete it from cache and replace with a throwing shim so the lazy require
  // inside getCostTracker() catches and returns null.
  const ctPath = require.resolve('../cost-tracker');
  const savedCt = require.cache[ctPath];
  // Replace with a module whose exports throw on access
  require.cache[ctPath] = {
    id: ctPath,
    filename: ctPath,
    loaded: true,
    exports: null // getCostTracker checks `if (!_costTracker)` — null triggers re-require
  };
  // Delete so the lazy require fails (file resolution cached, but module deleted)
  delete require.cache[ctPath];

  // Now also ensure that a fresh require of cost-tracker fails.
  // We can do this by temporarily renaming the resolve path in Module._cache
  // but the simplest way is to just test via a fresh KB module scope where
  // getCostTracker() will try require('./cost-tracker') and we intercept it.
  // The cleanest approach: clear pm-knowledge-base from cache, then
  // break cost-tracker resolution.
  const kbPath = require.resolve('../pm-knowledge-base');
  delete require.cache[kbPath];

  // Temporarily move cost-tracker out of require resolution by
  // adding a broken entry. Module._resolveFilename will find the file,
  // but we'll make require throw by adding a syntax error to cache.
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function(request, parent, isMain, options) {
    if (request.endsWith('cost-tracker') || request.endsWith('cost-tracker.js')) {
      if (parent && parent.filename && parent.filename.includes('pm-knowledge-base')) {
        throw new Error('Simulated: cost-tracker not available');
      }
    }
    return origResolve.call(this, request, parent, isMain, options);
  };

  try {
    const KB = require('../pm-knowledge-base');
    const kb = new KB.PmKnowledgeBase(testDir);
    const result = kb.gather();
    assert.strictEqual(result.budgetUsedToday, 'N/A');
  } finally {
    Module._resolveFilename = origResolve;
    // Restore saved cache entry if it existed
    if (savedCt) require.cache[ctPath] = savedCt;
  }
});

// --- Caching ---

test('caching: gather returns same values on repeat call (cache hit)', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const result1 = kb.gather();
  const result2 = kb.gather();
  assert.strictEqual(result1.projectName, result2.projectName);
  assert.strictEqual(result1.productBrief, result2.productBrief);
  assert.strictEqual(result1.currentMilestone, result2.currentMilestone);
  assert.strictEqual(result1.sprintPlan, result2.sprintPlan);
  // Verify cache was populated
  assert.ok(Object.keys(kb._cache).length > 0, 'Cache should have entries');
});

test('caching: clearCache forces fresh read', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const result1 = kb.gather();
  assert.strictEqual(result1.projectName, 'Test Project Alpha');

  // Modify file on disk
  fs.writeFileSync(path.join(testDir, 'work/PROJECT_BRIEF.md'),
    '# Updated Project Name\n\nNew brief.\n');

  // Without clearCache, should still get cached value
  const result2 = kb.gather();
  assert.strictEqual(result2.projectName, 'Test Project Alpha', 'Should return cached value');

  // After clearCache, should get fresh value
  kb.clearCache();
  const result3 = kb.gather();
  assert.strictEqual(result3.projectName, 'Updated Project Name', 'Should return fresh value after clearCache');
});

test('caching: respects TTL (expired cache returns fresh data)', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);

  // First gather populates cache
  kb.gather();
  assert.strictEqual(kb._cache.projectName.value, 'Test Project Alpha');

  // Modify file on disk
  fs.writeFileSync(path.join(testDir, 'work/PROJECT_BRIEF.md'),
    '# TTL Test Project\n\nTTL brief.\n');

  // Manually expire the cache entry by setting old timestamp
  kb._cache.projectName.ts = Date.now() - 400000; // 400s ago, beyond TTL_STABLE_MS (300s)

  const result = kb.gather();
  assert.strictEqual(result.projectName, 'TTL Test Project', 'Should re-read after TTL expiry');
});

test('caching: non-expired entry still returns cached value', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);

  kb.gather();
  assert.strictEqual(kb._cache.projectName.value, 'Test Project Alpha');

  // Modify file on disk
  fs.writeFileSync(path.join(testDir, 'work/PROJECT_BRIEF.md'),
    '# Should Not See This\n\nBrief.\n');

  // Set cache timestamp to 10s ago (well within TTL_STABLE_MS of 300s)
  kb._cache.projectName.ts = Date.now() - 10000;

  const result = kb.gather();
  assert.strictEqual(result.projectName, 'Test Project Alpha', 'Should use cached value within TTL');
});

// --- _cap() ---

test('_cap: returns full text when under limit', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const text = 'Hello world';
  assert.strictEqual(kb._cap(text, 100), text);
});

test('_cap: truncates with [...truncated] when over limit', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const text = 'A'.repeat(200);
  const result = kb._cap(text, 50);
  assert.ok(result.includes('[...truncated]'), 'Should include truncation marker');
  assert.ok(result.length < text.length, 'Result should be shorter than input');
  assert.ok(result.startsWith('AAAA'), 'Should start with original text');
  // substring(0, 50) + '\n[...truncated]'
  assert.strictEqual(result, 'A'.repeat(50) + '\n[...truncated]');
});

test('_cap: returns empty string for null/empty input', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  assert.strictEqual(kb._cap(null, 100), '');
  assert.strictEqual(kb._cap('', 100), '');
  assert.strictEqual(kb._cap(undefined, 100), '');
});

// --- recordDecision ---

test('recordDecision: does not throw when memory module unavailable', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  // memory module is not available in test env; should not throw
  assert.doesNotThrow(() => {
    kb.recordDecision({ type: 'assign', action: 'assign T1 to agent-1' });
  });
});

test('recordDecision: adds timestamp to decision', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const decision = { type: 'assign', action: 'assign T1 to agent-1' };
  kb.recordDecision(decision);
  assert.ok(decision.ts, 'Decision should have timestamp after recordDecision');
  // Verify it is a valid ISO string
  assert.ok(!isNaN(Date.parse(decision.ts)), 'Timestamp should be valid ISO string');
});

test('recordDecision: preserves existing timestamp', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const existingTs = '2026-01-15T12:00:00Z';
  const decision = { type: 'assign', action: 'test', ts: existingTs };
  kb.recordDecision(decision);
  assert.strictEqual(decision.ts, existingTs, 'Should not overwrite existing timestamp');
});

// --- TTL constants exported ---

test('exports TTL constants', () => {
  const { KB } = freshModules();
  assert.strictEqual(KB.TTL_VOLATILE_MS, 30000);
  assert.strictEqual(KB.TTL_MODERATE_MS, 60000);
  assert.strictEqual(KB.TTL_STABLE_MS, 300000);
});

// --- activePlans with taskId ---

test('gather: activePlans returns task-specific plan when taskId matches', () => {
  const { KB } = freshModules();
  const kb = new KB.PmKnowledgeBase(testDir);
  const result = kb.gather({ taskId: 'T1' });
  assert.ok(result.activePlans.includes('Plan for T1'),
    `Should include T1 plan content, got: ${result.activePlans}`);
});

// --- projectName fallback ---

test('gather: projectName defaults to Pilot AGI when no brief file', () => {
  const { KB } = freshModules();
  fs.unlinkSync(path.join(testDir, 'work/PROJECT_BRIEF.md'));
  const kb = new KB.PmKnowledgeBase(testDir);
  const result = kb.gather();
  assert.strictEqual(result.projectName, 'Pilot AGI');
});

// --- empty escalation log ---

test('gather: escalationHistory returns empty array when log is empty', () => {
  const { KB } = freshModules();
  fs.writeFileSync(path.join(testDir, '.claude/pilot/state/escalations/log.jsonl'), '');
  const kb = new KB.PmKnowledgeBase(testDir);
  const result = kb.gather();
  assert.deepStrictEqual(result.escalationHistory, []);
});

// ============================================================================
// PM BRAIN TESTS
// ============================================================================

console.log('\nPM Brain Tests\n');

// Mock claude function for testing
function mockClaudeFn() {
  return {
    success: true,
    result: {
      guidance: 'Test guidance',
      decision: { type: 'test', action: 'test' }
    }
  };
}

function mockClaudeFnGuidanceOnly() {
  return {
    success: true,
    result: {
      guidance: 'Guidance only, no decision'
    }
  };
}

function mockClaudeFnFailure() {
  return {
    success: false,
    error: 'Claude call failed'
  };
}

// --- Constructor ---

test('PmBrain: creates instance with projectRoot and options', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFn });
  assert.strictEqual(brain.projectRoot, testDir);
  assert.ok(brain.kb, 'Should have knowledge base instance');
  assert.ok(brain.conversations instanceof Map, 'conversations should be a Map');
});

test('PmBrain: accepts _callClaudeFn for testing', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFn });
  assert.strictEqual(brain._callClaudeFn, mockClaudeFn);
});

test('PmBrain: maxCallsPerHour defaults to 30', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFn });
  assert.strictEqual(brain.maxCallsPerHour, 30);
});

test('PmBrain: maxCallsPerHour can be overridden', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFn, maxCallsPerHour: 10 });
  assert.strictEqual(brain.maxCallsPerHour, 10);
});

// --- ask() ---

test('ask: returns result from mock claude call', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFn });
  const result = brain.ask('agent-1', 'What should I do next?', { taskId: 'T1' });
  assert.strictEqual(result.success, true);
});

test('ask: includes guidance in response', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFn });
  const result = brain.ask('agent-1', 'What should I do next?');
  assert.strictEqual(result.guidance, 'Test guidance');
});

test('ask: includes decision in response when present', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFn });
  const result = brain.ask('agent-1', 'Should I refactor?');
  assert.ok(result.decision, 'Should have a decision');
  assert.strictEqual(result.decision.type, 'test');
  assert.strictEqual(result.decision.action, 'test');
});

test('ask: decision is null when not present in response', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFnGuidanceOnly });
  const result = brain.ask('agent-1', 'Quick question');
  assert.strictEqual(result.decision, null);
});

test('ask: stores conversation thread (getThread returns entries)', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFn });
  brain.ask('agent-1', 'First question');
  const thread = brain.getThread('agent-1');
  assert.strictEqual(thread.length, 2); // agent question + pm response
  assert.strictEqual(thread[0].role, 'agent');
  assert.strictEqual(thread[0].content, 'First question');
  assert.strictEqual(thread[1].role, 'pm');
  assert.deepStrictEqual(thread[1].content, { guidance: 'Test guidance', decision: { type: 'test', action: 'test' } });
});

test('ask: multi-turn appends to thread', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFn });
  brain.ask('agent-1', 'First question');
  brain.ask('agent-1', 'Second question');
  const thread = brain.getThread('agent-1');
  // Each ask adds 2 entries (agent + pm). 2 asks = 4 entries.
  assert.strictEqual(thread.length, 4);
  assert.strictEqual(thread[0].content, 'First question');
  assert.strictEqual(thread[2].content, 'Second question');
});

test('ask: thread is capped at MAX_THREAD_TURNS', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFn });

  // MAX_THREAD_TURNS is 10 in pm-brain.js
  // Each ask adds 2 entries, so 6 asks = 12 entries, capped to last 10
  for (let i = 0; i < 6; i++) {
    brain.ask('agent-1', `Question ${i}`);
  }
  const thread = brain.getThread('agent-1');
  assert.ok(thread.length <= 10, `Thread should be capped at 10, got ${thread.length}`);
});

test('ask: returns error on claude call failure', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFnFailure });
  const result = brain.ask('agent-1', 'Test question');
  assert.strictEqual(result.success, false);
  assert.ok(result.error, 'Should have error message');
});

test('ask: returns error when claude throws exception', () => {
  const { Brain } = freshModules();
  const throwingFn = () => { throw new Error('Connection refused'); };
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: throwingFn });
  const result = brain.ask('agent-1', 'Test question');
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('Connection refused'), `Expected error message, got: ${result.error}`);
});

// --- Rate Limiting ---

test('rate limiting: allows calls within limit', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFn, maxCallsPerHour: 5 });

  const result1 = brain.ask('agent-1', 'Q1');
  assert.strictEqual(result1.success, true);

  const result2 = brain.ask('agent-1', 'Q2');
  assert.strictEqual(result2.success, true);
});

test('rate limiting: blocks calls exceeding maxCallsPerHour', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFn, maxCallsPerHour: 2 });

  // Pre-fill timestamps to simulate past calls within the hour
  brain._callTimestamps = [Date.now() - 1000, Date.now() - 500];

  const result = brain.ask('agent-1', 'Should be blocked');
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('Rate limit exceeded'), `Expected rate limit error, got: ${result.error}`);
});

test('rate limiting: returns success false with error message when rate limited', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFn, maxCallsPerHour: 1 });

  // Pre-fill one timestamp (already at limit)
  brain._callTimestamps = [Date.now()];

  const result = brain.ask('agent-1', 'Blocked');
  assert.strictEqual(result.success, false);
  assert.ok(typeof result.error === 'string', 'Error should be a string');
  assert.ok(result.error.includes('max 1 calls/hour'), `Expected max calls msg, got: ${result.error}`);
});

test('rate limiting: old timestamps are pruned (allows after hour passes)', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFn, maxCallsPerHour: 2 });

  // Pre-fill with old timestamps (more than 1 hour ago)
  brain._callTimestamps = [Date.now() - 3700000, Date.now() - 3700000];

  const result = brain.ask('agent-1', 'Should succeed after pruning');
  assert.strictEqual(result.success, true, 'Should allow call after old timestamps pruned');
});

// --- Prompt Building ---

test('prompt building: prompt includes the question', () => {
  const { Brain } = freshModules();
  let capturedPrompt = null;
  const captureFn = (prompt) => {
    capturedPrompt = prompt;
    return { success: true, result: { guidance: 'ok' } };
  };
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: captureFn });
  brain.ask('agent-1', 'Where are we on milestone 5?', { taskId: 'T1' });
  assert.ok(capturedPrompt.includes('Where are we on milestone 5?'),
    'Prompt should include the question');
});

test('prompt building: prompt includes PM persona section', () => {
  const { Brain } = freshModules();
  let capturedPrompt = null;
  const captureFn = (prompt) => {
    capturedPrompt = prompt;
    return { success: true, result: { guidance: 'ok' } };
  };
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: captureFn });
  brain.ask('agent-1', 'Test question');
  assert.ok(capturedPrompt.includes('You are the PM Agent') || capturedPrompt.includes('Project Manager'),
    'Prompt should include PM persona');
});

test('prompt building: prompt fits within maxPromptSize', () => {
  const { Brain } = freshModules();
  let capturedPrompt = null;
  const captureFn = (prompt) => {
    capturedPrompt = prompt;
    return { success: true, result: { guidance: 'ok' } };
  };
  // Use a very small maxPromptSize to force truncation
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: captureFn, maxPromptSize: 2000 });
  brain.ask('agent-1', 'Test question', { taskId: 'T1' });
  assert.ok(capturedPrompt.length <= 2000,
    `Prompt should be within maxPromptSize (2000), got ${capturedPrompt.length}`);
});

test('prompt building: prompt includes project name', () => {
  const { Brain } = freshModules();
  let capturedPrompt = null;
  const captureFn = (prompt) => {
    capturedPrompt = prompt;
    return { success: true, result: { guidance: 'ok' } };
  };
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: captureFn });
  brain.ask('agent-1', 'Test question');
  assert.ok(capturedPrompt.includes('Test Project Alpha'),
    `Prompt should include project name, got prompt length ${capturedPrompt.length}`);
});

// --- Thread Management ---

test('getThread: returns empty array for unknown agent', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFn });
  const thread = brain.getThread('nonexistent-agent');
  assert.deepStrictEqual(thread, []);
});

test('clearThread: removes specific agent thread', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFn });
  brain.ask('agent-1', 'Q1');
  brain.ask('agent-2', 'Q2');
  assert.strictEqual(brain.getThread('agent-1').length, 2);
  assert.strictEqual(brain.getThread('agent-2').length, 2);

  brain.clearThread('agent-1');
  assert.deepStrictEqual(brain.getThread('agent-1'), []);
  assert.strictEqual(brain.getThread('agent-2').length, 2, 'Other agent thread should be untouched');
});

test('clearAllThreads: removes all threads', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFn });
  brain.ask('agent-1', 'Q1');
  brain.ask('agent-2', 'Q2');
  brain.ask('agent-3', 'Q3');

  brain.clearAllThreads();
  assert.deepStrictEqual(brain.getThread('agent-1'), []);
  assert.deepStrictEqual(brain.getThread('agent-2'), []);
  assert.deepStrictEqual(brain.getThread('agent-3'), []);
  assert.strictEqual(brain.conversations.size, 0);
});

// --- Thread timestamps ---

test('ask: thread entries have timestamps', () => {
  const { Brain } = freshModules();
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFn });
  const before = Date.now();
  brain.ask('agent-1', 'Test');
  const after = Date.now();

  const thread = brain.getThread('agent-1');
  assert.ok(thread[0].ts >= before && thread[0].ts <= after, 'Agent entry should have valid timestamp');
  assert.ok(thread[1].ts >= before && thread[1].ts <= after, 'PM entry should have valid timestamp');
});

// --- KnowledgeBase integration within Brain ---

test('ask: brain uses knowledge base for context gathering', () => {
  const { Brain } = freshModules();
  let capturedPrompt = null;
  const captureFn = (prompt) => {
    capturedPrompt = prompt;
    return { success: true, result: { guidance: 'ok' } };
  };
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: captureFn });
  brain.ask('agent-1', 'Status update?', { taskId: 'T1' });

  // The prompt should contain knowledge-base-sourced info
  assert.ok(capturedPrompt.includes('Test Project Alpha'),
    'Prompt should include project name from KB');
});

// --- Decision persistence via recordDecision ---

test('ask: records decision from response', () => {
  const { Brain } = freshModules();
  let recordedDecision = null;
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFn });

  // Monkey-patch recordDecision to capture
  const originalRecord = brain.kb.recordDecision.bind(brain.kb);
  brain.kb.recordDecision = (d) => {
    recordedDecision = d;
    originalRecord(d);
  };

  brain.ask('agent-1', 'Should I proceed?', { taskId: 'T1' });

  assert.ok(recordedDecision, 'Should have recorded a decision');
  assert.strictEqual(recordedDecision.type, 'test');
  assert.strictEqual(recordedDecision.action, 'test');
  assert.strictEqual(recordedDecision.agent, 'agent-1');
  assert.strictEqual(recordedDecision.task, 'T1');
});

test('ask: does not record decision when none in response', () => {
  const { Brain } = freshModules();
  let recordCalled = false;
  const brain = new Brain.PmBrain(testDir, { _callClaudeFn: mockClaudeFnGuidanceOnly });

  brain.kb.recordDecision = () => { recordCalled = true; };

  brain.ask('agent-1', 'Quick question');
  assert.strictEqual(recordCalled, false, 'Should not record decision when none present');
});

// --- Multiple sprints (most recent is read) ---

test('gather: reads most recent sprint file when multiple exist', () => {
  const { KB } = freshModules();

  // Add a second, more recent sprint file
  fs.writeFileSync(path.join(testDir, 'work/sprints/sprint-2.md'),
    '# Sprint 2\n\nGoals:\n- Deploy to production\n');

  const kb = new KB.PmKnowledgeBase(testDir);
  const result = kb.gather();
  // Files are sorted reverse, so sprint-2.md is first
  assert.ok(result.sprintPlan.includes('Sprint 2'),
    `Should read most recent sprint, got: ${result.sprintPlan}`);
});

// --- Empty directories ---

test('gather: handles missing sprint directory gracefully', () => {
  const { KB } = freshModules();
  fs.rmSync(path.join(testDir, 'work/sprints'), { recursive: true, force: true });
  const kb = new KB.PmKnowledgeBase(testDir);
  const result = kb.gather();
  assert.strictEqual(result.sprintPlan, '');
});

test('gather: handles missing plans directory gracefully', () => {
  const { KB } = freshModules();
  fs.rmSync(path.join(testDir, 'work/plans'), { recursive: true, force: true });
  const kb = new KB.PmKnowledgeBase(testDir);
  const result = kb.gather();
  assert.strictEqual(result.activePlans, '');
});

// ============================================================================
// RESULTS
// ============================================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
