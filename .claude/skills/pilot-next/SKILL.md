---
name: pilot-next
description: Pick the next ready task from beads (bd) and display its context. Use at the start of a work session or after completing a task.
allowed-tools: Bash, Read, Glob, Grep
---

# Pick Next Task

You are selecting the next task to work on from beads (bd).

## Step 1: Check bd is initialized

```bash
bd issues --limit 1
```

If bd is not initialized, inform the user:
```
Beads (bd) is not initialized in this project.

Run: bd init
Or install beads: curl -fsSL https://beads.dev/install.sh | bash
```

## Step 2: Get ready tasks

```bash
bd ready --json
```

This returns tasks with no open blockers, ordered by priority.

## Step 3: Select top task

Pick the first task from `bd ready`. Display:

```
╔══════════════════════════════════════════════════════════════╗
║  NEXT TASK                                                   ║
╚══════════════════════════════════════════════════════════════╝

  ID:       {bd-xxxx}
  Title:    {task title}
  Priority: {P0/P1/P2}
  Status:   {open → claiming...}

CONTEXT
────────────────────────────────────────────────────────────────
  Spec:     {link to spec if referenced}
  Milestone: {milestone name}
  Sprint:   {sprint name}

DESCRIPTION
────────────────────────────────────────────────────────────────
{task description/body}

DEPENDENCIES
────────────────────────────────────────────────────────────────
  Blocked by: (none - ready to work)
  Blocks:     {list of tasks this unblocks}

────────────────────────────────────────────────────────────────
Next: /pilot-plan to create implementation plan
```

## Step 4: Claim the task

Update the task status to in_progress:

```bash
bd update {id} --status in_progress
```

## Step 5: Load minimal context

Based on task metadata, load ONLY what's needed:
- If task references a spec: Read that spec file
- If task mentions specific files: Note them for /pilot-plan
- Don't load unnecessary context

## Step 6: Create session capsule

Append to today's run log `runs/YYYY-MM-DD.md`:

```markdown
## Session started: {HH:MM}

### Current task
- ID: {bd-xxxx}
- Title: {title}
- Status: in_progress

### Context loaded
- {files read}
```

## Important Rules
- Always use `bd ready` to pick tasks (respects dependencies)
- Claim tasks immediately to prevent conflicts in multi-agent setups
- Load minimal context - progressive disclosure
- Log everything to runs/ for crash recovery
