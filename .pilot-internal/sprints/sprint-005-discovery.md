# Sprint 5: Diamond Discovery (Phase 4)

**Goal**: Guide users through product discovery
**Milestone**: M1 - Pilot AGI v2.0
**Status**: Blocked by Sprint 4

---

## Sprint Backlog

### Epic: E-004 Discovery Process

| ID | Task | Priority | Area | Status |
|----|------|----------|------|--------|
| T-026 | Create /pilot-discover skill | P0 | skills | pending |
| T-027 | Implement competitive research automation | P1 | research | pending |
| T-028 | Create persona generation logic | P1 | discovery | pending |
| T-029 | Create insights gathering flow | P1 | discovery | pending |
| T-030 | Create FEATURES_BACKLOG.yaml management | P1 | discovery | pending |
| T-031 | Update /pilot-init with discovery flow | P0 | skills | pending |
| T-032 | Create discovery templates | P2 | templates | pending |

---

## Task Details

### T-026: Create /pilot-discover skill

**Description**: Main skill that orchestrates the discovery process.

**Files**:
- `.claude/skills/pilot-discover/SKILL.md`

**Acceptance Criteria**:
- [ ] Asks smart questions about problem space
- [ ] Triggers competitive research
- [ ] Guides through persona creation
- [ ] Synthesizes insights
- [ ] Outputs to discovery/ directory

---

### T-027: Implement competitive research automation

**Description**: Auto-research competitors using web search.

**Acceptance Criteria**:
- [ ] Searches for competitors by product type
- [ ] Extracts strengths, weaknesses, pricing
- [ ] Finds user reviews/complaints
- [ ] Outputs to COMPETITORS.md

---

### T-028: Create persona generation logic

**Description**: Generate user personas from discovery questions.

**Acceptance Criteria**:
- [ ] Creates primary and secondary personas
- [ ] Includes goals, frustrations, behaviors
- [ ] Includes voice-of-customer quotes
- [ ] Outputs to PERSONAS.yaml

---

### T-031: Update /pilot-init with discovery flow

**Description**: Integrate discovery into project initialization.

**Acceptance Criteria**:
- [ ] New projects go through discovery first
- [ ] Discovery outputs feed into brief generation
- [ ] User can skip discovery if desired
- [ ] Brief includes persona references

---

## Definition of Done

- [ ] All tasks complete
- [ ] Discovery flow asks relevant questions (tested)
- [ ] Competitive research finds real competitors (tested)
- [ ] Personas are useful and specific (tested)
- [ ] Discovery outputs saved correctly (tested)

---

*Sprint created: 2026-01-21*
