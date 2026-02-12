# Milestone 6: Multi-LLM Orchestration — "The Right AI for Every Task"

**Task**: Pilot AGI-sny
**Status**: Design Spec
**Target**: v5.0.0
**Replaces**: `m6-physical-terminal-control.md` (absorbed as Stream B)

---

## Vision

```
You define your team:
  - Claude Opus for architecture & complex reasoning
  - GPT-4.5 for test generation
  - Gemini 2.5 Pro for fast UI work
  - DeepSeek for bulk code changes
  - Llama 3.3 for documentation (local, free)

PM Daemon assigns tasks to the best model for the job.
All agents share the same knowledge, policies, and artifacts.
You control everything from Telegram on your phone.
```

## Problem Statement

Pilot AGI is locked to Claude Code. This creates three problems:

1. **Single-vendor lock-in** — If Anthropic has an outage, downtime, or pricing change, everything stops
2. **Wrong tool for the job** — Claude Opus is overkill for writing README files; a local Llama model would be free. GPT-4.5 may be better at certain test patterns. Gemini 2.5 is faster for UI iteration
3. **Market limitation** — Developers using Cursor, Aider, OpenCode, or Codex CLI can't use Pilot AGI's governance layer

The insight: **Pilot AGI's core value isn't Claude — it's the governance, scheduling, shared knowledge, and reliability layer**. That layer is already ~90% model-agnostic. The remaining 10% is the coupling to Claude Code's hook system and `claude -p` spawn command.

```
CURRENT (M5):
┌──────────────────────────────────────────┐
│ PM Daemon (Node.js)                      │
│                                          │
│ Spawns: claude -p "task X"  ←── ONLY ONE │
│ Hooks:  Claude Code hooks   ←── ONLY ONE │
│ Output: log files                        │
└──────────────────────────────────────────┘

M6 TARGET:
┌──────────────────────────────────────────────────────────────┐
│ PM Daemon (Node.js)                                          │
│                                                              │
│ Spawns via adapters:                                         │
│   claude -p "task X"        → Claude Opus (complex backend)  │
│   aider --message "task Y"  → GPT-4.5 (test generation)     │
│   opencode -m "task Z"      → Gemini 2.5 (fast UI)          │
│   codex "task W"            → Codex (bulk changes)           │
│   ollama run llama "task V" → Llama 3.3 (docs, free)        │
│                                                              │
│ All share: policies, memory, artifacts, message bus          │
│ All governed: budgets, escalation, drift detection           │
│ Visible: terminal tabs/panes per agent                       │
│ Remote: Telegram bot for control + approval                  │
└──────────────────────────────────────────────────────────────┘
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         PM DAEMON (Node.js)                         │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  ┌──────────┐ │
│  │ Model-Aware   │  │ Terminal      │  │ Telegram   │  │ Shared   │ │
│  │ Scheduler     │  │ Controller   │  │ Bot        │  │ State    │ │
│  │               │  │              │  │            │  │          │ │
│  │ Score models  │  │ Open/close   │  │ /status    │  │ Memory   │ │
│  │ per task      │  │ Read output  │  │ /approve   │  │ Policy   │ │
│  │ Route work    │  │ Inject cmds  │  │ /budget    │  │ Artifacts│ │
│  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘  │ Bus      │ │
│         │                  │                │          └────┬─────┘ │
└─────────┼──────────────────┼────────────────┼──────────────┼───────┘
          │                  │                │              │
          ▼                  ▼                ▼              │
┌─────────────────────────────────────────────────┐         │
│              AGENT ADAPTER LAYER                 │         │
│                                                  │         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐        │         │
│  │ Claude   │ │ Aider    │ │ OpenCode │        │         │
│  │ Adapter  │ │ Adapter  │ │ Adapter  │        │         │
│  ├──────────┤ ├──────────┤ ├──────────┤        │         │
│  │ spawn()  │ │ spawn()  │ │ spawn()  │  ...   │         │
│  │ inject() │ │ inject() │ │ inject() │        │         │
│  │ monitor()│ │ monitor()│ │ monitor()│        │         │
│  │ enforce()│ │ enforce()│ │ enforce()│        │         │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘        │         │
│       │             │             │              │         │
└───────┼─────────────┼─────────────┼──────────────┘         │
        │             │             │                         │
        ▼             ▼             ▼                         │
┌────────────┐ ┌────────────┐ ┌────────────┐                │
│ Claude Code│ │ Aider      │ │ OpenCode   │                │
│ Terminal 1 │ │ Terminal 2 │ │ Terminal 3 │  ←── all read ──┘
│ (Opus)     │ │ (GPT-4.5)  │ │ (Gemini)   │     shared state
│ backend    │ │ tests      │ │ frontend   │
└────────────┘ └────────────┘ └────────────┘
```

## Design Principles

1. **Adapter pattern** — Each agent CLI gets a thin adapter (~100-200 lines). PM Daemon never talks to CLIs directly.
2. **Shared state is the glue** — All agents read/write the same memory channels, artifacts, and message bus. The LLM doesn't matter; the state format does.
3. **Best model for each task** — Scheduler scores models by capability, cost, speed, and task requirements. Not all tasks need the most expensive model.
4. **Terminal visibility** — Every agent runs in a visible terminal tab/window. PM can read output, inject commands, and arrange the layout.
5. **Telegram is the remote interface** — Control your multi-model AI team from your phone.
6. **Graceful degradation** — If only Claude Code is installed, everything works as before. Each additional CLI adds capabilities, none are required.
7. **Backward compatible** — Existing headless `claude -p` mode is preserved. Multi-LLM is opt-in.

---

## Stream A: Agent Adapter Layer

The core abstraction that makes multi-LLM work. Each supported agent CLI gets an adapter that implements four operations: **spawn**, **inject**, **monitor**, **enforce**.

### Phase 6.1: Agent Adapter Interface & Registry

**Problem**: PM Daemon is hardcoded to spawn `claude -p`. Need a generic interface that works across any coding agent CLI.

#### Adapter Interface

```javascript
// lib/agent-adapter.js

/**
 * @interface AgentAdapter
 * Every supported agent CLI implements this interface.
 */
class AgentAdapter {
  /** @returns {string} Adapter name (e.g., 'claude', 'aider', 'opencode') */
  get name() {}

  /** @returns {string} Display name (e.g., 'Claude Code', 'Aider', 'OpenCode') */
  get displayName() {}

  /**
   * Check if this agent CLI is installed and available.
   * @returns {Promise<{ available: boolean, version?: string, path?: string }>}
   */
  async detect() {}

  /**
   * Get the models this adapter supports.
   * @returns {Promise<Array<{ id: string, name: string, provider: string, capabilities: string[] }>>}
   */
  async listModels() {}

  /**
   * Spawn an agent process with a task.
   * @param {object} opts
   * @param {string} opts.prompt - The task prompt (plain text)
   * @param {string} opts.model - Model ID to use (e.g., 'claude-opus-4-6', 'gpt-4.5')
   * @param {string} opts.cwd - Working directory
   * @param {object} opts.env - Environment variables
   * @param {string} opts.contextFile - Path to context capsule JSON
   * @param {number} opts.maxTokens - Token budget for this task
   * @returns {Promise<{ pid: number, sessionId: string }>}
   */
  async spawn(opts) {}

  /**
   * Inject context into a running agent (if supported).
   * For CLI agents, this may mean writing to stdin or a watched file.
   * @param {string} sessionId
   * @param {string} content - Context to inject
   * @returns {Promise<boolean>} - Whether injection was successful
   */
  async inject(sessionId, content) {}

  /**
   * Read recent output from the agent.
   * @param {string} sessionId
   * @param {number} lines - Number of lines to read
   * @returns {Promise<string>}
   */
  async readOutput(sessionId, lines) {}

  /**
   * Check if agent process is still running.
   * @param {string} sessionId
   * @returns {Promise<{ alive: boolean, exitCode?: number }>}
   */
  async isAlive(sessionId) {}

  /**
   * Gracefully stop an agent.
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async stop(sessionId) {}

  /**
   * Get the enforcement strategy for this adapter.
   * Claude Code uses hooks. Others use git hooks, wrappers, or file watchers.
   * @returns {{ type: 'hooks'|'git-hooks'|'wrapper'|'file-watcher', details: object }}
   */
  getEnforcementStrategy() {}

  /**
   * Build the CLI command string for spawning.
   * @param {object} opts - Same as spawn opts
   * @returns {string} - The shell command to run
   */
  buildCommand(opts) {}
}
```

