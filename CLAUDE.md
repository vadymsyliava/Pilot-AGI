# Pilot AGI Agent Contract

This document defines how AI agents should work within this project.

## Core Principles

1. **Plan Before Code** - Never implement without an approved plan
2. **Verify Always** - Every change must be tested/verified
3. **Atomic Progress** - Small commits, each independently valuable
4. **Token Efficiency** - Load only what's needed, when needed
5. **bd is Truth** - Task state lives in beads, not markdown

## The Canonical Loop

```
bd ready → /pilot-plan → (approve) → /pilot-exec → /pilot-commit → /pilot-review → /pilot-close
```

1. `bd ready` - Pick top task (dependencies guarantee correct order)
2. `/pilot-plan` - Create implementation plan, **WAIT for approval**
3. `/pilot-exec` - Execute ONE micro-step, run verification
4. `/pilot-commit` - Create conventional commit with bd issue ID
5. `/pilot-review` - Quick code review (diff-focused)
6. `/pilot-close` - Validate DoD, close bd issue

Repeat steps 3-5 until all plan steps complete, then step 6.

## Task Management

- **bd (beads)** is the single source of truth for tasks
- Never track tasks in markdown files
- Always reference bd issue IDs in commits
- Claim tasks before starting (`bd update <id> --status in_progress`)

## Planning Documents

Located in `work/`:
- `ROADMAP.md` - High-level milestones and phases
- `milestones/*.md` - Milestone details
- `sprints/*.md` - Sprint planning
- `specs/*.md` - Feature specifications
- `research/*.md` - Research outputs
- `plans/*.md` - Approved implementation plans

These are for planning context, not task tracking.

## Session Capsules

Located in `runs/`:
- One file per day: `YYYY-MM-DD.md`
- Log every significant action for crash recovery
- Include resume context at end of session

## Token Discipline

1. **Progressive Disclosure** - Load context only when needed
2. **Scoped Reads** - Read specific sections, not entire files
3. **Minimal Skills** - Each skill < 500 lines
4. **Session Logs** - Summarize closed work, don't carry full context

## Commit Convention

Format: `type(scope): description [bd-xxxx]`

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`

Always include the bd issue ID.

## Never Do

- Start implementing without plan approval
- Skip verification steps
- Commit without bd issue reference
- Track tasks in markdown (use bd)
- Load unnecessary context
- Deviate from approved plan without re-approval

## Always Do

- Update session capsule after each action
- Claim tasks before starting
- Run verification after each step
- Keep commits atomic and small
- Follow existing code patterns
- Check canonical patterns before creating new ones
