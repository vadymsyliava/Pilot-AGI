---
name: pilot-next
description: Pick the next ready task from beads (bd) and display its context. Use at the start of a work session or after completing a task.
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion, Write
---

# Pick Next Task

You are selecting the next task to work on. Be PROACTIVE - never tell the user to run commands. Instead, offer actions and handle everything automatically.

## Core Principle: Action-Oriented UX

❌ NEVER say: "Run /pilot-plan to create implementation plan"
✅ ALWAYS say: "Start implementation?" and DO IT when they confirm

❌ NEVER say: "Next step: /pilot-commit"
✅ ALWAYS say: "Ready to commit?" and DO IT when they confirm

## Step 1: Check bd status

```bash
bd list --limit 1 2>/dev/null
```

## Step 2: Get available tasks (session-aware, deterministic)

Use the `next-task.js` CLI which does all filtering in code (no manual cross-referencing):

```bash
node .claude/pilot/hooks/cli/next-task.js 2>/dev/null
```

This returns JSON with:
- `session_id` — this session's ID (resolved by PID, not mtime)
- `my_claimed_task` — task already claimed by THIS session (if any)
- `available` — tasks NOT claimed by any other agent (use these)
- `total_ready` — total tasks bd considers ready
- `claimed_by_others` — how many are taken by other agents

If `my_claimed_task` is set, this session already has work — offer to resume it.
If `available` is empty and `claimed_by_others > 0`, tell the user "All ready tasks are claimed by other agents" and offer to wait or show claimed status. **CRITICAL**: Do NOT attempt to investigate, release, or take over another agent's claimed task. You must respect their claim.

## Step 3: Decision Tree

### Case A: Tasks exist and ready
→ Show task, offer actions (Step 4)

### Case B: No bd tasks exist
→ Check roadmap, offer to create tasks (Step 3B)

### Case C: bd not initialized
→ Check roadmap, offer to create tasks (Step 3B)

---

## Step 3B: No Tasks - Smart Detection

### 3B.1: Check for roadmap
```bash
ls work/ROADMAP.md work/*ROADMAP*.md 2>/dev/null
```

### 3B.2: If roadmap exists

Read roadmap, identify next incomplete milestone/phase, display:

```
╔══════════════════════════════════════════════════════════════╗
║  NO TASKS YET                                                ║
╚══════════════════════════════════════════════════════════════╝

NEXT MILESTONE: {milestone name}
────────────────────────────────────────────────────────────────
  1. {task from roadmap}
  2. {task from roadmap}
  3. {task from roadmap}
────────────────────────────────────────────────────────────────
```

### 3B.3: Ask with ACTION options (no commands!)

Use AskUserQuestion:

**Question**: "What would you like to do?"

**Options**:
1. **Create all tasks** - Immediately creates bd tasks from roadmap
2. **Discuss approach** - Have a conversation about implementation strategy
3. **Research first** - Explore before committing to tasks
4. **Define custom tasks** - Create different tasks than suggested

**CRITICAL**: When user picks an option, DO IT immediately. Don't tell them to run a command.

### 3B.4: If NO roadmap exists

```
╔══════════════════════════════════════════════════════════════╗
║  NO ROADMAP FOUND                                            ║
╚══════════════════════════════════════════════════════════════╝
```

Use AskUserQuestion:

**Question**: "This project has no roadmap. What are you building?"

**Options**:
1. **New project** - Start from scratch with smart questions
2. **Add to existing code** - Analyze codebase and plan features
3. **Quick task** - Just create a single task without full planning

Then handle their choice automatically.

---

## Step 4: Display Task (When tasks exist)

Show the first ready task:

```
╔══════════════════════════════════════════════════════════════╗
║  NEXT TASK                                                   ║
╚══════════════════════════════════════════════════════════════╝

  ID:       {bd-xxxx}
  Title:    {task title}
  Status:   To-Do

CONTEXT
────────────────────────────────────────────────────────────────
  Milestone: {milestone name}
  Blocks:    {what this unblocks when done}

DESCRIPTION
────────────────────────────────────────────────────────────────
{task description}
────────────────────────────────────────────────────────────────
```

### Step 4.1: Offer ACTIONS (mode-dependent)

**Check autonomy mode first**: Load `.claude/pilot/policy.yaml` and check `autonomy` section.

#### If `autonomy.mode` is `"full"`:
- **Skip AskUserQuestion** — automatically choose "Start implementation"
- Proceed directly to Step 5 (claim task, plan, auto-approve, execute)
- Display: `⚡ AUTONOMOUS MODE — Auto-starting task {bd-xxxx}`

#### If `autonomy.mode` is `"manual"` (or not set):
Use AskUserQuestion:

**Question**: "What would you like to do?"

**Options**:
1. **Start implementation** - Creates plan, changes status to in_progress
2. **See other tasks** - Show alternative tasks to work on
3. **Discuss this task** - Talk through the approach first
4. **Research first** - Look into something before starting

**CRITICAL**: Do NOT change status to in_progress here. Task stays "open/To-Do" until user explicitly chooses "Start implementation".

---

## Step 5: Handle "Start Implementation"

When user selects "Start implementation":

### 5.1: Atomic claim — bd status + session lease + broadcast

