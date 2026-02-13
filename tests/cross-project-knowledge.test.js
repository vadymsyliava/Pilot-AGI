'use strict';

/**
 * Tests for Phase 5.8 — Cross-Project Learning
 *
 * Run: node --test tests/cross-project-knowledge.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

let testDir;
let knowledgeDir;
let projectDir;

function freshModule(modPath) {
  const resolved = require.resolve(modPath);
  delete require.cache[resolved];
  return require(modPath);
}

function setupTestDirs() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-knowledge-test-'));
  knowledgeDir = path.join(testDir, 'knowledge');
  projectDir = path.join(testDir, 'project');
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  const stateDir = path.join(projectDir, '.claude/pilot/state');
  fs.mkdirSync(stateDir, { recursive: true });
}

function cleanupTestDirs() {
  try {
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  } catch (e) { /* best effort */ }
}

// ============================================================================
// CROSS-PROJECT KNOWLEDGE BASE
// ============================================================================

describe('cross-project-knowledge', () => {
  let knowledge;

  beforeEach(() => {
    setupTestDirs();
    knowledge = freshModule('../.claude/pilot/hooks/lib/cross-project-knowledge');
  });

  afterEach(() => { cleanupTestDirs(); });

  const opts = () => ({ knowledgePath: knowledgeDir });

  describe('publishKnowledge', () => {
    test('publishes entry and creates index', () => {
      const result = knowledge.publishKnowledge(
        'decomposition-templates',
        { task_type: 'feature', template: ['step1', 'step2'] },
        'MyProject', opts()
      );
      assert.ok(result.id);
      assert.equal(result.type, 'decomposition-templates');
      assert.equal(result.deduplicated, false);
      const index = knowledge.loadIndex(opts());
      assert.equal(index.entries.length, 1);
    });

    test('rejects invalid knowledge type', () => {
      assert.throws(() => {
        knowledge.publishKnowledge('invalid-type', {}, null, opts());
      }, /Invalid knowledge type/);
    });

    test('returns excluded for matching exclude pattern', () => {
      const result = knowledge.publishKnowledge(
        'tech-decisions',
        { decision: 'use secret token for auth' },
        'TestProject',
        { ...opts(), excludePatterns: ['*secret*'] }
      );
      assert.equal(result.excluded, true);
      assert.equal(result.id, null);
    });
  });

  describe('queryKnowledge', () => {
    test('finds entries by keyword match', () => {
      knowledge.publishKnowledge('failure-modes',
        { event_type: 'test_failure', context: 'react component rendering error' },
        'Project1', opts());
      knowledge.publishKnowledge('failure-modes',
        { event_type: 'budget_exceeded', context: 'database migration timeout' },
        'Project2', opts());
      const results = knowledge.queryKnowledge('failure-modes', ['react', 'rendering'], 10, opts());
      assert.ok(results.length >= 1);
      assert.equal(results[0].content.event_type, 'test_failure');
    });

    test('returns all types when type is null', () => {
      knowledge.publishKnowledge('failure-modes', { event: 'test' }, 'P', opts());
      knowledge.publishKnowledge('tech-decisions', { decision: 'use vitest' }, 'P', opts());
      const results = knowledge.queryKnowledge(null, ['test', 'vitest'], 10, opts());
      assert.equal(results.length, 2);
    });

    test('returns empty for no matches', () => {
      const results = knowledge.queryKnowledge('failure-modes', ['nonexistent'], 10, opts());
      assert.deepEqual(results, []);
    });
  });

  describe('anonymization', () => {
    test('strips absolute file paths', () => {
      const result = knowledge.anonymize(
        { file: '/Users/john/MyProject/src/index.js', note: 'important' },
        'MyProject', 'full'
      );
      assert.equal(result.file, '<path>');
    });

    test('replaces project name in full mode', () => {
      const result = knowledge.anonymize(
        { text: 'The MyProject codebase uses React' },
        'MyProject', 'full'
      );
      assert.ok(result.text.includes('<project>'));
      assert.ok(!result.text.includes('MyProject'));
    });

    test('skips anonymization in none mode', () => {
      const result = knowledge.anonymize(
        { file: '/Users/john/src/index.js' },
        'MyProject', 'none'
      );
      assert.equal(result.file, '/Users/john/src/index.js');
    });

    test('hashes project name consistently', () => {
      const hash1 = knowledge.hashProject('MyProject');
      const hash2 = knowledge.hashProject('MyProject');
      const hash3 = knowledge.hashProject('OtherProject');
      assert.equal(hash1, hash2);
      assert.notEqual(hash1, hash3);
      assert.equal(hash1.length, 12);
    });

    test('redacts sensitive patterns in full mode', () => {
      const result = knowledge.anonymize(
        { config: 'password: "s3cret123"', api: 'token: "ghp_abc123"' },
        null, 'full'
      );
      assert.ok(result.config.includes('<redacted>'));
      assert.ok(result.api.includes('<redacted>'));
    });
  });

  describe('deduplication', () => {
    test('detects duplicate entries', () => {
      knowledge.publishKnowledge('tech-decisions',
        { decision: 'use vitest for testing framework', reason: 'fast and compatible' },
        'Project1', opts());
      const result = knowledge.publishKnowledge('tech-decisions',
        { decision: 'use vitest for testing framework', reason: 'fast and compatible with jest' },
        'Project2', opts());
      assert.equal(result.deduplicated, true);
    });

    test('allows distinct entries', () => {
      knowledge.publishKnowledge('tech-decisions',
        { decision: 'use vitest for testing' }, 'Project1', opts());
      const result = knowledge.publishKnowledge('tech-decisions',
        { decision: 'use PostgreSQL for database storage engine' }, 'Project2', opts());
      assert.equal(result.deduplicated, false);
    });
  });

  describe('pruning', () => {
    test('removes old entries with zero usage', () => {
      knowledge.publishKnowledge('failure-modes', { event: 'old_failure' }, 'P', opts());
      const index = knowledge.loadIndex(opts());
      index.entries[0].created_at = '2020-01-01T00:00:00Z';
      index.entries[0].usage_count = 0;
      fs.writeFileSync(path.join(knowledgeDir, 'index.json'), JSON.stringify(index, null, 2));
      const result = knowledge.pruneKnowledge(30, 500, opts());
      assert.equal(result.pruned, 1);
      assert.equal(result.remaining, 0);
    });

    test('keeps entries with usage_count > 0', () => {
      knowledge.publishKnowledge('failure-modes', { event: 'used_failure' }, 'P', opts());
      const index = knowledge.loadIndex(opts());
      index.entries[0].created_at = '2020-01-01T00:00:00Z';
      index.entries[0].usage_count = 5;
      fs.writeFileSync(path.join(knowledgeDir, 'index.json'), JSON.stringify(index, null, 2));
      const result = knowledge.pruneKnowledge(30, 500, opts());
      assert.equal(result.pruned, 0);
      assert.equal(result.remaining, 1);
    });

    test('enforces per-type limit', () => {
      for (let i = 0; i < 3; i++) {
        knowledge.publishKnowledge('cost-benchmarks',
          { task_type: 'type_' + i, tokens: i * 1000 }, 'P', opts());
      }
      const result = knowledge.pruneKnowledge(9999, 2, opts());
      assert.equal(result.pruned, 1);
      assert.equal(result.remaining, 2);
    });
  });

  describe('getKnowledgeStats', () => {
    test('returns correct statistics', () => {
      // Use distinct content to avoid deduplication
      knowledge.publishKnowledge('failure-modes',
        { event_type: 'test_failure', context: 'react rendering crash in component' },
        'P', opts());
      knowledge.publishKnowledge('failure-modes',
        { event_type: 'budget_exceeded', context: 'database migration took too long' },
        'P', opts());
      knowledge.publishKnowledge('tech-decisions',
        { decision: 'use postgresql for persistence layer' }, 'P', opts());
      const stats = knowledge.getKnowledgeStats(opts());
      assert.equal(stats.total, 3);
      assert.equal(stats.byType['failure-modes'], 2);
      assert.equal(stats.byType['tech-decisions'], 1);
    });
  });

  describe('recordUsage', () => {
    test('increments usage count', () => {
      const { id } = knowledge.publishKnowledge('tech-decisions', { decision: 'use node' }, 'P', opts());
      knowledge.recordUsage(id, opts());
      knowledge.recordUsage(id, opts());
      const index = knowledge.loadIndex(opts());
      const entry = index.entries.find(e => e.id === id);
      assert.equal(entry.usage_count, 2);
    });
  });

  describe('resetKnowledge', () => {
    test('clears the entire knowledge base', () => {
      knowledge.publishKnowledge('failure-modes', { event: 'test' }, 'P', opts());
      knowledge.resetKnowledge(opts());
      assert.equal(fs.existsSync(knowledgeDir), false);
    });
  });
});

