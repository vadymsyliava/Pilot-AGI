# Milestone 6: Physical Terminal Control — AppleScript + iTerm2 + Telegram

**Task**: Pilot AGI-sny
**Status**: Design Spec
**Target**: v5.0.0

## Problem Statement

Pilot AGI's PM Daemon spawns agent processes via `claude -p` — headless, invisible, no terminal window. This works for overnight mode but creates two critical gaps:

1. **No physical terminal visibility** — Agents run as background processes. You can `--tail` their logs, but there's no actual terminal you can interact with, resize, scroll, or inspect.
2. **No remote human interface** — All interaction requires being at the machine. When PM escalates or needs approval, the human must be at their laptop.

```
CURRENT (M4/M5):
┌──────────────────────────────────┐
│ PM Daemon (Node.js)              │
│ Spawns: claude -p "task X"       │──→ Background process (invisible)
│ Output: log file only            │
│ Interaction: CLI flags only      │
└──────────────────────────────────┘

DESIRED (M6):
┌──────────────────────────────────┐
│ PM Daemon (Node.js)              │
│ Spawns into: real Terminal tab   │──→ Visible terminal window/tab
│ Controls: AppleScript/iTerm2 API │──→ Can read output, resize, arrange
│ Remote: Telegram bot             │──→ Human approves from phone
└──────────────────────────────────┘
```

## Architecture Overview

Three layers with clean provider abstraction:

```
┌─────────────────────────────────────────────────────────────────┐
│                    PM DAEMON (Node.js)                            │
│                                                                  │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐ │
│  │ Terminal Control │  │ Terminal Provider │  │ Telegram Bot   │ │
│  │ API (unified)    │  │ Registry         │  │ Interface      │ │
│  │                  │  │                  │  │                │ │
│  │ .openTerminal()  │  │ .detect()        │  │ /status        │ │
│  │ .runCommand()    │  │ .getProvider()   │  │ /approve       │ │
│  │ .readOutput()    │  │ .listProviders() │  │ /kill          │ │
│  │ .splitPane()     │  │                  │  │ /logs          │ │
│  │ .closeTerminal() │  │                  │  │ /morning       │ │
│  └────────┬────────┘  └────────┬─────────┘  └───────┬────────┘ │
│           │                     │                     │          │
└───────────┼─────────────────────┼─────────────────────┼──────────┘
            │                     │                     │
    ┌───────▼────────┐   ┌───────▼────────┐    ┌───────▼────────┐
    │  AppleScript    │   │  iTerm2 Python │    │  Telegram API  │
    │  Provider       │   │  API Provider  │    │  (polling)     │
    │                 │   │                │    │                │
    │  Terminal.app   │   │  iTerm2.app    │    │  Remote human  │
    │  (always works) │   │  (if installed)│    │  interface     │
    └─────────────────┘   └────────────────┘    └────────────────┘
```

## Design Principles

1. **AppleScript is the universal layer** — Works with Terminal.app (ships with macOS), no extra installs
2. **iTerm2 Python API is the premium layer** — Richer features (splits, screen contents, profiles) for users who have iTerm2
3. **Provider pattern** — Auto-detect terminal app, use best available provider, fallback gracefully
4. **Telegram is optional** — Zero-config if not wanted, one env var to enable
5. **Backward compatible** — Headless `claude -p` still works; terminal mode is opt-in via `policy.yaml`

---

## Phase 6.1: Terminal Provider Abstraction

**Problem**: Need a unified API that works across Terminal.app (AppleScript), iTerm2 (Python API + AppleScript), and potentially other terminal emulators.

### Terminal Provider Interface

```javascript
// lib/terminal-provider.js

/**
 * @interface TerminalProvider
 */
class TerminalProvider {
  /** @returns {string} Provider name */
  get name() {}

  /** @returns {boolean} Whether this provider is available on the system */
  async isAvailable() {}

  /**
   * Open a new terminal window/tab and run a command.
   * @param {object} opts
   * @param {string} opts.command - Command to execute
   * @param {string} opts.title - Window/tab title
   * @param {string} opts.cwd - Working directory
   * @param {object} opts.env - Environment variables
   * @param {'window'|'tab'|'split'} opts.target - Where to open
   * @returns {Promise<{terminalId: string, pid: number}>}
   */
  async open(opts) {}

  /**
   * Send a command to an existing terminal session.
   * @param {string} terminalId
   * @param {string} command
   */
  async sendCommand(terminalId, command) {}

  /**
   * Read recent output from a terminal session.
   * @param {string} terminalId
   * @param {number} lines - Number of lines to read
   * @returns {Promise<string>}
   */
  async readOutput(terminalId, lines) {}

  /**
   * Split an existing terminal pane.
   * @param {string} terminalId
   * @param {'horizontal'|'vertical'} direction
   * @param {string} command - Command for new pane
   * @returns {Promise<{terminalId: string}>}
   */
  async split(terminalId, direction, command) {}

  /**
   * Close a terminal session.
   * @param {string} terminalId
   */
  async close(terminalId) {}

  /**
   * List all managed terminal sessions.
   * @returns {Promise<Array<{terminalId: string, title: string, pid: number}>>}
   */
  async list() {}

  /**
   * Check if a terminal session is still alive.
   * @param {string} terminalId
   * @returns {Promise<boolean>}
   */
  async isAlive(terminalId) {}
}
```

