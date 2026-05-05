# M7 Sprint: Agent Soul — Self-Educating, Opinionated, Evolving Agents

**Milestone**: 7 — "Agents That Learn, Opine, and Grow"
**Target**: v6.0.0

## Sprint Overview

Give every agent a persistent SOUL.md that evolves with real experience. Agents learn from failures, remember user corrections permanently, verify decisions against internet best practices, develop data-backed opinions, review each other's work, and plan sprints collaboratively. All from one terminal via PM daemon.

## Research Summary

### Key Patterns (from web research)
- **Dual-layer memory**: Hot path (recent sessions) + cold path (persistent soul file) — Mem0/AgentCore pattern
- **Reflexion pattern**: Critique-and-revise cycles where agents evaluate intermediate steps (ICLR 2026)
- **Implicit preference learning**: Track correction behaviors, not explicit config (RLHF-inspired)
- **Multi-lens peer review**: Specialized agents (security, perf, style) review simultaneously (Qodo/TEX pattern)

### Existing Infrastructure to Reuse
- `memory.js` — channel pub/sub for soul-updates broadcasting
- `session-start.js` line 543-563 — inject soul alongside shared memory context
- `agent-loop.js` DONE transition — plug in post-mortem generation
- `post-tool-use.js` line 66-80 — plug in correction detection
- `pm-research.js` — mirror patterns for best practice web search
- `analytics.js` — extend for growth tracking metrics
- Per-agent memory dirs already exist at `.claude/pilot/memory/agents/<role>/`

## Wave Execution Plan

### Wave 1 (Independent — start immediately)
| Task | Phase | Description |
|---|---|---|
| Pilot AGI-tfro | 7.1 | SOUL.md Schema & Lifecycle |
| Pilot AGI-h4yi | 7.3 | User Correction Capture |

These two are independent — **run in parallel**.

### Wave 2 (needs 7.1)
| Task | Phase | Blocked By |
|---|---|---|
| Pilot AGI-34nh | 7.2 | Pilot AGI-tfro (7.1) |
| Pilot AGI-j482 | 7.4 | Pilot AGI-tfro (7.1) |

Post-mortem pipeline and best practice verification both need soul file to write to.

### Wave 3 (needs Wave 2)
| Task | Phase | Blocked By |
|---|---|---|
| Pilot AGI-p92y | 7.5 | Pilot AGI-34nh + Pilot AGI-j482 (7.2+7.4) |
| Pilot AGI-m370 | 7.6 | Pilot AGI-34nh + Pilot AGI-h4yi (7.2+7.3) |

Opinions need outcome data. Self-assessment needs failure metrics + correction frequency.

### Wave 4 (needs 7.5)
| Task | Phase | Blocked By |
|---|---|---|
| Pilot AGI-xpc3 | 7.7 | Pilot AGI-tfro + Pilot AGI-p92y (7.1+7.5) |

Peer review needs soul-aware agents with established opinions.

### Wave 5 (needs 7.6+7.7)
| Task | Phase | Blocked By |
|---|---|---|
| Pilot AGI-si1p | 7.8 | Pilot AGI-m370 + Pilot AGI-xpc3 (7.6+7.7) |

Sprint planning needs skill data from self-assessment + trust from peer review.

### Wave 6 (needs all above)
| Task | Phase | Blocked By |
|---|---|---|
| Pilot AGI-nvn8 | 7.9 | Pilot AGI-si1p (7.8) |

Persistence layer needs stable soul format after all features are built.

## Task Details

### Phase 7.1: SOUL.md Schema & Lifecycle [Pilot AGI-tfro]
- Define schema: identity, preferences, opinions, lessons, corrections, patterns
- Create initial templates for all 8 agent roles
- Soul loader in session-start hook
- Soul writer API for self-updates
- PM soul editor for calibration
- 4KB size budget with consolidation
- Storage: `.claude/pilot/souls/<role>.md`

### Phase 7.2: Failure Post-Mortem Pipeline [Pilot AGI-34nh]
- Auto-detect: test failures, rejected PRs, escalations, budget overruns, drift
- Root cause classifier (5 categories)
- Lesson extraction: what → why → what to do differently
- Store in SOUL.md `## Lessons Learned` section
- Dedup with frequency tracking
- Pre-task lesson review before starting work

### Phase 7.3: User Correction Capture [Pilot AGI-h4yi]
- Detect: plan rejections, manual overrides, explicit corrections in prompts
- Classify: style, technical, convention, factual
- Extract behavioral rules → store in SOUL.md
- Rule application before decisions
- Confidence decay for old unreinforced rules
- Plug into post-tool-use + user-prompt-submit hooks

### Phase 7.4: Internet Best Practice Verification [Pilot AGI-j482]
- Decision gate before novel technical choices
- Source quality scoring (docs > blogs > SO)
- Citation requirement in plan comments
- Contradiction detection vs agent's plan
- Cache in shared memory
- Rate limit: max 5 searches per task

### Phase 7.5: Opinionated Agent Personalities [Pilot AGI-p92y]
- Opinion formation from repeated success (2-3x weak → 10+ strong)
- Expression in plans with evidence
- Challenge protocol with counter-evidence
- Evolution based on ongoing outcomes
- PM diversity preservation across team

### Phase 7.6: Agent Self-Assessment & Growth [Pilot AGI-m370]
- Metrics: success rate, time, rework, coverage, cost
- Skill progression tracking in SOUL.md
- PM-set growth goals with tracking
- Weekly auto-retrospective
- Skill gap detection → targeted learning

### Phase 7.7: Peer Review Protocol [Pilot AGI-xpc3]
- PM assigns reviewer by expertise match
- Review via one-shot `claude -p` with reviewer's SOUL.md
- Checklist: correctness, style, coverage, soul alignment
- Both reviewer + author update souls from outcome
- Lightweight mode for small changes

### Phase 7.8: Collaborative Sprint Planning [Pilot AGI-si1p]
- Agent bidding based on soul expertise + growth goals
- PM-mediated negotiation
- Soul-informed effort estimates
- Retrospective input per agent
- All via PM daemon + `claude -p` with soul injection

### Phase 7.9: Soul Persistence & Cross-Session [Pilot AGI-nvn8]
- Backup to `~/.pilot-agi/souls/` for cross-project
- Soul merge: global + project-specific
- Soul diff via git history
- Soul reset API (partial wipe)
- Format versioning for backward compat

## Definition of Done

- [ ] All 9 phases complete (tasks closed in bd)
- [ ] Tests passing (>80% coverage on new code)
- [ ] Every agent role has an evolving SOUL.md
- [ ] User correction → permanent soul rule (verified in 2+ tasks)
- [ ] Post-mortem pipeline catches failures and prevents repeats
- [ ] Agents cite web sources in plan decisions
- [ ] Peer review catches issues before PM review
- [ ] Sprint planning with agent input produces better estimates
- [ ] All runs from single `pm-daemon.js --watch` terminal

## Dependency Graph

```
Wave 1: [7.1 Soul Schema] ─────────────────────┬──── [7.3 Corrections]
             │                                   │
Wave 2: [7.2 Post-Mortems] [7.4 Best Practices] │
             │         │        │                │
Wave 3:      └────[7.5 Opinions]│    [7.6 Growth]┘
                       │        │        │
Wave 4:         [7.7 Peer Review]        │
                       │                 │
Wave 5:         [7.8 Sprint Planning]────┘
                       │
Wave 6:         [7.9 Persistence]
```

---

*Created by Pilot AGI /pilot-sprint*