// ============================================================================
// KNOWLEDGE HARVESTER
// ============================================================================

describe('knowledge-harvester', () => {
  let harvester;

  beforeEach(() => {
    setupTestDirs();
    harvester = freshModule('../.claude/pilot/hooks/lib/knowledge-harvester');
  });

  afterEach(() => { cleanupTestDirs(); });

  test('loadCrossProjectPolicy returns consistent structure', () => {
    const policy = harvester.loadCrossProjectPolicy(projectDir);
    // Policy structure should always have these fields
    assert.equal(typeof policy.enabled, 'boolean');
    assert.equal(typeof policy.publish, 'boolean');
    assert.equal(typeof policy.consume, 'boolean');
    assert.equal(policy.anonymize_level, 'full');
  });

  test('harvestFromTask returns results without error', () => {
    const result = harvester.harvestFromTask('task-1', projectDir);
    // Should return valid structure regardless of policy
    assert.ok(Array.isArray(result.published));
    assert.ok(Array.isArray(result.skipped));
    assert.ok(typeof result.harvested === 'object');
  });

  test('getProjectName extracts name from path', () => {
    assert.equal(harvester.getProjectName('/Users/test/MyProject'), 'MyProject');
  });
});

// ============================================================================
// KNOWLEDGE CONSUMER
// ============================================================================

