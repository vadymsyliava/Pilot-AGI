---
name: pilot-close
description: Validate Definition of Done (DoD) and close the bd issue. Checks all plan steps complete, tests pass, requirements met. Use when task is finished.
allowed-tools: Read, Bash
---

# Close Task

You are validating completion and closing the bd task.

## Step 1: Get current task

```bash
bd list --status in_progress --json
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

## Step 9: Auto-chain (Autonomous Mode)

Load `.claude/pilot/policy.yaml` and check `autonomy` section.

If `autonomy.mode` is `"full"` AND `autonomy.auto_chain_on_close` is `true`:

### 9.1: Update autonomous state
Update `.claude/pilot/state/autonomous.json`:
- Add completed task ID to `completedTasks` array
- Check if `completedTasks.length >= autonomy.max_tasks_per_session` — if so, stop with "Session task limit reached"
- Check if consecutive errors >= `autonomy.max_consecutive_errors` — if so, stop

### 9.2: Release current task locks
```bash
node .claude/pilot/hooks/cli/release-task.js 2>/dev/null
```

### 9.3: Get next ready task
```bash
bd ready --json 2>/dev/null
```
Filter against claimed tasks:
```bash
node .claude/pilot/hooks/cli/list-claimed.js 2>/dev/null
```

### 9.4: Chain to next task
If an unclaimed ready task exists:
1. Claim it: `bd update {id} --status in_progress && node .claude/pilot/hooks/cli/claim-task.js {id}`
2. Create implementation plan (inline, same as /pilot-plan)
3. Auto-approve the plan (write approval file to `.claude/pilot/state/approved-plans/`)
4. Begin executing all steps (invoke /pilot-exec autonomous loop)

If NO unclaimed tasks remain:
```
════════════════════════════════════════════════════════════════
✓ ALL TASKS COMPLETE
════════════════════════════════════════════════════════════════

  Session summary:
    Tasks completed: {N}
    Total commits:   {M}

  No more ready tasks. Agent stopping.
════════════════════════════════════════════════════════════════
```

Update `autonomous.json` with `running: false` and `phase: "complete"`.

## Important Rules
- NEVER close without verifying DoD
- All steps must be committed
- Tests must pass
- Document what was done in session capsule
- If requirements changed, note it before closing
- In autonomous mode: auto-chain continues the loop until no tasks remain or limits are hit
