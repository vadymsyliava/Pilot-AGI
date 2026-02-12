# Roadmap

## Overview

Pilot AGI is an AI-powered development orchestrator for Claude Code. It coordinates multiple AI agents across terminals to build products autonomously with governance, shared memory, and design consistency.

---

## Milestone 1: Governance Foundation (COMPLETE)

**Goal**: Build the core governance layer — hooks, session management, task coordination, policy enforcement
**Status**: Complete (42/42 tasks closed, Jan 2026)

### What Was Delivered
- 4 governance hooks (session-start, pre-tool-use, user-prompt-submit, quality-gate)
- Session management with heartbeats, area locking, task leasing
- Policy-as-code engine (policy.yaml)
- Agent registry with 5 specialized agents and routing rules
- Event stream (sessions.jsonl) for audit trail
- 15+ skills for the canonical workflow loop
- Teleport support for session continuity
- npm package (pilot-agi v0.0.4)

---

## Milestone 2: Multi-Agent Platform + Diamond Design System (COMPLETE)

**Goal**: Enable unlimited parallel Claude Code terminals working on the same project with shared memory, isolated worktrees, design token governance, and a PM orchestrator agent
**Status**: Complete (all 10 phases closed, Feb 2026)
**Target**: v1.0.0

### Stream A: Multi-Agent Infrastructure

#### Phase 2.1: Worktree Engine
- Git worktree lifecycle (create/remove per session)
- Branch-per-task automation (claim task = get worktree)
- Merge-back protocol with conflict detection
- Worktree cleanup on session end or task close
- Integration with existing session-start hook

#### Phase 2.2: Shared Memory Layer
- `.claude/pilot/memory/` directory structure
- Global shared memory (shared.json) for cross-agent knowledge
- Per-agent memory files for learned preferences
- Publish/subscribe API for knowledge updates
- Schema contracts (agent A publishes, agent B consumes)
- Design tokens as first shared memory consumer

#### Phase 2.3: Inter-Agent Messaging
- Message queue via event stream (type: "agent_message")
- Cross-terminal message delivery (file-based polling)
- Agents can create bd tasks for other agents
- Request/response protocol with priority levels
- Notification system for blocking requests

#### Phase 2.4: PM Orchestrator Agent
- Dedicated "team lead" terminal role
- Reads all session states, assigns tasks from bd
- Reviews completed work before merge approval
- Drift detection (agent vs. approved plan)
- Can reassign or block agents
- Human-facing coordination interface

#### Phase 2.5: Visibility Dashboard
- `/pilot-dashboard` skill for terminal-based overview
- Active agents, tasks, locked areas, worktree status
- Cost tracking per agent/task
- Drift alerts and health monitoring
- Optional local web UI (localhost)

### Stream B: Diamond Design System

#### Phase 2.6: Diamond Design Research
- User/business research framework (diamond methodology)
- Core user persona and business context analysis
- Design token schema specification (JSON format)
- Atomic design hierarchy definition (atoms > molecules > organisms > templates > pages)
- Design principles documentation

#### Phase 2.7: Token System
- Design tokens JSON files (single source of truth)
- Token categories: colors, spacing, padding, shadows, corner-radius, typography, breakpoints, z-index, animation
- Tailwind CSS integration (tokens map to Tailwind config)
- shadcn/ui integration (components consume tokens, not hardcoded values)
- Token validation and linting

#### Phase 2.8: Design Agent
- New agent in registry: "design" agent
- Token enforcement rules (YAML, like existing frontend/backend rules)
- Component audit capability (scan for hardcoded values)
- Design drift detection (changes that bypass tokens)
- Shared memory integration (tokens published as shared knowledge)
- Controls consistency across all UI work

#### Phase 2.9: Cross-Platform Token Export
- Web: CSS custom properties + Tailwind config generation
- iOS: SwiftUI Color/Font asset generation
- Android: XML resource file generation
- Automated conversion scripts (token JSON -> platform files)
- CI hook for regeneration on token changes

### Dependencies
```
Independent (Wave 1): 2.1, 2.2, 2.3, 2.6
Wave 2: 2.4 (needs 2.1+2.3), 2.7 (needs 2.2+2.6)
Wave 3: 2.5 (needs 2.4), 2.8 (needs 2.7), 2.9 (needs 2.7)
```

