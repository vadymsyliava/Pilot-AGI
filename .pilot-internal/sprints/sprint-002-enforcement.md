# Sprint 2: Proactive Enforcement (Phase 1)

**Goal**: No silent work - everything tracked and approved
**Milestone**: M1 - Pilot AGI v2.0
**Status**: Complete

---

## Sprint Backlog

### Epic: E-001 Governance System

| ID | Task | Priority | Area | Status |
|----|------|----------|------|--------|
| T-001 | Create policy.yaml schema and defaults | P0 | config | pending |
| T-002 | Implement session_start.js hook | P0 | hooks | pending |
| T-003 | Implement user_prompt_submit.js hook | P0 | hooks | pending |
| T-004 | Implement pre_tool_use.js hook | P0 | hooks | pending |
| T-005 | Create /pilot-approve skill | P1 | skills | pending |
| T-006 | Create /pilot-new-task skill | P1 | skills | pending |
| T-007 | Update /pilot-next with claim logic | P1 | skills | pending |
| T-008 | Create run log templates | P2 | templates | pending |

---

## Task Details

### T-001: Create policy.yaml schema and defaults

**Description**: Define the governance policy schema that controls enforcement rules.

**Files**:
- `.claude/pilot/policy.yaml` (default policy)
- `.claude/pilot/schemas/policy.schema.json` (validation schema)

**Acceptance Criteria**:
- [ ] Schema defines all enforcement rules (R1-R5)
- [ ] Default values are sensible for solo developers
- [ ] User can override via project policy.yaml

---

### T-002: Implement session_start.js hook

**Description**: Hook that runs when Claude Code session begins.

**Files**:
- `.claude/pilot/hooks/session_start.js`

**Acceptance Criteria**:
- [ ] Generates unique session ID
- [ ] Registers session in state
- [ ] Checks for other active sessions
- [ ] Loads context (brief, roadmap, tasks)
- [ ] Returns locked files list

---

### T-003: Implement user_prompt_submit.js hook

**Description**: Hook that classifies user intent and routes to appropriate workflow.

**Files**:
- `.claude/pilot/hooks/user_prompt_submit.js`

**Acceptance Criteria**:
- [ ] Classifies intent (new_project, new_scope, continue, question)
- [ ] Routes new_project to /pilot-init
- [ ] Routes new_scope to /pilot-new-task
- [ ] Routes continue to /pilot-next if no active task

---

### T-004: Implement pre_tool_use.js hook

**Description**: Hook that enforces policy before Edit/Write operations.

**Files**:
- `.claude/pilot/hooks/pre_tool_use.js`

**Acceptance Criteria**:
- [ ] Blocks Edit/Write without active task
- [ ] Blocks Edit/Write without approved plan (when required)
- [ ] Blocks Edit/Write on protected branches
- [ ] Blocks Edit/Write on locked files
- [ ] Returns helpful error messages with suggested commands

---

### T-005: Create /pilot-approve skill

**Description**: Skill to mark a plan as approved.

**Files**:
- `.claude/skills/pilot-approve/SKILL.md`

**Acceptance Criteria**:
- [ ] Validates plan exists for current task
- [ ] Sets plan.approved = true
- [ ] Records approval timestamp and approver
- [ ] Updates bd task metadata

---

### T-006: Create /pilot-new-task skill

**Description**: Skill to propose and create new tasks from user requests.

**Files**:
- `.claude/skills/pilot-new-task/SKILL.md`

**Acceptance Criteria**:
- [ ] Extracts task description from user prompt
- [ ] Searches bd for similar existing tasks
- [ ] Suggests linking if overlap found
- [ ] Creates bd task with proper metadata
- [ ] Guesses dependencies from context

---

### T-007: Update /pilot-next with claim logic

**Description**: Update pilot-next to properly claim tasks for the session.

**Files**:
- `.claude/skills/pilot-next/SKILL.md` (update)

**Acceptance Criteria**:
- [ ] Sets task status to in_progress
- [ ] Records session_id as assignee
- [ ] Checks for conflicts before claiming
- [ ] Updates session state with claimed task

---

### T-008: Create run log templates

**Description**: Templates for session run logs with resume capsules.

**Files**:
- `.claude/pilot/templates/run-log.md`

**Acceptance Criteria**:
- [ ] Template includes session info
- [ ] Template includes task progress
- [ ] Template includes resume capsule section
- [ ] Auto-updated after each action

---

## Definition of Done

- [ ] All tasks complete
- [ ] Edit/Write blocked without active task (tested)
- [ ] Edit/Write blocked without approved plan (tested)
- [ ] Edit/Write blocked on main branch (tested)
- [ ] New scope prompts trigger task proposal (tested)
- [ ] Documentation updated

---

*Sprint created: 2026-01-21*
