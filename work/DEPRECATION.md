# Pilot AGI Deprecation Notes

**Purpose**: Track features that overlap with Claude Code native functionality and decide keep/deprecate.

---

## Analysis: Pilot AGI vs Claude Code Native

### Features to KEEP (Add Governance Value)

| Skill | Why Keep |
|-------|----------|
| `/pilot-plan` | Adds approval gates on top of native Plan Mode |
| `/pilot-exec` | Adds verification requirements |
| `/pilot-commit` | Links commits to bd tasks (governance audit) |
| `/pilot-auto` | Adds policy enforcement to autonomous execution |
| `/pilot-approve` | Core governance - approval workflow |
| `/pilot-pause` | Governance control over autonomous mode |
| `/pilot-session` | Task claiming, leases, locks (coordination) |
| `/pilot-close` | DoD validation (quality gate) |
| `/pilot-review` | Pre-commit review checklist |
| `/pilot-serve` | Kanban API for monitoring/dashboards |

### Features to DEPRECATE (Redundant with Native)

| Skill | Native Equivalent | Action |
|-------|------------------|--------|
| `/pilot-parallel` | Task tool spawns parallel agents | **DEPRECATE** - use native Task tool |
| `/pilot-kb-sync` | No direct equivalent, but low value | **DEPRECATE** - KB auto-generation is fragile |
| `/pilot-kb-verify` | No direct equivalent, but low value | **DEPRECATE** - KB verification is brittle |

### Features to SIMPLIFY (Leverage Native)

| Skill | Change |
|-------|--------|
| `/pilot-research` | Keep but note it persists to work/research/ (native doesn't) |
| `/pilot-discover` | Consider merging into `/pilot-status` |

---

## Migration Notes

### /pilot-parallel → Native Task tool

Users who used `/pilot-parallel` should now use the native Task tool:

```
# Old (Pilot AGI)
/pilot-parallel "research task 1" "research task 2"

# New (Native Claude Code)
Use Task tool with run_in_background: true for parallel execution
```

### KB Features Deprecation

The knowledge base auto-sync features (`/pilot-kb-sync`, `/pilot-kb-verify`) are deprecated because:
1. They require maintaining generated JSON files
2. They're brittle when codebase changes
3. Claude Code's native exploration is more flexible

Users should rely on:
- Native `Glob` and `Grep` for codebase exploration
- Session capsules (`runs/`) for context continuity

---

## Timeline

- **v2.0.0**: Mark deprecated features with warnings
- **v2.1.0**: Remove deprecated skills entirely

---

*Last updated: 2026-01-25*