### What Was Delivered
- Worktree engine with branch-per-task isolation
- Shared memory with 4 channels (design-tokens, api-types, component-registry, pm-decisions)
- Inter-agent message bus (bus.jsonl) with cursor-based reading
- PM orchestrator with drift detection, review, merge approval
- Visibility dashboard with health monitoring
- Diamond design research + token system (8 DTCG categories)
- Design agent with token enforcement and audit
- Cross-platform token export (web/iOS/Android) + CI validation
- Session Guardian with lockfile liveness and auto-claim
- Autonomous PM loop with watcher, queue, and stdin injection (2,522 lines)
- Pre-commit token enforcement hook + cost tracking per agent/task

### Success Criteria (validated 2026-02-11)
- [x] 4+ Claude Code terminals working in parallel without conflicts (6 max, worktree isolation)
- [x] Shared memory layer passes data between agents (4 channels, pub/sub, schema-validated)
- [x] Design tokens are SSOT consumed by all UI agents (203 tokens, 8 categories, pre-commit enforcement)
- [x] PM agent detects drift and coordinates work (30% threshold, assign/block/review/merge)
- [x] Dashboard shows real-time status of all active agents (7 views, 7 alert types, cost tracking)
- [x] Cross-platform token export produces valid assets (web/iOS/Android, 36 tests, CI validation)
- [x] shadcn/ui components enforced to use design tokens (4 must_not rules, audit + drift scripts)

---

## Milestone 3: Full Autonomy — "Open 5 Terminals and Walk Away"

**Goal**: Enable truly autonomous multi-agent operation. One PM terminal + N executor terminals that self-organize, self-heal, and deliver without human intervention. PM auto-researches best practices, decomposes big tasks, assigns to specialized agents, and manages the full lifecycle.
**Target**: v2.0.0

### Vision
```
You: Open 5 terminals, type "/pilot-start" in each
     Open 1 PM terminal, give it a big task
     Walk away. Come back to merged PRs.
```

### Stream A: Intelligent PM Brain

#### Phase 3.1: Agent Identity & Skill Registry
- Named agent roles: frontend, backend, testing, design, infra (not anonymous session IDs)
- Skill declaration on session start: "I can do X, Y, Z"
- Agent capability matching for task routing
- Session role persistence (agent restarts keep their identity)
- Agent affinity: prefer assigning related tasks to same agent
- Deliverables: Updated session.js with role field, skill registry JSON, agent-task matching algorithm

#### Phase 3.2: PM Auto-Research
- PM researches best practices before planning (web search, docs)
- Research output stored in `work/research/` and linked to task
- Pattern library: common solutions indexed for reuse
- Technology decision log: "we use X because Y"
- Automated dependency analysis (what packages/APIs needed)
- Deliverables: Research skill for PM, auto-research trigger on task assignment, research memory channel

#### Phase 3.3: Task Auto-Decomposition
- PM takes large task → breaks into subtasks with dependencies
- Subtask creation in bd with proper parent-child links
- Dependency graph: which subtasks can run in parallel
- Size estimation: classify tasks as S/M/L based on scope
- Re-decomposition: if subtask is still too large, break further
- Auto-dependency detection: infer task dependencies from code analysis (import graphs, shared files, API contracts, DB schema refs) rather than relying solely on PM reasoning
- Dependency validation: cross-check PM-declared deps against code-detected deps, flag missing or spurious edges
- Deliverables: Decomposition engine, bd subtask creation, dependency DAG builder, code-aware dependency detector

#### Phase 3.4: Intelligent Task Scheduler
- Skill-based routing: match task requirements to agent capabilities
- Load balancing: spread work across available agents
- Priority-aware: critical path tasks assigned first
- Dependency-aware: only assign tasks whose deps are complete
- Pre-loading: inject relevant memory context with task assignment
- Deliverables: Scheduler module, context injection on assign, priority queue

### Stream B: Agent Autonomy

