# Sprint 4: Knowledge Base SSOT (Phase 3)

**Goal**: Product knowledge always current
**Milestone**: M1 - Pilot AGI v2.0
**Status**: Blocked by Sprint 3

---

## Sprint Backlog

### Epic: E-003 Knowledge Base

| ID | Task | Priority | Area | Status |
|----|------|----------|------|--------|
| T-018 | Create KB directory structure | P0 | config | pending |
| T-019 | Implement route auto-generation | P0 | kb | pending |
| T-020 | Create PAGES.yaml template | P1 | templates | pending |
| T-021 | Integrate OpenAPI validation | P1 | kb | pending |
| T-022 | Integrate Prisma/DBML validation | P1 | kb | pending |
| T-023 | Create /pilot-kb-sync skill | P1 | skills | pending |
| T-024 | Create /pilot-kb-verify skill | P1 | skills | pending |
| T-025 | Add KB context loading to agents | P0 | agents | pending |

---

## Task Details

### T-018: Create KB directory structure

**Description**: Set up the knowledge base directory structure.

**Files**:
- `.claude/pilot/kb/ui/`
- `.claude/pilot/kb/api/`
- `.claude/pilot/kb/data/`
- `.claude/pilot/kb/arch/`

**Acceptance Criteria**:
- [ ] Directories created on project init
- [ ] README explains purpose of each

---

### T-019: Implement route auto-generation

**Description**: Auto-generate ROUTES.generated.json from filesystem.

**Acceptance Criteria**:
- [ ] Scans src/app/ for Next.js routes
- [ ] Identifies page vs API routes
- [ ] Detects auth requirements
- [ ] Regenerates on /pilot-kb-sync

---

### T-025: Add KB context loading to agents

**Description**: Master agents automatically load relevant KB before work.

**Acceptance Criteria**:
- [ ] Frontend agent loads kb/ui/
- [ ] Backend agent loads kb/api/
- [ ] Database agent loads kb/data/
- [ ] All agents load kb/arch/

---

## Definition of Done

- [ ] All tasks complete
- [ ] Routes auto-generated correctly (tested)
- [ ] KB verify fails on drift (tested)
- [ ] Agents load KB context (tested)

---

*Sprint created: 2026-01-21*
