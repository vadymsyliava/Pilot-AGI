# M6: Physical Terminal Control & Remote Human Interface

**Task**: Pilot AGI-sny
**Status**: Design Spec
**Milestone**: 6

## Problem Statement

Pilot AGI has all the "brain" pieces (memory, scheduling, escalation, checkpoint-respawn, overnight mode) but no **hands**. The PM daemon operates through file-based state and spawned headless processes (`claude -p`), which means:

```
TODAY:
                                    ┌─ Agent Tab 1 (manually opened)
                                    ├─ Agent Tab 2 (manually opened)
Human ──→ PM Daemon ──→ State Files ├─ Agent Tab 3 (manually opened)
                                    └─ ??? (PM thinks 6 exist, only 3 do)

Problems:
- PM can't open/close terminal tabs
- PM can't type into an agent's terminal to answer a question
- PM can't read what an agent is outputting in real-time
- PM can't answer agent permission prompts
- PM can't detect real tab count vs stale state file count
- Human must sit at keyboard for escalations, approvals, tab management
- Human can't interact from phone/remote
- Overnight runs stall when agents ask questions
```

## Proposed Architecture

Two new layers that give PM physical control and remote human access:

```
PROPOSED:

┌──────────────────────────────────────────────────────────────┐
│  You (Human)                                                  │
│    ├── PM Terminal (primary interface)                         │
│    └── Telegram (remote/mobile interface)                     │
└───────────────┬──────────────────────────┬────────────────────┘
                │                          │
┌───────────────▼──────────────────────────▼────────────────────┐
│  PM Daemon (brain)                                             │
│    ├── terminal-controller.js (hands)                          │
│    │     ├── AppleScript provider (Terminal.app — default)     │
│    │     └── iTerm2 provider (Python API — premium)            │
│    │                                                           │
│    └── telegram-bridge.js (remote voice)                       │
│          └── Telegram Bot ←→ Human's phone                    │
└───────────────┬───────────────────────────────────────────────┘
                │
    ┌───────────┼───────────┐
    ▼           ▼           ▼
┌────────┐ ┌────────┐ ┌────────┐
│ Tab 1  │ │ Tab 2  │ │ Tab N  │   Actual terminal tabs
│Backend │ │Frontend│ │ Test   │   PM opens/reads/types/closes
└────────┘ └────────┘ └────────┘
```

## Design Principles

1. **AppleScript is the foundation** — Works with any macOS terminal (Terminal.app, iTerm2, Warp). `osascript` is the universal control layer that gives PM physical hands.
2. **iTerm2 is the premium upgrade** — Python API adds stable session IDs, triggers, event hooks, cleaner output reading. Optional enhancement, not requirement.
3. **PM is the brain, terminals are the body** — PM decides what to do, terminal controller executes physical actions.
4. **Intent, not commands** — Telegram messages are natural language intent; PM interprets and decides action.
5. **Ground truth from terminals** — Real tab count from AppleScript/iTerm2 is authoritative, not state files.
6. **Graceful degradation** — If terminal control fails, fall back to existing `claude -p` headless mode.
7. **Security by default** — Telegram bot only accepts messages from configured user ID; no raw shell passthrough.

## Components

### 1. AppleScript Bridge (`applescript-bridge.js`)

The core foundation. Uses `osascript` via `child_process.execSync` to control any macOS terminal. This is the "motor cortex" — every terminal action goes through here.