### Provider Registry

```javascript
// lib/terminal-registry.js

class TerminalRegistry {
  constructor() {
    this.providers = new Map(); // name -> TerminalProvider
    this.activeProvider = null;
  }

  register(provider) {
    this.providers.set(provider.name, provider);
  }

  /**
   * Auto-detect best available terminal provider.
   * Priority: iTerm2 Python API > iTerm2 AppleScript > Terminal.app
   */
  async detect() {
    const priority = ['iterm2-python', 'iterm2-applescript', 'terminal-applescript'];

    for (const name of priority) {
      const provider = this.providers.get(name);
      if (provider && await provider.isAvailable()) {
        this.activeProvider = provider;
        return provider;
      }
    }

    throw new Error('No terminal provider available');
  }

  getProvider() {
    return this.activeProvider;
  }
}
```

### Detection Logic

| Check | Method | Result |
|-------|--------|--------|
| iTerm2 installed? | `mdfind "kMDItemBundleIdentifier == 'com.googlecode.iterm2'"` | Path or empty |
| iTerm2 running? | `osascript -e 'application "iTerm2" is running'` | true/false |
| iTerm2 Python API enabled? | `python3 -c "import iterm2"` | Exit code 0/1 |
| Terminal.app available? | Always true on macOS | true |
| Automation permission? | Try `osascript -e 'tell app "Terminal" to name'` | Success/error |

**Files**: new `lib/terminal-provider.js`, new `lib/terminal-registry.js`

---

## Phase 6.2: AppleScript Terminal Provider

**The universal provider** — works with Terminal.app on every Mac. No extra software needed.

### Implementation Strategy

Use `osascript` via `child_process.execFile` for all operations. Prefer JXA (JavaScript for Automation) over traditional AppleScript for better Node.js integration.

### Key Operations

**Open new terminal window with command:**
```javascript
// JXA via osascript
async open(opts) {
  const script = `
    const term = Application('Terminal');
    term.activate();
    term.doScript(${JSON.stringify(opts.command)});
    const win = term.windows[0];
    win.name();
  `;
  const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script]);
  return { terminalId: `terminal:${windowIndex}`, pid: extractPid(stdout) };
}
```

**Open new tab (System Events workaround):**

Terminal.app's `make new tab` is broken and has been for years. Must use System Events:

```javascript
async openTab(opts) {
  const script = `
    tell application "Terminal" to activate
    tell application "System Events"
      keystroke "t" using command down
    end tell
    delay 0.5
    tell application "Terminal"
      do script "${opts.command}" in front window
    end tell
  `;
  await execFileAsync('osascript', ['-e', script]);
}
```

**Read terminal contents:**
```javascript
async readOutput(terminalId, lines = 50) {
  const [, index] = terminalId.split(':');
  const script = `
    tell application "Terminal"
      set tabContents to contents of tab 1 of window ${index}
      return tabContents
    end tell
  `;
  const { stdout } = await execFileAsync('osascript', ['-e', script]);
  const allLines = stdout.split('\n');
  return allLines.slice(-lines).join('\n');
}
```

**Send command to existing terminal:**
```javascript
async sendCommand(terminalId, command) {
  const [, index] = terminalId.split(':');
  const script = `
    tell application "Terminal"
      do script "${command}" in tab 1 of window ${index}
    end tell
  `;
  await execFileAsync('osascript', ['-e', script]);
}
```

### Limitations

| Feature | Terminal.app | Workaround |
|---------|-------------|------------|
| Split panes | Not supported | Open new tab instead |
| Named tabs | Limited | Set title via ANSI escape: `printf '\e]1;Title\a'` |
| Read output | Returns all content | Parse last N lines from `contents` |
| New tab | `make new tab` broken | System Events keystroke `Cmd+T` |
| Focus window | Works | `activate` + window index |

### Performance

- Each `osascript` call: ~100-300ms overhead (process spawn + Apple Event dispatch)
- Batch operations where possible (single script with multiple commands)
- Cache window references to avoid re-querying

**Files**: new `lib/providers/terminal-applescript.js`

---

## Phase 6.3: iTerm2 Provider (AppleScript + Python API)

**The premium provider** — richer features for iTerm2 users. Two sub-providers:

### 6.3a: iTerm2 AppleScript Provider

For users who have iTerm2 but haven't set up the Python API. AppleScript support in iTerm2 is in maintenance mode (bug fixes only) but still functional.

**Open window with profile:**
```applescript
tell application "iTerm2"
  create window with default profile
  tell current session of current window
    write text "cd /project && claude -p 'task X'"
  end tell
end tell
```

**Split pane:**
```applescript
tell application "iTerm2"
  tell current session of current window
    split horizontally with default profile command "tail -f agent.log"
  end tell
end tell
```

