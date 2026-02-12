# Milestone 4: Process Control & Immortal Agents

**Goal**: Transform Pilot AGI from "agents are Claude sessions" to "agents are managed processes". PM Daemon spawns, monitors, checkpoints, and respawns Claude processes. Sessions are ephemeral; progress lives in git and checkpoints. The system runs overnight without human intervention.

**Target**: v3.0.0

## The Problem (What M3 Got Wrong)

M3 built autonomy features assuming Claude sessions are long-lived agents. In reality:

1. **Sessions die silently** — `/clear`, `/compact`, or context exhaustion kills the session but the terminal stays open. Session file remains "active" forever.
2. **PM can't reach agents** — The message bus is write-only. Idle agents never poll. Delegation messages go unread.
3. **Zombie sessions accumulate** — No clean end signal → PM sees ghost agents, wastes slots, makes bad decisions.
4. **Context window = agent lifetime** — When context fills, the agent dies. M3's checkpoint system saves state but nobody respawns the agent.
5. **PM is a Claude session too** — It has the same context limit problem it's supposed to solve.

## The Architecture Shift

```
BEFORE (M3):                        AFTER (M4):
┌──────────────┐                    ┌──────────────────────┐
│ Claude Session│ = Agent            │ PM Daemon (Node.js)  │ ← Immortal, no context limit
│ (ephemeral)  │                    │ Spawns/monitors/     │
│ Dies at 60%  │                    │ respawns processes    │
└──────────────┘                    └──────┬───────────────┘
                                          │ spawns
                                    ┌─────▼─────────────┐
                                    │ claude -p "task X" │ ← Ephemeral worker
                                    │ Exits when done or │
                                    │ at 60% context     │
                                    └─────┬─────────────┘
                                          │ writes
                                    ┌─────▼─────────────┐
                                    │ Checkpoint + Git   │ ← Durable progress
                                    │ Survives restarts  │
                                    └───────────────────┘
```

Key insight: **Sessions come and go. Progress lives in git + checkpoints. The PM daemon is the immortal thread.**

---

## Phase 4.1: Session Lifecycle Overhaul

**Problem**: Sessions have no clean death signal. `/clear` and context exhaustion leave zombie "active" sessions.

**Deliverables**:
- Session end hook: fires on process exit (SIGTERM, SIGINT, exit event) — marks session as ended
- Liveness verification: PM checks `kill -0 <pid>` before trusting session status
- Zombie reaper: periodic sweep marks sessions as ended if PID is dead
- Session archival: move old session files (>24h ended) to `sessions/archive/`
- Clean state guarantee: at any time, "active" sessions = actually running processes

**Files**: `session.js`, `pm-daemon.js`

---

## Phase 4.2: Process Spawner v2

**Problem**: Current `_spawnAgent()` sends a one-shot prompt. No checkpoint injection, no worktree setup, no structured context.

**Deliverables**:
- Context-aware spawn: inject checkpoint state, plan progress, research findings into prompt
- Worktree-per-agent: auto-create git worktree before spawn, cleanup on exit
- Structured task file: write `.claude/pilot/state/task-contexts/<taskId>.md` with full context, agent reads on start
- Resume-aware: if checkpoint exists, spawn prompt says "resume from step N" not "start fresh"
- Agent profile injection: model, budget, permissions, skill scope per agent type
- Spawn verification: confirm session file appears within 10s, retry if not

**Files**: `pm-daemon.js`, `orchestrator.js`, new `spawn-context.js`

---

## Phase 4.3: Checkpoint-Respawn Loop

**Problem**: Checkpoint system (3.5) saves state at 60% context but nobody respawns the agent. The task stalls.

**Deliverables**:
- Exit-on-checkpoint: when pressure hits 60%, agent saves checkpoint and **exits** (not just compacts)
- PM detects exit: daemon's child process `on('exit')` handler triggers respawn logic
- Respawn with checkpoint: PM reads checkpoint, builds new context, spawns fresh Claude process
- Continuity protocol: new session gets plan, completed steps, current step, test results, relevant code snippets
- Step verification: on resume, agent validates previous steps' git commits exist before continuing
- Max respawn limit: configurable cap (default 10) to prevent infinite loops on stuck tasks

**Files**: `pm-daemon.js`, `checkpoint.js`, `pm-pressure-monitor.js`, `spawn-context.js`

---

## Phase 4.4: PM Daemon as Pure Node.js

**Problem**: PM is currently a Claude session (`/pilot-pm` skill) with its own context limit. It can't run forever.

**Deliverables**:
- Standalone daemon: `pm-daemon.js --watch` is the **only** PM — no Claude session needed
- AI-assisted decisions: for complex decisions (merge review, task decomposition), daemon makes short `claude` API calls via `claude -p "review this diff" --output-format json`
- Decision types:
  - **Mechanical** (no AI): spawn, health check, cleanup, budget check → pure Node.js
  - **Judgment** (short AI call): merge review, task decomposition, conflict resolution → one-shot `claude -p`
- Log everything: all decisions logged to `pm-daemon.log` and event stream
- Dashboard via CLI: `node pm-daemon.js --status` prints current state (replaces `/pilot-pm` Claude session)
- Web dashboard (stretch): optional `localhost:3847` for real-time monitoring