#### Adapter Registry

```javascript
// lib/agent-registry.js

class AgentAdapterRegistry {
  constructor() {
    this.adapters = new Map();    // name -> AgentAdapter
    this.detected = new Map();    // name -> detection result
  }

  register(adapter) {
    this.adapters.set(adapter.name, adapter);
  }

  /**
   * Detect all available agent CLIs on the system.
   * @returns {Promise<Map<string, { available, version, path }>>}
   */
  async detectAll() {
    const results = new Map();
    for (const [name, adapter] of this.adapters) {
      const result = await adapter.detect();
      results.set(name, result);
      this.detected.set(name, result);
    }
    return results;
  }

  /**
   * Get adapter by name.
   * @param {string} name
   * @returns {AgentAdapter}
   */
  get(name) {
    return this.adapters.get(name);
  }

  /**
   * Get all available adapters (detected and installed).
   * @returns {AgentAdapter[]}
   */
  getAvailable() {
    return [...this.adapters.values()].filter(a =>
      this.detected.get(a.name)?.available
    );
  }

  /**
   * Get the best adapter for a given model.
   * @param {string} modelId
   * @returns {AgentAdapter|null}
   */
  getAdapterForModel(modelId) {
    for (const adapter of this.getAvailable()) {
      const models = this.detected.get(adapter.name)?.models || [];
      if (models.some(m => m.id === modelId)) return adapter;
    }
    return null;
  }
}
```

#### Detection on PM Daemon Start

When PM Daemon starts, it scans for available agent CLIs:

```
$ pm-daemon.js --watch

Detecting available agent CLIs...
  Claude Code  v2.1.0  /usr/local/bin/claude     [claude-opus-4-6, claude-sonnet-4-5, claude-haiku-4-5]
  Aider        v0.82   /usr/local/bin/aider       [gpt-4.5, gpt-4o, o3-mini]
  OpenCode     v1.4    /usr/local/bin/opencode     [gemini-2.5-pro, gemini-2.5-flash]
  Codex CLI    v0.3    /usr/local/bin/codex        [codex-mini]
  Ollama       v0.6    /usr/local/bin/ollama       [llama-3.3-70b, deepseek-coder-v3, qwen-2.5-coder]

5 adapters available, 14 models detected.
Using default model: claude-opus-4-6 (Claude Code)
```

**Files**: `lib/agent-adapter.js`, `lib/agent-registry.js`
**Tests**: adapter interface compliance, registry detection, model lookup

---

### Phase 6.2: Claude Code Adapter

**The reference adapter** — wraps existing Pilot AGI integration. Everything that works today continues to work through this adapter.

```javascript
// lib/adapters/claude-adapter.js

class ClaudeAdapter extends AgentAdapter {
  get name() { return 'claude'; }
  get displayName() { return 'Claude Code'; }

  async detect() {
    try {
      const { stdout } = await execFile('claude', ['--version']);
      return {
        available: true,
        version: stdout.trim(),
        path: await which('claude'),
        models: [
          { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', capabilities: ['reasoning', 'architecture', 'refactoring', 'complex-logic'] },
          { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'anthropic', capabilities: ['general', 'fast', 'balanced'] },
          { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic', capabilities: ['fast', 'cheap', 'docs', 'simple'] },
        ]
      };
    } catch { return { available: false }; }
  }

  async spawn(opts) {
    const args = ['-p', opts.prompt, '--model', opts.model || 'claude-opus-4-6'];
    if (opts.contextFile) {
      // Claude Code reads context via hooks (session-start injects from context file)
      opts.env.PILOT_CONTEXT_FILE = opts.contextFile;
    }
    if (opts.maxTokens) {
      opts.env.PILOT_TOKEN_BUDGET = String(opts.maxTokens);
    }

    const proc = spawn('claude', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return { pid: proc.pid, sessionId: opts.env.PILOT_SESSION_ID, process: proc };
  }

  async inject(sessionId, content) {
    // Claude Code uses stdin injection via PM watcher
    // Write to the agent's stdin pipe
    const proc = this._getProcess(sessionId);
    if (proc && proc.stdin.writable) {
      proc.stdin.write(content + '\n');
      return true;
    }
    return false;
  }

  getEnforcementStrategy() {
    return {
      type: 'hooks',
      details: {
        sessionStart: '.claude/pilot/hooks/session-start.js',
        preToolUse: '.claude/pilot/hooks/pre-tool-use.js',
        postToolUse: '.claude/pilot/hooks/post-tool-use.js',
        userPromptSubmit: '.claude/pilot/hooks/user-prompt-submit.js'
      }
    };
  }

  buildCommand(opts) {
    const model = opts.model || 'claude-opus-4-6';
    return `claude -p "${opts.prompt}" --model ${model}`;
  }
}
```

**Files**: `lib/adapters/claude-adapter.js`
**Tests**: detect, spawn, inject, buildCommand

---

### Phase 6.3: Aider Adapter (OpenAI / GPT Models)

```javascript
// lib/adapters/aider-adapter.js

class AiderAdapter extends AgentAdapter {
  get name() { return 'aider'; }
  get displayName() { return 'Aider'; }

  async detect() {
    try {
      const { stdout } = await execFile('aider', ['--version']);
      return {
        available: true,
        version: stdout.trim(),
        path: await which('aider'),
        models: [
          { id: 'gpt-4.5', name: 'GPT-4.5', provider: 'openai', capabilities: ['general', 'testing', 'patterns'] },
          { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', capabilities: ['fast', 'balanced', 'multimodal'] },
          { id: 'o3-mini', name: 'o3-mini', provider: 'openai', capabilities: ['reasoning', 'math', 'logic'] },
          { id: 'deepseek-chat', name: 'DeepSeek V3', provider: 'deepseek', capabilities: ['bulk', 'cheap', 'code-gen'] },
        ]
      };
    } catch { return { available: false }; }
  }

  async spawn(opts) {
    const args = [
      '--message', opts.prompt,
      '--model', opts.model || 'gpt-4.5',
      '--yes-always',                   // Auto-accept edits (governance is external)
      '--no-auto-commits',              // We handle commits via policy
      '--no-suggest-shell-commands',    // Safety: no shell execution
    ];

    // Inject context via --read flag (read-only context files)
    if (opts.contextFile) {
      args.push('--read', opts.contextFile);
    }

    // Aider supports AIDER_MODEL env var as override
    const env = { ...process.env, ...opts.env };
    if (opts.model) env.AIDER_MODEL = opts.model;

    const proc = spawn('aider', args, {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return { pid: proc.pid, sessionId: opts.env.PILOT_SESSION_ID, process: proc };
  }

  async inject(sessionId, content) {
    // Aider accepts commands via stdin in chat mode
    const proc = this._getProcess(sessionId);
    if (proc && proc.stdin.writable) {
      proc.stdin.write(content + '\n');
      return true;
    }
    return false;
  }

  getEnforcementStrategy() {
    return {
      type: 'git-hooks',
      details: {
        // Aider doesn't have Claude-style hooks.
        // Enforce via:
        // 1. pre-commit git hook (block commits without task ID)
        // 2. File watcher (detect edits outside locked areas)
        // 3. Post-run validation (check output against plan)
        preCommit: '.git/hooks/pre-commit',       // Policy check
        fileWatcher: true,                          // Area lock enforcement
        postRun: true                               // Output validation
      }
    };
  }

  buildCommand(opts) {
    return `aider --message "${opts.prompt}" --model ${opts.model || 'gpt-4.5'} --yes-always --no-auto-commits`;
  }
}
```

