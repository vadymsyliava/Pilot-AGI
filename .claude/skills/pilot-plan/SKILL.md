---
name: pilot-plan
description: Create a detailed implementation plan for the current bd task. Researches requirements, identifies files, creates step-by-step plan. ALWAYS wait for user approval before execution.
allowed-tools: Read, Glob, Grep, Bash
---

# Plan Implementation

You are creating an implementation plan for the current task.

## Step 1: Get current task

```bash
bd list --status in_progress --json
```

If no task is in progress:
```
No task currently in progress.
Run /pilot-next to pick a task first.
```

## Step 2: Load task context

From the task metadata, identify:
- **spec**: Link to specification file
- **milestone**: Which milestone this belongs to
- **canonical**: Any canonical patterns to follow

Read referenced files using progressive disclosure:
- Read spec section (not entire file)
- Read only relevant canonical patterns
- Note files that will need modification

## Step 3: Research

Before planning, understand:
1. What exactly needs to be built?
2. What patterns exist in the codebase?
3. What files will change?
4. What are the verification criteria?

Use `Glob` and `Grep` to explore - don't read entire codebase.

## Step 4: Create implementation plan

Structure the plan as micro-steps (each independently verifiable):

```
╔══════════════════════════════════════════════════════════════╗
║  IMPLEMENTATION PLAN                                         ║
║  Task: {bd-xxxx} - {title}                                   ║
╚══════════════════════════════════════════════════════════════╝

OVERVIEW
────────────────────────────────────────────────────────────────
{1-2 sentences describing what this accomplishes}

MICRO-STEPS
────────────────────────────────────────────────────────────────

Step 1: {name}
  Goal:   {what this step accomplishes}
  Files:  {files to modify}
  Test:   {how to verify this step}

Step 2: {name}
  Goal:   {what this step accomplishes}
  Files:  {files to modify}
  Test:   {how to verify this step}

[... continue for all steps ...]

VERIFICATION
────────────────────────────────────────────────────────────────
  [ ] {requirement 1 from spec}
  [ ] {requirement 2 from spec}
  [ ] All tests pass
  [ ] No regressions

RISKS
────────────────────────────────────────────────────────────────
  • {potential issue and mitigation}

────────────────────────────────────────────────────────────────
Approve this plan? (yes / no / edit)
```

## Step 5: STOP and wait for approval

**CRITICAL**: Do not proceed until user approves.

Display:
```
⏸  Waiting for approval...

Options:
  • Type "yes" or "approve" to proceed
  • Type "no" to cancel
  • Suggest edits to refine the plan
```

## Step 6: Save plan

Once approved, save to `work/plans/{bd-id}-plan.md`:

```markdown
# Plan: {task title}

**Task**: {bd-xxxx}
**Created**: {timestamp}
**Status**: Approved

## Steps
[... plan content ...]
```

## Step 7: Update session capsule

Append to `runs/YYYY-MM-DD.md`:
```markdown
### Plan created: {HH:MM}
- Task: {bd-xxxx}
- Steps: {N}
- Status: Approved
- Next: /pilot-exec
```

## Important Rules
- NEVER start implementation without approval
- Keep steps small (each should be < 50 lines of change)
- Each step must have a verification method
- Follow existing patterns (check canonical/ first)
- If task is too big, suggest breaking into multiple bd issues
