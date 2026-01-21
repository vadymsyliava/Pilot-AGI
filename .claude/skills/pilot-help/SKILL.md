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

CANONICAL WORKFLOW
────────────────────────────────────────────────────────────────

  New Project:
  /pilot-init → /pilot-sprint → bd ready → /pilot-plan → ...

  Daily Work:
  bd ready → /pilot-plan → (approve) → /pilot-exec → /pilot-commit → /pilot-review → /pilot-close

  1. /pilot-init      Initialize project (once per project)
  2. /pilot-sprint    Plan sprint with bd tasks
  3. bd ready         Pick top task (deps guarantee order)
  4. /pilot-plan      Create implementation plan, wait for approval
  5. /pilot-exec      Execute one micro-step with verification
  6. /pilot-commit    Create conventional commit with bd issue ID
  7. /pilot-review    Quick code review checklist
  8. /pilot-close     Validate DoD, close bd issue

SKILLS
────────────────────────────────────────────────────────────────

  Project Setup:
  /pilot-init       Initialize project with smart questions
  /pilot-sprint     Plan next sprint with bd tasks
  /pilot-design     Create/update design system (shadcn/ui)

  Workflow:
  /pilot-next       Pick next ready task from bd, show context
  /pilot-plan       Create implementation plan for current task
  /pilot-exec       Execute one micro-step only
  /pilot-commit     Create conventional commit linked to bd issue
  /pilot-review     Code review checklist (diff-focused)
  /pilot-close      Validate DoD and close bd issue

  Utilities:
  /pilot-research   Research a topic, store in work/research/
  /pilot-status     Show current position and progress
  /pilot-update     Update Pilot AGI to latest version
  /pilot-help       Show this help

BEADS (bd) INTEGRATION
────────────────────────────────────────────────────────────────

  Pilot AGI uses beads (bd) as the single source of truth for tasks.

  Key bd commands:
    bd ready          List actionable tasks (no blockers)
    bd create         Create a new task
    bd update <id>    Update task status
    bd dep add        Add dependencies between tasks
    bd issues         Query all tasks

  Install beads: curl -fsSL https://beads.dev/install.sh | bash

PROJECT STRUCTURE
────────────────────────────────────────────────────────────────

  .beads/             Task database (created by bd init)
  .claude/
    skills/pilot-*/   Pilot AGI skills
    pilot/            Framework internals (hooks, templates)
    settings.json     Hooks configuration
  work/
    ROADMAP.md        High-level planning
    milestones/       Milestone specs
    sprints/          Sprint planning
    specs/            Feature specifications
    research/         Research outputs
  runs/
    YYYY-MM-DD.md     Session capsules for recovery
  CLAUDE.md           Agent contract

MORE INFO
────────────────────────────────────────────────────────────────

  GitHub:  https://github.com/vadymsyliava/Pilot-AGI
  Beads:   https://github.com/steveyegge/beads
  Update:  /pilot-update

```