**Get session contents:**
```applescript
tell application "iTerm2"
  tell current session of current window
    set screenContents to contents
    return screenContents
  end tell
end tell
```

iTerm2 application structure: windows contain tabs, tabs contain sessions (sessions occur when there are split panes).

### 6.3b: iTerm2 Python API Provider

For users with Python API enabled — the most powerful option. Uses async/await, persistent WebSocket connection, and provides line-range screen reading.

**Architecture**: PM Daemon spawns a long-running Python bridge process that maintains a persistent connection to iTerm2's Python API.

```
PM Daemon (Node.js)          Python Bridge           iTerm2
┌──────────────┐            ┌──────────────┐        ┌──────────┐
│ Sends JSON   │──stdin───→ │ iterm2 lib   │──WS──→ │ Python   │
│ commands     │            │ async/await  │        │ API      │
│              │←─stdout──  │ Returns JSON │←─WS──  │ Server   │
└──────────────┘            └──────────────┘        └──────────┘
```

**Python bridge script** (`scripts/iterm2-bridge.py`):
```python
#!/usr/bin/env python3
import iterm2
import asyncio
import json
import sys

class ITerm2Bridge:
    def __init__(self):
        self.sessions = {}  # id -> Session

    async def handle_command(self, connection, cmd):
        app = await iterm2.async_get_app(connection)

        if cmd['action'] == 'open':
            window = await iterm2.Window.async_create(connection)
            session = window.current_tab.current_session
            if cmd.get('command'):
                await session.async_send_text(cmd['command'] + '\n')
            self.sessions[session.session_id] = session
            return {'terminalId': session.session_id}

        elif cmd['action'] == 'split':
            parent = self.sessions.get(cmd['terminalId'])
            vertical = cmd.get('direction', 'vertical') == 'vertical'
            new_session = await parent.async_split_pane(vertical=vertical)
            if cmd.get('command'):
                await new_session.async_send_text(cmd['command'] + '\n')
            self.sessions[new_session.session_id] = new_session
            return {'terminalId': new_session.session_id}

        elif cmd['action'] == 'read':
            session = self.sessions.get(cmd['terminalId'])
            contents = await session.async_get_contents(0, cmd.get('lines', 50))
            lines = [line.string for line in contents]
            return {'output': '\n'.join(lines)}

        elif cmd['action'] == 'send':
            session = self.sessions.get(cmd['terminalId'])
            await session.async_send_text(cmd['command'] + '\n')
            return {'ok': True}

        elif cmd['action'] == 'close':
            session = self.sessions.get(cmd['terminalId'])
            await session.async_close()
            del self.sessions[cmd['terminalId']]
            return {'ok': True}

        elif cmd['action'] == 'list':
            result = []
            for sid, session in self.sessions.items():
                result.append({
                    'terminalId': sid,
                    'title': await session.async_get_variable('session.name')
                })
            return {'sessions': result}

    async def main(self, connection):
        for line in sys.stdin:
            cmd = json.loads(line.strip())
            result = await self.handle_command(connection, cmd)
            print(json.dumps(result), flush=True)

bridge = ITerm2Bridge()
iterm2.run_until_complete(bridge.main)
```

**Node.js integration:**
```javascript
// lib/providers/iterm2-python.js
class ITerm2PythonProvider extends TerminalProvider {
  constructor() {
    super();
    this.bridge = null; // child_process handle
  }

  async isAvailable() {
    try {
      await execFileAsync('python3', ['-c', 'import iterm2']);
      return true;
    } catch { return false; }
  }

  async _ensureBridge() {
    if (!this.bridge) {
      this.bridge = spawn('python3', ['scripts/iterm2-bridge.py'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      // Set up line-based JSON protocol on stdout
    }
  }

  async open(opts) {
    await this._ensureBridge();
    return this._send({ action: 'open', ...opts });
  }
  // ... other methods delegate to bridge
}
```

### Feature Comparison

| Feature | Terminal.app (AS) | iTerm2 (AS) | iTerm2 (Python) |
|---------|:-:|:-:|:-:|
| Open window | Yes | Yes | Yes |
| Open tab | Workaround* | Yes | Yes |
| Split pane | No | Yes | Yes |
| Read output | Full contents only | Full contents | Line-range |
| Named profiles | No | Yes | Yes |
| Window arrangement | Basic | Good | Full |
| Screen monitoring | No | No | ScreenStreamer |
| Session variables | No | Limited | Full |
| Performance | ~200ms/call | ~200ms/call | ~50ms/call** |

*System Events keystroke workaround
**Python API uses persistent WebSocket, not per-call process spawn

### Prerequisites

- iTerm2 Python API requires: `pip3 install iterm2` + enable in iTerm2 Preferences > Magic > Enable Python API
- iTerm2 AppleScript: no setup beyond Automation permission
- Terminal.app: no setup beyond Automation permission

**Files**: new `lib/providers/iterm2-applescript.js`, new `lib/providers/iterm2-python.js`, new `scripts/iterm2-bridge.py`

