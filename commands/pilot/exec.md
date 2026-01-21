---
name: pilot:exec
description: Execute an approved implementation plan. Implements step-by-step with verification at each stage. Use after /pilot:plan has been approved.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Execute Plan

You are executing an approved implementation plan.

## Step 1: Load Plan

Read the current plan from `.planning/plans/phase-{N}-plan.md`
Read current state from `.planning/STATE.md`

If no approved plan exists:
```
No approved plan found. Run /pilot:plan first.
```

## Step 2: Execute Steps

For each step in the plan:

### Before Step
```
────────────────────────────────────────────────────────────────
Step {N}/{Total}: {Step Name}
────────────────────────────────────────────────────────────────
Goal: {Step goal}
Files: {Files to modify}
```

### During Step
1. Make the changes described in the step
2. Keep changes minimal and focused
3. Follow existing code patterns
4. Add tests if the plan specifies

### After Step
1. Run the verification command from the plan
2. If verification passes:
   ```
   ✓ Step {N} complete
   ```
3. If verification fails:
   ```
   ✗ Step {N} verification failed

   Error: {error message}

   Options:
   1. Fix and retry
   2. Skip and continue
   3. Stop execution
   ```

### Commit Step
After each successful step, create an atomic commit:
```bash
git add -A
git commit -m "feat(phase-{N}): {step description}"
```

## Step 3: Update Progress

After each step, update `.planning/STATE.md`:
```markdown
## Progress
- [x] Step 1: {name}
- [x] Step 2: {name}
- [ ] Step 3: {name} (in progress)
```

## Step 4: Handle Blockers

If you encounter something not covered by the plan:
1. Stop execution
2. Explain the blocker
3. Ask whether to:
   - Adjust the plan
   - Work around it
   - Abort this phase

## Step 5: Complete Execution

When all steps are done:
```
════════════════════════════════════════════════════════════════
Phase {N} Execution Complete
════════════════════════════════════════════════════════════════

Steps completed: {X}/{X}
Commits made: {Y}

Next: Run /pilot:verify to confirm everything works correctly.
```

Update STATE.md:
```markdown
## Current Position
- Phase: {N}
- Status: Execution Complete - Ready for Verification
```

## Important Rules
- Never skip verification steps
- Commit after each successful step (atomic commits)
- Stop and ask if something unexpected happens
- Keep the user informed of progress
- Don't deviate from the approved plan without permission