**Files**: `lib/adapters/aider-adapter.js`
**Tests**: detect, spawn, inject, buildCommand, enforcement strategy

---

### Phase 6.4: OpenCode Adapter (Google / Gemini Models)

```javascript
// lib/adapters/opencode-adapter.js

class OpenCodeAdapter extends AgentAdapter {
  get name() { return 'opencode'; }
  get displayName() { return 'OpenCode'; }

  async detect() {
    try {
      const { stdout } = await execFile('opencode', ['--version']);
      return {
        available: true,
        version: stdout.trim(),
        path: await which('opencode'),
        models: [
          { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', capabilities: ['fast', 'ui', 'multimodal', 'large-context'] },
          { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', capabilities: ['very-fast', 'cheap', 'simple'] },
        ]
      };
    } catch { return { available: false }; }
  }

  async spawn(opts) {
    // OpenCode uses -m flag for non-interactive mode
    const args = ['-m', opts.prompt];
    if (opts.model) args.push('--model', opts.model);

    const env = { ...process.env, ...opts.env };

    const proc = spawn('opencode', args, {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return { pid: proc.pid, sessionId: opts.env.PILOT_SESSION_ID, process: proc };
  }

  getEnforcementStrategy() {
    return {
      type: 'wrapper',
      details: {
        // OpenCode supports MCP servers — can potentially load Pilot governance as MCP
        mcpServer: true,
        preCommit: '.git/hooks/pre-commit',
        fileWatcher: true,
        postRun: true
      }
    };
  }

  buildCommand(opts) {
    return `opencode -m "${opts.prompt}" --model ${opts.model || 'gemini-2.5-pro'}`;
  }
}
```

**Files**: `lib/adapters/opencode-adapter.js`
**Tests**: detect, spawn, buildCommand

---

### Phase 6.5: Codex CLI Adapter (OpenAI Codex)

```javascript
// lib/adapters/codex-adapter.js

class CodexAdapter extends AgentAdapter {
  get name() { return 'codex'; }
  get displayName() { return 'Codex CLI'; }

  async detect() {
    try {
      const { stdout } = await execFile('codex', ['--version']);
      return {
        available: true,
        version: stdout.trim(),
        path: await which('codex'),
        models: [
          { id: 'codex-mini', name: 'Codex Mini', provider: 'openai', capabilities: ['fast', 'code-gen', 'balanced'] },
          { id: 'o4-mini', name: 'o4-mini', provider: 'openai', capabilities: ['reasoning', 'general'] },
        ]
      };
    } catch { return { available: false }; }
  }

  async spawn(opts) {
    // Codex CLI uses positional argument for the prompt
    const args = [opts.prompt];
    if (opts.model) args.push('--model', opts.model);
    args.push('--approval-mode', 'full-auto'); // Governance is external
    args.push('--quiet');                       // Machine-friendly output

    const proc = spawn('codex', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return { pid: proc.pid, sessionId: opts.env.PILOT_SESSION_ID, process: proc };
  }

  getEnforcementStrategy() {
    return {
      type: 'wrapper',
      details: {
        // Codex runs in a sandbox by default.
        // Pilot adds: pre-commit hook, file watcher, post-run validation
        sandbox: true,
        preCommit: '.git/hooks/pre-commit',
        fileWatcher: true,
        postRun: true
      }
    };
  }

  buildCommand(opts) {
    return `codex "${opts.prompt}" --model ${opts.model || 'codex-mini'} --approval-mode full-auto --quiet`;
  }
}
```

**Files**: `lib/adapters/codex-adapter.js`
**Tests**: detect, spawn, buildCommand

---

### Phase 6.6: Ollama Adapter (Local Open-Source Models)

**The free tier** — run models locally with zero API costs. Perfect for documentation, simple refactors, and cost-conscious tasks.

```javascript
// lib/adapters/ollama-adapter.js

class OllamaAdapter extends AgentAdapter {
  get name() { return 'ollama'; }
  get displayName() { return 'Ollama (Local)'; }

  async detect() {
    try {
      const { stdout } = await execFile('ollama', ['list']);
      const models = this._parseOllamaList(stdout);
      return {
        available: true,
        version: 'local',
        path: await which('ollama'),
        models: models.map(m => ({
          id: `ollama:${m.name}`,
          name: m.name,
          provider: 'local',
          capabilities: this._inferCapabilities(m.name),
          size: m.size,
          costPerToken: 0 // Free!
        }))
      };
    } catch { return { available: false }; }
  }

  async spawn(opts) {
    // Ollama doesn't have a native coding CLI.
    // We wrap it: pipe prompt to ollama run, capture output, apply as patch.
    // Use the pilot-ollama-wrapper script that:
    //   1. Reads the task context
    //   2. Sends to ollama via API
    //   3. Parses code blocks from response
    //   4. Applies changes via git apply or direct write
    //   5. Reports status to shared state

    const wrapperPath = path.join(__dirname, '..', 'scripts', 'ollama-agent-wrapper.js');
    const args = [wrapperPath, '--model', opts.model, '--task', opts.contextFile];

    const proc = spawn('node', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return { pid: proc.pid, sessionId: opts.env.PILOT_SESSION_ID, process: proc };
  }

  getEnforcementStrategy() {
    return {
      type: 'wrapper',
      details: {
        // Full control via wrapper script — all enforcement built in
        wrapperScript: 'scripts/ollama-agent-wrapper.js',
        preCommit: '.git/hooks/pre-commit',
        fullControl: true
      }
    };
  }

  _inferCapabilities(modelName) {
    const name = modelName.toLowerCase();
    if (name.includes('coder') || name.includes('deepseek')) return ['code-gen', 'bulk', 'cheap'];
    if (name.includes('llama')) return ['general', 'docs', 'simple'];
    if (name.includes('qwen')) return ['code-gen', 'general'];
    if (name.includes('mistral')) return ['general', 'fast'];
    return ['general'];
  }

  _parseOllamaList(stdout) {
    // Parse `ollama list` output into model objects
    return stdout.split('\n').slice(1).filter(Boolean).map(line => {
      const [name, , size] = line.trim().split(/\s+/);
      return { name, size };
    });
  }

  buildCommand(opts) {
    return `node scripts/ollama-agent-wrapper.js --model ${opts.model} --task ${opts.contextFile}`;
  }
}
```

