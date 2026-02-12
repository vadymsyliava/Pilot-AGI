---
name: pilot-exec
description: Execute micro-steps from the approved plan. In autonomous mode, executes ALL remaining steps continuously. Otherwise executes one step at a time.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Execute Micro-Step

## Autonomous Mode Check

Before executing, load `.claude/pilot/policy.yaml` and check the `autonomy` section.

If `autonomy.mode` is `"full"` AND `autonomy.auto_advance_steps` is `true`:
- Execute ALL remaining steps in sequence (not just one)
- After each step: verify -> commit (via `/pilot-commit` inline) -> continue to next step
- Only stop if verification fails AND `autonomy.stop_on_error` is `true`
- Update session capsule after each step
- After the LAST step completes successfully, automatically close the task (invoke `/pilot-close` logic inline)
- Do NOT prompt the user between steps — keep going until done or blocked

If `autonomy.mode` is `"manual"` (or not set): execute ONE step as before.

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

## Step 4b: Auto-generate tests (if enabled)

After verification passes and the step modified source code files, check if auto-test generation is enabled:

```bash
node -e "
const { loadConfig, runPipeline } = require('./.claude/pilot/hooks/lib/test-gen-integration');
const config = loadConfig();
if (!config.enabled) { console.log(JSON.stringify({ skipped: true, reason: 'disabled' })); process.exit(0); }
const result = runPipeline({ staged: true });
console.log(JSON.stringify(result));
"
```

If `test_generation.enabled` is `true` in policy.yaml:
- The pipeline analyzes staged changes, detects test framework, generates tests via claude -p
- Generated test files are written to the test directory and should be included in the commit
- If `test_generation.coverage_gate` is `true`, generated tests are run and coverage is checked

If the pipeline produces test files, include them in the step's commit.
If the coverage gate fails, report the failure but don't block the step.

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

### Manual mode:
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

### Autonomous mode:
After each step, display a brief progress line and continue immediately:
```
✓ Step {N}/{TOTAL}: {step name} — committed {hash}
```

After ALL steps complete:
```
════════════════════════════════════════════════════════════════
✓ ALL STEPS COMPLETE ({TOTAL}/{TOTAL})

Task:    {bd-xxxx}
Commits: {N}

Proceeding to close task...
════════════════════════════════════════════════════════════════
```

Then invoke `/pilot-close` logic inline (validate DoD, close bd issue, auto-chain to next task).

## Important Rules
- In manual mode: execute ONLY ONE step at a time
- In autonomous mode: execute ALL steps continuously, commit after each
- ALWAYS run verification before marking a step complete
- Update session capsule after every step (crash recovery)
- Don't deviate from the plan without re-approval
- Keep changes small and atomic
- If verification fails in autonomous mode: stop, log the error, report to user
