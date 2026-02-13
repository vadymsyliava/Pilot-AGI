# Milestone 6: Physical Terminal Control & Remote Human Interface

**Goal**: Give PM daemon physical control over macOS terminals via AppleScript (foundation) and iTerm2 Python API (premium). Add Telegram bot for remote human interaction. PM opens/closes tabs, types into agents, reads output, auto-approves prompts, scales agent pool, and reports to human via Telegram. The human only needs one PM terminal — or just their phone.

**Target**: v5.0.0
**Spec**: `work/specs/iterm2-orchestration-telegram.md`
**Estimated scope**: ~32 tasks across 7 phases

## The Problem (What M5 Still Requires Humans For)

M5 achieved autonomous intelligence — agents approve their own plans, resolve merge conflicts, generate tests, and scale dynamically. But the PM daemon still has no **physical hands**:

1. **PM can't open terminal tabs** — Agents are headless `claude -p` processes. No visible terminal for debugging or observation.
2. **PM can't type into agents** — When an agent asks a question or needs a permission prompt answered, PM has no way to send keystrokes.
3. **PM can't read real terminal output** — Only sees what agents write to logs. Can't detect permission dialogs, crash output, or interactive prompts.
4. **PM can't detect real tab count** — State files may say 6 agents running, but only 3 terminals exist. No ground truth.
5. **PM can't answer permission prompts** — Claude Code asks "Allow?" → agent blocks forever. Overnight runs stall.
6. **Human must be at keyboard** — Escalations go to log files. No push notifications, no mobile approval.
7. **No remote interaction** — Human can't check status or approve work from their phone.

## The Architecture Shift

```
BEFORE (M5):                          AFTER (M6):
┌──────────────────────┐              ┌────────────────────────────┐
│ PM spawns headless   │              │ PM opens real terminal tabs │
│ claude -p processes  │              │ via AppleScript/iTerm2     │
│ No visual feedback   │              │ Reads output, types input  │
└──────────────────────┘              └────────────────────────────┘
┌──────────────────────┐              ┌────────────────────────────┐
│ Escalations → log    │              │ Escalations → Telegram     │
│ file only            │              │ with approve/reject buttons│
└──────────────────────┘              └────────────────────────────┘
┌──────────────────────┐              ┌────────────────────────────┐
│ Human must be at     │              │ Human approves from phone  │
│ keyboard for prompts │              │ PM auto-approves per policy│
└──────────────────────┘              └────────────────────────────┘
```

Key insight: **AppleScript is the universal macOS terminal controller. iTerm2 is the premium upgrade. Telegram is the remote voice. Existing headless mode is the fallback.**

---

## Stream A: Terminal Orchestration

### Phase 6.1: AppleScript Bridge Foundation
**Problem**: PM has no way to physically interact with terminal applications.

**Deliverables**:
- `applescript-bridge.js` — Core module using `osascript` to control Terminal.app
- Operations: openTab, closeTab, sendToTab, readTab, listTabs, detectState
- Tab identification via custom titles (`pilot-<role>-<taskId>`)
- ANSI code stripping for clean output reading
- State detection regex (permission prompt, idle, working, stalled)
- Race condition handling (wait for idle before sending input)
- Accessibility permission detection and user guidance
- Unit tests with mocked osascript calls

### Phase 6.2: iTerm2 Premium Provider
**Problem**: AppleScript has limitations — no stable session IDs, no structured output, no event hooks.

**Deliverables**:
- `iterm2-bridge.py` — Python script using iTerm2's Python API
- Stable session UUIDs (no title-matching fragility)
- Trigger-based auto-approve (regex → send "y\n", zero latency)
- ScreenStreamer for real-time output monitoring
- Badge support for visual agent identification on tabs
- Split pane creation for multi-agent layouts
- Auto-detection: iTerm2 running + API enabled → use Python API

### Phase 6.3: Terminal Controller (Unified Interface)
**Problem**: PM shouldn't care which provider is active. Need unified API.

**Deliverables**:
- `terminal-controller.js` abstracting AppleScript and iTerm2 providers
- Provider auto-detection on startup (iTerm2 → AppleScript → headless fallback)
- Registry: tabId → { role, taskId, state, startedAt }
- Sync loop: reconcile registry with real terminal tabs (ground truth)
- High-level operations: scaleAgents, autoApprove, checkpointRespawn, broadcastToAll

### Phase 6.4: PM Daemon Terminal Integration
**Problem**: PM daemon needs to use terminal controller in its scan loops.

**Deliverables**:
- `_terminalScanLoop()` in pm-daemon.js (alongside existing loops)
- Terminal-based spawning: `openAgent()` alongside existing headless `claude -p`
- Ground truth reconciliation (real tabs vs state files)
- Permission auto-approve per policy configuration
- Stall detection → restart or escalate
- Dynamic scaling based on queue depth vs active tabs

---

## Stream B: Remote Human Interface

### Phase 6.5: Telegram Bridge
**Problem**: Human has no remote interface. Must be at keyboard for all interactions.

**Deliverables**:
- `telegram-bridge.js` — Telegram bot running as launchd daemon
- Long polling mode (no public server needed)
- Inbound: message → intent parse → PM inbox (never raw shell passthrough)
- Outbound: PM outbox → Telegram (formatted status, logs, alerts)
- Security: chat ID allowlist, rate limiting (10/min, 100/hr), audit log
- Kill switch: "LOCKDOWN" phrase stops all agents immediately
- Bot token stored in macOS Keychain or environment variable

### Phase 6.6: Telegram Approval & Conversations
**Problem**: Escalations need human response. Can't wait for human to sit down at keyboard.

**Deliverables**:
- Escalation → Telegram with inline approve/reject buttons
- Timeout escalation if no response in N minutes
- Morning report delivery (overnight summary with stats)
- NL queries: "what's the status?" → PM generates and sends answer
- Idea capture: "add dark mode" → PM creates bd task
- Sprint progress updates pushed proactively

---

## Stream C: Integration

### Phase 6.7: End-to-End Integration & Testing
**Problem**: All components need to work together reliably.

**Deliverables**:
- Full flow test: Telegram → PM → terminals → agents → Telegram report
- Failover testing: iTerm2 → AppleScript → headless on failure
- Security testing: unauthorized Telegram user blocked + audit logged
- Overnight test: Telegram start at 8pm → morning report at 8am
- Chaos testing: kill random tabs → PM detects and recovers
- Multi-sprint test: 50 tasks, fully autonomous

---

## Dependencies

```
Wave 1: 6.1 (AppleScript bridge — zero deps)
Wave 2: 6.2 (needs 6.1 interface), 6.5 (Telegram — standalone)
Wave 3: 6.3 (needs 6.1+6.2), 6.6 (needs 6.5)
Wave 4: 6.4 (needs 6.3)
Wave 5: 6.7 (needs all)
```

## Platform Requirements

- **macOS only** — AppleScript and iTerm2 are macOS-exclusive
- **Accessibility permissions** — Required for keystroke simulation
- **iTerm2 Python API** — Optional; requires manual enable in iTerm2 preferences
- **Telegram bot** — Optional; requires BotFather token and chat ID
- **Fallback** — Existing headless `claude -p` mode works on all platforms

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