#### Ollama Agent Wrapper

Since Ollama doesn't have a native coding agent CLI, we provide a lightweight Node.js wrapper that:

1. Reads the task context capsule
2. Constructs a coding-focused system prompt
3. Calls Ollama's HTTP API (`localhost:11434/api/generate`)
4. Parses code blocks from the response
5. Applies changes to files (with diff validation)
6. Reports status to Pilot AGI shared state
7. Loops for multi-step tasks (plan step by step)

```javascript
// scripts/ollama-agent-wrapper.js (simplified)

const SYSTEM_PROMPT = `You are a coding agent. You will receive a task with context.
Respond with file changes in this exact format:

--- FILE: path/to/file.js ---
<complete file content>
--- END FILE ---

Only output files that need changes. Follow the plan exactly.`;

async function run(model, contextFile) {
  const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  const prompt = `${SYSTEM_PROMPT}\n\nTask: ${context.task}\nPlan Step: ${context.currentStep}\n\nContext:\n${context.relevantCode}`;

  const response = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    body: JSON.stringify({ model, prompt, stream: false })
  });

  const { response: text } = await response.json();
  const files = parseFileBlocks(text);

  for (const { path, content } of files) {
    fs.writeFileSync(path, content);
    console.log(`Updated: ${path}`);
  }

  // Report completion to shared state
  updateSharedState(context.sessionId, { status: 'step_complete', step: context.currentStep });
}
```

**Files**: `lib/adapters/ollama-adapter.js`, `scripts/ollama-agent-wrapper.js`
**Tests**: detect, spawn, wrapper output parsing

---

### Phase 6.7: Universal Enforcement Layer

**Problem**: Claude Code has hooks. Other CLIs don't. Need enforcement that works for any agent.

#### Enforcement Strategies

```
┌─────────────────────────────────────────────────────────┐
│              ENFORCEMENT STRATEGIES                      │
│                                                          │
│  Claude Code:   Native hooks (session-start, pre-tool,  │
│                 post-tool, user-prompt) — richest        │
│                                                          │
│  Aider/Codex:   Git hooks + file watcher + post-run     │
│                 validation — good enough                  │
│                                                          │
│  OpenCode:      MCP server + git hooks — medium          │
│                                                          │
│  Ollama:        Wrapper controls everything — full        │
│                                                          │
│  All agents:    Pre-commit hook (universal baseline)     │
└─────────────────────────────────────────────────────────┘
```

#### Universal Pre-Commit Hook

Regardless of the agent CLI, every agent operates in a git worktree. The pre-commit hook enforces policies universally:

```javascript
// lib/enforcement/universal-pre-commit.js

/**
 * Universal pre-commit hook that works for ALL agent types.
 * Installed in each agent's worktree .git/hooks/pre-commit
 */
function preCommitCheck() {
  const sessionId = process.env.PILOT_SESSION_ID;
  const taskId = process.env.PILOT_TASK_ID;

  // 1. Must have active task
  if (!taskId) {
    console.error('BLOCKED: No active task. All commits must reference a task.');
    process.exit(1);
  }

  // 2. Must have approved plan (if policy requires it)
  const policy = loadPolicy();
  if (policy.require_plan_approval) {
    const approvalFile = `.claude/pilot/state/approved-plans/${taskId}.json`;
    if (!fs.existsSync(approvalFile)) {
      console.error('BLOCKED: No approved plan for this task.');
      process.exit(1);
    }
  }

  // 3. Area lock check — no editing files outside locked area
  const lockedAreas = getLockedAreas(sessionId);
  const stagedFiles = getStagedFiles();
  const violations = stagedFiles.filter(f => !isInLockedArea(f, lockedAreas));
  if (violations.length > 0) {
    console.error(`BLOCKED: Editing files outside locked area: ${violations.join(', ')}`);
    process.exit(1);
  }

  // 4. Design token enforcement (if applicable)
  if (policy.enforce_design_tokens) {
    const tokenViolations = checkDesignTokens(stagedFiles);
    if (tokenViolations.length > 0) {
      console.error(`BLOCKED: Hardcoded values found. Use design tokens:\n${tokenViolations.join('\n')}`);
      process.exit(1);
    }
  }

  // 5. Commit message format check
  // (delegated to commit-msg hook)

  // 6. Budget check
  const budget = checkBudget(taskId, sessionId);
  if (budget.exceeded) {
    console.error(`BLOCKED: Token budget exceeded. Used: ${budget.used}, Limit: ${budget.limit}`);
    process.exit(1);
  }

  console.log('Pre-commit checks passed.');
}
```

#### File Watcher for Non-Hook Agents

For agents without native hooks (Aider, Codex, Ollama), a lightweight file watcher monitors edits in real-time:

```javascript
// lib/enforcement/file-watcher.js

class AgentFileWatcher {
  constructor(worktreePath, sessionId, policy) {
    this.path = worktreePath;
    this.sessionId = sessionId;
    this.policy = policy;
    this.watcher = null;
  }

  start() {
    this.watcher = fs.watch(this.path, { recursive: true }, (event, filename) => {
      if (this._shouldIgnore(filename)) return;

      // Check area lock
      const locked = getLockedAreas(this.sessionId);
      if (!isInLockedArea(filename, locked)) {
        this._reportViolation('area_lock', filename);
      }

      // Track file for cost estimation
      this._trackFileChange(filename);
    });
  }

  _shouldIgnore(filename) {
    return filename.startsWith('.git/') ||
           filename.startsWith('node_modules/') ||
           filename.startsWith('.claude/pilot/state/');
  }

  _reportViolation(type, filename) {
    // Write violation to shared state for PM to pick up
    const violation = { type, filename, sessionId: this.sessionId, timestamp: Date.now() };
    appendJsonl('.claude/pilot/state/violations.jsonl', violation);
  }

  stop() {
    if (this.watcher) this.watcher.close();
  }
}
```

**Files**: `lib/enforcement/universal-pre-commit.js`, `lib/enforcement/file-watcher.js`, `lib/enforcement/post-run-validator.js`
**Tests**: pre-commit policy checks, area lock enforcement, file watcher detection

---

## Stream B: Terminal Orchestration

Physical terminal control — PM opens/closes/monitors terminal tabs. Essential for visual multi-LLM management.

*Note: This stream absorbs the original M6 spec (`m6-physical-terminal-control.md`). The architecture is identical but now supports any agent CLI, not just Claude Code.*

### Phase 6.8: Terminal Provider Abstraction

**Same as original Phase 6.1** — TerminalProvider interface and registry.

Provider interface: `open()`, `sendCommand()`, `readOutput()`, `split()`, `close()`, `list()`, `isAlive()`

Provider priority: iTerm2 Python API > iTerm2 AppleScript > Terminal.app AppleScript > Headless (no terminal)

**Files**: `lib/terminal-provider.js`, `lib/terminal-registry.js`
**Tests**: provider interface, registry detection

---

### Phase 6.9: AppleScript + iTerm2 Providers

**Same as original Phases 6.2 + 6.3** — Terminal.app via AppleScript/JXA, iTerm2 via AppleScript, iTerm2 via Python API bridge.

Key addition: **each terminal tab is labeled with the agent CLI name + model**:

