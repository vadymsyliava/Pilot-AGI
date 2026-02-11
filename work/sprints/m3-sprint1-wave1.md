# Sprint 1: M3 Wave 1 — Foundation for Full Autonomy

**Milestone**: 3 (Full Autonomy)
**Sprint Goal**: Build the 4 independent foundation pieces that all later M3 phases depend on
**Start**: 2026-02-11
**Tasks**: 4 (all independent, can run in parallel with 4 agents)

---

## Tasks

| ID | Phase | Title | Size | Agent Role |
|----|-------|-------|------|------------|
| Pilot AGI-csv | 3.5 | Autonomous Context Window Management | M | infra |
| Pilot AGI-ou5 | 3.1 | Agent Identity & Skill Registry | M | backend |
| Pilot AGI-i52 | 3.7 | Per-Agent Persistent Memory | M | backend |
| Pilot AGI-16h | 3.10 | Reliable Message Bus | M | backend |

---

## Task Details

### Pilot AGI-csv — Context Window Management (Phase 3.5)

**Why first**: Without this, agents can't run long tasks without human intervention. This is the #1 blocker for "walk away" autonomy.

**Subtasks** (5):
1. Auto-checkpoint in post-tool-use: At 60%, save checkpoint automatically (not just nudge)
2. Programmatic compact trigger: Enqueue compact action via stdin-injector
3. Auto-resume on session-start: Detect checkpoint → load → inject → continue
4. PM pressure monitor: PM watches all agents' pressure levels
5. PM self-management: PM checkpoints its own state before compact

**Key files**: `post-tool-use.js`, `pressure.js`, `checkpoint.js`, `session-start.js`, `stdin-injector.js`
**Tests needed**: Pressure threshold trigger, checkpoint save/load round-trip, resume prompt generation

---

### Pilot AGI-ou5 — Agent Identity (Phase 3.1)

**Why first**: All intelligent routing (3.2-3.4) needs to know which agent is which. Today they're anonymous session IDs.

**Subtasks** (6):
1. Add `role` field to session state (frontend/backend/testing/design/infra/pm)
2. Skill registry JSON at `.claude/pilot/config/skill-registry.json`
3. Agent capability broadcast on session-start
4. Task-to-agent matching algorithm
5. Session role persistence across restarts
6. Agent affinity tracking (prefer related tasks to same agent)

**Key files**: `session.js`, `agents.yaml`, `messaging.js`, `orchestrator.js`
**Tests needed**: Role assignment, skill matching, broadcast receipt, affinity scoring

---

### Pilot AGI-i52 — Per-Agent Memory (Phase 3.7)

**Why first**: Agents must remember past work. Currently all agent memory directories are empty.

**Subtasks** (6):
1. Auto-record decisions in post-tool-use hook
2. Decision log format and writer
3. Issue/error log format and writer
4. Memory loading on session-start (inject as context)
5. Cross-agent memory query API
6. Memory pruning with TTL

**Key files**: `memory.js`, `post-tool-use.js`, `session-start.js`, `.claude/pilot/memory/agents/`
**Tests needed**: Memory write/read round-trip, cross-agent query, TTL expiry

---

### Pilot AGI-16h — Reliable Message Bus (Phase 3.10)

**Why first**: All inter-agent communication depends on reliable delivery. Current bus has no ACK, no compaction.

**Subtasks** (6):
1. ACK protocol with retry
2. Dead letter queue
3. Wire compactBus() into periodic maintenance
4. Priority-based message processing
5. Sequence numbers for ordering
6. Cursor corruption recovery

**Key files**: `messaging.js`, `pm-watcher.js`, `pm-loop.js`
**Tests needed**: ACK/NACK flow, DLQ routing, compaction correctness, priority ordering

---

## Execution Strategy

All 4 tasks are independent — zero dependencies between them. With 4 agent terminals:

```
Terminal 1 (infra):  Pilot AGI-csv — Context Window Management
Terminal 2 (backend): Pilot AGI-ou5 — Agent Identity
Terminal 3 (backend): Pilot AGI-i52 — Per-Agent Memory
Terminal 4 (backend): Pilot AGI-16h — Reliable Message Bus
Terminal 5 (PM):      Coordinates, reviews, merges
```

Each task touches different files (no area conflicts), so they can truly run in parallel.

## Definition of Done

- [ ] All 4 tasks pass tests
- [ ] PM review approved for each
- [ ] Merged to feat/m3-roadmap branch
- [ ] Integration test: agent auto-checkpoints at 60%, compacts, resumes
- [ ] Integration test: agent declares role on start, PM routes by skill
- [ ] Integration test: agent memory persists across session restart
- [ ] Integration test: message ACK/retry works end-to-end