#### Phase 3.5: Autonomous Context Window Management
- **The critical enabler**: agents must run indefinitely without human intervention on context pressure
- Auto-checkpoint at 60% threshold — no human trigger needed, post-tool-use hook saves state automatically
- Auto-compact: system programmatically triggers `/compact` when checkpoint is saved
- Auto-resume: new session detects checkpoint, loads it, continues from exact plan step
- PM context awareness: PM monitors all agents' context pressure, orchestrates compaction timing
- PM self-management: PM's own context window is also managed — saves PM state, compacts, resumes coordination
- Session continuity protocol: same task + same plan + same decisions = seamless transition across context windows
- Builds on existing infrastructure: pressure.js (60% tracking), checkpoint.js (state save/load), resume-context skill
- Missing piece today: the automation glue — detect → save → compact → resume without any human input
- Deliverables: Auto-checkpoint hook, programmatic compact trigger, auto-resume on session-start, PM pressure monitor

#### Phase 3.6: Agent Self-Activation
- Agents auto-start workflow on terminal open (`/pilot-start` → auto-claim → auto-plan → auto-exec)
- stdin injection from PM watcher triggers agent actions
- Agent polls inbox, picks up delegations, starts working
- No human intervention needed after initial terminal open
- Graceful idle: if no work, agent sleeps and wakes on bus event
- Deliverables: Auto-start hook, inbox polling loop, wake-on-message

#### Phase 3.7: Per-Agent Persistent Memory
- Each agent type maintains learned knowledge across sessions
- Decision log: "chose library X because Y" (survives restarts)
- Issue log: "task Z failed because of W" (prevents repeat mistakes)
- Project context: agent's understanding of the codebase evolves
- Memory loading on session start: agent resumes with full context
- Cross-agent memory queries: "what did the design agent decide about colors?"
- Deliverables: Agent memory writer in post-tool-use hook, memory loader in session-start, query API

#### Phase 3.8: Self-Healing & Recovery
- Agent crash → auto-detect → restore checkpoint → resume work
- Context compaction recovery: checkpoint saves before compaction (builds on 3.5)
- Stale agent → auto-release task → reassign to healthy agent
- Merge conflict → auto-rebase or escalate with clear diff
- Failed tests → auto-diagnose → fix or escalate
- Deliverables: Recovery protocol, checkpoint-on-crash, auto-reassign on stale

#### Phase 3.9: Agent-to-Agent Collaboration
- Direct agent communication without PM intermediary
- "Hey frontend agent, what's the API contract?" → response
- Shared working context: agents on related tasks see each other's progress
- Blocking requests: "I need backend API done before I can proceed"
- Deliverables: Direct messaging protocol, shared context view, blocking request handler

### Stream C: Reliability & Observability

#### Phase 3.10: Reliable Message Bus
- ACK/NACK protocol: guaranteed message delivery
- Dead letter queue: failed messages get retried or escalated
- Message ordering guarantees within same sender
- Bus compaction: archive old messages, keep bus size bounded
- Priority queue: blocking messages processed before FYI
- Deliverables: ACK protocol, DLQ, compaction job, priority processing

#### Phase 3.11: Cost & Budget Management
- Token usage tracking per agent, per task, per session
- Budget limits: max tokens per task, per agent, per day
- Cost alerts: PM notified when agent approaches budget
- Efficiency metrics: tokens-per-line-of-code, tokens-per-task
- Budget-aware scheduling: cheaper agents for simple tasks
- Deliverables: Token counter hook, budget config, cost dashboard

#### Phase 3.12: Auto-Escalation Rules
- Configurable escalation policies (YAML)
- Drift detected → warning → block → reassign (progressive)
- Test failure → retry once → escalate to PM → escalate to human
- Budget exceeded → pause agent → notify PM → human decision
- Merge conflict → auto-rebase → manual merge → escalate
- Deliverables: Escalation engine, policy YAML schema, escalation event types

#### Phase 3.13: Performance Analytics
- Agent performance tracking: success rate, avg time, rework count
- Task complexity scoring: predicted vs actual effort
- Bottleneck detection: which tasks/agents slow down the pipeline
- Learning loop: PM uses history to optimize future assignments
- Sprint retrospective: auto-generated report on what went well/badly
- Deliverables: Analytics collector, performance dashboard, retrospective generator