**Files**: `pm-daemon.js`, `pm-loop.js`, new `pm-decisions.js`

---

## Phase 4.5: Terminal Management

**Problem**: Agents are invisible processes. No way to see what they're doing, no terminal output.

**Deliverables**:
- Log streaming: each agent writes to `.claude/pilot/logs/agent-<taskId>.log`
- Tail command: `node pm-daemon.js --tail <taskId>` streams agent output
- Process table: `node pm-daemon.js --ps` shows all running agents with PID, task, duration, context %
- Kill command: `node pm-daemon.js --kill <taskId>` gracefully stops an agent
- tmux integration (optional): if running in tmux, PM can create panes showing live agent output

**Files**: `pm-daemon.js`, new `agent-logger.js`

---

## Phase 4.6: Reliable Task Handoff

**Problem**: When agent exits (checkpoint, crash, or completion), task state can be inconsistent. Partially committed work, uncommitted changes, broken tests.

**Deliverables**:
- Pre-exit protocol: before exiting, agent stashes uncommitted changes, writes checkpoint, updates bd status
- Post-exit validation: PM verifies last commit matches expected plan step
- Dirty worktree handling: if agent died mid-edit, PM can: (a) stash and resume, (b) reset to last commit, (c) reassign
- Test gate on resume: new agent runs tests for previous steps before continuing
- Handoff report: checkpoint includes "what I was doing, what worked, what failed"

**Files**: `checkpoint.js`, `recovery.js`, `spawn-context.js`

---

## Phase 4.7: Multi-Agent Coordination v2

**Problem**: Agents can't coordinate because they can't reach each other. Current message bus assumes long-lived listeners.

**Deliverables**:
- File-based contracts: agent A writes output contract (API spec, type definitions) to shared location; agent B reads on start
- Dependency-aware spawning: PM doesn't spawn task Y until task X's output files exist
- Shared artifact registry: `.claude/pilot/state/artifacts/<taskId>/` contains outputs other tasks depend on
- Blocking resolution: if agent B needs something from agent A, PM detects the block and prioritizes A
- Progress broadcasting: agents write progress to state file; PM aggregates for dashboard

**Files**: `orchestrator.js`, `scheduler.js`, new `artifact-registry.js`

---

## Phase 4.8: Overnight Mode

**Problem**: System should run a large task set unattended for hours (the "set at 2pm, done by morning" scenario).

**Deliverables**:
- Task queue seeding: `node pm-daemon.js --plan "build auth system"` decomposes and queues tasks
- Full lifecycle: decompose → research → spawn → work → checkpoint → respawn → complete → next task
- Error budget: configurable failure tolerance (e.g., 3 consecutive failures → pause and alert)
- Progress report: periodic summary to `pm-daemon.log` and optional webhook/email
- Graceful shutdown: `node pm-daemon.js --drain` stops spawning, lets active agents finish
- Morning report: `node pm-daemon.js --report` shows what happened overnight (tasks completed, failures, time, cost)

**Files**: `pm-daemon.js`, `pm-loop.js`, new `reporter.js`

---

## Dependencies

```
Wave 1 (Independent):
  4.1  Session Lifecycle Overhaul — no deps, fixes foundation
  4.4  PM as Pure Node.js — no deps, refactors daemon
  4.5  Terminal Management — no deps, observability

Wave 2:
  4.2  Process Spawner v2 (needs 4.1 + 4.4)
  4.6  Reliable Task Handoff (needs 4.1)

Wave 3:
  4.3  Checkpoint-Respawn Loop (needs 4.2 + 4.6)
  4.7  Multi-Agent Coordination v2 (needs 4.2 + 4.6)

Wave 4:
  4.8  Overnight Mode (needs all above)
```

## Success Criteria

- [ ] PM Daemon runs as pure Node.js — no Claude session, no context limit
- [ ] `kill -0 <pid>` used for liveness — no more zombie sessions
- [ ] Agent hits 60% context → exits → PM respawns with checkpoint → continues from exact step
- [ ] Respawn cycle works 10+ times on a large task without losing progress
- [ ] `node pm-daemon.js --ps` shows real-time process table
- [ ] `node pm-daemon.js --status` shows full system state (replaces `/pilot-pm`)
- [ ] Task with 20 steps completes across 4+ context windows seamlessly
- [ ] Overnight mode: queue 10 tasks at 8pm → 7+ completed by 8am
- [ ] Total cost per overnight run tracked and reported
- [ ] Zero zombie sessions after 24h of operation

## What Changes from M3

| M3 (Current) | M4 (New) |
|--------------|----------|
| PM is a Claude session (`/pilot-pm`) | PM is a Node.js daemon |
| Agents are Claude sessions in terminals | Agents are spawned/managed processes |
| Checkpoint saves state, human restarts | Checkpoint → auto-exit → auto-respawn |
| Message bus for communication | File-based contracts + artifact registry |
| Heartbeat trusts session files | Heartbeat checks actual PID liveness |
| Agent dies = task stalls | Agent dies = PM respawns in 30s |
| Manual terminal management | Process table, logs, tail, kill |
| "Open 5 terminals" | `pm-daemon.js --watch` handles everything |
