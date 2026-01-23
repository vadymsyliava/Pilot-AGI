---
name: pilot-approve
description: Approve an implementation plan for the current task. Creates approval state so pre-tool-use enforcement allows edits. Use after reviewing a plan from /pilot-plan.
allowed-tools: Read, Bash, Write
---

# Approve Plan

You are approving an implementation plan so that code edits are allowed.

## Background

The pre-tool-use hook enforces that Edit/Write operations require:
1. An active bd task (in_progress status)
2. An approved plan for that task

This skill creates the approval state file that unlocks editing.

## Step 1: Get current task

```bash
bd list --status in_progress --json
```

If no task is in progress:
```
╔══════════════════════════════════════════════════════════════╗
║  NO ACTIVE TASK                                              ║
╚══════════════════════════════════════════════════════════════╝

Cannot approve a plan without an active task.

Next:
  • /pilot-next to pick and start a task
```

Stop here if no active task.

## Step 2: Check for existing plan

Look for plan file:
```bash
ls work/plans/{bd-id}*.md 2>/dev/null || echo "no plan"
```

If no plan exists, suggest creating one first but DON'T block - user may have a mental plan or plan was communicated verbally.

## Step 3: Create approval state

Create directory if needed:
```bash
mkdir -p .claude/pilot/state/approved-plans
```

Create approval file at `.claude/pilot/state/approved-plans/{task-id}.json`:

```json
{
  "task_id": "{bd-xxxx}",
  "approved": true,
  "approved_at": "{ISO timestamp}",
  "plan_file": "{path to plan file if exists, null otherwise}"
}
```

## Step 4: Update session capsule

Append to `runs/YYYY-MM-DD.md`:

```markdown
### Plan approved: {HH:MM}
- Task: {bd-xxxx}
- Title: {title}
- Ready for: /pilot-exec
```

## Step 5: Report

```
╔══════════════════════════════════════════════════════════════╗
║  PLAN APPROVED                                               ║
╚══════════════════════════════════════════════════════════════╝

  Task:     {bd-xxxx}
  Title:    {title}
  Status:   Ready for implementation

────────────────────────────────────────────────────────────────
Edit/Write operations are now allowed for this task.

Next:
  • /pilot-exec to execute the plan step by step
  • Or start implementing directly
────────────────────────────────────────────────────────────────
```

## Revoking Approval

If the user wants to revoke approval (e.g., plan needs changes):

```bash
rm .claude/pilot/state/approved-plans/{task-id}.json
```

Then edits will be blocked again until re-approved.

## Important Rules

- Approval is per-task, not global
- Approval persists until task is closed or approval file is deleted
- Always show clear confirmation of approval
- If user seems unsure, ask for confirmation before approving