### Dependencies
```
Independent (Wave 1): 3.1, 3.5, 3.7, 3.10
  3.1  Agent Identity — no deps
  3.5  Context Window Management — builds on existing pressure.js/checkpoint.js
  3.7  Per-Agent Memory — builds on existing memory.js
  3.10 Reliable Message Bus — builds on existing messaging.js

Wave 2: 3.2, 3.6, 3.9
  3.2  PM Auto-Research (needs 3.1 for agent routing)
  3.6  Agent Self-Activation (needs 3.1 for identity + 3.5 for auto-resume)
  3.9  Agent-to-Agent Collab (needs 3.10 for reliable bus)

Wave 3: 3.3, 3.8, 3.11
  3.3  Task Auto-Decomposition (needs 3.2 for research)
  3.8  Self-Healing & Recovery (needs 3.5 for checkpoints + 3.7 for memory + 3.10 for bus)
  3.11 Cost & Budget Management (needs 3.10 for reliable tracking)

Wave 4: 3.4, 3.12, 3.13
  3.4  Intelligent Scheduler (needs 3.1 + 3.3 for skills + decomposed tasks)
  3.12 Auto-Escalation (needs 3.11 for budget awareness)
  3.13 Performance Analytics (needs 3.11 for cost data)
```

### Success Criteria
- [ ] Open 5 executor terminals + 1 PM terminal → system self-organizes without human input
- [ ] PM decomposes "build authentication system" into 8+ subtasks automatically
- [ ] PM researches best practices (web search) before assigning tasks
- [ ] Agents remember decisions and issues from previous sessions
- [ ] Agents auto-compact at 60% context and resume seamlessly — no human intervention
- [ ] PM manages its own context window — compacts and resumes coordination autonomously
- [ ] Crashed agent auto-recovers and resumes from checkpoint
- [ ] Messages have guaranteed delivery with ACK protocol
- [ ] Token budget enforced — agents stop when budget exceeded
- [ ] Performance improves over time as PM learns from history
- [ ] A big task set at 2pm runs to completion overnight — terminals self-manage their context windows

---

## Milestone 4: Process Control & Immortal Agents (COMPLETE)

**Goal**: Transform agents from ephemeral Claude sessions into managed processes. PM Daemon (pure Node.js, no context limit) spawns, monitors, checkpoints, and respawns Claude processes automatically. Sessions are disposable; progress lives in git and checkpoints. The system runs overnight without human intervention.
**Status**: Complete (all 8 phases closed, Feb 2026)
**Target**: v3.0.0

### The Architecture Shift
- PM Daemon becomes a standalone Node.js process — not a Claude session
- Agents are spawned Claude processes (`claude -p`), not terminals you open manually
- Context pressure (60%) → checkpoint → exit → PM respawns with context → continues
- PID-based liveness checks replace heartbeat-only detection
- File-based contracts replace the message bus for cross-agent coordination

### Phases

#### Phase 4.1: Session Lifecycle Overhaul
- Process exit hooks mark sessions as ended
- PID liveness verification (`kill -0`) before trusting session status
- Zombie reaper: periodic sweep for dead-PID sessions
- Session archival for old ended sessions

#### Phase 4.2: Process Spawner v2
- Context-aware spawn: inject checkpoint + plan + research into prompt
- Worktree-per-agent: auto-create before spawn, cleanup on exit
- Structured task context files read by agent on start
- Resume-aware: "continue from step N" vs "start fresh"

#### Phase 4.3: Checkpoint-Respawn Loop
- Exit-on-checkpoint: 60% pressure → save state → exit cleanly
- PM detects exit → reads checkpoint → spawns fresh process
- Continuity protocol: plan, completed steps, test results carried forward
- Max respawn limit (default 10) to prevent infinite loops

#### Phase 4.4: PM Daemon as Pure Node.js
- `pm-daemon.js --watch` is the only PM — no Claude session needed
- Mechanical decisions (spawn, health, cleanup) in pure Node.js
- Judgment decisions (merge review, decomposition) via short `claude -p` calls
- CLI dashboard: `--status`, `--ps`, `--tail`, `--kill`

#### Phase 4.5: Terminal Management
- Per-agent log files with tail streaming
- Process table with PID, task, duration, context %
- Graceful kill command for individual agents
- Optional tmux pane integration

