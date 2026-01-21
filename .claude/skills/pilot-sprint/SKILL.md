---
name: pilot-sprint
description: Plan next sprint with bd tasks. Reads ROADMAP.md, creates sprint definition, and generates bd issues with dependencies.
argument-hint: [sprint-number or "next"]
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion
---

# Sprint Planning

You are creating a sprint plan with concrete bd tasks.

## Arguments
- `$ARGUMENTS` contains sprint number (e.g., "1", "2") or "next" for the next sprint

## Step 1: Load Context

Read project context:
```bash
# Check if project is initialized
ls work/PROJECT_BRIEF.md work/ROADMAP.md
```

If files don't exist:
```
Project not initialized. Run /pilot-init first.
```

Read the files:
- `work/PROJECT_BRIEF.md` - Project scope and features
- `work/ROADMAP.md` - Milestones and phases

## Step 2: Determine Sprint Scope

Check existing sprints:
```bash
ls work/sprints/ 2>/dev/null || echo "No sprints yet"
```

If `$ARGUMENTS` is "next" or empty, determine the next sprint number.

Identify which phase(s) from ROADMAP.md should be in this sprint:
- For solo developers, 1 sprint = roughly 1 week
- Each sprint should complete 1-2 phases
- Sprint should have a clear, demo-able goal

## Step 3: Research Phase (Automatic)

For each phase in the sprint, identify technical decisions that need research:

- New libraries or frameworks being used
- APIs or integrations to connect
- Patterns not yet established in the codebase

For each topic needing research, create a quick summary:

```
RESEARCH NEEDED
────────────────────────────────────────────────────────────────
1. {topic} - {why needed}
2. {topic} - {why needed}
────────────────────────────────────────────────────────────────

Auto-research these topics? (yes / skip / select)
```

If yes, use WebSearch to research each topic and create brief findings.

## Step 4: Define Sprint Goal

```
SPRINT {N} PLANNING
────────────────────────────────────────────────────────────────

Sprint Goal: {Clear, measurable outcome}

Phases Included:
• Phase {X}: {name}
• Phase {Y}: {name} (optional)

Demo Criteria:
• {What can be shown at sprint end}
• {What can be shown at sprint end}

Duration: {start} to {end} (1 week default)

────────────────────────────────────────────────────────────────
```

## Step 5: Break Down Tasks

For each phase, create specific, actionable tasks.

Task sizing guidelines:
- Each task = 1-4 hours of work
- Each task has clear acceptance criteria
- Tasks should be independently committable
- Maximum 8-12 tasks per sprint (solo developer)

```
TASKS FOR SPRINT {N}
────────────────────────────────────────────────────────────────

Phase {X}: {name}
  1. {task title}
     AC: {acceptance criteria}

  2. {task title}
     AC: {acceptance criteria}
     Depends on: #1

Phase {Y}: {name}
  3. {task title}
     AC: {acceptance criteria}

  4. {task title}
     AC: {acceptance criteria}
     Depends on: #3

────────────────────────────────────────────────────────────────

Approve task breakdown? (yes / edit)
```

## Step 6: Create Sprint File

Write to `work/sprints/sprint-{NNN}.md`:

```markdown
# Sprint {N}

**Goal**: {sprint goal}
**Duration**: {start} to {end}
**Status**: Planning

---

## Phases

### Phase {X}: {name}
From ROADMAP.md Milestone {M}

### Phase {Y}: {name}
From ROADMAP.md Milestone {M}

---

## Tasks

| ID | Task | Phase | Status | Dependencies |
|----|------|-------|--------|--------------|
| 1 | {title} | {X} | pending | - |
| 2 | {title} | {X} | pending | #1 |
| 3 | {title} | {Y} | pending | - |
| 4 | {title} | {Y} | pending | #3 |

---

## Definition of Done

- [ ] All tasks complete
- [ ] Tests passing (>80% coverage on new code)
- [ ] No security vulnerabilities
- [ ] Demo criteria met
- [ ] Code reviewed

---

## Research

{Link to any research done during planning}

---

## Notes

{Any decisions made during sprint planning}

---

*Created by Pilot AGI /pilot-sprint*
```

## Step 7: Create bd Issues

For each task, create a bd issue:

```bash
bd create "{task title}" --label "{phase-label}" --desc "{acceptance criteria}"
```

Add dependencies:
```bash
bd dep add {dependent-id} {dependency-id}
```

## Step 8: Verify Setup

```bash
bd ready  # Should show first actionable tasks
```

## Step 9: Final Report

```
SPRINT {N} CREATED
────────────────────────────────────────────────────────────────

  Goal:     {sprint goal}
  Duration: {dates}
  Tasks:    {N} created in bd

  Ready to start:
  • {first actionable task}
  • {second actionable task}

  Files:
  • work/sprints/sprint-{NNN}.md

  Next Steps:
  1. Run: bd ready (see actionable tasks)
  2. Run: /pilot-next (pick first task)
  3. Run: /pilot-plan (plan implementation)

────────────────────────────────────────────────────────────────
```

## Important Rules

- Each sprint needs a clear, demo-able goal
- Keep sprints focused (1-2 phases max)
- Tasks must have acceptance criteria
- Research technical decisions before committing to them
- Create bd issues, not just markdown
- First tasks must have no dependencies
- Don't overplan - leave room for discovery