describe('knowledge-consumer', () => {
  let consumer;
  let knowledge;

  beforeEach(() => {
    setupTestDirs();
    knowledge = freshModule('../.claude/pilot/hooks/lib/cross-project-knowledge');
    consumer = freshModule('../.claude/pilot/hooks/lib/knowledge-consumer');
  });

  afterEach(() => { cleanupTestDirs(); });

  test('enrichContext adds cross-project templates', () => {
    const task = { id: 'task-1', title: 'Implement feature testing', description: 'Add test coverage' };
    const entries = [
      { id: 'k1', type: 'decomposition-templates',
        content: { task_type: 'feature', template: ['plan', 'code', 'test'], success_rate: 0.9, avg_subtasks: 3 } },
      { id: 'k2', type: 'failure-modes',
        content: { event_type: 'test_failure', level: 'warning', resolution: 'retry' } }
    ];

    const origRecordUsage = knowledge.recordUsage;
    knowledge.recordUsage = () => {};
    try {
      const result = consumer.enrichContext(task, entries, { projectPath: projectDir });
      assert.ok(result.task._cross_project_templates);
      assert.equal(result.task._cross_project_templates[0].task_type, 'feature');
      assert.ok(result.task._cross_project_failure_modes);
      assert.equal(result.knowledge_applied.length, 2);
    } finally {
      knowledge.recordUsage = origRecordUsage;
    }
  });

  test('enrichContext returns unchanged task when no entries', () => {
    const task = { id: 'task-1', title: 'Test' };
    const result = consumer.enrichContext(task, [], { projectPath: projectDir });
    assert.deepEqual(result.task, task);
    assert.equal(result.knowledge_applied.length, 0);
  });
});

// ============================================================================
// KNOWLEDGE PACKS
// ============================================================================

