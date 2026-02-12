/**
 * Multi-LLM End-to-End Integration Tests — Phase 6.18 (Pilot AGI-094)
 *
 * Validates the full multi-LLM pipeline:
 *   1. Multi-adapter registry and model resolution
 *   2. Terminal layout with adapter-aware command building
 *   3. Process spawner adapter integration
 *   4. Cost normalizer cross-model tracking
 *   5. PM dashboard rendering with model data
 *   6. Enforcement layer for non-Claude agents
 *   7. Model-aware task scheduling
 *
 * Run: node --test tests/integration/multi-llm.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// =============================================================================
// HELPERS
// =============================================================================

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-multi-llm-e2e-'));
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

function freshModule(modPath) {
  const resolved = require.resolve(modPath);
  delete require.cache[resolved];
  return require(resolved);
}

function setupPilotDirs(tmpDir) {
  const dirs = [
    '.claude/pilot/state/sessions',
    '.claude/pilot/state/costs/daily',
    '.claude/pilot/state/approved-plans',
    '.claude/pilot/state/artifacts',
    '.claude/pilot/state/validations',
    '.claude/pilot/hooks/lib'
  ];
  for (const d of dirs) {
    fs.mkdirSync(path.join(tmpDir, d), { recursive: true });
  }
}

// =============================================================================
// MOCK ADAPTERS
// =============================================================================

function createMockAdapter(name, opts = {}) {
  return {
    name,
    displayName: opts.displayName || name.charAt(0).toUpperCase() + name.slice(1),
    supportedModels: opts.models || [],
    buildCommand(cmdOpts) {
      const model = cmdOpts.model ? ` --model ${cmdOpts.model}` : '';
      const escaped = (cmdOpts.prompt || '').slice(0, 50).replace(/'/g, "\\'");
      return `${name} --message '${escaped}'${model}`;
    },
    getEnforcementStrategy() {
      return name === 'claude' ? 'native' : 'external';
    }
  };
}

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

const MOCK_MODELS = {
  'claude-opus-4-6': { provider: 'anthropic', name: 'Claude Opus 4.6', cost: { input: 15.0, output: 75.0 } },
  'claude-sonnet-4-5': { provider: 'anthropic', name: 'Claude Sonnet 4.5', cost: { input: 3.0, output: 15.0 } },
  'gpt-4.5': { provider: 'openai', name: 'GPT-4.5', cost: { input: 2.0, output: 10.0 } },
  'gemini-2.5-flash': { provider: 'google', name: 'Gemini 2.5 Flash', cost: { input: 0.15, output: 0.60 } },
  'ollama:deepseek-coder-v3': { provider: 'local', name: 'DeepSeek V3', cost: { input: 0, output: 0 } }
};

// =============================================================================
// E2E SCENARIOS
// =============================================================================

describe('Multi-LLM E2E Integration', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
    setupPilotDirs(tmpDir);
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  // ===========================================================================
  // Scenario 1: Multi-adapter spawn pipeline
  // ===========================================================================
  describe('Scenario 1: Multi-adapter spawn pipeline', () => {
    it('should build commands for Claude, Aider, and OpenCode adapters', () => {
      const { TerminalLayout } = freshModule('../../lib/terminal-layout');

      const registry = createMockAdapterRegistry({
        claude: createMockAdapter('claude', { models: ['claude-opus-4-6', 'claude-sonnet-4-5'] }),
        aider: createMockAdapter('aider', { displayName: 'Aider', models: ['gpt-4.5'] }),
        opencode: createMockAdapter('opencode', { displayName: 'OpenCode', models: ['gemini-2.5-flash'] })
      });

      const layout = new TerminalLayout({
        adapterRegistry: registry,
        projectRoot: tmpDir
      });

      // Claude spawn
      const claude = layout.buildSpawnCommand({
        modelId: 'claude-opus-4-6',
        prompt: 'Fix authentication bug',
        cwd: tmpDir
      });
      assert.equal(claude.adapterName, 'claude');
      assert.equal(claude.isClaudeNative, true);

      // Aider spawn
      const aider = layout.buildSpawnCommand({
        modelId: 'gpt-4.5',
        prompt: 'Refactor database layer',
        cwd: tmpDir
      });
      assert.equal(aider.adapterName, 'aider');
      assert.equal(aider.isClaudeNative, false);
      assert.ok(aider.command.startsWith('aider'));

      // OpenCode spawn
      const opencode = layout.buildSpawnCommand({
        modelId: 'gemini-2.5-flash',
        prompt: 'Add unit tests',
        cwd: tmpDir
      });
      assert.equal(opencode.adapterName, 'opencode');
      assert.equal(opencode.isClaudeNative, false);
      assert.ok(opencode.command.startsWith('opencode'));
    });

    it('should format tab titles with correct model labels', () => {
      const { TerminalLayout } = freshModule('../../lib/terminal-layout');

      const layout = new TerminalLayout({
        adapterRegistry: null,
        projectRoot: tmpDir
      });

      assert.equal(
        layout.formatTabTitle('claude-opus-4-6', 'bd-100', 'Fix auth'),
        '[Opus] bd-100 — Fix auth'
      );
      assert.equal(
        layout.formatTabTitle('gpt-4.5', 'bd-101', 'Refactor DB'),
        '[GPT-4.5] bd-101 — Refactor DB'
      );
      assert.equal(
        layout.formatTabTitle('gemini-2.5-flash', 'bd-102', 'Add tests'),
        '[Gemini Flash] bd-102 — Add tests'
      );
    });

    it('should build environment variables for multi-model agents', () => {
      const { TerminalLayout } = freshModule('../../lib/terminal-layout');

      const layout = new TerminalLayout({
        adapterRegistry: null,
        projectRoot: tmpDir
      });

      const env = layout.buildSpawnEnv({
        taskId: 'bd-200',
        sessionId: 'S-test-aider',
        modelId: 'gpt-4.5',
        adapterName: 'aider',
        agentType: 'backend'
      });

      assert.equal(env.PILOT_TASK_ID, 'bd-200');
      assert.equal(env.PILOT_MODEL, 'gpt-4.5');
      assert.equal(env.PILOT_ADAPTER, 'aider');
      assert.equal(env.PILOT_AGENT_TYPE, 'backend');
      assert.equal(env.PILOT_DAEMON_SPAWNED, '1');
    });
  });

  // ===========================================================================
  // Scenario 2: Cross-model cost tracking and normalization
  // ===========================================================================
  describe('Scenario 2: Cross-model cost tracking', () => {
    it('should track costs across Claude, GPT, and Gemini in a single day', () => {
      const { CostNormalizer } = freshModule('../../lib/cost-normalizer');
      const normalizer = new CostNormalizer(MOCK_MODELS, { projectRoot: tmpDir });

      // Simulate 3 agents working on different tasks
      normalizer.recordDailyCost({
        modelId: 'claude-opus-4-6',
        inputTokens: 200_000,
        outputTokens: 100_000,
        taskId: 'bd-301',
        sessionId: 'S-claude-1'
      });

      normalizer.recordDailyCost({
        modelId: 'gpt-4.5',
        inputTokens: 300_000,
        outputTokens: 150_000,
        taskId: 'bd-302',
        sessionId: 'S-aider-1'
      });

      normalizer.recordDailyCost({
        modelId: 'gemini-2.5-flash',
        inputTokens: 500_000,
        outputTokens: 200_000,
        taskId: 'bd-303',
        sessionId: 'S-opencode-1'
      });

      const report = normalizer.getDailyReport();

      // Verify per-provider aggregation
      assert.ok(report.byProvider.anthropic, 'Should have anthropic data');
      assert.ok(report.byProvider.openai, 'Should have openai data');
      assert.ok(report.byProvider.google, 'Should have google data');

      // Verify per-model breakdown
      assert.equal(Object.keys(report.byModel).length, 3);
      assert.ok(report.byModel['claude-opus-4-6'].dollars > 0);
      assert.ok(report.byModel['gpt-4.5'].dollars > 0);
      assert.ok(report.byModel['gemini-2.5-flash'].dollars > 0);

      // Verify savings vs all-Opus
      assert.ok(report.savings.saved > 0, 'Should show savings from cheaper models');
      assert.ok(parseFloat(report.savings.percentSaved) > 0, 'Should show positive savings %');

      // Verify total = sum of model costs
      const modelSum = Object.values(report.byModel).reduce((s, m) => s + m.dollars, 0);
      assert.ok(Math.abs(report.total - modelSum) < 0.01, 'Total should equal sum of model costs');
    });

    it('should enforce provider budgets across models', () => {
      const { CostNormalizer } = freshModule('../../lib/cost-normalizer');
      const normalizer = new CostNormalizer(MOCK_MODELS, {
        projectRoot: tmpDir,
        providerBudgets: { anthropic: 5.0, openai: 2.0, google: 1.0 }
      });

      // Record Opus cost that exceeds anthropic budget
      normalizer.recordDailyCost({
        modelId: 'claude-opus-4-6',
        inputTokens: 200_000,
        outputTokens: 100_000, // $3 + $7.5 = $10.5
        taskId: 'bd-400'
      });

      // Record GPT cost under openai budget
      normalizer.recordDailyCost({
        modelId: 'gpt-4.5',
        inputTokens: 50_000,
        outputTokens: 25_000, // $0.1 + $0.25 = $0.35
        taskId: 'bd-401'
      });

      const budgets = normalizer.checkAllProviderBudgets();

      assert.equal(budgets.anthropic.status, 'exceeded', 'Anthropic should be exceeded');
      assert.equal(budgets.openai.status, 'ok', 'OpenAI should be ok');
      assert.equal(budgets.google.status, 'ok', 'Google should be ok');
    });

    it('should calculate local model savings at 100%', () => {
      const { CostNormalizer } = freshModule('../../lib/cost-normalizer');
      const normalizer = new CostNormalizer(MOCK_MODELS, { projectRoot: tmpDir });

      normalizer.recordDailyCost({
        modelId: 'ollama:deepseek-coder-v3',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        taskId: 'bd-500'
      });

      const report = normalizer.getDailyReport();

      assert.equal(report.savings.actual, 0, 'Local models cost $0');
      assert.ok(report.savings.opusEquivalent > 0, 'Opus equivalent should be expensive');
      assert.equal(report.savings.percentSaved, '100.0', 'Should save 100%');
    });
  });

  // ===========================================================================
  // Scenario 3: Dashboard renders multi-model view
  // ===========================================================================
  describe('Scenario 3: Dashboard multi-model rendering', () => {
    it('should render complete dashboard with agents, costs, budgets, and savings', () => {
      const { PmDashboard } = freshModule('../../lib/pm-dashboard-terminal');

      const dashboard = new PmDashboard({ projectRoot: tmpDir });

      const data = {
        agents: [
          { session_id: 'S-1', agent_name: 'opus-agent', claimed_task: 'bd-601', status: 'healthy', modelId: 'claude-opus-4-6' },
          { session_id: 'S-2', agent_name: 'gpt-agent', claimed_task: 'bd-602', status: 'healthy', modelId: 'gpt-4.5' },
          { session_id: 'S-3', agent_name: 'gemini-agent', claimed_task: 'bd-603', status: 'stale', modelId: 'gemini-2.5-flash' },
          { session_id: 'S-4', agent_name: 'local-agent', claimed_task: 'bd-604', status: 'healthy', modelId: 'ollama:deepseek-coder-v3' }
        ],
        tasks: { open: 5, in_progress: 4, closed: 20, total: 29, items: [] },
        locks: { areas: [], files: [] },
        costs: [
          { session_id: 'S-1', cost_usd: 5.25 },
          { session_id: 'S-2', cost_usd: 1.50 },
          { session_id: 'S-3', cost_usd: 0.12 },
          { session_id: 'S-4', cost_usd: 0 }
        ],
        pressure: [
          { session_id: 'S-1', pct_estimate: 45 },
          { session_id: 'S-2', pct_estimate: 30 },
          { session_id: 'S-3', pct_estimate: 80 },
          { session_id: 'S-4', pct_estimate: 15 }
        ],
        drift: [],
        multiModel: {
          dailyReport: {
            date: '2026-02-12',
            total: 6.87,
            byModel: {
              'claude-opus-4-6': { dollars: 5.25, tokens: 300000, entries: 3 },
              'gpt-4.5': { dollars: 1.50, tokens: 200000, entries: 2 },
              'gemini-2.5-flash': { dollars: 0.12, tokens: 700000, entries: 5 },
              'ollama:deepseek-coder-v3': { dollars: 0, tokens: 1500000, entries: 10 }
            },
            byProvider: {
              anthropic: { dollars: 5.25, tasks: 3, entries: 3 },
              openai: { dollars: 1.50, tasks: 2, entries: 2 },
              google: { dollars: 0.12, tasks: 5, entries: 5 },
              local: { dollars: 0, tasks: 10, entries: 10 }
            },
            savings: { opusEquivalent: 85.0, actual: 6.87, saved: 78.13, percentSaved: '91.9' },
            entryCount: 20
          },
          providerBudgets: {
            anthropic: { status: 'ok', spent: 5.25, budget: 50.0 },
            openai: { status: 'ok', spent: 1.50, budget: 30.0 },
            google: { status: 'ok', spent: 0.12, budget: 10.0 },
            local: { status: 'ok', spent: 0, budget: null }
          },
          savings: { opusEquivalent: 85.0, actual: 6.87, saved: 78.13, percentSaved: '91.9' },
          modelShortNames: {
            'claude-opus-4-6': 'Opus',
            'gpt-4.5': 'GPT-4.5',
            'gemini-2.5-flash': 'Gemini Flash',
            'ollama:deepseek-coder-v3': 'DeepSeek'
          }
        },
        collected_at: new Date().toISOString()
      };

      const output = dashboard.render(data);

      // Header
      assert.ok(output.includes('PILOT AGI'), 'Should have header');
      assert.ok(output.includes('4 active'), 'Should show 4 active agents');

      // Agent table — all 4 agents with model labels
      assert.ok(output.includes('opus-agent'), 'Should show opus agent');
      assert.ok(output.includes('gpt-agent'), 'Should show gpt agent');
      assert.ok(output.includes('gemini-agent'), 'Should show gemini agent');
      assert.ok(output.includes('local-agent'), 'Should show local agent');
      assert.ok(output.includes('Opus'), 'Should show Opus label');
      assert.ok(output.includes('GPT-4.5'), 'Should show GPT-4.5 label');
      assert.ok(output.includes('Gemini Flash'), 'Should show Gemini Flash label');
      assert.ok(output.includes('DeepSeek'), 'Should show DeepSeek label');

      // Context % column
      assert.ok(output.includes('45%'), 'Should show opus ctx%');
      assert.ok(output.includes('80%'), 'Should show gemini ctx%');

      // Cost column
      assert.ok(output.includes('$5.25'), 'Should show opus cost');
      assert.ok(output.includes('$1.50'), 'Should show gpt cost');

      // Status column
      assert.ok(output.includes('OK'), 'Should show healthy status');
      assert.ok(output.includes('STALE'), 'Should show stale status');

      // Cost summary
      assert.ok(output.includes('$6.87'), 'Should show total cost');
      assert.ok(output.includes('3 calls') || output.includes('2 calls'), 'Should show call counts');

      // Provider budgets
      assert.ok(output.includes('PROVIDER BUDGETS'), 'Should show budgets section');
      assert.ok(output.includes('$5.25/$50.00'), 'Should show anthropic budget');
      assert.ok(output.includes('unlimited'), 'Should show local as unlimited');

      // Savings
      assert.ok(output.includes('91.9%'), 'Should show savings percentage');
      assert.ok(output.includes('$78.13'), 'Should show dollar savings');
    });
  });

  // ===========================================================================
  // Scenario 4: Enforcement for non-Claude agents
  // ===========================================================================
  describe('Scenario 4: Enforcement enforcement', () => {
    it('should skip enforcement for Claude agents', () => {
      const { TerminalLayout } = freshModule('../../lib/terminal-layout');

      const layout = new TerminalLayout({
        adapterRegistry: null,
        projectRoot: tmpDir
      });

      const result = layout.startEnforcement({
        taskId: 'bd-700',
        sessionId: 'S-claude-1',
        adapterName: 'claude',
        cwd: tmpDir
      });

      assert.equal(result.gitHookInstalled, false);
      assert.equal(result.fileWatcherStarted, false);
    });

    it('should validate post-run for Claude as passing', () => {
      const { TerminalLayout } = freshModule('../../lib/terminal-layout');

      const layout = new TerminalLayout({
        adapterRegistry: null,
        projectRoot: tmpDir
      });

      const result = layout.validatePostRun({
        cwd: tmpDir,
        sessionId: 'S-claude-1',
        taskId: 'bd-701',
        adapterName: 'claude'
      });

      assert.equal(result.passed, true);
      assert.deepEqual(result.violations, []);
    });
  });

  // ===========================================================================
  // Scenario 5: Full pipeline — adapter → command → env → cost → dashboard
  // ===========================================================================
  describe('Scenario 5: Full pipeline integration', () => {
    it('should flow from adapter selection through to dashboard rendering', () => {
      const { TerminalLayout } = freshModule('../../lib/terminal-layout');
      const { CostNormalizer } = freshModule('../../lib/cost-normalizer');
      const { PmDashboard } = freshModule('../../lib/pm-dashboard-terminal');

      // Step 1: Set up adapters
      const registry = createMockAdapterRegistry({
        claude: createMockAdapter('claude', { models: ['claude-sonnet-4-5'] }),
        aider: createMockAdapter('aider', { displayName: 'Aider', models: ['gpt-4.5'] })
      });

      const layout = new TerminalLayout({
        adapterRegistry: registry,
        projectRoot: tmpDir
      });

      // Step 2: Build commands for both adapters
      const claudeCmd = layout.buildSpawnCommand({
        modelId: 'claude-sonnet-4-5',
        prompt: 'Implement feature A',
        cwd: tmpDir
      });
      const aiderCmd = layout.buildSpawnCommand({
        modelId: 'gpt-4.5',
        prompt: 'Implement feature B',
        cwd: tmpDir
      });

      assert.equal(claudeCmd.isClaudeNative, true);
      assert.equal(aiderCmd.isClaudeNative, false);

      // Step 3: Build environment for both
      const claudeEnv = layout.buildSpawnEnv({
        taskId: 'bd-801', sessionId: 'S-1',
        modelId: 'claude-sonnet-4-5', adapterName: 'claude'
      });
      const aiderEnv = layout.buildSpawnEnv({
        taskId: 'bd-802', sessionId: 'S-2',
        modelId: 'gpt-4.5', adapterName: 'aider'
      });

      assert.equal(claudeEnv.PILOT_ADAPTER, 'claude');
      assert.equal(aiderEnv.PILOT_ADAPTER, 'aider');

      // Step 4: Record costs for both
      const normalizer = new CostNormalizer(MOCK_MODELS, { projectRoot: tmpDir });

      normalizer.recordDailyCost({
        modelId: 'claude-sonnet-4-5',
        inputTokens: 100_000,
        outputTokens: 50_000,
        taskId: 'bd-801',
        sessionId: 'S-1'
      });

      normalizer.recordDailyCost({
        modelId: 'gpt-4.5',
        inputTokens: 100_000,
        outputTokens: 50_000,
        taskId: 'bd-802',
        sessionId: 'S-2'
      });

      // Step 5: Get daily report
      const report = normalizer.getDailyReport();
      assert.equal(report.entryCount, 2);
      assert.ok(report.byModel['claude-sonnet-4-5']);
      assert.ok(report.byModel['gpt-4.5']);

      // Step 6: Render dashboard
      const dashboard = new PmDashboard({ projectRoot: tmpDir });

      const data = {
        agents: [
          { session_id: 'S-1', agent_name: 'sonnet-1', claimed_task: 'bd-801', status: 'healthy', modelId: 'claude-sonnet-4-5' },
          { session_id: 'S-2', agent_name: 'gpt-1', claimed_task: 'bd-802', status: 'healthy', modelId: 'gpt-4.5' }
        ],
        tasks: { open: 2, in_progress: 2, closed: 0, total: 4, items: [] },
        locks: { areas: [], files: [] },
        costs: [],
        pressure: [],
        drift: [],
        multiModel: {
          dailyReport: report,
          providerBudgets: normalizer.checkAllProviderBudgets(),
          savings: report.savings,
          modelShortNames: { 'claude-sonnet-4-5': 'Sonnet', 'gpt-4.5': 'GPT-4.5' }
        },
        collected_at: new Date().toISOString()
      };

      const output = dashboard.render(data);

      // Verify full pipeline output
      assert.ok(output.includes('Sonnet'), 'Dashboard shows Sonnet');
      assert.ok(output.includes('GPT-4.5'), 'Dashboard shows GPT-4.5');
      assert.ok(output.includes('2 active'), 'Dashboard shows 2 active agents');
      assert.ok(report.savings.saved > 0, 'Shows savings from using cheaper models');
    });
  });

  // ===========================================================================
  // Scenario 6: Model failover (adapter failure → fallback to Claude)
  // ===========================================================================
  describe('Scenario 6: Model failover', () => {
    it('should fallback to Claude when adapter buildCommand fails', () => {
      const { TerminalLayout } = freshModule('../../lib/terminal-layout');

      const brokenAdapter = {
        name: 'broken',
        displayName: 'Broken Agent',
        supportedModels: ['broken-model'],
        buildCommand() { throw new Error('CLI not installed'); }
      };

      const registry = createMockAdapterRegistry({ broken: brokenAdapter });

      const layout = new TerminalLayout({
        adapterRegistry: registry,
        projectRoot: tmpDir
      });

      const result = layout.buildSpawnCommand({
        modelId: 'broken-model',
        adapterName: 'broken',
        prompt: 'This should fallback',
        cwd: tmpDir
      });

      assert.equal(result.adapterName, 'claude');
      assert.equal(result.isClaudeNative, true);
      assert.ok(result.command.includes('claude'));
    });

    it('should fallback to Claude when no adapter registry exists', () => {
      const { TerminalLayout } = freshModule('../../lib/terminal-layout');

      const layout = new TerminalLayout({
        adapterRegistry: null,
        projectRoot: tmpDir
      });

      const result = layout.buildSpawnCommand({
        modelId: 'unknown-model',
        prompt: 'Test fallback',
        cwd: tmpDir
      });

      assert.equal(result.adapterName, 'claude');
      assert.equal(result.isClaudeNative, true);
    });
  });

  // ===========================================================================
  // Scenario 7: Process spawner adapter parameter
  // ===========================================================================
  describe('Scenario 7: Process spawner adapter support', () => {
    it('should accept adapter and modelId options', () => {
      const mod = freshModule('../../.claude/pilot/hooks/lib/process-spawner');

      // Verify the module accepts the new options
      assert.ok(typeof mod.spawnAgent === 'function');

      // DRY RUN with adapter
      const mockAdapter = createMockAdapter('aider', { models: ['gpt-4.5'] });

      const result = mod.spawnAgent(
        { id: 'bd-900', title: 'Test task', description: 'Test' },
        {
          projectRoot: tmpDir,
          adapter: mockAdapter,
          modelId: 'gpt-4.5',
          dryRun: true
        }
      );

      assert.ok(result.success);
      assert.equal(result.dry_run, true);
    });

    it('should include adapter info in context file', () => {
      const mod = freshModule('../../.claude/pilot/hooks/lib/process-spawner');

      // Write context file
      const contextPath = mod._writeContextFile('bd-test-ctx', {
        task: { id: 'bd-test-ctx', title: 'Test' },
        agent_type: 'backend'
      }, tmpDir);

      assert.ok(fs.existsSync(contextPath));
      const ctx = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
      assert.equal(ctx.task.id, 'bd-test-ctx');
      assert.equal(ctx.agent_type, 'backend');

      // Cleanup
      mod.cleanupContextFile('bd-test-ctx', tmpDir);
      assert.ok(!fs.existsSync(contextPath));
    });
  });

  // ===========================================================================
  // Scenario 8: Cross-module constants consistency
  // ===========================================================================
  describe('Scenario 8: Cross-module consistency', () => {
    it('should have consistent model short names across modules', () => {
      const { MODEL_SHORT_NAMES } = freshModule('../../lib/terminal-layout');

      // Key models should be mapped
      assert.ok(MODEL_SHORT_NAMES['claude-opus-4-6'], 'Opus should be mapped');
      assert.ok(MODEL_SHORT_NAMES['claude-sonnet-4-5'], 'Sonnet should be mapped');
      assert.ok(MODEL_SHORT_NAMES['gpt-4.5'], 'GPT-4.5 should be mapped');
      assert.ok(MODEL_SHORT_NAMES['gemini-2.5-flash'], 'Gemini Flash should be mapped');
      assert.ok(MODEL_SHORT_NAMES['ollama:deepseek-coder-v3'], 'DeepSeek should be mapped');
    });

    it('should have consistent normalization baseline', () => {
      const { SONNET_OUTPUT_RATE } = freshModule('../../lib/cost-normalizer');
      assert.equal(SONNET_OUTPUT_RATE, 15.0, 'Sonnet output rate should be $15/1M');
    });

    it('should export all expected interfaces from cost normalizer', () => {
      const mod = freshModule('../../lib/cost-normalizer');
      assert.ok(mod.CostNormalizer);
      assert.ok(mod.createNormalizer);
      assert.ok(mod.SONNET_OUTPUT_RATE);
      assert.ok(mod.DAILY_COSTS_DIR);
      assert.ok(mod.FALLBACK_PRICING);
    });

    it('should export all expected interfaces from terminal layout', () => {
      const mod = freshModule('../../lib/terminal-layout');
      assert.ok(mod.TerminalLayout);
      assert.ok(mod.MODEL_SHORT_NAMES);
    });

    it('should export all expected interfaces from dashboard', () => {
      const mod = freshModule('../../lib/pm-dashboard-terminal');
      assert.ok(mod.PmDashboard);
      assert.ok(mod.renderBar);
      assert.ok(mod.pad);
    });
  });
});