```
Tab titles:
  [Claude Opus] Backend API auth     ← Claude Code running Opus
  [GPT-4.5] Auth unit tests          ← Aider running GPT-4.5
  [Gemini 2.5] Login component       ← OpenCode running Gemini
  [Llama 3.3] API documentation      ← Ollama running Llama (free)
  PM Dashboard                       ← Live status
```

**Files**: `lib/providers/terminal-applescript.js`, `lib/providers/iterm2-applescript.js`, `lib/providers/iterm2-python.js`, `scripts/iterm2-bridge.py`
**Tests**: open/close/read for each provider, tab labeling

---

### Phase 6.10: Terminal-Aware Multi-LLM Spawner

Extends the process spawner to route through both the agent adapter AND the terminal provider:

```
PM Daemon
  ↓
Scheduler picks: task X → model: gpt-4.5 → adapter: aider
  ↓
Adapter builds command: `aider --message "..." --model gpt-4.5 --yes-always`
  ↓
Terminal provider opens tab: title "[GPT-4.5] Task X", runs command
  ↓
File watcher + pre-commit hook enforce governance
  ↓
Terminal monitor reads output, detects patterns
```

```javascript
// Modified pm-daemon.js._spawnAgent()

async _spawnAgent(taskId, assignment) {
  const { modelId, adapterId } = assignment;

  // 1. Get adapter for this model
  const adapter = this.adapterRegistry.get(adapterId);
  if (!adapter) throw new Error(`Adapter ${adapterId} not available`);

  // 2. Build context capsule
  const contextFile = await this.contextBuilder.build(taskId, {
    research: true, checkpoint: true, plan: true, artifacts: true
  });

  // 3. Build environment
  const env = {
    PILOT_SESSION_ID: generateSessionId(),
    PILOT_TASK_ID: taskId,
    PILOT_MODEL: modelId,
    PILOT_ADAPTER: adapterId,
    PILOT_CONTEXT_FILE: contextFile,
  };

  // 4. Build command via adapter
  const command = adapter.buildCommand({
    prompt: await this.contextBuilder.buildPrompt(taskId),
    model: modelId,
    contextFile,
    cwd: worktreePath,
  });

  // 5. Spawn into terminal (or headless)
  const termConfig = this.policy.terminal || {};
  if (termConfig.enabled && this.terminalRegistry.getProvider()) {
    const provider = this.terminalRegistry.getProvider();
    const result = await provider.open({
      command,
      title: `[${this._modelShortName(modelId)}] ${taskTitle}`,
      cwd: worktreePath,
      env,
      target: termConfig.spawn_mode || 'tab'
    });

    // 6. Start enforcement for non-Claude agents
    if (adapterId !== 'claude') {
      await this._startExternalEnforcement(taskId, env.PILOT_SESSION_ID, worktreePath);
    }

    // 7. Start terminal monitoring
    this.terminalMonitor.watch(taskId, result.terminalId, DEFAULT_PATTERNS, this._onTerminalEvent.bind(this));

    return result;
  } else {
    // Headless spawn (existing behavior)
    return adapter.spawn({ prompt, model: modelId, cwd: worktreePath, env, contextFile });
  }
}
```

**Files**: modified `lib/pm-daemon.js`, modified `lib/process-spawner.js`, `lib/terminal-layout.js`
**Tests**: multi-adapter spawn routing, terminal labeling, enforcement startup

---

## Stream C: Model-Aware Intelligence

The scheduler and cost system learn to pick the best model for each task.

### Phase 6.11: Model Capability Registry

A structured registry of what each model is good at, how fast it is, and how much it costs.

```javascript
// lib/model-registry.js

const MODEL_PROFILES = {
  'claude-opus-4-6': {
    provider: 'anthropic',
    adapter: 'claude',
    strengths: ['complex-reasoning', 'architecture', 'refactoring', 'security', 'code-review'],
    weaknesses: ['slow', 'expensive'],
    speed: 0.3,          // Relative: 0=slowest, 1=fastest
    cost: {
      input: 15.0,       // $ per 1M tokens
      output: 75.0,
    },
    contextWindow: 200000,
    bestFor: ['backend-architecture', 'security-review', 'complex-refactor', 'merge-review'],
  },

  'claude-sonnet-4-5': {
    provider: 'anthropic',
    adapter: 'claude',
    strengths: ['general', 'balanced', 'coding', 'fast-enough'],
    weaknesses: [],
    speed: 0.6,
    cost: { input: 3.0, output: 15.0 },
    contextWindow: 200000,
    bestFor: ['general-coding', 'feature-implementation', 'bug-fixes'],
  },

  'claude-haiku-4-5': {
    provider: 'anthropic',
    adapter: 'claude',
    strengths: ['very-fast', 'very-cheap', 'good-enough'],
    weaknesses: ['limited-reasoning'],
    speed: 0.9,
    cost: { input: 0.80, output: 4.0 },
    contextWindow: 200000,
    bestFor: ['documentation', 'simple-refactors', 'formatting', 'comments'],
  },

  'gpt-4.5': {
    provider: 'openai',
    adapter: 'aider',
    strengths: ['test-generation', 'patterns', 'general'],
    weaknesses: ['context-window'],
    speed: 0.5,
    cost: { input: 2.0, output: 10.0 },
    contextWindow: 128000,
    bestFor: ['test-generation', 'unit-tests', 'integration-tests'],
  },

  'gemini-2.5-pro': {
    provider: 'google',
    adapter: 'opencode',
    strengths: ['fast', 'large-context', 'ui', 'multimodal'],
    weaknesses: ['less-precise-edits'],
    speed: 0.8,
    cost: { input: 1.25, output: 10.0 },
    contextWindow: 1000000,
    bestFor: ['frontend-ui', 'css', 'react-components', 'rapid-iteration'],
  },

  'gemini-2.5-flash': {
    provider: 'google',
    adapter: 'opencode',
    strengths: ['very-fast', 'cheap', 'good-enough'],
    weaknesses: ['quality-ceiling'],
    speed: 0.95,
    cost: { input: 0.15, output: 0.60 },
    contextWindow: 1000000,
    bestFor: ['simple-tasks', 'bulk-changes', 'formatting'],
  },

  'ollama:deepseek-coder-v3': {
    provider: 'local',
    adapter: 'ollama',
    strengths: ['free', 'private', 'code-focused'],
    weaknesses: ['slower-local', 'less-capable'],
    speed: 0.2,  // Depends on hardware
    cost: { input: 0, output: 0 },
    contextWindow: 128000,
    bestFor: ['documentation', 'simple-refactors', 'private-code'],
  },

  'ollama:llama-3.3-70b': {
    provider: 'local',
    adapter: 'ollama',
    strengths: ['free', 'private', 'general'],
    weaknesses: ['slower-local', 'large-model'],
    speed: 0.15,
    cost: { input: 0, output: 0 },
    contextWindow: 128000,
    bestFor: ['documentation', 'readme', 'comments', 'private-code'],
  },
};
```

**Files**: `lib/model-registry.js`
**Tests**: model lookup, capability matching

---

### Phase 6.12: Model-Aware Task Scheduler

Extends the existing scheduler (M3.4) to factor in model selection.

#### Scoring Algorithm

The existing scheduler scores agents by: skill (55%), load (20%), affinity (15%), cost (10%).

The new scheduler adds a **model selection step** before agent assignment:

