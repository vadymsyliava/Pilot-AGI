# Sprint 6: Autonomous Execution (Phase 5)

**Goal**: AI works independently after approval
**Milestone**: M1 - Pilot AGI v2.0
**Status**: Complete

---

## Sprint Backlog

### Epic: E-005 Autonomous System

| ID | Task | Priority | Area | Status |
|----|------|----------|------|--------|
| T-033 | Create master agent definitions | P0 | agents | pending |
| T-034 | Implement context auto-loading | P0 | agents | pending |
| T-035 | Create autonomous execution loop | P0 | core | pending |
| T-036 | Implement parallel agent spawning | P1 | orchestration | pending |
| T-037 | Create approval gates system | P1 | governance | pending |
| T-038 | Create /pilot-auto skill | P1 | skills | pending |
| T-039 | Create /pilot-pause skill | P2 | skills | pending |

---

## Task Details

### T-033: Create master agent definitions

**Description**: Define the three master agents with their rules and context.

**Files**:
- `.claude/pilot/agents/frontend-master.md`
- `.claude/pilot/agents/backend-master.md`
- `.claude/pilot/agents/database-master.md`

**Acceptance Criteria**:
- [ ] Each agent has clear capabilities
- [ ] Each agent has must/must_not rules
- [ ] Each agent specifies context to load
- [ ] Each agent has output format

---

### T-034: Implement context auto-loading

**Description**: Agents automatically load full context before work.

**Acceptance Criteria**:
- [ ] Loads PROJECT_BRIEF.md
- [ ] Loads ROADMAP.md
- [ ] Loads relevant KB sections
- [ ] Loads task details and related tasks
- [ ] Loads recent changes (git log)

---

### T-035: Create autonomous execution loop

**Description**: Loop that executes tasks without user intervention.

**Acceptance Criteria**:
- [ ] Picks next ready task
- [ ] Loads context
- [ ] Creates plan if needed
- [ ] Executes micro-steps
- [ ] Commits after each step
- [ ] Moves to next task

---

### T-036: Implement parallel agent spawning

**Description**: Spawn multiple agents for independent tasks.

**Acceptance Criteria**:
- [ ] Detects independent tasks
- [ ] Spawns appropriate agents in parallel
- [ ] Collects results
- [ ] Handles conflicts

---

### T-037: Create approval gates system

**Description**: Gates that pause autonomous execution for high-risk actions.

**Acceptance Criteria**:
- [ ] Gates defined in policy.yaml
- [ ] Always-approve gates (delete, migrations)
- [ ] Conditional gates (large refactors)
- [ ] User can approve/reject

---

## Definition of Done

- [ ] All tasks complete
- [ ] Autonomous loop completes tasks (tested)
- [ ] Agents load correct context (tested)
- [ ] Parallel execution works (tested)
- [ ] Approval gates stop when needed (tested)

---

*Sprint created: 2026-01-21*
