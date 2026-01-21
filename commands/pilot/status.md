---
name: pilot:status
description: Check current project progress and state. Shows milestone, phase, completed work, and suggests next action. Use when user asks "where am I" or wants progress update.
allowed-tools: Read, Glob
---

# Check Project Status

Display current project state and suggest next actions.

## Step 1: Read State Files

Read these files if they exist:
- `.planning/STATE.md` - Current progress
- `.planning/ROADMAP.md` - Planned work
- `.planning/PROJECT.md` - Project overview

## Step 2: Display Status

Format output as:

```
╔══════════════════════════════════════════════════════════════╗
║                    PROJECT STATUS                            ║
╚══════════════════════════════════════════════════════════════╝

PROJECT: [Name from PROJECT.md]

CURRENT POSITION
────────────────────────────────────────────────────────────────
  Milestone:  [N] - [Name]
  Phase:      [N] - [Name]
  Status:     [In Progress / Planning / Verifying / Complete]

PROGRESS
────────────────────────────────────────────────────────────────
  Completed:  [X] phases
  Remaining:  [Y] phases

  [■■■■■■■■■□□□□□□] 60%

RECENT ACTIVITY
────────────────────────────────────────────────────────────────
  • [Last action from STATE.md]
  • [Previous action]

NEXT STEPS
────────────────────────────────────────────────────────────────
  Suggested: /pilot:[next-command]
  Reason: [Why this is the logical next step]

```

## Step 3: Suggest Next Action

Based on current state, suggest:

| Current State | Suggested Command |
|---------------|-------------------|
| Just initialized | `/pilot:plan 1` |
| Plan approved | `/pilot:exec` |
| Execution complete | `/pilot:verify` |
| Verification passed | `/pilot:plan [N+1]` |
| Milestone complete | `/pilot:milestone next` |
| No project found | `/pilot:init` |

## If No Project Found

If `.planning/` doesn't exist:
```
No Pilot AGI project found in this directory.

Run /pilot:init to start a new project.
```

## Notes
- Keep status display concise
- Always suggest a clear next action
- Show progress visually when possible