```
1. Task arrives: "Write unit tests for auth module"
2. Task analysis:
   - Type: test-generation
   - Complexity: medium
   - Risk: low (tests, not production code)
   - Files: src/auth/*.js, tests/auth/*.test.js
3. Model scoring:
   - claude-opus-4-6:  capability=0.7, cost=0.2, speed=0.3 → score: 0.45
   - gpt-4.5:          capability=0.9, cost=0.6, speed=0.5 → score: 0.72  ← BEST
   - gemini-2.5-pro:   capability=0.6, cost=0.7, speed=0.8 → score: 0.68
   - ollama:deepseek:  capability=0.4, cost=1.0, speed=0.2 → score: 0.48
4. Selected: gpt-4.5 via Aider adapter
5. Agent assignment: spawn Aider terminal with GPT-4.5
```

```javascript
// lib/model-scheduler.js

class ModelScheduler {
  constructor(modelRegistry, policy) {
    this.models = modelRegistry;
    this.policy = policy;
    this.weights = policy.scheduling?.model_weights || {
      capability: 0.40,   // How good is this model at this task type?
      cost: 0.30,         // How cheap is it? (inverted: cheaper = higher score)
      speed: 0.20,        // How fast is it?
      reliability: 0.10,  // Historical success rate for this task type
    };
  }

  /**
   * Score all available models for a task and return ranked list.
   * @param {object} task - Task with type, complexity, risk, files
   * @param {string[]} availableAdapters - Names of available adapters
   * @returns {Array<{ modelId, adapterId, score, breakdown }>}
   */
  scoreModels(task, availableAdapters) {
    const candidates = [];

    for (const [modelId, profile] of Object.entries(MODEL_PROFILES)) {
      // Skip if adapter not available
      if (!availableAdapters.includes(profile.adapter)) continue;

      // Skip if model exceeds task budget
      if (task.budget && this._estimateCost(profile, task) > task.budget) continue;

      const capability = this._scoreCapability(profile, task);
      const cost = this._scoreCost(profile, task);
      const speed = this._scoreSpeed(profile, task);
      const reliability = this._scoreReliability(modelId, task.type);

      const score =
        capability * this.weights.capability +
        cost * this.weights.cost +
        speed * this.weights.speed +
        reliability * this.weights.reliability;

      candidates.push({
        modelId,
        adapterId: profile.adapter,
        score,
        breakdown: { capability, cost, speed, reliability },
        estimatedCost: this._estimateCost(profile, task),
      });
    }

    return candidates.sort((a, b) => b.score - a.score);
  }

  _scoreCapability(profile, task) {
    // Check if task type matches model's bestFor list
    const matchScore = profile.bestFor.some(b => task.type.includes(b)) ? 1.0 : 0;
    const strengthScore = profile.strengths.filter(s => task.requirements?.includes(s)).length / Math.max(task.requirements?.length || 1, 1);
    return matchScore * 0.6 + strengthScore * 0.4;
  }

  _scoreCost(profile, task) {
    // Normalize: free = 1.0, most expensive = 0.0
    const maxCost = 75.0; // Claude Opus output price as ceiling
    const modelCost = profile.cost.output;
    return 1 - (modelCost / maxCost);
  }

  _scoreSpeed(profile, task) {
    // Simple tasks benefit more from speed
    const speedWeight = task.complexity === 'simple' ? 1.5 : 1.0;
    return Math.min(profile.speed * speedWeight, 1.0);
  }

  _scoreReliability(modelId, taskType) {
    // Read historical outcomes for this model + task type
    const history = this._readHistory(modelId, taskType);
    if (history.total === 0) return 0.5; // Unknown = neutral
    return history.success / history.total;
  }

  _estimateCost(profile, task) {
    // Rough estimate: avg task ~50K input tokens, ~20K output tokens
    const inputTokens = task.estimatedTokens?.input || 50000;
    const outputTokens = task.estimatedTokens?.output || 20000;
    return (inputTokens * profile.cost.input / 1000000) +
           (outputTokens * profile.cost.output / 1000000);
  }
}
```

#### Policy Configuration

```yaml
# policy.yaml additions

models:
  default: claude-sonnet-4-5          # Fallback model
  preferences:
    backend:        claude-opus-4-6    # Complex backend → Opus
    frontend:       gemini-2.5-pro     # Fast UI → Gemini
    testing:        gpt-4.5            # Tests → GPT
    documentation:  ollama:llama-3.3-70b  # Docs → free local model
    simple:         gemini-2.5-flash   # Simple tasks → cheapest
    security:       claude-opus-4-6    # Security-sensitive → best reasoning

  # Override: force specific model for all tasks (useful for testing)
  force_model: null                    # Set to model ID to force

  scheduling:
    model_weights:
      capability: 0.40
      cost: 0.30
      speed: 0.20
      reliability: 0.10

  # Budget per model provider per day
  provider_budgets:
    anthropic: 50.00      # $50/day for Claude models
    openai: 30.00         # $30/day for GPT models
    google: 20.00         # $20/day for Gemini models
    local: null            # No limit for local models
```

**Files**: `lib/model-scheduler.js`, modified `lib/scheduler.js`
**Tests**: model scoring, budget filtering, preference override, historical learning

---

### Phase 6.13: Cross-Model Cost Normalization

Different models have different pricing. The cost tracker needs to normalize everything to a common unit.

```javascript
// lib/cost-normalizer.js

class CostNormalizer {
  constructor(modelRegistry) {
    this.models = modelRegistry;
  }

  /**
   * Calculate actual cost for a task execution.
   * @param {string} modelId
   * @param {object} usage - { inputTokens, outputTokens }
   * @returns {{ dollars: number, normalizedTokens: number }}
   */
  calculateCost(modelId, usage) {
    const profile = this.models[modelId];
    if (!profile) return { dollars: 0, normalizedTokens: 0 };

    const dollars =
      (usage.inputTokens * profile.cost.input / 1000000) +
      (usage.outputTokens * profile.cost.output / 1000000);

    // Normalize to "Claude Sonnet equivalent tokens" for fair comparison
    // This allows comparing cost-efficiency across models
    const sonnetRate = 15.0; // Sonnet output rate per 1M
    const normalizedTokens = (dollars / sonnetRate) * 1000000;

    return { dollars, normalizedTokens };
  }

  /**
   * Get cost-per-line-of-code for a model on a completed task.
   * Used for efficiency comparison and learning.
   */
  costPerLine(modelId, usage, linesChanged) {
    const { dollars } = this.calculateCost(modelId, usage);
    return linesChanged > 0 ? dollars / linesChanged : 0;
  }

  /**
   * Generate daily cost report broken down by provider.
   */
  async getDailyReport() {
    const today = new Date().toISOString().split('T')[0];
    const costs = await this._readDailyCosts(today);

    const byProvider = {};
    for (const entry of costs) {
      const provider = this.models[entry.modelId]?.provider || 'unknown';
      if (!byProvider[provider]) byProvider[provider] = { dollars: 0, tasks: 0, tokens: 0 };
      byProvider[provider].dollars += entry.dollars;
      byProvider[provider].tasks += 1;
      byProvider[provider].tokens += entry.inputTokens + entry.outputTokens;
    }

    return {
      date: today,
      total: Object.values(byProvider).reduce((sum, p) => sum + p.dollars, 0),
      byProvider,
      savings: this._calculateSavings(costs), // How much saved vs using Opus for everything
    };
  }

  _calculateSavings(costs) {
    // Calculate what it would have cost if all tasks used Claude Opus
    const opusProfile = this.models['claude-opus-4-6'];
    let opusCost = 0;
    let actualCost = 0;

    for (const entry of costs) {
      opusCost += (entry.inputTokens * opusProfile.cost.input / 1000000) +
                  (entry.outputTokens * opusProfile.cost.output / 1000000);
      actualCost += entry.dollars;
    }

    return {
      opusEquivalent: opusCost,
      actual: actualCost,
      saved: opusCost - actualCost,
      percentSaved: opusCost > 0 ? ((opusCost - actualCost) / opusCost * 100).toFixed(1) : 0,
    };
  }
}
```

