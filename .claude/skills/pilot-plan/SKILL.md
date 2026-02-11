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

## Step 5: Save plan

Save the plan to `work/plans/{bd-id}-plan.md`:

```markdown
# Plan: {task title}

**Task**: {bd-xxxx}
**Created**: {timestamp}
**Status**: Awaiting Approval

## Steps
[... plan content ...]
```

## Step 6: Handle approval

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
      // Check if this is an autonomous worker (spawned by PM or parallel executor)
      const isWorker = d.role || d.parent_pid;
      console.log(JSON.stringify({ autonomous: true, session_id: d.session_id }));
      process.exit(0);
    }
  } catch(e) {}
}
console.log(JSON.stringify({ autonomous: false }));
"
```

**If autonomous mode**: Auto-approve the plan immediately:
1. Create the approval file at `.claude/pilot/state/approved-plans/{taskId}.json`
2. Display: "Plan auto-approved (autonomous mode). Ready to implement. Run /pilot-exec to start."
3. Do NOT use AskUserQuestion — proceed to save and announce

**If interactive mode**: Display the plan and tell the user:
```
Plan saved to: work/plans/{bd-id}-plan.md

Ready to implement. Run /pilot-approve, then /pilot-exec to start.
```

## Step 7: Update session capsule

Append to `runs/YYYY-MM-DD.md`:
```markdown
### Plan created: {HH:MM}
- Task: {bd-xxxx}
- Steps: {N}
- Status: {Approved if autonomous, Awaiting Approval if interactive}
- Next: /pilot-exec
```

## Important Rules
- Keep steps small (each should be < 50 lines of change)
- Each step must have a verification method
- Follow existing patterns (check canonical/ first)
- If task is too big, suggest breaking into multiple bd issues
- In autonomous mode, auto-approve and proceed — do NOT wait for user input
- In interactive mode, save the plan and tell the user to run /pilot-approve
