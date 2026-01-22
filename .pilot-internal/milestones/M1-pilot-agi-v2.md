# Milestone 1: Pilot AGI v2.0 - Autonomous Development Framework

**Goal**: Transform Pilot AGI into a fully autonomous development orchestrator
**Version**: v2.0.0
**Status**: In Progress

---

## Vision

Enable users to go from idea to production-ready product with minimal intervention:
- One command install
- Smart discovery process
- Autonomous execution after approval
- Multi-terminal parallel work
- Always-current product knowledge

---

## Phases

### Phase 1: Proactive Enforcement
**Sprint**: Sprint 1
**Goal**: No silent work - everything tracked and approved

Deliverables:
- [ ] policy.yaml governance SSOT
- [ ] session_start.js hook
- [ ] user_prompt_submit.js hook
- [ ] pre_tool_use.js hook (Edit/Write enforcement)
- [ ] /pilot-approve skill
- [ ] /pilot-new-task skill
- [ ] Run log templates

### Phase 2: Multi-Session Safety
**Sprint**: Sprint 2
**Goal**: 2-6 Claude Code terminals working without conflicts

Deliverables:
- [ ] Session ID generation
- [ ] Session state management
- [ ] Task claim/lease protocol
- [ ] Area locking system
- [ ] Event stream (sessions.jsonl)
- [ ] /pilot-session skill
- [ ] /pilot-claim skill
- [ ] /pilot-release skill

### Phase 3: Knowledge Base SSOT
**Sprint**: Sprint 3
**Goal**: Product knowledge always current

Deliverables:
- [ ] KB directory structure
- [ ] Route auto-generation
- [ ] OpenAPI integration
- [ ] Schema validation (Prisma/DBML)
- [ ] /pilot-kb-sync skill
- [ ] /pilot-kb-verify skill

### Phase 4: Diamond Discovery
**Sprint**: Sprint 4
**Goal**: Guide users through product discovery

Deliverables:
- [ ] /pilot-discover skill
- [ ] Competitive research automation
- [ ] Persona generation
- [ ] Insights gathering
- [ ] Features backlog management
- [ ] Updated /pilot-init with discovery flow

### Phase 5: Autonomous Execution
**Sprint**: Sprint 5
**Goal**: AI works independently after approval

Deliverables:
- [ ] Master agent definitions (frontend, backend, database)
- [ ] Context auto-loading
- [ ] Autonomous execution loop
- [ ] Parallel agent spawning
- [ ] Approval gates for high-risk actions

### Phase 6: Kanban API Foundation
**Sprint**: Sprint 6
**Goal**: API ready for future UI

Deliverables:
- [ ] pilot serve command
- [ ] Read-only endpoints
- [ ] Event streaming

---

## Success Criteria

- [ ] New project → first commit in < 15 minutes
- [ ] Multi-session conflicts: 0
- [ ] KB drift detection: 100%
- [ ] Autonomous task completion: > 80%
- [ ] User interventions: < 5 per day

---

## Dependencies

- bd (beads) for task management
- Claude Code hooks system
- Node.js >= 18

---

## Risks

| Risk | Mitigation |
|------|------------|
| Hook complexity | Start with minimal enforcement, add incrementally |
| Session conflicts | Conservative locking, clear error messages |
| KB maintenance burden | Auto-generate what we can, warn on drift |

---

*Milestone created: 2026-01-21*