**Files**: `lib/cost-normalizer.js`, modified `lib/cost-tracker.js`
**Tests**: cost calculation, normalization, savings report

---

## Stream D: Remote Human Interface (Telegram)

Control your multi-model AI team from your phone.

### Phase 6.14: Telegram Bot Interface

**Same as original Phase 6.6** — Telegram bot with commands and inline approval buttons.

Additions for multi-LLM:

```
New commands:
  /models     - Show available models and their status
  /assign     - Override model assignment: "/assign Pilot AGI-xyz claude-opus-4-6"
  /savings    - Show cost savings from smart model routing
  /providers  - Show provider budget usage

New notifications:
  "Model switch: Task X switching from GPT-4.5 to Claude Opus (retry after failure)"
  "Savings today: $12.40 saved by routing 8 tasks to cheaper models"
  "Provider budget alert: OpenAI at 80% ($24/$30)"
```

**Files**: `lib/telegram-bot.js`
**Tests**: commands, notifications, authorization

---

### Phase 6.15: Telegram Approval & Conversations

**Same as original Phase 6.6 approval section** — inline approve/reject buttons, timeout escalation, morning reports.

Additions:

```
Morning report example:
──────────────────────────────
PILOT AGI — Morning Report
Date: 2026-02-12

Tasks completed: 14/16
Tasks failed: 1 (retry queued)
Tasks blocked: 1 (waiting for human decision)

Model Usage:
  Claude Opus:  3 tasks  $8.40
  GPT-4.5:      5 tasks  $4.20
  Gemini 2.5:   4 tasks  $1.80
  Llama (local): 2 tasks  $0.00
  TOTAL:        14 tasks $14.40

vs All-Opus: $52.30 (saved 72.5%!)

Top commits:
  feat(auth): JWT middleware [Pilot AGI-abc]
  test(auth): 94% coverage [Pilot AGI-def]
  feat(ui): Login component [Pilot AGI-ghi]

Needs attention:
  [Pilot AGI-jkl] Merge conflict in shared/types.ts
  → [Approve auto-resolve] [Review manually]
──────────────────────────────
```

**Files**: modified `lib/telegram-bot.js`
**Tests**: morning report formatting, approval flow

---

## Stream E: Integration & Quality

### Phase 6.16: PM Dashboard with Multi-Model View

Live terminal dashboard showing all agents with their model assignments:

```
┌─────────────────────────────────────────────────────────────────────┐
│ PILOT AGI — Multi-LLM Dashboard                        02/12 07:15 │
├─────────────────────────────────────────────────────────────────────┤
│ AGENTS                                                              │
│ Agent        Model           Task                   CTX    $Cost   │
│ ──────────── ─────────────── ───────────────────── ────── ─────── │
│ backend-1    Claude Opus     Auth middleware         42%   $2.10   │
│ testing-1    GPT-4.5         Auth unit tests         31%   $0.80   │
│ frontend-1   Gemini 2.5 Pro  Login component         55%   $0.45   │
│ docs-1       Llama 3.3 (L)   API documentation       -     FREE    │
│ backend-2    Claude Sonnet   User CRUD endpoints     28%   $0.60   │
├─────────────────────────────────────────────────────────────────────┤
│ QUEUE: 5 ready | 2 blocked | 1 in review                           │
│ BUDGET: $4.95/$50 today | Savings: $14.20 vs all-Opus (74%)       │
│ PROVIDERS: Anthropic $2.70/$50 | OpenAI $0.80/$30 | Google $0.45/$20│
│ ESCALATIONS: 1 pending (merge conflict, sent to Telegram)          │
├─────────────────────────────────────────────────────────────────────┤
│ RECENT                                                              │
│ 07:14 [GPT-4.5] testing-1 generated 12 tests, all passing         │
│ 07:13 [Opus] backend-1 checkpoint at 42% — continuing              │
│ 07:12 [Gemini] frontend-1 hot-reloading component                  │
│ 07:10 Scheduler: docs task → Llama 3.3 (free, sufficient quality) │
└─────────────────────────────────────────────────────────────────────┘
```

**Files**: `lib/pm-dashboard-terminal.js`, `scripts/pm-dashboard-live.js`
**Tests**: dashboard rendering, model display

---

### Phase 6.17: macOS Permission Setup

**Same as original Phase 6.8** — permission check for Automation and Accessibility.

**Files**: `lib/permission-check.js`
**Tests**: permission detection, instruction generation

---

### Phase 6.18: End-to-End Integration Testing

Full integration tests covering:

1. **Multi-adapter spawn**: PM spawns Claude + Aider + OpenCode in parallel on same project
2. **Shared state**: Agent A (Claude) publishes to memory channel, Agent B (GPT via Aider) reads it
3. **Cross-model artifacts**: Task A (Gemini) produces API types, Task B (Claude) consumes them
4. **Enforcement**: Non-Claude agent blocked by pre-commit hook when editing locked area
5. **Model failover**: If Aider fails, PM re-queues task and selects Claude as fallback
6. **Cost tracking**: All agents report costs, normalized to common unit, savings calculated
7. **Terminal visibility**: 4 agents in 4 terminal tabs, each labeled with model name
8. **Telegram flow**: Escalation → Telegram → approve → agent continues
9. **Overnight multi-model**: Queue 12 tasks → smart model routing → morning report with per-model breakdown

**Files**: `tests/integration/multi-llm.test.js`, `tests/integration/terminal-multi-model.test.js`
**Tests**: comprehensive E2E scenarios

---

## Dependencies

```
Wave 1 (Independent — no dependencies):
  6.1   Agent Adapter Interface & Registry
  6.8   Terminal Provider Abstraction
  6.11  Model Capability Registry
  6.14  Telegram Bot Interface
  6.17  macOS Permission Setup

Wave 2 (needs Wave 1):
  6.2   Claude Adapter (needs 6.1)
  6.3   Aider Adapter (needs 6.1)
  6.4   OpenCode Adapter (needs 6.1)
  6.5   Codex CLI Adapter (needs 6.1)
  6.6   Ollama Adapter (needs 6.1)
  6.9   AppleScript + iTerm2 Providers (needs 6.8)
  6.15  Telegram Approval & Conversations (needs 6.14)

Wave 3 (needs Wave 2):
  6.7   Universal Enforcement Layer (needs 6.2-6.6)
  6.10  Terminal-Aware Multi-LLM Spawner (needs 6.1-6.6 + 6.8-6.9)
  6.12  Model-Aware Task Scheduler (needs 6.11 + 6.1)
  6.13  Cross-Model Cost Normalization (needs 6.11)

Wave 4 (needs Wave 3):
  6.16  PM Dashboard with Multi-Model View (needs 6.10 + 6.13)
  6.18  End-to-End Integration Testing (needs all above)
```

## New Files

