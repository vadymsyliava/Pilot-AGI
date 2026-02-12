---
name: pilot-pm-review
description: PM work review before merge approval. Checks drift, plan completion, worktree state, and tests. Used by PM terminal to gate merges.
argument-hint: <bd-task-id>
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion
---

# PM Work Review

Review an agent's completed work before approving merge. This is the PM's quality gate.

## When to Use

- Agent signals task complete (via message or bd status)
- Before merging agent worktree back to base branch
- When drift was previously detected and agent claims it's fixed

## Step 1: Identify Task

If `$ARGUMENTS` contains a task ID, use that. Otherwise:

```bash
node -e "
const orch = require('./.claude/pilot/hooks/lib/orchestrator');
const overview = orch.getProjectOverview();
const inProgress = overview.tasks.in_progress;
inProgress.forEach(t => console.log(t.id, '|', t.title));
" 2>/dev/null
```

Ask user which task to review if multiple.

## Step 2: Run Automated Review

```bash
node -e "
const orch = require('./.claude/pilot/hooks/lib/orchestrator');
const result = orch.reviewWork('{taskId}');
console.log(JSON.stringify(result, null, 2));
" 2>/dev/null
```

## Step 3: Display Results

```
╔══════════════════════════════════════════════════════════════╗
║  WORK REVIEW: {task_id}                                      ║
╚══════════════════════════════════════════════════════════════╝

AUTOMATED CHECKS
────────────────────────────────────────────────────────────────
  Plan Complete:    {✓ All steps done / ✗ Step X of Y}
  Drift Check:      {✓ No drift / ✗ Score: 0.XX, N unplanned files}
  Worktree Clean:   {✓ Clean / ✗ Uncommitted changes}
  Tests Pass:       {✓ Pass / ✗ Failed / — Not checked}

{If drift detected:}
DRIFT DETAILS
────────────────────────────────────────────────────────────────
  Planned files:
    {list}
  Actual files modified:
    {list}
  UNPLANNED (not in plan):
    {list with ⚠ markers}

{If issues found:}
ISSUES
────────────────────────────────────────────────────────────────
  1. {issue description}
  2. {issue description}
────────────────────────────────────────────────────────────────
```

## Step 4: Show Code Diff

Show the actual changes the agent made:

```bash
# Get the agent's branch
node -e "
const session = require('./.claude/pilot/hooks/lib/session');
const all = session.getAllSessionStates();
const owner = all.find(s => s.claimed_task === '{taskId}');
if (owner?.worktree_branch) {
  console.log(owner.worktree_branch);
}
" 2>/dev/null
```

Then show the diff:

```bash
git diff main...{branch} --stat
```

Present the file-level summary. Offer to show full diff for specific files.

## Step 5: Merge Decision

Use AskUserQuestion:

**Question**: "What's your decision?"

**Options**:
1. **Approve & merge** — All checks pass, merge to base branch
2. **Approve with notes** — Merge but leave feedback for agent
3. **Reject — needs fixes** — Send feedback, agent must fix issues
4. **Inspect more** — Read specific files before deciding

### 5.1: Approve & Merge

```bash
node -e "
const orch = require('./.claude/pilot/hooks/lib/orchestrator');
const pmState = orch.loadPmState();
const result = orch.approveMerge('{taskId}', pmState?.pm_session_id || 'PM');
console.log(JSON.stringify(result, null, 2));
" 2>/dev/null
```

Report merge result. If conflicts, show them and offer resolution options.

### 5.2: Reject with Feedback

Ask for feedback text, then:

```bash
node -e "
const orch = require('./.claude/pilot/hooks/lib/orchestrator');
const pmState = orch.loadPmState();
const result = orch.rejectMerge('{taskId}', pmState?.pm_session_id || 'PM', '{feedback}');
console.log(JSON.stringify(result, null, 2));
" 2>/dev/null
```

Confirms that rejection + feedback was sent to the agent via message bus.

## Important

- **Never merge without review** — even if all checks pass, human PM decides
- **Drift is advisory** — small drift may be acceptable (config files, etc.)
- **Feedback is delivered** — via message bus to the agent's session
- **All decisions logged** — to event stream and pm-decisions shared memory channel
