# M6 Sprint: Multi-LLM Orchestration — "The Right AI for Every Task"

**Milestone**: 6 — Universal AI Coding Orchestrator
**Target**: v5.0.0
**Spec**: `work/specs/m6-multi-llm-orchestration.md`

## Sprint Overview

Transform Pilot AGI from Claude-only to universal multi-LLM orchestrator. Any model (Claude, GPT, Gemini, DeepSeek, Llama) works as an agent — governed by the same policies, sharing the same knowledge, coordinated by one PM Daemon. Smart scheduling routes tasks to the best model by capability, cost, and speed.

## Existing Work (Carried Forward)

Terminal providers and Telegram from old M6 spec are absorbed into new M6:

| Old Task | Status | Maps To |
|---|---|---|
| Pilot AGI-xqn: AppleScript Bridge | DONE | Phase 6.8+6.9 Terminal Providers |
| Pilot AGI-3du: iTerm2 Provider | DONE | Phase 6.9 Terminal Providers |
| Pilot AGI-l6p: Terminal Controller | IN PROGRESS | Phase 6.10 Multi-LLM Spawner (partial) |
| Pilot AGI-6l3: Telegram Bridge | IN PROGRESS | Phase 6.14 Telegram Bot |
| Pilot AGI-pl7: Telegram Approval | PENDING | Phase 6.15 Telegram Approval |
| Pilot AGI-msm: E2E Testing | PENDING | Phase 6.18 Integration Testing |

## Wave Execution Plan

### Wave 1 (Independent — start immediately, max parallelism: 5)

| Task | Phase | Description | Deps |
|---|---|---|---|
| Pilot AGI-cni | 6.1 | Agent Adapter Interface & Registry | none |
| Pilot AGI-bqq | 6.11 | Model Capability Registry | none |
| Pilot AGI-41c | 6.17 | macOS Permission Setup | none |
| ◐ Pilot AGI-6l3 | 6.14 | Telegram Bridge (in progress) | none |
| ◐ Pilot AGI-l6p | 6.10 | Terminal Controller (in progress) | none |

### Wave 2 (needs 6.1 adapter interface)

| Task | Phase | Description | Blocked By |
|---|---|---|---|
| Pilot AGI-0ub | 6.2 | Claude Code Adapter | cni (6.1) |
| Pilot AGI-7u3 | 6.3 | Aider Adapter (GPT/DeepSeek) | cni (6.1) |
| Pilot AGI-pg3 | 6.4 | OpenCode Adapter (Gemini) | cni (6.1) |
| Pilot AGI-eud | 6.5 | Codex CLI Adapter | cni (6.1) |
| Pilot AGI-5w6 | 6.6 | Ollama Adapter (Local/Free) | cni (6.1) |
| Pilot AGI-pl7 | 6.15 | Telegram Approval & Conversations | 6l3 (6.14) |

### Wave 3 (needs adapters + model registry)

| Task | Phase | Description | Blocked By |
|---|---|---|---|
| Pilot AGI-mkn | 6.7 | Universal Enforcement Layer | 0ub, 7u3, 5w6 |
| Pilot AGI-vdx | 6.10 | Terminal-Aware Multi-LLM Spawner | cni, 0ub |
| Pilot AGI-5ww | 6.12 | Model-Aware Task Scheduler | bqq (6.11), cni (6.1) |
| Pilot AGI-bro | 6.13 | Cross-Model Cost Normalization | bqq (6.11) |

### Wave 4 (integration — needs everything)

| Task | Phase | Description | Blocked By |
|---|---|---|---|
| Pilot AGI-5jg | 6.16 | PM Dashboard Multi-Model View | vdx, bro |
| Pilot AGI-094 | 6.18 | E2E Integration Testing | mkn, vdx, 5ww, 5jg |

## Dependency Graph

```
Wave 1:  [6.1 Adapter IF]────────────────────────────┐
         [6.11 Model Reg]──────────────┐              │
         [6.14 Telegram]───┐           │              │
         [6.17 macOS]      │           │              │
                           │           │              │
Wave 2:  [6.2 Claude]──┐  │   [6.15 Approval]        │
         [6.3 Aider]──┐│  │           │              │
         [6.4 OpenCode]││  │           │              │
         [6.5 Codex]   ││  │           │              │
         [6.6 Ollama]──┤│  │           │              │
                       ││  │           │              │
Wave 3:  [6.7 Enforce]─┘│  │           │              │
         [6.10 Spawner]──┘  │           │              │
         [6.12 Scheduler]───┘           │              │
         [6.13 Cost]────────┘           │              │
                                        │              │
Wave 4:  [6.16 Dashboard]──────────────┘              │
         [6.18 E2E]────────────────────────────────────┘
```

