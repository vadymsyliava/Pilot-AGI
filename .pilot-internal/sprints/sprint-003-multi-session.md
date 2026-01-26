# Sprint 3: Multi-Session Safety (Phase 2)

**Goal**: 2-6 Claude Code terminals working without conflicts
**Milestone**: M1 - Pilot AGI v2.0
**Status**: Complete

---

## Sprint Backlog

### Epic: E-002 Session Management

| ID | Task | Priority | Area | Status |
|----|------|----------|------|--------|
| T-009 | Implement session ID generation | P0 | core | pending |
| T-010 | Create session state management | P0 | core | pending |
| T-011 | Implement task claim/lease protocol | P0 | core | pending |
| T-012 | Implement area locking system | P1 | core | pending |
| T-013 | Create event stream (sessions.jsonl) | P1 | logging | pending |
| T-014 | Create /pilot-session skill | P1 | skills | pending |
| T-015 | Create /pilot-claim skill | P1 | skills | pending |
| T-016 | Create /pilot-release skill | P1 | skills | pending |
| T-017 | Add heartbeat mechanism | P2 | core | pending |

---

## Task Details

### T-009: Implement session ID generation

**Description**: Generate unique, collision-resistant session IDs.

**Acceptance Criteria**:
- [ ] IDs are unique across concurrent sessions
- [ ] IDs are human-readable (S-abc123 format)
- [ ] IDs persist across hook calls within session

---

### T-010: Create session state management

**Description**: Manage session state in JSON files.

**Files**:
- `.claude/pilot/state/sessions/<session_id>.json`

**Acceptance Criteria**:
- [ ] State persists session_id, claimed_task, locked_areas
- [ ] State includes timestamps (started, last_heartbeat)
- [ ] State cleaned up on session end

---

### T-011: Implement task claim/lease protocol

**Description**: Protocol for claiming tasks with time-limited leases.

**Acceptance Criteria**:
- [ ] Claim sets assignee and lease_expires_at
- [ ] Cannot claim already-claimed task
- [ ] Lease defaults to 30 minutes
- [ ] Expired leases can be re-claimed

---

### T-012: Implement area locking system

**Description**: Lock areas (frontend, backend, etc.) to prevent conflicts.

**Files**:
- `.claude/pilot/locks/areas/<area>.lock`

**Acceptance Criteria**:
- [ ] Lock file contains session_id, task_id, expires_at
- [ ] pre_tool_use checks locks before allowing edits
- [ ] Locks released on task completion

---

### T-013: Create event stream

**Description**: Append-only event log for session activity.

**Files**:
- `.pilot/sessions.jsonl`

**Acceptance Criteria**:
- [ ] Logs session_started, task_claimed, heartbeat, task_completed
- [ ] Events include timestamps
- [ ] Can be streamed for future Kanban UI

---

## Definition of Done

- [ ] All tasks complete
- [ ] Two terminals get different session IDs (tested)
- [ ] Cannot claim same task from two terminals (tested)
- [ ] Area locks prevent edit conflicts (tested)
- [ ] Lease expiry allows re-claim (tested)

---

*Sprint created: 2026-01-21*
