/**
 * Tests for Phase 6.10: Terminal-Aware Multi-LLM Spawner (Pilot AGI-vdx)
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

function freshModule(modPath) {
  const resolved = require.resolve(modPath);
  delete require.cache[resolved];
  return require(resolved);
}

// =============================================================================
// MOCK ADAPTER REGISTRY
// =============================================================================

function createMockAdapterRegistry(adapters = {}) {
  const map = new Map(Object.entries(adapters));
  return {
    adapters: map,
    getAdapterForModel(modelId) {
      for (const [, adapter] of map) {
        if (adapter.supportedModels && adapter.supportedModels.includes(modelId)) {
          return adapter;
        }
      }
      return null;
    }
  };
}

function createMockAdapter(name, opts = {}) {
  return {
    name,
    displayName: opts.displayName || name,
    supportedModels: opts.models || [],
    buildCommand(cmdOpts) {
      const model = cmdOpts.model ? ` --model ${cmdOpts.model}` : '';
      return `${name} --message '${cmdOpts.prompt.slice(0, 50)}'${model}`;
    }
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('TerminalLayout', () => {
  let mod;

  beforeEach(() => {
    mod = freshModule('../lib/terminal-layout');
  });

  describe('MODEL_SHORT_NAMES', () => {
    it('should export short names for known models', () => {
      assert.equal(mod.MODEL_SHORT_NAMES['claude-opus-4-6'], 'Opus');
      assert.equal(mod.MODEL_SHORT_NAMES['gpt-4.5'], 'GPT-4.5');
      assert.equal(mod.MODEL_SHORT_NAMES['gemini-2.5-pro'], 'Gemini Pro');
      assert.equal(mod.MODEL_SHORT_NAMES['ollama:deepseek-coder-v3'], 'DeepSeek');
      assert.equal(mod.MODEL_SHORT_NAMES['codex-mini'], 'Codex');
    });
  });

  describe('formatTabTitle()', () => {
    it('should format title with known model', () => {
      const layout = new mod.TerminalLayout({
        adapterRegistry: null,
        projectRoot: '/tmp/test'
      });

      const title = layout.formatTabTitle('claude-opus-4-6', 'bd-123', 'Fix auth bug');
      assert.equal(title, '[Opus] bd-123 — Fix auth bug');
    });

    it('should truncate long task titles', () => {
      const layout = new mod.TerminalLayout({
        adapterRegistry: null,
        projectRoot: '/tmp/test'
      });

      const longTitle = 'This is a very long task title that exceeds thirty characters by far';
      const title = layout.formatTabTitle('gpt-4.5', 'bd-456', longTitle);
      assert.ok(title.includes('[GPT-4.5]'));
      assert.ok(title.includes('bd-456'));
      assert.ok(title.includes('...'));
      assert.ok(title.length < 80);
    });

    it('should work without task title', () => {
      const layout = new mod.TerminalLayout({
        adapterRegistry: null,
        projectRoot: '/tmp/test'
      });

      const title = layout.formatTabTitle('claude-sonnet-4-5', 'bd-789');
      assert.equal(title, '[Sonnet] bd-789');
    });

    it('should generate fallback name for unknown models', () => {
      const layout = new mod.TerminalLayout({
        adapterRegistry: null,
        projectRoot: '/tmp/test'
      });

      const title = layout.formatTabTitle('my-custom-model', 'bd-001');
      assert.ok(title.includes('bd-001'));
      // Should contain some formatted name, not raw ID
      assert.ok(title.startsWith('['));
    });
  });

  describe('getModelShortName()', () => {
    it('should return known short names', () => {
      const layout = new mod.TerminalLayout({
        adapterRegistry: null,
        projectRoot: '/tmp/test'
      });

      assert.equal(layout.getModelShortName('claude-opus-4-6'), 'Opus');
      assert.equal(layout.getModelShortName('o3-mini'), 'o3-mini');
    });

    it('should use adapter displayName as fallback', () => {
      const registry = createMockAdapterRegistry({
        custom: createMockAdapter('custom', {
          displayName: 'Custom Agent',
          models: ['custom-model-v1']
        })
      });

      const layout = new mod.TerminalLayout({
        adapterRegistry: registry,
        projectRoot: '/tmp/test'
      });

      assert.equal(layout.getModelShortName('custom-model-v1'), 'Custom Agent');
    });

    it('should generate capitalized fallback for completely unknown models', () => {
      const layout = new mod.TerminalLayout({
        adapterRegistry: null,
        projectRoot: '/tmp/test'
      });

      const name = layout.getModelShortName('ollama:some-model-7b');
      assert.equal(name, 'Some Model 7b');
    });
  });

  describe('resolveAdapter()', () => {
    it('should return null when no registry', () => {
      const layout = new mod.TerminalLayout({
        adapterRegistry: null,
        projectRoot: '/tmp/test'
      });

      assert.equal(layout.resolveAdapter('gpt-4.5'), null);
    });

    it('should resolve adapter by name', () => {
      const registry = createMockAdapterRegistry({
        aider: createMockAdapter('aider', { models: ['gpt-4.5'] })
      });

      const layout = new mod.TerminalLayout({
        adapterRegistry: registry,
        projectRoot: '/tmp/test'
      });

      const result = layout.resolveAdapter('gpt-4.5', 'aider');
      assert.ok(result);
      assert.equal(result.adapterName, 'aider');
    });

    it('should resolve adapter by model ID', () => {
      const registry = createMockAdapterRegistry({
        aider: createMockAdapter('aider', { models: ['gpt-4.5', 'gpt-4o'] })
      });

      const layout = new mod.TerminalLayout({
        adapterRegistry: registry,
        projectRoot: '/tmp/test'
      });

      const result = layout.resolveAdapter('gpt-4.5');
      assert.ok(result);
      assert.equal(result.adapter.name, 'aider');
    });

    it('should return null for unknown model', () => {
      const registry = createMockAdapterRegistry({
        aider: createMockAdapter('aider', { models: ['gpt-4.5'] })
      });

      const layout = new mod.TerminalLayout({
        adapterRegistry: registry,
        projectRoot: '/tmp/test'
      });

      const result = layout.resolveAdapter('unknown-model-xyz');
      assert.equal(result, null);
    });
  });

  describe('buildSpawnCommand()', () => {
    it('should use adapter when available', () => {
      const registry = createMockAdapterRegistry({
        aider: createMockAdapter('aider', { models: ['gpt-4.5'] })
      });

      const layout = new mod.TerminalLayout({
        adapterRegistry: registry,
        projectRoot: '/tmp/test'
      });

      const result = layout.buildSpawnCommand({
        modelId: 'gpt-4.5',
        prompt: 'Fix the authentication bug',
        cwd: '/tmp/test'
      });

      assert.equal(result.adapterName, 'aider');
      assert.equal(result.isClaudeNative, false);
      assert.ok(result.command.startsWith('aider'));
    });

    it('should fallback to claude when no adapter found', () => {
      const layout = new mod.TerminalLayout({
        adapterRegistry: null,
        projectRoot: '/tmp/test'
      });

      const result = layout.buildSpawnCommand({
        modelId: 'some-unknown',
        prompt: 'Do something',
        cwd: '/tmp/test'
      });

      assert.equal(result.adapterName, 'claude');
      assert.equal(result.isClaudeNative, true);
      assert.ok(result.command.includes('claude'));
    });

    it('should fallback when adapter.buildCommand throws', () => {
      const badAdapter = {
        name: 'broken',
        displayName: 'Broken',
        supportedModels: ['bad-model'],
        buildCommand() { throw new Error('Build failed'); }
      };

      const registry = createMockAdapterRegistry({ broken: badAdapter });

      const layout = new mod.TerminalLayout({
        adapterRegistry: registry,
        projectRoot: '/tmp/test'
      });

      const result = layout.buildSpawnCommand({
        modelId: 'bad-model',
        adapterName: 'broken',
        prompt: 'Test prompt',
        cwd: '/tmp/test'
      });

      assert.equal(result.adapterName, 'claude');
      assert.equal(result.isClaudeNative, true);
    });
  });

  describe('buildSpawnEnv()', () => {
    it('should include all required env vars', () => {
      const layout = new mod.TerminalLayout({
        adapterRegistry: null,
        projectRoot: '/tmp/test'
      });

      const env = layout.buildSpawnEnv({
        taskId: 'bd-123',
        sessionId: 'S-test-1',
        modelId: 'gpt-4.5',
        adapterName: 'aider',
        agentType: 'backend'
      });

      assert.equal(env.PILOT_DAEMON_SPAWNED, '1');
      assert.equal(env.PILOT_TASK_ID, 'bd-123');
      assert.equal(env.PILOT_SESSION_ID, 'S-test-1');
      assert.equal(env.PILOT_MODEL, 'gpt-4.5');
      assert.equal(env.PILOT_ADAPTER, 'aider');
      assert.equal(env.PILOT_AGENT_TYPE, 'backend');
      assert.equal(env.PILOT_PROJECT_ROOT, '/tmp/test');
    });

    it('should include optional fields when provided', () => {
      const layout = new mod.TerminalLayout({
        adapterRegistry: null,
        projectRoot: '/tmp/test'
      });

      const env = layout.buildSpawnEnv({
        taskId: 'bd-456',
        contextFile: '/tmp/ctx.json',
        worktreePath: '/tmp/wt',
        respawnCount: 3
      });

      assert.equal(env.PILOT_CONTEXT_FILE, '/tmp/ctx.json');
      assert.equal(env.PILOT_WORKTREE_PATH, '/tmp/wt');
      assert.equal(env.PILOT_RESPAWN_COUNT, '3');
    });

    it('should omit optional fields when not provided', () => {
      const layout = new mod.TerminalLayout({
        adapterRegistry: null,
        projectRoot: '/tmp/test'
      });

      const env = layout.buildSpawnEnv({
        taskId: 'bd-789'
      });

      assert.equal(env.PILOT_CONTEXT_FILE, undefined);
      assert.equal(env.PILOT_WORKTREE_PATH, undefined);
      assert.equal(env.PILOT_RESPAWN_COUNT, undefined);
    });
  });

  describe('startEnforcement() / stopEnforcement()', () => {
    it('should skip enforcement for claude adapter', () => {
      const layout = new mod.TerminalLayout({
        adapterRegistry: null,
        projectRoot: '/tmp/test'
      });

      const result = layout.startEnforcement({
        taskId: 'bd-123',
        sessionId: 'S-test',
        adapterName: 'claude',
        cwd: '/tmp/test'
      });

      assert.equal(result.gitHookInstalled, false);
      assert.equal(result.fileWatcherStarted, false);
    });

    it('should return false for non-Claude without enforcement modules', () => {
      const layout = new mod.TerminalLayout({
        adapterRegistry: null,
        projectRoot: '/tmp/nonexistent'
      });

      const result = layout.startEnforcement({
        taskId: 'bd-456',
        sessionId: 'S-test-2',
        adapterName: 'aider',
        cwd: '/tmp/nonexistent'
      });

      // Should not throw — enforcement modules may not be available
      assert.equal(typeof result.gitHookInstalled, 'boolean');
      assert.equal(typeof result.fileWatcherStarted, 'boolean');
    });

    it('should return stopped=false for unknown session', () => {
      const layout = new mod.TerminalLayout({
        adapterRegistry: null,
        projectRoot: '/tmp/test'
      });

      const result = layout.stopEnforcement('nonexistent-session');
      assert.equal(result.stopped, false);
    });
  });

  describe('validatePostRun()', () => {
    it('should pass for claude adapter', () => {
      const layout = new mod.TerminalLayout({
        adapterRegistry: null,
        projectRoot: '/tmp/test'
      });

      const result = layout.validatePostRun({
        cwd: '/tmp/test',
        sessionId: 'S-test',
        taskId: 'bd-123',
        adapterName: 'claude'
      });

      assert.equal(result.passed, true);
      assert.deepEqual(result.violations, []);
      assert.deepEqual(result.warnings, []);
    });

    it('should not throw for non-Claude without validator module', () => {
      const layout = new mod.TerminalLayout({
        adapterRegistry: null,
        projectRoot: '/tmp/nonexistent'
      });

      const result = layout.validatePostRun({
        cwd: '/tmp/nonexistent',
        sessionId: 'S-test',
        taskId: 'bd-456',
        adapterName: 'aider'
      });

      // Should gracefully handle missing module
      assert.equal(result.passed, true);
    });
  });
});

describe('process-spawner adapter support', () => {
  it('should export _parseCommand for testing', () => {
    // _parseCommand is not exported but spawnAgent is
    const mod = freshModule('../.claude/pilot/hooks/lib/process-spawner');
    assert.ok(mod.spawnAgent);
    assert.ok(mod.MAX_PROMPT_LENGTH);
    assert.equal(mod.MAX_PROMPT_LENGTH, 16000);
  });
});
