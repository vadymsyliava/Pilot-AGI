---
name: pilot-close
description: Validate Definition of Done (DoD) and close the bd issue. Checks all plan steps complete, tests pass, requirements met. Use when task is finished.
allowed-tools: Read, Bash
---

# Close Task

You are validating completion and closing the bd task.

## Step 1: Get current task

```bash
bd issues --status in_progress --json
```

## Step 2: Load plan and verify all steps complete

Read `work/plans/{bd-id}-plan.md` and session capsule.

Check each step was completed and committed.

## Step 3: Run final verification

Execute the full verification from the plan:

```bash
{test command}
```

## Step 4: Validate Definition of Done

Display checklist:

```
╔══════════════════════════════════════════════════════════════╗
║  DEFINITION OF DONE                                          ║
║  Task: {bd-xxxx} - {title}                                   ║
╚══════════════════════════════════════════════════════════════╝

PLAN COMPLETION
────────────────────────────────────────────────────────────────
  [✓] Step 1: {name} - committed {hash}
  [✓] Step 2: {name} - committed {hash}
  [✓] Step 3: {name} - committed {hash}

REQUIREMENTS
────────────────────────────────────────────────────────────────
  [✓] {requirement 1 from spec}
  [✓] {requirement 2 from spec}
  [ ] {requirement 3} ← NOT MET

VERIFICATION
────────────────────────────────────────────────────────────────
  [✓] All tests pass
  [✓] No regressions
  [✓] Code reviewed

────────────────────────────────────────────────────────────────
```

## Step 5: Handle incomplete items

If any DoD items not met:

```
⚠ Task cannot be closed - DoD not satisfied

Missing:
  • {item 1}
  • {item 2}

Options:
1. Continue work: /pilot-exec
2. Close anyway with note
3. Create follow-up task for remaining work
```

## Step 6: Close the bd issue

If all complete:

```bash
bd update {id} --status closed
```

## Step 7: Update session capsule

Append to `runs/YYYY-MM-DD.md`:

```markdown
### Task closed: {HH:MM}
- Task: {bd-xxxx}
- Title: {title}
- Commits: {N}
- Duration: {time from claim to close}

### Summary
{Brief summary of what was accomplished}
```

## Step 8: Report completion

```
════════════════════════════════════════════════════════════════
✓ TASK COMPLETE
════════════════════════════════════════════════════════════════

  Task:     {bd-xxxx}
  Title:    {title}
  Commits:  {N}
  Status:   Closed

  Summary:
    {what was accomplished}

────────────────────────────────────────────────────────────────
Next:
  • /pilot-next to pick next task
  • bd ready to see remaining work
════════════════════════════════════════════════════════════════
```

## Important Rules
- NEVER close without verifying DoD
- All steps must be committed
- Tests must pass
- Document what was done in session capsule
- If requirements changed, note it before closing
