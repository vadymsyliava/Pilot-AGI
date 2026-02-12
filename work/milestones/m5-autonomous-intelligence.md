# Milestone 5: Autonomous Intelligence — "Self-Improving, Self-Scaling, Zero-Touch"

**Goal**: Elevate Pilot AGI from a coordinated multi-agent system to a self-improving autonomous intelligence. Agents learn from history, approve their own plans for routine work, resolve merge conflicts with AST-level understanding, generate tests on the fly, scale dynamically, and prevent drift before it happens. Humans only intervene for genuinely novel decisions.

**Target**: v4.0.0

## The Problem (What M4 Still Requires Humans For)

M4 achieved "overnight mode" — but several bottlenecks still require human input:

1. **Plan approval is always manual** — Every task blocks on human `/pilot-approve`. Routine tasks (add a test, fix a typo, update a dependency) still block on human.
2. **Merge conflicts escalate** — Any conflict that auto-rebase can't fix goes straight to human. The system can't reason about intent.
3. **Tests are written manually** — Agents write code but don't auto-generate coverage. Missing tests get caught in review, wasting a round-trip.
4. **Fixed agent pool** — 6 agents whether the queue has 2 tasks or 50. No scaling up/down based on demand.
5. **Decomposition doesn't learn** — Same decomposition heuristics every time. Mistakes repeat across projects.
6. **Drift is reactive** — Detected after the fact, then escalated. By then the agent has wasted tokens on divergent work.
7. **Memory grows unbounded** — Shared memory channels accumulate stale data. Agents load irrelevant context, wasting tokens.
8. **No cross-project learning** — Each project starts from zero. Patterns discovered in project A aren't available in project B.
9. **Escalations are terminal-only** — Human escalations go to a log file. No push notifications, no mobile approval.
10. **Agents are local-only** — All execution happens on the developer's machine. No cloud offloading.

## The Architecture Shift

```
BEFORE (M4):                          AFTER (M5):
┌─────────────────────┐              ┌──────────────────────────┐
│ Human approves every│              │ Confidence-tiered auto-  │
│ plan manually       │              │ approval (routine = skip)│
└─────────────────────┘              └──────────────────────────┘
┌─────────────────────┐              ┌──────────────────────────┐
│ Merge conflict →    │              │ AST-aware semantic merge │
│ escalate to human   │              │ resolver (intent-based)  │
└─────────────────────┘              └──────────────────────────┘
┌─────────────────────┐              ┌──────────────────────────┐
│ Fixed 6 agents      │              │ Dynamic 1-N agents based │
│ always running      │              │ on queue depth + budget  │
└─────────────────────┘              └──────────────────────────┘
┌─────────────────────┐              ┌──────────────────────────┐
│ Same decomposition  │              │ Feedback loop: learn from│
│ heuristics forever  │              │ outcomes, adapt strategy │
└─────────────────────┘              └──────────────────────────┘
```

Key insight: **Intelligence isn't just running tasks — it's learning when to ask, when to act, and when to improve itself.**

---

## Phase 5.0: Agent-Connect Communication Model (Foundation)

**Problem**: PM → Agent communication is file-based polling with 5-30s latency. PM can't push to agents, agents can't reach PM in real-time. Manual terminals are second-class citizens. No persistent connection.

**The Inversion**: Instead of PM pushing to agents via files, agents connect TO PM and maintain persistent bidirectional channels. PM becomes a hub that agents dial into.

**Deliverables**:
- PM Hub Server (`pm-hub.js`): lightweight HTTP + WebSocket server embedded in PM daemon
  - Binds to `127.0.0.1:3847` (localhost only, secure by default)
  - REST API: `/api/status`, `/api/register`, `/api/heartbeat`, `/api/report`, `/api/tasks/ready`, `/api/tasks/:id/claim`
  - WebSocket: persistent bidirectional channel per agent
- Agent Connector (`agent-connector.js`): client module used by session-start hook
  - On session-start, every agent (spawned or manual) connects to PM hub
  - If PM not running → fall back to file bus (zero regression)
  - Auto-reconnect with exponential backoff on disconnect