describe('knowledge-packs', () => {
  let packs;
  let knowledge;

  beforeEach(() => {
    setupTestDirs();
    knowledge = freshModule('../.claude/pilot/hooks/lib/cross-project-knowledge');
    packs = freshModule('../.claude/pilot/hooks/lib/knowledge-packs');
  });

  afterEach(() => { cleanupTestDirs(); });

  const kOpts = () => ({ knowledgePath: knowledgeDir });

  describe('exportPack', () => {
    test('exports knowledge to a pack file', () => {
      knowledge.publishKnowledge('failure-modes', { event: 'test' }, 'P', kOpts());
      knowledge.publishKnowledge('tech-decisions', { decision: 'use react' }, 'P', kOpts());
      const packPath = path.join(testDir, 'test-pack.json');
      const result = packs.exportPack(null, packPath, kOpts());
      assert.equal(result.entries, 2);
      assert.ok(result.size > 0);
      assert.ok(fs.existsSync(packPath));
      const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
      assert.equal(pack.schema_version, '1.0');
      assert.equal(pack.entries.length, 2);
      assert.ok(pack.checksum);
    });

    test('exports filtered by type', () => {
      knowledge.publishKnowledge('failure-modes', { event: 'test' }, 'P', kOpts());
      knowledge.publishKnowledge('tech-decisions', { decision: 'use react' }, 'P', kOpts());
      const packPath = path.join(testDir, 'filtered-pack.json');
      const result = packs.exportPack(['failure-modes'], packPath, kOpts());
      assert.equal(result.entries, 1);
    });
  });

  describe('importPack', () => {
    test('imports a valid pack', () => {
      knowledge.publishKnowledge('failure-modes', { event: 'pack_event' }, 'P', kOpts());
      const packPath = path.join(testDir, 'import-test.json');
      packs.exportPack(null, packPath, kOpts());
      knowledge.resetKnowledge(kOpts());
      fs.mkdirSync(knowledgeDir, { recursive: true });
      const result = packs.importPack(packPath, kOpts());
      assert.equal(result.imported, 1);
      assert.equal(result.errors, 0);
      const index = knowledge.loadIndex(kOpts());
      assert.equal(index.entries.length, 1);
    });

    test('skips duplicates on import', () => {
      knowledge.publishKnowledge('failure-modes', { event: 'existing' }, 'P', kOpts());
      const packPath = path.join(testDir, 'dup-test.json');
      packs.exportPack(null, packPath, kOpts());
      const result = packs.importPack(packPath, kOpts());
      assert.equal(result.skipped, 1);
      assert.equal(result.imported, 0);
    });

    test('rejects invalid pack', () => {
      const packPath = path.join(testDir, 'invalid.json');
      fs.writeFileSync(packPath, 'not json');
      const result = packs.importPack(packPath, kOpts());
      assert.equal(result.errors, 1);
      assert.equal(result.imported, 0);
    });
  });

  describe('validatePack', () => {
    test('validates a correct pack', () => {
      knowledge.publishKnowledge('failure-modes', { event: 'test' }, 'P', kOpts());
      const packPath = path.join(testDir, 'valid-pack.json');
      packs.exportPack(null, packPath, kOpts());
      const result = packs.validatePack(packPath);
      assert.equal(result.valid, true);
      assert.equal(result.issues.length, 0);
    });

    test('detects missing file', () => {
      const result = packs.validatePack('/nonexistent/path.json');
      assert.equal(result.valid, false);
      assert.ok(result.issues[0].includes('does not exist'));
    });

    test('detects invalid JSON', () => {
      const packPath = path.join(testDir, 'bad.json');
      fs.writeFileSync(packPath, '{bad json');
      const result = packs.validatePack(packPath);
      assert.equal(result.valid, false);
      assert.ok(result.issues[0].includes('Invalid JSON'));
    });

    test('detects checksum mismatch', () => {
      knowledge.publishKnowledge('failure-modes', { event: 'test' }, 'P', kOpts());
      const packPath = path.join(testDir, 'tampered.json');
      packs.exportPack(null, packPath, kOpts());
      const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
      pack.entries[0].content.event = 'tampered';
      fs.writeFileSync(packPath, JSON.stringify(pack));
      const result = packs.validatePack(packPath);
      assert.equal(result.valid, false);
      assert.ok(result.issues.some(i => i.includes('Checksum mismatch')));
    });

    test('detects missing entry fields', () => {
      const packPath = path.join(testDir, 'incomplete.json');
      fs.writeFileSync(packPath, JSON.stringify({
        schema_version: '1.0',
        entries: [{ content: { foo: 'bar' } }]
      }));
      const result = packs.validatePack(packPath);
      assert.equal(result.valid, false);
      assert.ok(result.issues.some(i => i.includes('missing type')));
      assert.ok(result.issues.some(i => i.includes('missing id')));
    });
  });
});

// ============================================================================
// PM LOOP INTEGRATION
// ============================================================================

describe('pm-loop knowledge harvest integration', () => {
  beforeEach(() => {
    for (const key of Object.keys(require.cache)) {
      if (key.includes('pm-loop') || key.includes('knowledge')) {
        delete require.cache[key];
      }
    }
  });

  test('PmLoop has _knowledgeHarvestScan method', () => {
    const { PmLoop } = require('../.claude/pilot/hooks/lib/pm-loop');
    const loop = new PmLoop(process.cwd(), { dryRun: true });
    assert.equal(typeof loop._knowledgeHarvestScan, 'function');
  });

  test('PmLoop tracks lastKnowledgeHarvestScan', () => {
    const { PmLoop } = require('../.claude/pilot/hooks/lib/pm-loop');
    const loop = new PmLoop(process.cwd(), { dryRun: true });
    assert.equal(loop.lastKnowledgeHarvestScan, 0);
  });

  test('getStats includes knowledge harvest scan timestamp', () => {
    const { PmLoop } = require('../.claude/pilot/hooks/lib/pm-loop');
    const loop = new PmLoop(process.cwd(), { dryRun: true });
    const stats = loop.getStats();
    assert.ok('last_knowledge_harvest_scan' in stats);
  });
});