```javascript
// AppleScript can:
// - Open new tabs:      tell application "Terminal" to do script "command"
// - Type into tabs:     tell application "System Events" to keystroke "text"
// - Read tab output:    tell application "Terminal" to get contents of tab X
// - Close tabs:         tell application "Terminal" to close tab X
// - Count tabs:         tell application "Terminal" to count tabs of window 1
// - Set tab titles:     set custom title of tab X to "name"
// - Prevent sleep:      do shell script "caffeinate -dims &"
// - Show dialogs:       display dialog "message" — for human escalation

class AppleScriptBridge {
    constructor(terminalApp = 'Terminal') {
        this.app = terminalApp; // 'Terminal' or 'iTerm'
    }

    // Open a new tab and run a command in it
    async openTab(command, title) {
        const script = `
            tell application "${this.app}"
                activate
                set newTab to do script "${command}"
                set custom title of newTab to "${title}"
                return id of newTab
            end tell
        `;
        return execSync(`osascript -e '${script}'`).toString().trim();
    }

    // Type text into a specific tab (matched by custom title)
    async sendToTab(tabTitle, text) {
        const script = `
            tell application "${this.app}"
                repeat with w in windows
                    repeat with t in tabs of w
                        if custom title of t is "${tabTitle}" then
                            set selected of t to true
                            tell application "System Events"
                                keystroke "${text}"
                                keystroke return
                            end tell
                        end if
                    end repeat
                end repeat
            end tell
        `;
        execSync(`osascript -e '${script}'`);
    }

    // Read current content of a tab (raw terminal output)
    async readTab(tabTitle) {
        const script = `
            tell application "${this.app}"
                repeat with w in windows
                    repeat with t in tabs of w
                        if custom title of t is "${tabTitle}" then
                            return contents of t
                        end if
                    end repeat
                end repeat
            end tell
        `;
        const raw = execSync(`osascript -e '${script}'`).toString();
        return this._stripAnsi(raw);
    }

    // List all open tabs with titles and busy state
    async listTabs() {
        // Returns: [{ windowIndex, tabIndex, title, busy }]
    }

    // Close a specific tab by title
    async closeTab(tabTitle) { ... }

    // Show native macOS dialog for human escalation
    async showDialog(message, buttons) {
        // display dialog "${message}" buttons ${buttons} default button 1
    }

    // Prevent macOS sleep while agents work
    async preventSleep(pid) {
        // do shell script "caffeinate -dims -w ${pid} &"
    }
}
```

**Why AppleScript first:**
- Works with Terminal.app (pre-installed on every Mac)
- Works with iTerm2 (same `tell application "iTerm"` syntax)
- Works even with Warp (basic `tell application "Warp"`)
- Zero dependencies — `osascript` is built into macOS
- User doesn't need to install anything extra

### 2. iTerm2 Provider (`iterm2-bridge.py`) — Premium Upgrade

Python script using the `iterm2` package (ships with iTerm2). Activated when iTerm2 is detected with Python API enabled.

```python
# Advantages over AppleScript:
# - Stable session UUIDs (not fragile title matching)
# - Clean output reading (no ANSI codes in response)
# - Event hooks: on_new_session, on_output, on_close
# - Triggers: regex → auto-action (auto-approve permissions!)
# - Badges: visual agent identification on tabs
# - Split panes: multiple agents in one window

import iterm2

async def main(connection):
    app = await iterm2.async_get_app(connection)

    async def open_agent(role, task_id, prompt):
        window = app.current_window
        tab = await window.async_create_tab()
        session = tab.current_session
        await session.async_set_variable("user.badge", f"{role}-{task_id}")
        await session.async_send_text(f'claude --resume "/pilot-exec"\n')
        return session.session_id  # Stable UUID — no title fragility

    async def read_output(session_id, lines=50):
        session = app.get_session_by_id(session_id)
        contents = await session.async_get_contents()
        # Structured LineContents — no ANSI parsing needed
        return contents

    async def detect_state(session_id):
        session = app.get_session_by_id(session_id)
        contents = await session.async_get_contents()
        last_lines = contents[-5:]
        if any("Allow?" in l or "permission" in l for l in last_lines):
            return "permission_prompt"
        if any(l.strip().endswith(">") for l in last_lines):
            return "idle"
        return "working"

    # iTerm2 Triggers: zero-latency auto-approve (no polling!)
    async def setup_triggers(session_id):
        trigger = iterm2.Trigger(
            regex=r"Do you want to proceed\?|Allow\?|Approve\?",
            action=iterm2.TriggerAction.SEND_TEXT,
            parameter="y\n"
        )
        # Applied per-profile for agent sessions
```

### 3. Terminal Controller (`terminal-controller.js`)

Unified interface PM daemon uses. Abstracts over both providers:

