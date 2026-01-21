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

## Step 2: Get ready tasks

```bash
bd ready --json 2>/dev/null
```

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

### Step 4.1: Offer ACTIONS (not commands!)

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

### 5.1: Change status to in_progress
```bash
bd update {id} --status in_progress
```

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

### 5.4: Ask for approval

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

## Status Flow

```
open (To-Do) → [user picks "Start Implementation"] → in_progress → [work done] → closed
```

The status change happens at the moment of commitment, not at display time.
