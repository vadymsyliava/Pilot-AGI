# Sprint 7: Kanban API Foundation (Phase 6)

**Goal**: API ready for future Kanban UI
**Milestone**: M1 - Pilot AGI v2.0
**Status**: Blocked by Sprint 6

---

## Sprint Backlog

### Epic: E-006 Kanban API

| ID | Task | Priority | Area | Status |
|----|------|----------|------|--------|
| T-040 | Create pilot serve command | P1 | cli | pending |
| T-041 | Implement GET /api/sessions endpoint | P1 | api | pending |
| T-042 | Implement GET /api/issues endpoint | P1 | api | pending |
| T-043 | Implement GET /api/issues/:id endpoint | P2 | api | pending |
| T-044 | Implement GET /api/events endpoint | P2 | api | pending |
| T-045 | Implement GET /api/kb endpoint | P2 | api | pending |
| T-046 | Implement GET /api/locks endpoint | P2 | api | pending |

---

## Task Details

### T-040: Create pilot serve command

**Description**: CLI command to start local API server.

**Acceptance Criteria**:
- [ ] Starts HTTP server on configurable port
- [ ] Default port 3333
- [ ] Logs requests
- [ ] Graceful shutdown

---

### T-041: Implement GET /api/sessions endpoint

**Description**: List all active sessions with status.

**Response**:
```json
{
  "sessions": [
    {
      "id": "S-abc123",
      "status": "active",
      "task": "BD-123",
      "area": "backend",
      "started_at": "...",
      "last_heartbeat": "..."
    }
  ]
}
```

---

### T-042: Implement GET /api/issues endpoint

**Description**: List all bd issues with status.

**Response**:
```json
{
  "issues": [
    {
      "id": "BD-123",
      "title": "...",
      "status": "in_progress",
      "assignee": "S-abc123",
      "priority": "P1",
      "area": "backend"
    }
  ]
}
```

---

### T-044: Implement GET /api/events endpoint

**Description**: Stream events from sessions.jsonl.

**Query params**:
- `since` - timestamp to start from

**Acceptance Criteria**:
- [ ] Returns events in chronological order
- [ ] Supports since parameter
- [ ] Can be used for real-time updates

---

## Definition of Done

- [ ] All tasks complete
- [ ] pilot serve starts server (tested)
- [ ] All endpoints return correct data (tested)
- [ ] API documented

---

## Future Work (Not This Sprint)

- Write endpoints (POST, PUT, DELETE)
- WebSocket for real-time updates
- Authentication
- Kanban UI (separate milestone)

---

*Sprint created: 2026-01-21*