---

## Phase 6.4: Terminal-Aware Process Spawner

**Problem**: Current `process-spawner.js` uses `claude -p` which creates an invisible background process. Need to spawn agents into visible terminal windows/tabs.

### Spawn Modes

```yaml
# policy.yaml
terminal:
  enabled: true
  provider: auto          # auto | terminal | iterm2 | headless
  spawn_mode: tab         # window | tab | split | headless
  layout: grid            # grid | stack | side-by-side
  max_visible: 6          # Max terminal windows/tabs
  show_pm_dashboard: true # Dedicate one pane to PM status
```

### Spawn Flow

```
Current Flow:
  PM Daemon -> child_process.spawn('claude', ['-p', prompt]) -> invisible process

New Flow:
  PM Daemon -> terminalProvider.open({
    command: `claude -p "${prompt}"`,
    title: `Agent: ${taskTitle}`,
    cwd: worktreePath,
    env: { PILOT_TASK_ID, PILOT_SESSION_ID, ... }
  }) -> visible terminal tab/window
```

### Integration with PM Daemon

Modify `pm-daemon.js._spawnAgent()`:

```javascript
async _spawnAgent(taskId, prompt, opts = {}) {
  const terminalConfig = this.policy.terminal || {};

  if (terminalConfig.enabled && terminalConfig.provider !== 'headless') {
    // Spawn into visible terminal
    const provider = this.terminalRegistry.getProvider();
    const result = await provider.open({
      command: this._buildClaudeCommand(prompt, opts),
      title: `[${taskId}] ${opts.title || 'Agent'}`,
      cwd: opts.worktreePath || this.projectRoot,
      env: this._buildAgentEnv(taskId, opts),
      target: terminalConfig.spawn_mode || 'tab'
    });

    // Track terminal alongside process
    this.agentTerminals.set(taskId, {
      terminalId: result.terminalId,
      provider: provider.name,
      spawnedAt: Date.now()
    });

    return result;
  } else {
    // Existing headless spawn
    return this._spawnHeadless(taskId, prompt, opts);
  }
}
```

### Terminal Layout Manager

When spawning multiple agents, arrange terminals intelligently:

```javascript
// lib/terminal-layout.js

class TerminalLayout {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.slots = []; // { terminalId, taskId, position }
  }

  /**
   * Auto-arrange agent terminals based on layout config.
   * grid: 2x3 grid of splits (iTerm2 only)
   * stack: vertical stack of tabs
   * side-by-side: PM left, agents right
   */
  async arrangeForAgents(agentCount) {
    const layout = this.config.layout || 'grid';

    switch (layout) {
      case 'grid':
        return this._arrangeGrid(agentCount);
      case 'stack':
        return this._arrangeStack(agentCount);
      case 'side-by-side':
        return this._arrangeSideBySide(agentCount);
    }
  }

  async _arrangeGrid(count) {
    // iTerm2: Use splits to create grid
    // Terminal.app: Use tabs (no splits available)
    if (this.provider.name.startsWith('iterm2')) {
      const root = await this.provider.open({ command: '' });
      let current = root.terminalId;

      for (let i = 1; i < count; i++) {
        const direction = i % 2 === 0 ? 'horizontal' : 'vertical';
        const split = await this.provider.split(current, direction);
        current = split.terminalId;
      }
    } else {
      // Terminal.app: open tabs
      for (let i = 0; i < count; i++) {
        await this.provider.open({ target: 'tab' });
      }
    }
  }
}
```

**Files**: modified `lib/process-spawner.js`, modified `lib/pm-daemon.js`, new `lib/terminal-layout.js`

---

## Phase 6.5: Terminal Monitoring & Interaction

**Problem**: PM Daemon needs to monitor agent terminals for health, read output for progress tracking, and inject commands for course corrections.

### Output Monitoring

```javascript
// lib/terminal-monitor.js

class TerminalMonitor {
  constructor(terminalRegistry, opts = {}) {
    this.registry = terminalRegistry;
    this.pollIntervalMs = opts.pollIntervalMs || 5000;
    this.watchers = new Map(); // taskId -> { terminalId, lastOutput, callback }
  }

  /**
   * Watch a terminal for specific patterns (errors, completion markers).
   */
  watch(taskId, terminalId, patterns, callback) {
    this.watchers.set(taskId, {
      terminalId,
      patterns,     // [{ regex, event }]
      callback,
      lastOutput: '',
      lastCheck: 0
    });
  }

  /**
   * Periodic scan of all watched terminals.
   */
  async scan() {
    const provider = this.registry.getProvider();

    for (const [taskId, watcher] of this.watchers) {
      try {
        const alive = await provider.isAlive(watcher.terminalId);
        if (!alive) {
          watcher.callback({ event: 'terminated', taskId });
          this.watchers.delete(taskId);
          continue;
        }

        const output = await provider.readOutput(watcher.terminalId, 20);
        if (output === watcher.lastOutput) continue;

        const newContent = output.replace(watcher.lastOutput, '');
        for (const { regex, event } of watcher.patterns) {
          if (regex.test(newContent)) {
            watcher.callback({ event, taskId, match: newContent.match(regex)[0] });
          }
        }

        watcher.lastOutput = output;
      } catch (e) {
        // Terminal may have closed
      }
    }
  }
}
```

