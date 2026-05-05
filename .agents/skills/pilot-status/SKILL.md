---
name: pilot-status
description: Show current project state, progress, and suggest next action. Reads from bd and session capsules to give complete picture.
allowed-tools: Read, Bash, Glob
---

# Project Status

You are displaying the current project state.

## Step 1: Check bd status

```bash
bd list --json
```

Get counts by status:
- Open
- In Progress
- Blocked
- Closed

## Step 2: Get current task

```bash
bd list --status in_progress --json
```

## Step 3: Read session capsule

Check `runs/YYYY-MM-DD.md` for today's activity.

## Step 4: Read planning docs

Check `work/ROADMAP.md` for milestone progress.

## Step 5: Display status

```
╔══════════════════════════════════════════════════════════════╗
║                    PROJECT STATUS                            ║
╚══════════════════════════════════════════════════════════════╝

CURRENT TASK
────────────────────────────────────────────────────────────────
  {If task in progress:}
  ID:       {bd-xxxx}
  Title:    {title}
  Status:   In Progress
  Progress: Step {N}/{total}

  {If no task:}
  No task currently in progress.
  Run /pilot-next to pick a task.

BD SUMMARY
────────────────────────────────────────────────────────────────
  Open:        {N} tasks
  In Progress: {N} tasks
  Blocked:     {N} tasks
  Closed:      {N} tasks

  Ready now:   {N} tasks (no blockers)

  [████████████░░░░░░░░] {percent}% complete

MILESTONE PROGRESS
────────────────────────────────────────────────────────────────
  Current: {milestone name}
  Phase:   {current phase}

TODAY'S SESSION
────────────────────────────────────────────────────────────────
  Started:  {time}
  Tasks:    {completed today}
  Commits:  {N}

────────────────────────────────────────────────────────────────
SUGGESTED NEXT ACTION
────────────────────────────────────────────────────────────────

  {Based on state, suggest one of:}
  • /pilot-next    (no task in progress)
  • /pilot-plan    (task claimed, no plan)
  • /pilot-exec    (plan approved)
  • /pilot-close   (all steps done)
  • bd ready       (check available work)
```

## Routing Logic

| State | Suggestion |
|-------|------------|
| No bd initialized | Run `bd init` |
| No task in progress | `/pilot-next` |
| Task claimed, no plan | `/pilot-plan` |
| Plan approved, steps remain | `/pilot-exec` |
| All steps complete | `/pilot-close` |
| Task closed | `/pilot-next` |

## Important Rules
- Always show clear next action
- Include progress visualization
- Note any blockers
- Check session capsule for context
