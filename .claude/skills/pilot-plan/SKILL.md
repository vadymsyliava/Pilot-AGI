---
name: pilot-plan
description: Create a detailed implementation plan for the current bd task. Researches requirements, identifies files, creates step-by-step plan. In autonomous mode, auto-approves and continues.
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
```

## Step 5: Compute confidence score (Phase 5.1)

After generating the plan, compute the confidence score to determine the approval tier:

```bash
node -e "
const scorer = require('./.claude/pilot/hooks/lib/confidence-scorer');
const plan = {
  files: [/* list of files from the plan steps */],
  steps: [/* plan steps with files */]
};
const task = {
  id: '{bd-xxxx}',
  title: '{task title}',
  description: '{task description}',
  labels: [/* task labels */]
};
const result = scorer.scoreAndRecord(plan, task);
console.log(JSON.stringify(result));
"
```

Display the confidence result in the plan output:

```
CONFIDENCE ASSESSMENT
────────────────────────────────────────────────────────────────
  Score:    {score} ({tier})
  Factors:  scope={scope}, familiarity={familiarity},
            history={history}, risk={risk}
  Risks:    {risk_tags or 'none detected'}
  Action:   {auto-approve | notify-approve | require human approval}
────────────────────────────────────────────────────────────────
```

## Step 6: Save plan

Save the plan to `work/plans/{bd-id}-plan.md`:

```markdown
# Plan: {task title}

**Task**: {bd-xxxx}
**Created**: {timestamp}
**Confidence**: {score} ({tier})
**Status**: Awaiting Approval

## Steps
[... plan content ...]
```

## Step 7: Handle approval (confidence-tier-aware)

Check if running in autonomous mode (the ask-interceptor hook blocks AskUserQuestion):

```bash
node -e "
const fs = require('fs');
const sessionDir = '.claude/pilot/state/sessions';
const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.json') && !f.includes('.pressure'));
const ppid = process.ppid;
for (const f of files) {
  try {
    const d = JSON.parse(fs.readFileSync(sessionDir + '/' + f, 'utf8'));
    if (d.parent_pid === ppid && d.status === 'active' && !d.ended_at) {
      const isWorker = d.role || d.parent_pid;
      console.log(JSON.stringify({ autonomous: true, session_id: d.session_id }));
      process.exit(0);
    }
  } catch(e) {}
}
console.log(JSON.stringify({ autonomous: false }));
"
```

**If autonomous mode**: Use the confidence tier from Step 5 to decide:

- **auto_approve** (score >= 0.85): Auto-approve immediately:
  1. Create approval file at `.claude/pilot/state/approved-plans/{taskId}.json` with `confidence_tier: 'auto_approve'`
  2. Display: "Plan auto-approved (confidence: {score}, tier: auto). Executing..."
  3. Do NOT use AskUserQuestion — proceed directly to /pilot-exec

- **notify_approve** (0.60-0.85): Auto-approve with notification:
  1. Create approval file with `confidence_tier: 'notify_approve'`
  2. Display: "Plan notify-approved (confidence: {score}). Risk signals: {tags}. Proceeding..."
  3. Proceed to /pilot-exec

- **require_approve** (< 0.60): **STOP. Do not auto-approve.**
  1. Display warning:
     ```
     ⚠ HIGH-RISK PLAN — Confidence {score} (requires human approval)
     Risk signals: {risk_tags}

     This plan touches sensitive areas and needs human review.
     Run /pilot-approve to manually approve.
     ```
  2. Do NOT create approval file. Do NOT proceed to exec.

**If interactive mode**: Display the plan with confidence info:
```
Plan saved to: work/plans/{bd-id}-plan.md
Confidence: {score} ({tier})

Ready to implement. Run /pilot-approve, then /pilot-exec to start.
```

## Step 8: Update session capsule

Append to `runs/YYYY-MM-DD.md`:
```markdown
### Plan created: {HH:MM}
- Task: {bd-xxxx}
- Steps: {N}
- Confidence: {score} ({tier})
- Status: {Approved/Notify-Approved/Awaiting Human Approval}
- Next: /pilot-exec
```

## Important Rules
- Keep steps small (each should be < 50 lines of change)
- Each step must have a verification method
- Follow existing patterns (check canonical/ first)
- If task is too big, suggest breaking into multiple bd issues
- In autonomous mode, auto-approve and proceed — do NOT wait for user input
- In interactive mode, save the plan and tell the user to run /pilot-approve