```javascript
class TerminalController {
    constructor(options = {}) {
        // Auto-detect best available provider
        this.provider = options.provider || this._detectProvider();
        // 'applescript' → AppleScriptBridge (default, works everywhere)
        // 'iterm2'      → iTerm2Bridge (premium, auto-detected)

        this.registry = new Map(); // tabId → { role, taskId, startedAt }
        this.syncInterval = options.syncInterval || 10_000;
    }

    _detectProvider() {
        // 1. Check if iTerm2 running + Python API enabled → 'iterm2'
        // 2. Else → 'applescript' (always available on macOS)
    }

    // ── Core Operations (PM's hands) ──

    async openAgent(role, taskId, prompt)     // Open tab, run claude agent
    async sendInput(tabId, text)              // Type into specific tab
    async readOutput(tabId, lines = 50)       // Read terminal content
    async closeAgent(tabId)                   // Close tab
    async listRealTabs()                      // Ground truth tab inventory
    async detectState(tabId)                  // working | idle | waiting | permission

    // ── High-Level Operations (PM's intelligence) ──

    async autoApprove(tabId, policy)          // Detect prompt → approve per policy
    async answerQuestion(tabId, context)      // Agent asked Q → PM generates answer
    async syncRegistry()                      // Reconcile map with real tabs
    async scaleAgents(desired, roles)         // Open/close tabs to target count
    async broadcastToAll(text)                // Send same message to all agents
    async checkpointRespawn(tabId)            // Save state, restart in same tab

    // ── Monitoring (PM's eyes) ──

    async getGroundTruth()                    // { tabs, states, mismatch }
    async detectStalled(timeout = 120_000)    // Agents with no output for >2min
    async getTabMetrics()                     // Per-tab: uptime, output rate, state
}
```

### 4. PM Daemon Integration

New loop in `pm-daemon.js`:

```javascript
class PmDaemon {
    async init() {
        // ... existing init ...
        this.terminalController = new TerminalController({
            provider: this.config.terminal_orchestration?.provider || 'auto'
        });
    }

    // Terminal orchestration loop (every 10-15s, alongside existing loops)
    async _terminalScanLoop() {
        // 1. Sync — reconcile state files with real tabs
        const truth = await this.terminalController.getGroundTruth();
        if (truth.mismatch) this._reconcileState(truth);

        // 2. Check each tab state
        for (const [tabId, agent] of this.terminalController.registry) {
            const state = await this.terminalController.detectState(tabId);
            switch (state) {
                case 'permission_prompt':
                    await this._handlePermission(tabId, agent);
                    break;
                case 'idle':
                    await this._handleIdle(tabId, agent); // assign next task
                    break;
                case 'stalled':
                    await this._handleStalled(tabId, agent); // restart/escalate
                    break;
            }
        }

        // 3. Scaling decision
        const queueDepth = await this._getQueueDepth();
        const activeTabs = this.terminalController.registry.size;
        if (queueDepth > activeTabs * 2) {
            await this.terminalController.scaleAgents(activeTabs + 1);
        }
    }

    // Terminal-based spawn (replaces headless for interactive mode)
    async _spawnAgentViaTerminal(role, taskId, context) {
        const prompt = this._buildAgentPrompt(role, taskId, context);
        const tabId = await this.terminalController.openAgent(role, taskId, prompt);
        this._registerAgentSession(tabId, role, taskId);
    }
}
```

### 5. The Full Autonomous Flow

```
1. You open ONE terminal, run: /pilot-pm
   (or trigger via Telegram: "start working on ProjectX")

2. PM reads roadmap → plans Sprint 1 → identifies 8 tasks

3. PM via AppleScript opens 4 tabs:
   ┌─────────────────────────────────────────────┐
   │ Tab 1: pilot-backend-task12                  │
   │ Tab 2: pilot-backend-task13                  │
   │ Tab 3: pilot-frontend-task14                 │
   │ Tab 4: pilot-test-task15                     │
   └─────────────────────────────────────────────┘

4. PM types task context into each agent tab

5. PM monitors all tabs (every 10-30s loop):
   - Reads output → detects finished/blocked/asking
   - Agent finished       → sends next task or closes tab
   - Permission question  → auto-approves per policy
   - Agent stuck          → reads error, reassigns or helps
   - Context limit hit    → checkpoint-respawn in same tab
   - Agent idle           → assigns next queued task

6. Sprint 1 complete → PM runs tests → plans Sprint 2 → repeats

7. You interact ANY time:
   - PM terminal: "pause all", "skip task X"
   - Telegram: "prioritize the auth flow"
   - PM adjusts and continues

8. Overnight: agents self-manage, PM monitors,
   caffeinate prevents sleep, morning report → Telegram
```