## Parallel Execution Strategy

**Sprint 1 (Waves 1+2): Foundation — max 5 parallel agents**
- Agents A+B: 6.1 Adapter Interface + 6.11 Model Registry (parallel, independent)
- Agents C+D: Continue 6.14 Telegram + 6.10 Terminal Controller (in progress)
- Agent E: 6.17 macOS permissions
- After 6.1 done: Agents fan out to 6.2-6.6 adapters (5-way parallel!)

**Sprint 2 (Wave 3): Intelligence — max 4 parallel agents**
- Agent A: 6.7 Universal Enforcement
- Agent B: 6.12 Model-Aware Scheduler
- Agent C: 6.13 Cost Normalization
- Agent D: 6.10 Multi-LLM Spawner (extends terminal controller)

**Sprint 3 (Wave 4): Integration — max 2 agents**
- Agent A: 6.16 PM Dashboard
- Agent B: 6.18 E2E Testing (after dashboard done)

## Task ID Reference (All M6)

| ID | Phase | Title | Priority | Status | Sprint |
|---|---|---|---|---|---|
| Pilot AGI-cni | 6.1 | Agent Adapter Interface & Registry | P1 | open | 1 |
| Pilot AGI-0ub | 6.2 | Claude Code Adapter | P1 | open | 1 |
| Pilot AGI-7u3 | 6.3 | Aider Adapter (OpenAI/DeepSeek) | P1 | open | 1 |
| Pilot AGI-pg3 | 6.4 | OpenCode Adapter (Google Gemini) | P1 | open | 1 |
| Pilot AGI-eud | 6.5 | Codex CLI Adapter | P2 | open | 1 |
| Pilot AGI-5w6 | 6.6 | Ollama Adapter (Local Free Models) | P1 | open | 1 |
| Pilot AGI-mkn | 6.7 | Universal Enforcement Layer | P1 | open | 2 |
| Pilot AGI-xqn | 6.8+6.9 | AppleScript Bridge (done) | P1 | closed | — |
| Pilot AGI-3du | 6.9 | iTerm2 Provider (done) | P1 | closed | — |
| Pilot AGI-l6p | 6.10 | Terminal Controller (partial) | P1 | in_progress | 1 |
| Pilot AGI-vdx | 6.10 | Terminal-Aware Multi-LLM Spawner | P1 | open | 2 |
| Pilot AGI-bqq | 6.11 | Model Capability Registry | P1 | open | 1 |
| Pilot AGI-5ww | 6.12 | Model-Aware Task Scheduler | P1 | open | 2 |
| Pilot AGI-bro | 6.13 | Cross-Model Cost Normalization | P1 | open | 2 |
| Pilot AGI-6l3 | 6.14 | Telegram Bridge | P1 | in_progress | 1 |
| Pilot AGI-pl7 | 6.15 | Telegram Approval & Conversations | P2 | open | 1 |
| Pilot AGI-5jg | 6.16 | PM Dashboard Multi-Model View | P2 | open | 3 |
| Pilot AGI-41c | 6.17 | macOS Permission Setup | P2 | open | 1 |
| Pilot AGI-094 | 6.18 | E2E Integration Testing | P2 | open | 3 |

## Definition of Done

Each phase must have:
- [ ] Implementation complete per spec
- [ ] Unit tests passing
- [ ] Integration with existing infrastructure verified
- [ ] No breaking changes to headless mode
- [ ] policy.yaml section documented
- [ ] Works with Claude-only setup (backward compatible)

## Success Metrics

- [ ] 5+ agent CLI adapters detected on startup
- [ ] Smart routing saves 50%+ vs all-Opus
- [ ] Cross-model shared memory works (Claude writes, GPT reads)
- [ ] Universal enforcement blocks unauthorized edits for any agent
- [ ] Overnight: 12 tasks, 4 models → morning report via Telegram

---

*Created by Pilot AGI /pilot-sprint — M6 Multi-LLM Orchestration*
