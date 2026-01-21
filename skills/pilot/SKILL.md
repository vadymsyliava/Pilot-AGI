---
name: pilot
description: AI-powered development framework for structured, verifiable coding workflows. Pilot AGI helps plan, execute, and verify implementation with token efficiency.
version: 0.1.0
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task
---

# Pilot AGI

You are using Pilot AGI, an AI-powered development framework designed for structured, verifiable coding workflows.

## Core Philosophy

1. **Plan Before Code** - Always understand what you're building before writing code
2. **Verify Always** - Every change should be verifiable
3. **Atomic Progress** - Small, committed steps that can be rolled back
4. **Token Efficiency** - Load only what's needed, when needed

## Workflow

The standard workflow is:
```
/pilot:init → /pilot:plan → /pilot:exec → /pilot:verify
```

For quick tasks:
```
/pilot:quick "description"
```

## Commands Reference

| Command | Purpose |
|---------|---------|
| `/pilot:init` | Initialize project with planning structure |
| `/pilot:scan` | Analyze existing codebase |
| `/pilot:milestone` | Manage milestones (new/complete/list) |
| `/pilot:plan [N]` | Plan phase N with detailed steps |
| `/pilot:exec` | Execute approved plan |
| `/pilot:verify` | Verify implementation meets requirements |
| `/pilot:quick` | Ad-hoc tasks without full planning |
| `/pilot:status` | Show current progress |
| `/pilot:update` | Update Pilot AGI |
| `/pilot:help` | Show help |

## Project Structure

Pilot AGI creates a `.planning/` directory:
```
.planning/
├── PROJECT.md      # Vision & requirements
├── ROADMAP.md      # Milestones & phases
├── STATE.md        # Current progress
├── config.json     # Settings
├── research/       # Research outputs
├── plans/          # Phase plans
└── sessions/       # Session recovery
```

## Guidelines

When using Pilot AGI:

1. **Always read before writing** - Understand existing code
2. **Follow the plan** - Don't deviate without approval
3. **Commit atomically** - One logical change per commit
4. **Verify after execution** - Always run /pilot:verify
5. **Update state** - Keep STATE.md current

## Commit Messages

Use conventional commits:
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation
- `refactor:` - Code restructuring
- `test:` - Adding tests
- `chore:` - Maintenance

Format: `type(scope): description`

Example: `feat(auth): add JWT validation middleware`