- Port discovery: PM writes `pm-hub.json` with port + PID, env var `PILOT_PM_PORT` for spawned agents
- Real-time event processing: PM handles WS events immediately (not waiting for 30s tick)
- Instant crash detection: WS close event = agent gone (no stale heartbeat polling)
- Manual terminal integration: user opens terminal → session-start connects to PM → PM pushes ready tasks
- File bus retained as persistence/audit layer (bus.jsonl unchanged, still written for replay safety)

**WebSocket Protocol**:
- Agent → PM: `register`, `heartbeat`, `task_complete`, `request`, `checkpoint`, `ask_pm`
- PM → Agent: `welcome`, `task_assign`, `message`, `plan_approval`, `command`, `shutdown`, `pm_response`

**PM Brain on Demand** (the intelligence layer):
- PM daemon (Node.js) maintains a **persistent PM Knowledge Base** loaded from:
  - Product Brief, Roadmap, Sprint Plans, Implementation Plans
  - PM Decision History, Research Findings, Task Decompositions
  - All Agent States, Task Graph, Escalation History, Cost Data
- When agent asks a question (`ask_pm`), PM daemon:
  1. Gathers relevant knowledge from KB (prioritized by topic, capped at 16KB)
  2. Includes conversation history with that agent (last 10 turns)
  3. Spawns `claude -p` with full PM knowledge + persona + question
  4. Gets response, stores decision in KB, sends answer via WS
- **Not a fresh call** — every PM brain session has full project context, decision history, and conversation continuity
- **No API needed** — uses `claude -p` (Claude Code CLI), same as existing `pm-decisions.js`
- Multi-turn conversations: PM daemon holds per-agent Q&A threads in memory, injects into each call
- Cost-controlled: 16KB prompt cap, 120s timeout, max 30 calls/hour in `policy.yaml`

**Spec**: `work/specs/agent-connect-architecture.md`

**Files**: new `pm-hub.js`, new `agent-connector.js`, new `pm-brain.js`, new `pm-knowledge-base.js`, `pm-daemon.js`, `session-start.js`, `messaging.js`

---

## Phase 5.1: Adaptive Plan Approval (Confidence-Tiered)

**Problem**: Every task blocks on human plan approval, even trivial ones like "add a unit test" or "fix typo in README".

**Deliverables**:
- Confidence scorer: analyze task scope, risk level, code area familiarity, historical outcomes
- Three tiers:
  - **Auto-approve** (confidence > 0.85): small scope, well-tested area, similar to past successes → proceed immediately
  - **Notify-approve** (0.60-0.85): medium scope → proceed and notify human (can veto within window)
  - **Require-approve** (< 0.60): new area, risky changes, DB migrations, auth → block until human approves
- Historical learning: track plan outcomes (success/failure/rework) to refine confidence thresholds
- Risk classifier: tag plans by risk dimensions (data loss potential, user-facing, security-sensitive, infra-touching)
- Policy integration: configurable in `policy.yaml` under `approval.confidence_thresholds`
- Override: human can always set `approval: always_require` per project or per code area
- Audit trail: every auto-approved plan logged with confidence score and reasoning

**Files**: new `confidence-scorer.js`, `policy.js`, `pm-daemon.js`, `pre-tool-use.js`

---

## Phase 5.2: Semantic Merge Conflict Resolution

**Problem**: Merge conflicts that `git rebase` can't auto-resolve escalate to human. The system treats conflicts as text problems, not semantic ones.

**Deliverables**:
- AST-aware conflict parser: parse both sides of conflict into AST (supports JS/TS/Python/Go/Rust)
- Intent extraction: read commit messages + plan steps for both sides to understand *why* each change was made
- Resolution strategies:
  - **Additive**: both sides add different things → combine both
  - **Rename**: same function renamed differently → pick the plan-aligned name
  - **Overlapping edit**: both modify same function → merge logic, validate types
  - **Contradictory**: genuinely incompatible changes → escalate with clear explanation of conflict intent
- Test validation: after automated resolution, run relevant tests. If tests pass → commit. If fail → escalate.
- Confidence scoring: if resolver confidence < 70%, escalate instead of guessing
- Language plugins: pluggable AST parsers per language via registry
- Metrics: track auto-resolution success rate, human override frequency