| File | Purpose |
|------|---------|
| `lib/agent-adapter.js` | Abstract adapter interface |
| `lib/agent-registry.js` | Adapter detection and registration |
| `lib/adapters/claude-adapter.js` | Claude Code adapter |
| `lib/adapters/aider-adapter.js` | Aider adapter (OpenAI/DeepSeek) |
| `lib/adapters/opencode-adapter.js` | OpenCode adapter (Google) |
| `lib/adapters/codex-adapter.js` | Codex CLI adapter |
| `lib/adapters/ollama-adapter.js` | Ollama local model adapter |
| `scripts/ollama-agent-wrapper.js` | Wrapper for non-CLI Ollama agent |
| `lib/model-registry.js` | Model profiles and capabilities |
| `lib/model-scheduler.js` | Model-aware task scheduling |
| `lib/cost-normalizer.js` | Cross-model cost normalization |
| `lib/enforcement/universal-pre-commit.js` | Universal git hook enforcement |
| `lib/enforcement/file-watcher.js` | Real-time file edit monitoring |
| `lib/enforcement/post-run-validator.js` | Post-execution validation |
| `lib/terminal-provider.js` | Terminal provider interface |
| `lib/terminal-registry.js` | Terminal detection and registration |
| `lib/providers/terminal-applescript.js` | Terminal.app via AppleScript |
| `lib/providers/iterm2-applescript.js` | iTerm2 via AppleScript |
| `lib/providers/iterm2-python.js` | iTerm2 via Python API bridge |
| `scripts/iterm2-bridge.py` | Python bridge for iTerm2 API |
| `lib/terminal-layout.js` | Auto-arrange agent terminals |
| `lib/terminal-monitor.js` | Watch terminal output for patterns |
| `lib/telegram-bot.js` | Telegram bot for remote control |
| `lib/pm-dashboard-terminal.js` | Live multi-model dashboard |
| `scripts/pm-dashboard-live.js` | Dashboard rendering script |
| `lib/permission-check.js` | macOS permission verification |

## Modified Files

| File | Change |
|------|--------|
| `lib/pm-daemon.js` | Adapter registry init, multi-model spawning, terminal integration, Telegram startup |
| `lib/process-spawner.js` | Route through adapters instead of hardcoded `claude -p` |
| `lib/scheduler.js` | Integrate model-aware scoring |
| `lib/cost-tracker.js` | Multi-provider cost tracking |
| `lib/escalation.js` | Route to Telegram, model failover events |
| `lib/pm-loop.js` | Add terminal monitoring scan, model health checks |
| `policy.yaml` | Add `models`, `terminal`, `telegram` sections |

## Policy Configuration (Complete)

```yaml
# policy.yaml additions for M6

# --- Multi-LLM Model Configuration ---
models:
  default: claude-sonnet-4-5
  force_model: null                  # Set to override all scheduling

  preferences:
    backend:        claude-opus-4-6
    frontend:       gemini-2.5-pro
    testing:        gpt-4.5
    documentation:  ollama:llama-3.3-70b
    simple:         gemini-2.5-flash
    security:       claude-opus-4-6
    code-review:    claude-opus-4-6

  scheduling:
    model_weights:
      capability: 0.40
      cost: 0.30
      speed: 0.20
      reliability: 0.10

  provider_budgets:
    anthropic: 50.00
    openai: 30.00
    google: 20.00
    local: null

  failover:
    enabled: true
    max_retries: 2
    fallback_model: claude-sonnet-4-5

# --- Terminal Orchestration ---
terminal:
  enabled: false
  provider: auto
  spawn_mode: tab
  layout: grid
  max_visible: 6
  show_pm_dashboard: true
  monitor:
    enabled: true
    poll_interval_ms: 5000

# --- Telegram Remote Interface ---
telegram:
  enabled: false
  allowed_chat_ids: []
  mode: polling
  notifications:
    escalations: true
    task_complete: true
    errors: true
    morning_report: true
    morning_report_time: "08:00"
    model_switches: true
    savings_report: true
  approval:
    enabled: true
    timeout_minutes: 60
```

## Success Criteria

### Multi-LLM Core
- [ ] PM Daemon detects all installed agent CLIs on startup (Claude, Aider, OpenCode, Codex, Ollama)
- [ ] Adapter interface implemented for 5+ agent CLIs
- [ ] Scheduler routes tasks to best model based on capability, cost, speed, reliability
- [ ] Policy preferences respected: backend→Opus, frontend→Gemini, tests→GPT, docs→Llama
- [ ] Agent spawned via Aider (GPT) can read shared memory written by Claude agent
- [ ] Artifact contracts work across different model agents
- [ ] Model failover: if primary model fails, task retried with fallback model
- [ ] `force_model` policy override works for all tasks

### Governance Across Models
- [ ] Universal pre-commit hook blocks non-Claude agents from editing locked areas
- [ ] File watcher detects unauthorized edits in real-time for non-Claude agents
- [ ] Budget enforcement per provider: Anthropic $50/day, OpenAI $30/day, Google $20/day
- [ ] Cost normalization: all models report in common unit for fair comparison
- [ ] Escalation engine works for all agent types (not just Claude)

### Terminal Visibility
- [ ] Each agent runs in a visible terminal tab with model label
- [ ] iTerm2 users get split panes; Terminal.app users get tabs
- [ ] PM Dashboard shows all agents with model names and per-model costs
- [ ] Terminal monitor detects errors, completions, checkpoints across all agents

### Remote Control
- [ ] Telegram `/status` shows multi-model agent status
- [ ] Telegram `/models` shows available models and usage
- [ ] Telegram `/savings` shows cost optimization report
- [ ] Morning report includes per-model cost breakdown and savings vs all-Opus
- [ ] Inline approve/reject works for all agent types

### Cost Efficiency
- [ ] Smart routing saves 50%+ vs using Claude Opus for everything
- [ ] Local Ollama models used for zero-cost documentation tasks
- [ ] Daily savings report shows exact dollar amount saved
- [ ] Historical learning improves model selection over 20+ tasks

### Backward Compatibility
- [ ] Existing headless `claude -p` mode works when terminal.enabled=false
- [ ] Single-model users (Claude only) see zero changes in behavior
- [ ] All existing tests pass without modification
- [ ] policy.yaml without `models` section defaults to current behavior

## What This Changes vs M5

| M5 (Current) | M6 (New) |
|---|---|
| Claude Code only | Claude + GPT + Gemini + Codex + Ollama + any future CLI |
| Single model per session | Best model per task (automatic routing) |
| Flat cost tracking | Per-provider budgets, cross-model normalization, savings |
| Invisible background processes | Visible terminal tabs with model labels |
| CLI-only interaction | Telegram bot for remote control |
| Claude hooks for governance | Universal enforcement (hooks + git hooks + file watchers) |
| One adapter (hardcoded) | Pluggable adapter registry (add new CLIs easily) |
| Fixed pricing model | Model-aware cost optimization (50%+ savings potential) |

## Open Source Positioning

This milestone transforms Pilot AGI from a Claude Code wrapper into a **universal AI coding orchestrator**. The open source story:

1. **Core + adapters are MIT licensed** — anyone can use and extend
2. **Community adapters welcome** — Windsurf, Amazon Q, Kiro, etc.
3. **Model registry is community-maintained** — new models added via PR
4. **Policy templates** — HIPAA, SOC2, startup-speed, cost-optimized
5. **The governance layer is the moat** — harder to replicate than any single adapter

The viral demo: *"5 different AI models building the same app simultaneously. Claude does architecture. GPT writes tests. Gemini builds UI. Llama writes docs for free. All governed by one policy file. Controlled from your phone."*
