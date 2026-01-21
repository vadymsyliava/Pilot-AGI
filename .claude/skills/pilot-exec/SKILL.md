---
name: pilot-exec
description: Execute ONE micro-step from the approved plan. Makes changes, runs verification, updates session log. Use repeatedly until plan is complete.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Execute Micro-Step

You are executing ONE micro-step from the approved plan.

## Step 1: Load current state

Read the session capsule `runs/YYYY-MM-DD.md` to find:
- Current task (bd-xxxx)
- Current plan
- Last completed step

Read the plan from `work/plans/{bd-id}-plan.md`.

## Step 2: Identify next step

Find the next incomplete step in the plan.

Display:
```
╔══════════════════════════════════════════════════════════════╗
║  EXECUTING STEP {N}/{TOTAL}                                  ║
╚══════════════════════════════════════════════════════════════╝

  Task:  {bd-xxxx}
  Step:  {step name}
  Goal:  {step goal}
  Files: {files to modify}

────────────────────────────────────────────────────────────────
```

## Step 3: Execute the step

Make the changes described in the step:
- Keep changes minimal and focused
- Follow existing code patterns
- Don't scope creep beyond the step

## Step 4: Run verification

Execute the verification command from the plan:

```bash
{test command from plan}
```

Report result:
```
Verification: {PASS / FAIL}
```

If FAIL:
```
⚠ Step verification failed

Error: {error message}

Options:
1. Fix and retry verification
2. Rollback changes: git checkout -- {files}
3. Stop and reassess plan
```

## Step 5: Update session capsule

Append to `runs/YYYY-MM-DD.md`:

```markdown
### Step {N} complete: {HH:MM}
- Step: {step name}
- Files changed:
  - {file1}: {what changed}
  - {file2}: {what changed}
- Verification: PASS
- Next step: {N+1} - {next step name}
```

## Step 6: Report and prompt next action

```
────────────────────────────────────────────────────────────────
✓ Step {N}/{TOTAL} complete

Changed files:
  ~ {file1}
  ~ {file2}

Next:
  • /pilot-commit to commit this step
  • /pilot-exec to continue to next step
  • /pilot-review if you want code review first
────────────────────────────────────────────────────────────────
```

## Important Rules
- Execute ONLY ONE step at a time
- ALWAYS run verification before marking complete
- Update session capsule after every step (crash recovery)
- Don't deviate from the plan without re-approval
- Keep changes small and atomic
