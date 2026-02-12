# Sprint 2: M3 Wave 2 — Intelligent PM & Agent Autonomy

**Milestone**: 3 (Full Autonomy)
**Sprint Goal**: Build PM research brain, agent self-activation, and direct agent-to-agent collaboration
**Start**: 2026-02-11
**Tasks**: 3 (all independent, can run in parallel with 3 agents)

---

## Tasks

| ID | Phase | Title | Size | Agent Role |
|----|-------|-------|------|------------|
| Pilot AGI-fb9 | 3.2 | PM Auto-Research | M | pm/backend |
| Pilot AGI-rcn | 3.6 | Agent Self-Activation | M | infra |
| Pilot AGI-pab | 3.9 | Agent-to-Agent Collaboration | M | backend |

---

## Task Details

### Phase 3.2 — PM Auto-Research

**Dependencies**: 3.1 (Agent Identity) ✓
**Why now**: PM needs to research best practices before planning tasks. Currently PM assigns tasks without context.

**Deliverables**:
1. Research skill for PM — auto-trigger web search + doc analysis before task assignment
2. Research output stored in `work/research/` and linked to bd task
3. Pattern library — common solutions indexed for reuse (`work/research/patterns/`)
4. Technology decision log — "we use X because Y" (memory channel: `research`)
5. Automated dependency analysis — what packages/APIs needed for a task

**Key files**: `orchestrator.js`, `pm-loop.js`, `memory.js` (new channel), `/pilot-research` skill
**Integration**: PM loop's task scan should trigger auto-research before assignment
**Tests needed**: Research trigger on new task, pattern storage/retrieval, decision log round-trip

---

### Phase 3.6 — Agent Self-Activation

**Dependencies**: 3.1 (Agent Identity) ✓, 3.5 (Context Window Management) ✓
**Why now**: Agents must auto-start without human typing commands. The "walk away" promise requires agents that wake up, find work, and execute.

**Deliverables**:
1. Auto-start hook — on session-start, detect role → check inbox → auto-claim ready task → auto-plan → auto-exec
2. Inbox polling loop — agent periodically checks message bus for delegations
3. Wake-on-message — nudge file triggers immediate bus check
4. Graceful idle — if no work, agent sleeps (no busy-wait) and wakes on bus event
5. PM stdin injection integration — PM can trigger agent actions via action queue

**Key files**: `session-start.js`, `messaging.js` (nudge system), `stdin-injector.js`, `pm-loop.js`
**Integration**: Builds on existing nudgeSession() and action queue; needs session-start to auto-trigger workflow
**Tests needed**: Auto-start from clean session, inbox polling wakeup, idle-to-active transition

---

### Phase 3.9 — Agent-to-Agent Collaboration

**Dependencies**: 3.10 (Reliable Message Bus) ✓
**Why now**: Agents currently communicate only through PM. Direct communication reduces PM bottleneck and latency.

**Deliverables**:
1. Direct agent messaging — peer-to-peer via bus (not through PM)
2. Agent discovery — query active agents by role (`getSessionsByRole()` already exists)
3. API contract queries — "hey backend agent, what's the API shape?" request/response protocol
4. Shared working context — agents on related tasks see each other's progress (memory channel)
5. Blocking request handler — "I need backend API done before I can proceed" → PM escalation

**Key files**: `messaging.js`, `session.js` (agent discovery), `memory.js` (shared context channel)
**Integration**: Extends existing messaging with agent-addressed messages (by role, not just session ID)
**Tests needed**: Direct message delivery, agent discovery, blocking request escalation to PM

---

## Execution Strategy

All 3 tasks are independent — zero dependencies between them. With 3 agent terminals:

```
Terminal 1 (pm/backend): Phase 3.2 — PM Auto-Research
Terminal 2 (infra):      Phase 3.6 — Agent Self-Activation
Terminal 3 (backend):    Phase 3.9 — Agent-to-Agent Collaboration
Terminal 4 (PM):         Coordinates, reviews, merges
```

Each task touches different files/areas (minimal overlap), so they can run in parallel.

## Definition of Done

- [ ] All 3 tasks pass tests
- [ ] PM review approved for each
- [ ] Merged to feat/m3-roadmap branch
- [ ] Integration test: PM auto-researches before assigning a new task
- [ ] Integration test: Agent starts, auto-claims task, begins work without human input
- [ ] Integration test: Frontend agent asks backend agent for API contract, gets response
- [ ] Integration test: Blocking request escalates to PM when direct resolution fails
