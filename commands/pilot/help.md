---
name: pilot:help
description: Display help and documentation for all Pilot AGI commands. Use when the user asks about available commands or how to use Pilot AGI.
allowed-tools: Read
---

# Pilot AGI Help

Display this help information:

```
╔══════════════════════════════════════════════════════════════╗
║                      PILOT AGI                               ║
║         AI-powered development framework v0.1.0              ║
╚══════════════════════════════════════════════════════════════╝

COMMANDS
────────────────────────────────────────────────────────────────

  /pilot:init       Initialize a new project
                    Creates .planning/ with PROJECT.md, ROADMAP.md, STATE.md

  /pilot:scan       Analyze existing codebase
                    Builds understanding of code structure and patterns

  /pilot:milestone  Manage milestones
                    Create, complete, or list project milestones

  /pilot:plan [N]   Plan work for phase N
                    Creates detailed implementation plan, waits for approval

  /pilot:exec       Execute approved plan
                    Implements plan step-by-step with verification

  /pilot:verify     Verify completion
                    Confirms implementation meets requirements

  /pilot:quick      Ad-hoc tasks
                    Quick fixes and small changes without full planning

  /pilot:status     Check progress
                    Shows current position, completed work, next steps

  /pilot:update     Update framework
                    Downloads and installs latest version

  /pilot:help       Show this help
                    You are here!

WORKFLOW
────────────────────────────────────────────────────────────────

  New Project:
    /pilot:init → /pilot:plan 1 → /pilot:exec → /pilot:verify

  Existing Project:
    /pilot:scan → /pilot:plan N → /pilot:exec → /pilot:verify

  Quick Task:
    /pilot:quick "fix the bug"

  Check Progress:
    /pilot:status

PROJECT FILES
────────────────────────────────────────────────────────────────

  .planning/
  ├── PROJECT.md    Vision & requirements
  ├── ROADMAP.md    Milestones & phases
  ├── STATE.md      Current progress
  ├── config.json   Settings
  ├── research/     Domain research
  ├── plans/        Phase plans
  └── sessions/     Session recovery

MORE INFO
────────────────────────────────────────────────────────────────

  GitHub:  https://github.com/vadymsyliava/Pilot-AGI
  Issues:  https://github.com/vadymsyliava/Pilot-AGI/issues
  Update:  /pilot:update

```

If the user asks about a specific command, provide more details about that command.