### 6. Telegram Bridge (`telegram-bridge.js`)

Standalone Node.js service (runs as `launchd` daemon):

```javascript
class TelegramBridge {
    constructor(config) {
        this.botToken = config.botToken;          // from macOS Keychain / env
        this.allowedChatIds = config.chatIds;     // ONLY these user IDs
        this.pmInboxPath = config.pmInboxPath;
        this.pmOutboxPath = config.pmOutboxPath;
        this.rateLimit = config.rateLimit || 10;  // msgs/min
    }

    // ── Inbound: You on phone → PM ──

    async handleMessage(msg) {
        await this.validateSender(msg);      // chat ID allowlist
        await this.rateCheck(msg.from.id);   // token bucket
        const intent = this.parseIntent(msg.text);
        // "what's the status?"       → { action: 'status' }
        // "pause backend agents"     → { action: 'pause', scope: 'backend' }
        // "add dark mode idea"       → { action: 'idea', text: 'dark mode' }
        // "rm -rf /"                 → { action: 'unknown' } → REJECTED
        await this.writeToInbox(intent);
    }

    async handleCallbackQuery(query) { ... } // approve/reject buttons

    // ── Outbound: PM → Your phone ──

    async watchOutbox()                // Poll PM outbox → send to Telegram
    async sendStatus(chatId, data)     // Formatted progress update
    async sendEscalation(chatId, esc)  // With inline approve/reject buttons
    async sendMorningReport(chatId)    // Daily summary with stats

    // ── Security ──

    async validateSender(msg) {
        if (!this.allowedChatIds.includes(msg.from.id)) {
            this.audit('BLOCKED', msg);
            throw new Error('Unauthorized');
        }
    }
}
```

### 7. Security Module (`telegram-security.js`)

```javascript
const security = {
    // 1. Authentication: only configured Telegram user IDs (numeric)
    allowedUsers: new Set([/* from policy.yaml */]),

    // 2. Intent parsing: NL → structured action, NEVER raw shell
    parseIntent(text) {
        // "pause all"          → { action: 'pause', scope: 'all' }
        // "what's the status?" → { action: 'status' }
        // "add stripe idea"    → { action: 'idea', text: 'add stripe' }
        // Raw shell commands   → { action: 'unknown' } → REJECTED
    },

    // 3. Dangerous actions require double confirmation
    requiresConfirmation: ['pause_all', 'cancel_sprint', 'kill_agent', 'reset'],

    // 4. Rate limiting
    maxPerMinute: 10,
    maxPerHour: 100,

    // 5. Kill switch — immediately stops everything
    lockdownPhrase: 'LOCKDOWN',

    // 6. Audit trail — every interaction logged with timestamp
    logEvery: true,
};
```

**Security Invariant**: Telegram messages are INTENT. PM is the firewall. No raw text ever reaches `exec()`, `spawn()`, or terminal input. PM interprets intent through its normal policy layer.

### 8. Policy Configuration

New sections in `policy.yaml`:

```yaml
terminal_orchestration:
  enabled: true
  provider: auto              # auto | applescript | iterm2
  sync_interval_ms: 10000
  tab_title_prefix: "pilot"
  auto_approve:
    enabled: true
    allowed_tools: [Read, Glob, Grep, Write, Edit]
    require_confirmation: [Bash, push, deploy, delete]
  stall_detection:
    timeout_ms: 120000
    action: restart            # restart | escalate | ignore
  scaling:
    min_agents: 1
    max_agents: 8
    scale_up_ratio: 2.0
    scale_down_cooldown_ms: 300000
  sleep_prevention:
    enabled: true

telegram:
  enabled: false               # opt-in only
  allowed_chat_ids: []         # numeric Telegram user IDs
  rate_limit:
    per_minute: 10
    per_hour: 100
  proactive_updates:
    sprint_complete: true
    budget_alert: true
    escalation: true
    morning_report: true
    agent_stall: true
  confirmation_required:
    - pause_all
    - cancel_sprint
    - kill_agent
    - change_priority
  audit_log: true
  kill_switch_phrase: "LOCKDOWN"
```

## Phases

### Phase 6.1: AppleScript Bridge Foundation
- `applescript-bridge.js` — open/close/send/read/list/detect for Terminal.app
- Tab identification via custom titles (`pilot-<role>-<taskId>`)
- ANSI code stripping for clean output reading
- State detection regex (permission prompt, idle, working, stalled)
- Race condition handling (wait for idle before sending input)
- Unit tests for all operations
- **Standalone module — no PM integration yet**

