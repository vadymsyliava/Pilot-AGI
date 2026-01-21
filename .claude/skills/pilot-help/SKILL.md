---
name: pilot-help
description: Display help and documentation for all Pilot AGI commands. Shows the canonical workflow, available skills, and integration with beads (bd) for task management.
allowed-tools: Read
---

# Pilot AGI Help

Display this help information:

```
╔══════════════════════════════════════════════════════════════╗
║                      PILOT AGI                               ║
║     AI-powered development framework for Claude Code         ║
╚══════════════════════════════════════════════════════════════╝

GETTING STARTED
────────────────────────────────────────────────────────────────

  Just run: /pilot-start

  The AI will:
  • Detect your project state automatically
  • Show you what's next
  • Offer actions (not commands to type)
  • Do the work when you approve

HOW IT WORKS
────────────────────────────────────────────────────────────────

  Pilot AGI is ACTION-ORIENTED. You don't type commands.
  Instead, you're presented with choices:

    "What would you like to do?"
    → [Start Implementation] [Discuss] [Research] [Other Tasks]

  Pick an option. The AI handles everything else.

TYPICAL FLOW
────────────────────────────────────────────────────────────────

  1. /pilot-start or /pilot-next
     → Shows your next task (To-Do status)
     → Offers: Start Implementation / Discuss / Research

  2. Pick "Start Implementation"
     → Status changes to In Progress
     → AI creates implementation plan
     → Shows plan for your approval

  3. Approve plan
     → AI executes step by step
     → Shows progress
     → Asks "Commit changes?" when done

  4. Task complete
     → AI shows next task automatically
     → Cycle continues

TASK STATES
────────────────────────────────────────────────────────────────

  To-Do        Task exists, waiting to be started
      ↓        [User picks "Start Implementation"]
  In Progress  AI actively working on this task
      ↓        [Work completed and verified]
  Closed       Task done, committed, reviewed

  Note: Status only changes when you take action.
  Viewing a task doesn't change its status.

AVAILABLE SKILLS
────────────────────────────────────────────────────────────────

  Entry Points (start here):
  /pilot-start    Detect project state, guide you forward
  /pilot-next     Show next task, offer actions

  Project Setup:
  /pilot-init     New project: idea → brief → roadmap → tasks
  /pilot-sprint   Create tasks from roadmap milestone

  Design:
  /pilot-design   Create design system with shadcn/ui

  Utilities:
  /pilot-status   Show current progress
  /pilot-research Do research on a topic
  /pilot-help     Show this help
  /pilot-update   Check for updates

BEADS (bd) INTEGRATION
────────────────────────────────────────────────────────────────

  Pilot AGI uses beads (bd) to track tasks.
  You don't need to use bd commands - the AI handles it.

  But if you want to:
    bd ready       See actionable tasks
    bd issues      See all tasks
    bd create      Create a task manually

  Install: curl -fsSL https://beads.dev/install.sh | bash

PROJECT STRUCTURE
────────────────────────────────────────────────────────────────

  .beads/             Task database
  .claude/skills/     Pilot AGI skills
  work/
    PROJECT_BRIEF.md  What you're building
    ROADMAP.md        Milestones and phases
  runs/
    YYYY-MM-DD.md     Session logs

QUICK START
────────────────────────────────────────────────────────────────

  New project?     Run /pilot-start
  Resume work?     Run /pilot-next
  Need help?       Run /pilot-help

────────────────────────────────────────────────────────────────
  GitHub: https://github.com/vadymsyliava/Pilot-AGI
────────────────────────────────────────────────────────────────
```