**Files**: new `merge-resolver.js`, new `ast-parser.js`, `recovery.js`, `pm-daemon.js`

---

## Phase 5.3: Autonomous Test Generation

**Problem**: Agents write code but don't auto-generate tests. Missing coverage is caught in review, wasting a review cycle.

**Deliverables**:
- Coverage-aware generation: after each code change, analyze what's untested
- Test strategy per change type:
  - **New function** → unit test with happy path + edge cases
  - **Bug fix** → regression test that reproduces the original bug
  - **Refactor** → verify behavior is unchanged (snapshot/golden tests)
  - **API endpoint** → integration test with request/response validation
- Framework detection: auto-detect test framework (Vitest, Jest, Mocha, pytest, Go test)
- Mutation testing (stretch): verify generated tests actually catch bugs
- Test quality gate: generated tests must pass and cover the changed lines
- Integration with `/pilot-exec`: test generation is a sub-step after each code change, not a separate task
- Skip option: `policy.yaml` can disable auto-test-gen for specific areas (e.g., config files, docs)

**Files**: new `test-generator.js`, `agent-loop.js`, `policy.js`

---

## Phase 5.4: Dynamic Agent Pool Scaling

**Problem**: Fixed pool of agents (configured at startup). Queue of 50 tasks → same 6 agents. Queue of 1 task → 6 agents idle.

**Deliverables**:
- Autoscaler: PM daemon monitors queue depth, active agents, budget remaining
- Scale-up triggers:
  - Queue depth > 2x active agents → spawn more
  - High-priority task with no idle agent → spawn dedicated
  - Deadline approaching → increase parallelism
- Scale-down triggers:
  - No pending tasks → terminate idle agents after cooldown (default 5min)
  - Budget threshold reached → cap agent count
  - System resource pressure (CPU/memory) → reduce agents
- Configurable bounds: `pool.min` (default 1), `pool.max` (default 12), `pool.scale_factor` in `policy.yaml`
- Resource awareness: check system load (`os.cpus()`, `os.freemem()`) before spawning
- Cost-aware scaling: factor in per-agent cost when deciding to scale up
- Graceful scale-down: finish current step, checkpoint, then exit (no mid-task kills)

**Files**: new `autoscaler.js`, `pm-daemon.js`, `pm-loop.js`, `policy.js`

---

## Phase 5.5: Self-Improving Task Decomposition

**Problem**: Decomposition uses the same heuristics regardless of past outcomes. A decomposition pattern that consistently produces stuck subtasks gets used again.

**Deliverables**:
- Outcome tracking: for every decomposition, record:
  - Predicted subtask count vs actual
  - Predicted complexity (S/M/L) vs actual (time, respawns, rework)
  - Which subtasks got stuck, reassigned, or reworked
  - Which dependency edges were missing or spurious
- Pattern library: store successful decomposition templates indexed by task type
  - "auth system" → 8 subtasks, backend-first, DB migration isolated
  - "CRUD endpoint" → 4 subtasks, schema → handler → test → docs
  - "UI component" → 3 subtasks, tokens → component → storybook
- Feedback loop: before decomposing, check pattern library for similar past tasks
- Adaptive sizing: if tasks of type X consistently take 2x estimated → adjust size predictions
- Dependency learning: if code-detected deps consistently differ from PM-predicted deps → weight code analysis higher
- Retrospective trigger: after task completion, auto-evaluate decomposition quality and update patterns

**Files**: new `decomposition-learner.js`, `decomposition.js`, `memory.js`, `pm-loop.js`

---

## Phase 5.6: Predictive Drift Prevention

**Problem**: Drift is detected after the agent has already diverged. By then tokens are wasted and work may need to be discarded.

**Deliverables**:
- Pre-action check: before each tool use, compare intended action against plan step
- Embedding-based similarity: encode plan step and agent's next action, flag if similarity < threshold
- Guardrails injection: if divergence detected, inject course-correction prompt before the tool executes
- Drift prediction model: based on agent history, predict which plan steps are most likely to drift
- Proactive context refresh: for high-drift-risk steps, re-inject relevant plan context before agent starts
- Early warning: PM notified when drift probability exceeds threshold (before actual drift occurs)
- Metrics: drift prevention rate (caught before vs after), false positive rate, token savings
- Integration with post-tool-use hook: track per-step plan adherence score