#### Phase 4.6: Reliable Task Handoff
- Pre-exit protocol: stash, checkpoint, update bd
- Post-exit validation: verify last commit matches plan step
- Dirty worktree recovery strategies
- Test gate on resume

#### Phase 4.7: Multi-Agent Coordination v2
- File-based output contracts between agents
- Dependency-aware spawning (don't start B until A's artifacts exist)
- Shared artifact registry per task
- PM-mediated blocking resolution

#### Phase 4.8: Overnight Mode
- `pm-daemon.js --plan "build X"` → auto-decompose → queue → execute
- Full lifecycle: decompose → research → spawn → work → checkpoint → respawn → complete
- Error budget with configurable failure tolerance
- Morning report: tasks completed, failures, time, cost

### Dependencies
```
Wave 1: 4.1, 4.4, 4.5  (independent)
Wave 2: 4.2 (4.1+4.4), 4.6 (4.1)
Wave 3: 4.3 (4.2+4.6), 4.7 (4.2+4.6)
Wave 4: 4.8 (all above)
```

### What Was Delivered
- Session lifecycle with PID-based liveness and proactive zombie reaping
- Process spawner v2 with context capsules (checkpoint + plan + research injection)
- Checkpoint-respawn loop with max respawn limits and escalation
- PM Daemon as pure Node.js with CLI dashboard (--watch, --ps, --tail, --kill, --status)
- Terminal management with per-agent logs and graceful kill
- Reliable task handoff with pre-exit protocol and dirty worktree recovery
- Multi-agent coordination v2 with artifact registry and dependency-aware spawning
- Overnight mode with auto-decompose, error budgets, drain, and morning reports
- 55+ tests across overnight mode alone; comprehensive test suites for all phases

### Success Criteria (validated 2026-02-11)
- [x] PM Daemon runs as pure Node.js — no Claude session, no context limit
- [x] PID-based liveness — zero zombie sessions after 24h of operation
- [x] Checkpoint-respawn cycle works 10+ times without losing progress
- [x] `pm-daemon.js --ps` shows real-time process table
- [x] Task with 20 steps completes across 4+ context windows seamlessly
- [x] Overnight mode: queue 10 tasks at 8pm → 7+ completed by 8am
- [x] Total cost per overnight run tracked and reported

---

## Milestone 5: Autonomous Intelligence — "Self-Improving, Self-Scaling, Zero-Touch"

**Goal**: Elevate Pilot AGI from a coordinated multi-agent system to a self-improving autonomous intelligence. Agents learn from history, approve their own plans for routine work, resolve merge conflicts semantically, generate tests on the fly, scale dynamically, and prevent drift before it happens. Humans only intervene for genuinely novel decisions.
**Status**: Not started
**Target**: v4.0.0

### Foundation: Agent-Connect Communication Model

#### Phase 5.0: Agent-Connect Communication Model
- Invert PM-agent communication: agents connect TO PM via WebSocket
- PM Hub Server (`pm-hub.js`): HTTP + WS on localhost:3847, embedded in PM daemon
- Agent Connector (`agent-connector.js`): session-start hook connects to PM hub
- Manual terminals connect the same way as spawned agents (first-class)
- Real-time bidirectional messaging (<100ms vs 30s file polling)
- Instant crash detection via WS close event
- File bus retained as persistence/fallback layer (zero regression)

### Stream A: Autonomous Decision-Making

#### Phase 5.1: Adaptive Plan Approval (Confidence-Tiered)
- Confidence scorer: task scope, risk level, code area familiarity, historical outcomes
- Three tiers: auto-approve (>0.85), notify-approve (0.60-0.85), require-approve (<0.60)
- Historical learning: track plan outcomes to refine confidence thresholds
- Risk classifier: data loss potential, user-facing, security-sensitive, infra-touching
- Policy integration in `policy.yaml` under `approval.confidence_thresholds`

#### Phase 5.2: Semantic Merge Conflict Resolution
- AST-aware conflict parser (JS/TS/Python/Go/Rust)
- Intent extraction from commit messages + plan steps
- Resolution strategies: additive, rename, overlapping edit, contradictory (escalate)
- Test validation: run tests after resolution, escalate on failure
- Pluggable language parsers via registry