Change bd status AND claim in session state in one step.
This prevents other Claude Code sessions from working on the same task.

```bash
bd update {id} --status in_progress && node .claude/pilot/hooks/cli/claim-task.js {id}
```

The CLI helper does three things atomically:
1. Calls `session.claimTask()` — sets lease, locks session state
2. Broadcasts `task_claimed` event to all agents via message bus
3. Returns JSON with claim details (session_id, lease_expires_at)

**If claim fails** (already claimed by another session), show:
```
⚠ Task {id} is already claimed by session {other-session-id}
```
Then offer to pick a different task or wait.

### 5.2: Create session capsule
```bash
mkdir -p runs
echo "## $(date +%Y-%m-%d) Session

### Task: {bd-id}
- Title: {title}
- Status: in_progress
- Started: $(date +%H:%M)
" >> runs/$(date +%Y-%m-%d).md
```

### 5.3: AUTOMATICALLY create implementation plan

Do NOT say "Run /pilot-plan". Instead, immediately:

1. Analyze what needs to be done for this task
2. Identify files to create/modify
3. Break into micro-steps
4. Present the plan:

```
╔══════════════════════════════════════════════════════════════╗
║  IMPLEMENTATION PLAN                                         ║
╚══════════════════════════════════════════════════════════════╝

TASK: {title}
STATUS: In Progress

PLAN
────────────────────────────────────────────────────────────────
  Step 1: {description}
          Files: {files to touch}

  Step 2: {description}
          Files: {files to touch}

  Step 3: {description}
          Files: {files to touch}

VERIFICATION
────────────────────────────────────────────────────────────────
  • {how we'll know it works}
  • {test to run}
────────────────────────────────────────────────────────────────
```

### 5.4: Ask for approval (mode-dependent)

**Check autonomy mode first**: Load `.claude/pilot/policy.yaml` and check `autonomy` section.

#### If `autonomy.mode` is `"full"`:
- **Skip AskUserQuestion entirely** — do NOT ask the human
- Auto-approve the plan immediately:
  1. Write approval file to `.claude/pilot/state/approved-plans/{taskId}.json` with `auto_approved: true`
  2. Update `.claude/pilot/state/autonomous.json` with `running: true`, `currentTask: {taskId}`
  3. Display:
     ```
     ⚡ AUTONOMOUS MODE — Plan auto-approved
     ⚡ Executing all steps continuously...
     ```
  4. Begin executing ALL steps automatically (invoke /pilot-exec autonomous loop)
  5. After all steps: auto-commit each, auto-close, auto-chain to next task
  6. Agent enters continuous loop: plan -> exec all -> commit each -> close -> next

#### If `autonomy.mode` is `"manual"` (or not set):
Use AskUserQuestion:

**Question**: "Approve this plan?"

**Options**:
1. **Approve & start** - Begin implementation immediately
2. **Modify plan** - Adjust something before starting
3. **Cancel** - Go back to task selection

---

## Step 6: Handle "Discuss this task"

Have a natural conversation:
- Ask what aspects they want to discuss
- Answer questions about implementation
- When done, return to Step 4 action options

---

## Step 7: Handle "Research first"

Suggest topics based on task, then:
- Do the research
- Summarize findings
- Return to Step 4 action options

---

## Important Rules

1. **NEVER tell user to run commands** - You handle everything
2. **Task status is "open" until implementation starts** - Not when shown
3. **Be proactive** - Ask "Do this?" not "Run this command"
4. **Seamless flow** - One choice leads to the next action automatically
5. **User controls pace** - But you do the work
6. **NEVER release, modify, or override another agent's claimed task** - If a task is claimed by another session, you MUST NOT: release their claim, write to their session file, mark their session as abandoned, or call release-task.js with their session ID. Only the PM orchestrator can release another agent's task.
7. **NEVER judge another session as "abandoned" or "stale"** - That is the PM's job. If all tasks are claimed, offer to wait or ask the user — do not investigate other sessions to take over their work.
8. **Respect claim-task.js rejections** - If claim-task.js says the task is already claimed, accept it. Do not attempt workarounds.

## Status Flow

```
open (To-Do) → [user picks "Start Implementation"] → in_progress → [work done] → closed
```

The status change happens at the moment of commitment, not at display time.

## Multi-Session Coordination

### Pre-selection filtering (Step 2)

`next-task.js` does all filtering deterministically in code:
1. Resolves the calling session via PID matching (`resolveCurrentSession()`)
2. Calls `bd ready --json` to get all candidate tasks
3. Calls `getClaimedTaskIds(currentSessionId)` to find tasks claimed by OTHER sessions
4. Returns only unclaimed tasks in the `available` array

This eliminates both the race condition AND the LLM cross-referencing failure.

### Atomic claiming (Step 5)

When claiming a task via `claim-task.js`, the following happens atomically:
1. `resolveCurrentSession()` identifies the correct session by PID (not mtime)
2. `session.claimTask()` — writes claimed_task + lease to session state file
3. `messaging.sendBroadcast()` — sends `task_claimed` event to all agents
4. `session.logEvent()` — writes `task_claimed` to event stream

To release a task: `node .claude/pilot/hooks/cli/release-task.js`