**Files**: new `drift-predictor.js`, `pre-tool-use.js`, `post-tool-use.js`, `pm-loop.js`

---

## Phase 5.7: Memory Consolidation & Relevance Scoring

**Problem**: Shared memory channels grow unbounded. Agents load stale research, old decompositions, and irrelevant decisions — wasting context window tokens.

**Deliverables**:
- Relevance scorer: each memory entry gets a relevance score based on:
  - Recency (exponential decay)
  - Usage frequency (how often agents read it)
  - Task similarity (is current task related to when entry was created?)
  - Explicit links (entry tagged with task ID that's still active)
- Summarization: old entries get summarized (full → summary → archived)
  - Research findings > 7 days → summarize key conclusions
  - Completed task decompositions → archive, keep only template
  - PM decisions on closed tasks → summarize the pattern, archive specifics
- Tiered loading: agents only load entries above relevance threshold for their current task
- Compaction job: periodic (daily) sweep summarizes, archives, and cleans channels
- Memory budget: configurable max tokens per channel; oldest/lowest-relevance entries evicted first
- Cross-channel dedup: detect overlapping knowledge across channels, consolidate

**Files**: new `memory-consolidator.js`, `memory.js`, `pm-loop.js`, `policy.js`

---

## Phase 5.8: Cross-Project Learning

**Problem**: Each project starts from zero. Patterns, templates, and lessons from project A aren't available in project B.

**Deliverables**:
- Global knowledge base: `~/.pilot-agi/knowledge/` stores cross-project patterns
- What gets stored (anonymized):
  - Decomposition templates by task type (sanitized of project-specific details)
  - Common failure modes and their fixes (e.g., "EACCES on port 3000 → check existing process")
  - Technology decision rationale (e.g., "chose Vitest over Jest because faster + ESM native")
  - Optimal agent counts by workload type
  - Cost/time benchmarks by task complexity
- Privacy controls: opt-in per project, configurable in `policy.yaml` under `learning.cross_project`
- Knowledge import: on project init, relevant patterns from global KB injected into PM context
- Feedback: track whether imported patterns helped or were irrelevant — prune bad patterns
- Export/import: shareable knowledge packs (JSON) for team distribution

**Files**: new `knowledge-base.js`, `orchestrator.js`, `pm-research.js`, `policy.js`

---

## Phase 5.9: Real-Time Notification & Mobile Approval

**Problem**: Escalations go to a log file. Human must be at the terminal to approve plans, resolve conflicts, or handle escalations.

**Deliverables**:
- Notification channels:
  - **Slack webhook**: push escalations, morning reports, approval requests to a Slack channel
  - **Discord webhook**: same for Discord
  - **Email (SMTP)**: digest mode — batch notifications every N minutes
  - **System notification**: macOS `osascript` / Linux `notify-send` for local alerts
- Approval flow:
  - Escalation → notification with context + approval link
  - One-click approve/reject via webhook callback
  - Timeout: if no response within configurable window (default 1h), auto-escalate to next level
- Morning report delivery: overnight summary sent to configured channel at 8am
- Configuration: `policy.yaml` under `notifications` with channel configs and routing rules
- Priority-based routing: critical → immediate push; info → batch digest
- Webhook security: HMAC-signed payloads, configurable secrets

**Files**: new `notifier.js`, `escalation.js`, `pm-daemon.js`, `reporter.js`, `policy.js`

---

## Phase 5.10: Cloud Execution Bridge

**Problem**: All agents run on the developer's laptop. Can't scale beyond local resources, can't run when laptop is closed.

**Deliverables**:
- Execution provider abstraction: pluggable backends for where agents run
  - **Local** (default): current behavior, spawn on local machine
  - **SSH remote**: spawn agents on a remote server via SSH
  - **Docker**: spawn agents in containers (consistent environment, resource limits)
  - **Cloud (future)**: placeholder for managed cloud service
- Remote PM Daemon: PM daemon can run on a remote server, agents spawn locally or remotely
- State sync: checkpoint files and git repos synced between local and remote via git push/pull
- Log streaming: `pm-daemon.js --tail` works across network (SSE or WebSocket)
- Cost tracking: remote execution costs (compute time) tracked alongside token costs
- Configuration: `policy.yaml` under `execution.provider` with per-provider settings
- Fallback: if remote provider unavailable, gracefully fall back to local execution

**Files**: new `execution-provider.js`, new `providers/local.js`, new `providers/ssh.js`, new `providers/docker.js`, `pm-daemon.js`, `process-spawner.js`

---

## Dependencies

```
Wave 0 (Foundation):
  5.0  Agent-Connect Communication Model — no deps (replaces file-polling with persistent WS)

Wave 1 (Independent, build on 5.0):
  5.1  Adaptive Plan Approval (needs 5.0 for real-time approval flow)
  5.3  Autonomous Test Generation — no deps (hooks into agent-loop)
  5.7  Memory Consolidation — no deps (enhances existing memory.js)
  5.9  Real-Time Notifications (needs 5.0 for WS-based push)

Wave 2:
  5.2  Semantic Merge Resolution (needs 5.3 for test validation of resolutions)
  5.4  Dynamic Agent Scaling (needs 5.0 + 5.1 for real-time scaling + auto-approved throughput)
  5.5  Self-Improving Decomposition (needs 5.7 for pattern storage)
  5.6  Predictive Drift Prevention (needs 5.0 for real-time guardrails + 5.7 for relevance)

Wave 3:
  5.8  Cross-Project Learning (needs 5.5 for decomposition templates + 5.7 for consolidation)
  5.10 Cloud Execution Bridge (needs 5.0 for WS protocol + 5.4 for scaling abstraction)
```

## Success Criteria

- [ ] Agents connect to PM hub via WebSocket on session-start; <100ms message latency (vs 30s file polling)
- [ ] Manual terminals connect to PM the same way as spawned agents — fully integrated
- [ ] Agent crash detected instantly via WS close event (not 30s stale heartbeat)
- [ ] File bus fallback works seamlessly when PM is not running (zero regression)
- [ ] Routine tasks (typo fix, add test, dependency update) auto-approved and completed without human input
- [ ] 70%+ of merge conflicts resolved automatically with passing tests
- [ ] Every code change gets auto-generated tests; coverage never decreases
- [ ] Agent pool scales from 1 to 12 based on queue depth and budget
- [ ] Decomposition quality improves measurably over 10+ tasks (fewer stuck subtasks, more accurate estimates)
- [ ] Drift caught before tool execution in 80%+ of cases (vs. after in M4)
- [ ] Memory channels stay under configured budget; irrelevant entries pruned automatically
- [ ] Patterns from project A available and useful in project B
- [ ] Human receives Slack/Discord notification within 30s of escalation; can approve from phone
- [ ] Agents run on remote server; overnight mode works with laptop closed

## What Changes from M4

| M4 (Current) | M5 (New) |
|--------------|----------|
| File-polling communication (5-30s) | Agent-connect via WebSocket (<100ms) |
| Manual terminals are second-class | Manual terminals connect same as spawned |
| PM pushes to agents (unreliable) | Agents connect TO PM (reliable, persistent) |
| Every plan needs human approval | Confidence-tiered: routine tasks auto-approved |
| Merge conflicts → escalate to human | AST-aware semantic resolver handles 70%+ |
| Tests written manually by agents | Auto-generated after every code change |
| Fixed agent pool (configured at startup) | Dynamic 1-N scaling based on demand |
| Same decomposition heuristics forever | Learns from outcomes, adapts patterns |
| Drift detected after divergence | Predicted and prevented before tool execution |
| Memory grows unbounded | Consolidated, scored, pruned automatically |
| Each project starts from zero | Cross-project knowledge base |
| Escalations go to terminal log file | Push notifications + mobile approval |
| All execution on local machine | Pluggable remote execution (SSH/Docker) |
