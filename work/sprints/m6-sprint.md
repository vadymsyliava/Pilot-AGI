# M6 Sprint: Physical Terminal Control & Remote Human Interface

**Milestone**: 6 — "PM Gets Hands + Voice"
**Target**: v5.0.0
**Spec**: `work/specs/iterm2-orchestration-telegram.md`

## Sprint Overview

Give PM daemon physical control over macOS terminals (AppleScript + iTerm2) and remote human access (Telegram). After this milestone, PM opens tabs, types into agents, reads output, auto-approves prompts, scales the pool, and reports to you on Telegram. You just talk to PM.

## Wave Execution Plan

### Wave 1 (Independent — start immediately)
| Task | Phase | Description |
|---|---|---|
| Pilot AGI-xqn | 6.1 | AppleScript Bridge Foundation |
| Pilot AGI-6l3 | 6.5 | Telegram Bridge |

These two are independent — **run in parallel**.

### Wave 2 (needs Wave 1)
| Task | Phase | Blocked By |
|---|---|---|
| Pilot AGI-3du | 6.2 | Pilot AGI-xqn (6.1) |
| Pilot AGI-pl7 | 6.6 | Pilot AGI-6l3 (6.5) |

iTerm2 provider needs AppleScript interface. Telegram approval needs basic bridge.

### Wave 3 (needs Wave 2)
| Task | Phase | Blocked By |
|---|---|---|
| Pilot AGI-l6p | 6.3 | Pilot AGI-xqn + Pilot AGI-3du (6.1+6.2) |

Unified controller needs both providers built.

### Wave 4 (needs Wave 3)
| Task | Phase | Blocked By |
|---|---|---|
| Pilot AGI-1nv | 6.4 | Pilot AGI-l6p (6.3) |

PM integration needs unified controller.

### Wave 5 (needs Wave 4 + Wave 2b)
| Task | Phase | Blocked By |
|---|---|---|
| Pilot AGI-msm | 6.7 | Pilot AGI-1nv + Pilot AGI-pl7 (6.4+6.6) |

E2E testing needs everything built.

## Dependency Graph

```
Wave 1:  [6.1 AppleScript]──────────────┐    [6.5 Telegram]──────┐
              │                          │         │               │
Wave 2:  [6.2 iTerm2]                   │    [6.6 Approval]       │
              │                          │         │               │
Wave 3:  [6.3 Controller]───────────────┘         │               │
              │                                    │               │
Wave 4:  [6.4 PM Integration]─────────────────────┘               │
              │                                                    │
Wave 5:  [6.7 E2E Testing]────────────────────────────────────────┘
```

## Parallel Execution Strategy

**Maximum parallelism: 2 agents**

- Wave 1: Agent A → 6.1 (AppleScript), Agent B → 6.5 (Telegram) — **parallel**
- Wave 2: Agent A → 6.2 (iTerm2), Agent B → 6.6 (Telegram Approval) — **parallel**
- Wave 3: Agent A → 6.3 (Controller) — **sequential** (needs both providers)
- Wave 4: Agent A → 6.4 (PM Integration) — **sequential**
- Wave 5: Agent A → 6.7 (E2E Testing) — **sequential** (needs everything)

## Task IDs Reference

| ID | Phase | Title | Priority | Deps |
|---|---|---|---|---|
| Pilot AGI-xqn | 6.1 | AppleScript Bridge Foundation | P1 | none |
| Pilot AGI-3du | 6.2 | iTerm2 Premium Provider | P1 | xqn |
| Pilot AGI-l6p | 6.3 | Terminal Controller (Unified) | P1 | xqn, 3du |
| Pilot AGI-1nv | 6.4 | PM Daemon Terminal Integration | P1 | l6p |
| Pilot AGI-6l3 | 6.5 | Telegram Bridge | P1 | none |
| Pilot AGI-pl7 | 6.6 | Telegram Approval & Conversations | P2 | 6l3 |
| Pilot AGI-msm | 6.7 | E2E Integration & Testing | P2 | 1nv, pl7 |

## Definition of Done

Each phase must have:
- [ ] Implementation complete per spec
- [ ] Unit tests passing
- [ ] Integration with existing infrastructure verified
- [ ] No breaking changes to headless mode
- [ ] Policy.yaml section documented