### Default Watch Patterns

```javascript
const DEFAULT_PATTERNS = [
  { regex: /Error:|FATAL|panic|Traceback/, event: 'error' },
  { regex: /All plan steps complete/, event: 'task_complete' },
  { regex: /Context pressure: (\d+)%/, event: 'pressure_update' },
  { regex: /CHECKPOINT SAVED/, event: 'checkpoint' },
  { regex: /Waiting for plan approval/, event: 'needs_approval' },
];
```

### Command Injection

For PM to send commands to agent terminals:

```javascript
// PM tells agent to checkpoint
await pm.injectCommand('Pilot AGI-xyz', '/pilot-checkpoint');

// PM tells agent to stop
await pm.injectCommand('Pilot AGI-xyz', '/pilot-release');
```

**Files**: new `lib/terminal-monitor.js`, modified `lib/pm-daemon.js`

---

## Phase 6.6: Telegram Bot Interface

**Problem**: PM escalations and approvals require being at the machine. Need remote interface for notifications and interactive approval.

### Bot Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ PM DAEMON                                                        │
│                                                                  │
│  ┌───────────────────┐     ┌──────────────────────────────────┐ │
│  │ Escalation Engine │────→│ Telegram Bot Module               │ │
│  │ (escalation.js)   │     │                                   │ │
│  │                   │     │  Commands:                        │ │
│  │ Reporter          │────→│    /status  - system status       │ │
│  │ (reporter.js)     │     │    /ps      - agent process table │ │
│  │                   │     │    /approve - pending approvals   │ │
│  │ PM Loop           │────→│    /reject  - reject with reason  │ │
│  │ (pm-loop.js)      │     │    /kill    - stop an agent      │ │
│  └───────────────────┘     │    /logs    - tail agent logs     │ │
│                             │    /morning - morning report     │ │
│                             │    /budget  - cost summary       │ │
│                             │    /help    - command list        │ │
│                             │                                   │ │
│                             │  Notifications:                   │ │
│                             │    Escalation alerts              │ │
│                             │    Approval requests (inline kbd) │ │
│                             │    Task completion reports        │ │
│                             │    Error/crash alerts             │ │
│                             │    Morning report (scheduled)     │ │
│                             └──────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Configuration

```yaml
# policy.yaml
telegram:
  enabled: false            # Opt-in
  # Token stored in env var PILOT_TELEGRAM_TOKEN (never in yaml)
  allowed_chat_ids: []      # Whitelist of Telegram user/group IDs
  mode: polling             # polling | webhook
  notifications:
    escalations: true       # Send escalation alerts
    task_complete: true     # Send on task completion
    errors: true            # Send on agent errors
    morning_report: true    # Send scheduled morning report
    morning_report_time: "08:00"  # Local time for morning report
  approval:
    enabled: true           # Allow approve/reject via Telegram
    timeout_minutes: 60     # Auto-escalate if no response
```

### Bot Implementation