### Phase 6.2: iTerm2 Premium Provider
- `iterm2-bridge.py` using iTerm2 Python API
- Stable session UUIDs (no title-matching fragility)
- Trigger-based auto-approve (zero latency, no polling)
- Event hooks for instant crash detection
- Badge support for visual agent identification
- Auto-detection: iTerm2 running → Python API, else → AppleScript

### Phase 6.3: Terminal Controller (Unified Interface)
- `terminal-controller.js` abstracting both providers
- Provider auto-detection on startup
- Registry: tabId → { role, taskId, state }
- Sync loop: reconcile registry with real terminal tabs
- High-level ops: scaleAgents, autoApprove, checkpointRespawn

### Phase 6.4: PM Daemon Terminal Integration
- `_terminalScanLoop()` in pm-daemon.js
- Terminal-based spawning alongside existing headless mode
- Ground truth reconciliation (real tabs vs state files)
- Permission auto-approve per policy
- Stall detection → restart or escalate
- Dynamic scaling based on queue depth

### Phase 6.5: Telegram Bridge
- Telegram bot (BotFather token + chat ID)
- `telegram-bridge.js` as launchd daemon
- Inbound: message → intent parse → PM inbox
- Outbound: PM outbox → Telegram
- Security: chat ID allowlist, rate limiting, audit log
- Kill switch: "LOCKDOWN"

### Phase 6.6: Telegram Approval & Conversations
- Escalation → Telegram with inline approve/reject buttons
- Timeout escalation if no response in N minutes
- Morning report + sprint progress delivery
- NL queries: "what's the status?" → PM answers
- Idea capture: "add dark mode" → PM creates bd task

### Phase 6.7: End-to-End Integration & Testing
- Full flow: Telegram → PM → terminals → agents → Telegram report
- Failover: iTerm2 → AppleScript → headless
- Security: unauthorized blocked, rate limits enforced
- Overnight: Telegram at 8pm → morning report at 8am
- Multi-sprint: 50 tasks, fully autonomous
- Chaos: kill random tabs → PM detects and recovers

## Dependencies

```
Wave 1: 6.1 (AppleScript bridge — zero deps)
Wave 2: 6.2 (iTerm2, needs 6.1 interface), 6.5 (Telegram, standalone)
Wave 3: 6.3 (controller, needs 6.1+6.2), 6.6 (approval, needs 6.5)
Wave 4: 6.4 (PM integration, needs 6.3)
Wave 5: 6.7 (E2E testing, needs all)
```

## Migration Path

Additive — existing infrastructure kept as fallback:

```
EXISTING (kept, zero changes):
  pm-daemon.js → process-spawner.js → claude -p (headless)

NEW (primary when terminal available):
  pm-daemon.js → terminal-controller.js → applescript-bridge.js → Terminal tabs
                                        └→ iterm2-bridge.py → iTerm2 tabs

DETECTION ORDER:
  1. iTerm2 running + Python API enabled → iterm2-bridge.py
  2. Terminal.app available              → applescript-bridge.js
  3. Headless / SSH / CI                 → process-spawner.js (existing)
```

Zero breaking changes. Existing headless mode remains fully functional.

## Success Criteria

- [ ] PM opens/closes terminal tabs via AppleScript — zero manual tab management
- [ ] AppleScript works with Terminal.app out of the box (no extra installs)
- [ ] iTerm2 auto-detected and used when available (stable UUIDs, triggers)
- [ ] PM real tab count matches internal state (ground truth)
- [ ] Permission prompts auto-approved within 5s per policy
- [ ] Stalled agents detected and restarted within 2 minutes
- [ ] Agent pool scales 1→8 on queue depth, back to 1 on idle
- [ ] Telegram message → PM processes within 10s
- [ ] Escalation → Telegram with approve/reject buttons
- [ ] Overnight: Telegram at 8pm → morning report at 8am, zero intervention
- [ ] Unauthorized Telegram user blocked + audit logged
- [ ] Full sprint (20 tasks) with PM managing all terminals autonomously
- [ ] Fallback chain: iTerm2 → AppleScript → headless on failure
