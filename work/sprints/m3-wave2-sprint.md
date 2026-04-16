# Sprint: M3 Wave 2 — Autonomous Agent Intelligence

**Milestone**: 3 (Full Autonomy)
**Wave**: 2
**Started**: 2026-02-10
**Strategy**: Parallel execution — all 3 phases simultaneously

---

## Tasks

| ID | Phase | Title | Status | Agent |
|----|-------|-------|--------|-------|
| Pilot AGI-yyy | 3.2 | PM Auto-Research | open | — |
| Pilot AGI-5i4 | 3.6 | Agent Self-Activation | open | — |
| Pilot AGI-fjd | 3.9 | Agent-to-Agent Collaboration | open | — |

## Dependency Map

```
All Wave 1 deps satisfied:
  3.1 ✅ → 3.2, 3.6
  3.5 ✅ → 3.6
  3.10 ✅ → 3.9

Wave 2 internal:
  3.2 ──independent──→ 3.6
  3.9 ──enhances────→ 3.6 (agents can collaborate during auto-exec)
  All three can be built in parallel
```

## Feeds into Wave 3

```
3.2 → 3.3 (Task Auto-Decomposition uses research)
3.6 → 3.8 (Self-Healing builds on self-activation)
3.9 → 3.8 (Recovery uses agent collaboration)
```

## Done When

- [ ] PM auto-researches before assigning complex tasks
- [ ] Agents auto-start, claim, plan, execute without human input
- [ ] Agents communicate directly without PM intermediary
- [ ] 5+ agents self-organize in parallel terminals