```javascript
// lib/telegram-bot.js

const TelegramBot = require('node-telegram-bot-api');

class PilotTelegramBot {
  constructor(pmDaemon, opts = {}) {
    this.pm = pmDaemon;
    this.config = opts.config || {};
    this.bot = null;
    this.pendingApprovals = new Map(); // approvalId -> { taskId, type, expiresAt }
  }

  async start() {
    const token = process.env.PILOT_TELEGRAM_TOKEN;
    if (!token) throw new Error('PILOT_TELEGRAM_TOKEN not set');

    this.bot = new TelegramBot(token, { polling: true });
    this._registerCommands();
    this._registerCallbacks();
  }

  _registerCommands() {
    // /status - System overview
    this.bot.onText(/\/status/, async (msg) => {
      if (!this._isAuthorized(msg.chat.id)) return;
      const status = await this.pm.getStatus();
      await this.bot.sendMessage(msg.chat.id, this._formatStatus(status), {
        parse_mode: 'Markdown'
      });
    });

    // /ps - Process table
    this.bot.onText(/\/ps/, async (msg) => {
      if (!this._isAuthorized(msg.chat.id)) return;
      const processes = await this.pm.getProcessTable();
      await this.bot.sendMessage(msg.chat.id, this._formatProcessTable(processes), {
        parse_mode: 'Markdown'
      });
    });

    // /logs <taskId> - Tail agent logs
    this.bot.onText(/\/logs (.+)/, async (msg, match) => {
      if (!this._isAuthorized(msg.chat.id)) return;
      const taskId = match[1].trim();
      const logs = await this.pm.tailLogs(taskId, 30);
      await this.bot.sendMessage(msg.chat.id,
        `\`\`\`\n${logs}\n\`\`\``, { parse_mode: 'Markdown' });
    });

    // /kill <taskId> - Stop agent
    this.bot.onText(/\/kill (.+)/, async (msg, match) => {
      if (!this._isAuthorized(msg.chat.id)) return;
      const taskId = match[1].trim();
      await this.bot.sendMessage(msg.chat.id, `Stopping agent for ${taskId}...`);
      await this.pm.killAgent(taskId);
      await this.bot.sendMessage(msg.chat.id, `Agent for ${taskId} stopped.`);
    });

    // /morning - Morning report on demand
    this.bot.onText(/\/morning/, async (msg) => {
      if (!this._isAuthorized(msg.chat.id)) return;
      const report = await this.pm.getMorningReport();
      await this.bot.sendMessage(msg.chat.id, report, { parse_mode: 'Markdown' });
    });

    // /budget - Cost summary
    this.bot.onText(/\/budget/, async (msg) => {
      if (!this._isAuthorized(msg.chat.id)) return;
      const budget = await this.pm.getBudgetSummary();
      await this.bot.sendMessage(msg.chat.id, this._formatBudget(budget), {
        parse_mode: 'Markdown'
      });
    });
  }

  _registerCallbacks() {
    this.bot.on('callback_query', async (query) => {
      const chatId = query.message.chat.id;
      if (!this._isAuthorized(chatId)) return;

      const [action, approvalId] = query.data.split(':');
      const approval = this.pendingApprovals.get(approvalId);
      if (!approval) {
        await this.bot.answerCallbackQuery(query.id, { text: 'Approval expired' });
        return;
      }

      if (action === 'approve') {
        await this.pm.approveEscalation(approval.taskId, approval.type);
        await this.bot.editMessageText(
          `Approved: ${approval.summary}`,
          { chat_id: chatId, message_id: query.message.message_id }
        );
      } else if (action === 'reject') {
        await this.pm.rejectEscalation(approval.taskId, approval.type);
        await this.bot.editMessageText(
          `Rejected: ${approval.summary}`,
          { chat_id: chatId, message_id: query.message.message_id }
        );
      }

      this.pendingApprovals.delete(approvalId);
      await this.bot.answerCallbackQuery(query.id);
    });
  }

  // -- Outbound Notifications --

  async sendEscalation(chatId, escalation) {
    const approvalId = `esc_${Date.now()}`;
    const text = [
      `*Escalation: ${escalation.type}*`,
      `Task: \`${escalation.taskId}\``,
      `Level: ${escalation.level}`,
      `Details: ${escalation.details}`,
    ].join('\n');

    const msg = await this.bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: 'Approve', callback_data: `approve:${approvalId}` },
          { text: 'Reject', callback_data: `reject:${approvalId}` },
        ]]
      }
    });

    this.pendingApprovals.set(approvalId, {
      taskId: escalation.taskId,
      type: escalation.type,
      summary: escalation.details,
      messageId: msg.message_id,
      expiresAt: Date.now() + (this.config.approval?.timeout_minutes || 60) * 60000
    });
  }

  async sendTaskComplete(chatId, taskId, summary) {
    await this.bot.sendMessage(chatId,
      `*Task Complete*\n\`${taskId}\`\n${summary}`,
      { parse_mode: 'Markdown' }
    );
  }

  async sendError(chatId, taskId, error) {
    await this.bot.sendMessage(chatId,
      `*Agent Error*\n\`${taskId}\`\n\`\`\`\n${error}\n\`\`\``,
      { parse_mode: 'Markdown' }
    );
  }

  async sendMorningReport(chatId, report) {
    await this.bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
  }

  // -- Authorization --

  _isAuthorized(chatId) {
    const allowed = this.config.allowed_chat_ids || [];
    if (allowed.length === 0) return true; // No whitelist = open (dev mode)
    return allowed.includes(chatId);
  }

  // -- Formatting --

  _formatStatus(status) {
    return [
      '*Pilot AGI Status*',
      `Agents: ${status.activeAgents}/${status.maxAgents}`,
      `Tasks: ${status.tasksInProgress} in progress, ${status.tasksReady} ready`,
      `Budget: $${status.budgetUsed.toFixed(2)}/$${status.budgetLimit.toFixed(2)}`,
      `Uptime: ${status.uptime}`,
    ].join('\n');
  }

  _formatProcessTable(processes) {
    if (processes.length === 0) return 'No active agents';
    const rows = processes.map(p =>
      `\`${p.taskId}\` | ${p.status} | ${p.duration} | ${p.pressure}%`
    );
    return '*Agent Processes*\n' + rows.join('\n');
  }

  _formatBudget(budget) {
    return [
      '*Budget Summary*',
      `Today: $${budget.today.toFixed(2)}`,
      `This week: $${budget.week.toFixed(2)}`,
      `Per-task avg: $${budget.avgPerTask.toFixed(2)}`,
      `Remaining: $${budget.remaining.toFixed(2)}`,
    ].join('\n');
  }

  async stop() {
    if (this.bot) await this.bot.stopPolling();
  }
}
```

### Security

1. **Token**: Stored in `PILOT_TELEGRAM_TOKEN` env var, never in policy.yaml or code
2. **Chat ID whitelist**: Only authorized Telegram users can interact with the bot
3. **Approval timeout**: Unanswered approvals auto-escalate after configurable window
4. **No destructive commands without confirmation**: `/kill` requires confirmation callback

**Files**: new `lib/telegram-bot.js`, modified `lib/pm-daemon.js`, modified `lib/escalation.js`

---

## Phase 6.7: PM Dashboard Terminal

**Problem**: PM Daemon currently outputs to a log file. Need a dedicated terminal pane showing live PM status.

### Dashboard Pane

When terminal mode is enabled, PM Daemon opens a dedicated terminal showing:

```
+-----------------------------------------------------------------+
| PILOT AGI - PM Dashboard                            02/12 07:15 |
+-----------------------------------------------------------------+
| AGENTS          TASK                    STATUS    CTX    TIME    |
| --------------- ----------------------- -------- ------ ------  |
| frontend-1      Add auth middleware     working   42%   12m     |
| backend-1       Create user API         working   67%   23m     |
| testing-1       Unit tests for auth     idle      -     -       |
| design-1        Token audit             complete  -     8m      |
+-----------------------------------------------------------------+
| QUEUE: 3 ready | 2 blocked | 1 in review                       |
| BUDGET: $4.23/$50.00 today | $12.67/$200.00 week               |
| ESCALATIONS: 0 pending                                          |
+-----------------------------------------------------------------+
| RECENT EVENTS                                                    |
| 07:14 frontend-1 completed step 3/5 - Add auth middleware       |
| 07:13 backend-1 checkpoint at 67% - respawning                  |
| 07:12 testing-1 waiting for backend-1 artifacts                 |
| 07:10 PM auto-approved plan for frontend-1 (confidence: 0.91)  |
+-----------------------------------------------------------------+
```

### Implementation

The dashboard is a standalone Node.js script using ANSI escape codes for formatting. It reads PM state from state files and refreshes every 2 seconds.

```javascript
// lib/pm-dashboard-terminal.js