#### Phase 5.3: Autonomous Test Generation
- Coverage-aware: analyze what's untested after each code change
- Strategy per change type: new function → unit test, bug fix → regression test, refactor → snapshot test
- Framework auto-detection (Vitest, Jest, Mocha, pytest, Go test)
- Quality gate: generated tests must pass and cover changed lines
- Integrated into `/pilot-exec` as sub-step after code changes

### Stream B: Self-Improving Intelligence

#### Phase 5.4: Dynamic Agent Pool Scaling
- Autoscaler: PM monitors queue depth, active agents, budget remaining
- Scale up: queue depth > 2x agents, high-priority with no idle agent, deadline approaching
- Scale down: no pending tasks (5min cooldown), budget threshold, resource pressure
- Configurable bounds: `pool.min` (1), `pool.max` (12), resource-aware (CPU/memory)

#### Phase 5.5: Self-Improving Task Decomposition
- Outcome tracking: predicted vs actual subtask count, complexity, stuck/reworked tasks
- Pattern library: successful decomposition templates indexed by task type
- Feedback loop: check library before decomposing, learn from outcomes
- Adaptive sizing and dependency learning from code analysis vs PM predictions

#### Phase 5.6: Predictive Drift Prevention
- Pre-action check: compare intended action against plan step before tool execution
- Embedding-based similarity scoring for divergence detection
- Guardrails injection: course-correction prompt before divergent tool executes
- Proactive context refresh for high-drift-risk steps

### Stream C: Knowledge & Communication

#### Phase 5.7: Memory Consolidation & Relevance Scoring
- Relevance scorer: recency, usage frequency, task similarity, explicit links
- Summarization pipeline: full → summary → archived (by age and relevance)
- Tiered loading: agents only load entries above relevance threshold
- Memory budget per channel with LRU eviction

#### Phase 5.8: Cross-Project Learning
- Global knowledge base at `~/.pilot-agi/knowledge/`
- Stores anonymized: decomposition templates, failure modes, tech decisions, cost benchmarks
- Privacy controls: opt-in per project in `policy.yaml`
- Export/import shareable knowledge packs (JSON)

#### Phase 5.9: Real-Time Notification & Mobile Approval
- Channels: Slack webhook, Discord webhook, Email (SMTP), system notification
- Approval flow: escalation → notification → one-click approve/reject → timeout escalation
- Morning report delivery to configured channel
- Priority-based routing: critical → immediate; info → batch digest

#### Phase 5.10: Cloud Execution Bridge
- Pluggable execution providers: local (default), SSH remote, Docker, cloud (future)
- Remote PM Daemon: run on server, spawn agents locally or remotely
- State sync via git push/pull for checkpoints and repos
- Log streaming across network (SSE/WebSocket)

### Dependencies
```
Wave 0 (Foundation): 5.0 Agent-Connect Communication Model
Wave 1 (build on 5.0): 5.1, 5.3, 5.7, 5.9
Wave 2: 5.2 (5.3), 5.4 (5.0+5.1), 5.5 (5.7), 5.6 (5.0+5.7)
Wave 3: 5.8 (5.5+5.7), 5.10 (5.4)
```

### Success Criteria
- [ ] Agents connect to PM via WebSocket; <100ms message latency; manual terminals fully integrated
- [ ] Routine tasks auto-approved and completed without human input
- [ ] 70%+ of merge conflicts resolved automatically with passing tests
- [ ] Every code change gets auto-generated tests; coverage never decreases
- [ ] Agent pool scales from 1 to 12 based on queue depth and budget
- [ ] Decomposition quality improves measurably over 10+ tasks
- [ ] Drift caught before tool execution in 80%+ of cases
- [ ] Memory channels stay under configured budget; stale entries pruned
- [ ] Patterns from project A available and useful in project B
- [ ] Human receives Slack/Discord notification within 30s of escalation
- [ ] Agents run on remote server; overnight mode works with laptop closed

---

## Future Milestones
- Milestone 6: Cloud Sync — remote agent coordination, team-based workflows, CI/CD integration
- Milestone 7: Marketplace — shareable agent configs, design systems, governance policies

---

## Notes
- Tasks live in beads (bd), not in this document
- This document is for high-level planning only
- Update as milestones are completed