class PmDashboardTerminal {
  constructor(terminalProvider, pmDaemon) {
    this.provider = terminalProvider;
    this.pm = pmDaemon;
    this.terminalId = null;
  }

  async start() {
    const result = await this.provider.open({
      command: `node ${__dirname}/../scripts/pm-dashboard-live.js`,
      title: 'Pilot AGI - PM Dashboard',
      target: 'window'  // Own window, not a tab among agents
    });
    this.terminalId = result.terminalId;
  }

  async stop() {
    if (this.terminalId) {
      await this.provider.close(this.terminalId);
    }
  }
}
```

**Files**: new `lib/pm-dashboard-terminal.js`, new `scripts/pm-dashboard-live.js`

---

## Phase 6.8: macOS Permission Setup & Onboarding

**Problem**: AppleScript terminal control requires macOS Automation and Accessibility permissions. First-time setup must be smooth.

### Permission Check Flow

```javascript
// lib/permission-check.js

class PermissionCheck {
  /**
   * Check all required permissions and guide user through setup.
   * @returns {{ ready: boolean, missing: string[] }}
   */
  async checkAll() {
    const results = {
      automation_terminal: await this._checkAutomation('Terminal'),
      automation_iterm: await this._checkAutomation('iTerm2'),
      accessibility: await this._checkAccessibility(),
    };

    const missing = Object.entries(results)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);

    return { ready: missing.length === 0, missing };
  }

  async _checkAutomation(appName) {
    try {
      await execFileAsync('osascript', ['-e',
        `tell application "${appName}" to name of window 1`
      ], { timeout: 5000 });
      return true;
    } catch (e) {
      if (e.message.includes('not allowed') || e.message.includes('assistive')) {
        return false;
      }
      return true; // Other errors (e.g., no windows open) mean permission is OK
    }
  }

  async _checkAccessibility() {
    try {
      await execFileAsync('osascript', ['-e', `
        tell application "System Events"
          name of first process
        end tell
      `], { timeout: 5000 });
      return true;
    } catch { return false; }
  }

  /**
   * Return setup instructions for missing permissions.
   */
  getSetupInstructions(missing) {
    const instructions = [];

    if (missing.includes('automation_terminal') || missing.includes('automation_iterm')) {
      instructions.push({
        title: 'Grant Automation Permission',
        steps: [
          'Open System Settings > Privacy & Security > Automation',
          'Find your terminal application (Terminal or iTerm2)',
          'Enable the checkbox to allow controlling Terminal/iTerm2',
          'If not listed, run `pilot-agi --check-permissions` to trigger the dialog'
        ]
      });
    }

    if (missing.includes('accessibility')) {
      instructions.push({
        title: 'Grant Accessibility Permission (for tab creation)',
        steps: [
          'Open System Settings > Privacy & Security > Accessibility',
          'Click the lock icon and authenticate',
          'Add your terminal application to the list',
          'This is needed for creating new tabs via keyboard shortcuts'
        ]
      });
    }

    return instructions;
  }
}
```

### First-Run Onboarding

When `terminal.enabled: true` in policy.yaml and PM daemon starts:

1. Run permission check
2. If missing, display clear instructions in PM log and (if Telegram enabled) send to user
3. Attempt to trigger the macOS permission dialog by running a test AppleScript
4. Wait for user to grant, re-check on next daemon tick
5. Once all permissions granted, proceed with terminal-mode spawning

Note: Programmatic permission granting requires disabling SIP (System Integrity Protection) which is not recommended. The `tccutil` command can only reset permissions, not grant them. User must grant manually through System Settings.

**Files**: new `lib/permission-check.js`, modified `lib/pm-daemon.js`

---

## Dependencies

```
Wave 1 (Independent):
  6.1  Terminal Provider Abstraction - no deps, defines interfaces
  6.6  Telegram Bot Interface - no deps, standalone module
  6.8  Permission Setup - no deps, utility module

Wave 2:
  6.2  AppleScript Provider (needs 6.1 interface)
  6.3  iTerm2 Provider (needs 6.1 interface)

Wave 3:
  6.4  Terminal-Aware Spawner (needs 6.1 + 6.2/6.3 + existing process-spawner)
  6.5  Terminal Monitoring (needs 6.2/6.3)
  6.7  PM Dashboard Terminal (needs 6.2/6.3)
```

## New Files

| File | Purpose |
|------|---------|
| `lib/terminal-provider.js` | Abstract provider interface |
| `lib/terminal-registry.js` | Provider detection and registration |
| `lib/providers/terminal-applescript.js` | Terminal.app via AppleScript/JXA |
| `lib/providers/iterm2-applescript.js` | iTerm2 via AppleScript |
| `lib/providers/iterm2-python.js` | iTerm2 via Python API bridge |
| `scripts/iterm2-bridge.py` | Persistent Python process for iTerm2 API |
| `lib/terminal-layout.js` | Auto-arrange agent terminals |
| `lib/terminal-monitor.js` | Watch terminal output for patterns |
| `lib/telegram-bot.js` | Telegram bot for remote control |
| `lib/pm-dashboard-terminal.js` | Live PM dashboard in terminal |
| `scripts/pm-dashboard-live.js` | Dashboard rendering script |
| `lib/permission-check.js` | macOS permission verification |

## Modified Files

| File | Change |
|------|--------|
| `lib/pm-daemon.js` | Add terminal registry, Telegram bot startup, dashboard |
| `lib/process-spawner.js` | Route spawns through terminal provider |
| `lib/escalation.js` | Route escalations to Telegram |
| `lib/pm-loop.js` | Add terminal monitoring scan |
| `policy.yaml` | Add `terminal` and `telegram` sections |

## Policy Configuration

```yaml
# policy.yaml additions

terminal:
  enabled: false            # Opt-in to terminal mode
  provider: auto            # auto | terminal | iterm2 | headless
  spawn_mode: tab           # window | tab | split | headless
  layout: grid              # grid | stack | side-by-side
  max_visible: 6            # Max visible terminals
  show_pm_dashboard: true   # Live PM dashboard pane
  monitor:
    enabled: true           # Watch terminal output
    poll_interval_ms: 5000  # Output check frequency

telegram:
  enabled: false            # Opt-in to Telegram
  # Token: PILOT_TELEGRAM_TOKEN env var
  allowed_chat_ids: []      # Whitelist (empty = open)
  mode: polling             # polling | webhook
  notifications:
    escalations: true
    task_complete: true
    errors: true
    morning_report: true
    morning_report_time: "08:00"
  approval:
    enabled: true
    timeout_minutes: 60
```

## Success Criteria

- [ ] PM Daemon spawns agents into visible Terminal.app tabs via AppleScript
- [ ] iTerm2 users get split panes and screen content reading via Python API
- [ ] Auto-detection picks best available terminal provider
- [ ] PM can read agent terminal output and inject commands
- [ ] Telegram bot responds to /status, /ps, /logs, /kill, /morning
- [ ] Escalation sends Telegram notification with inline approve/reject buttons
- [ ] Approval timeout auto-escalates after configured window
- [ ] Live PM dashboard shows agent status, queue, budget, events
- [ ] macOS permissions are checked on startup with clear setup instructions
- [ ] Headless mode (existing `claude -p`) still works when terminal mode is disabled
- [ ] Morning report delivered to Telegram at scheduled time

## What Changes from M5

| M5 (Current) | M6 (New) |
|--------------|----------|
| Agents are invisible background processes | Agents run in visible terminal tabs/windows |
| PM status via `--ps` CLI only | Live PM dashboard in dedicated terminal |
| Escalations go to log file or WebSocket | Escalations push to Telegram with approve/reject |
| Must be at laptop for approvals | Approve/reject from phone via Telegram |
| No terminal output monitoring | PM reads terminal contents, detects patterns |
| No terminal arrangement | Auto-arrange agents in grid/stack/side-by-side |
| Single spawn mode (headless) | Multiple: window, tab, split, headless |
