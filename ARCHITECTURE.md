# Pilot AGI Architecture

## Design Philosophy

1. **bd as SSOT** - Tasks live in beads, not markdown
2. **Token Efficiency** - Progressive disclosure, minimal context
3. **Crash Recovery** - Session capsules enable continuity
4. **Verifiable Progress** - Every step has verification criteria

## The Canonical Loop

```
bd ready → /pilot-plan → (approve) → /pilot-exec → /pilot-commit → /pilot-review → /pilot-close
```

This loop ensures:
- Dependencies are respected (bd ready)
- Plans are approved before execution
- Each step is verified before committing
- DoD is validated before closing

## Directory Structure

```
pilot-agi/                      # npm package
├── bin/
│   └── install.js              # npx installer
├── .claude/
│   ├── skills/
│   │   ├── pilot-help/SKILL.md
│   │   ├── pilot-next/SKILL.md
│   │   ├── pilot-plan/SKILL.md
│   │   ├── pilot-exec/SKILL.md
│   │   ├── pilot-commit/SKILL.md
│   │   ├── pilot-review/SKILL.md
│   │   ├── pilot-close/SKILL.md
│   │   ├── pilot-research/SKILL.md
│   │   ├── pilot-status/SKILL.md
│   │   └── pilot-update/SKILL.md
│   └── pilot/
│       ├── hooks/
│       │   └── session-start.js
│       ├── templates/
│       │   ├── session-capsule.md
│       │   ├── ROADMAP.md
│       │   └── spec.md
│       ├── prompts/
│       │   └── roles/
│       └── config.default.json
├── work/                       # Planning templates
├── runs/                       # Session capsule directory
├── CLAUDE.md                   # Agent contract
├── package.json
├── README.md
└── CHANGELOG.md
```

## Project Structure (after installation)

```
user-project/
├── .beads/                     # Task database (created by bd init)
│   ├── issues.jsonl            # Task data (Git-tracked)
│   └── beads.db                # SQLite cache (not tracked)
├── .claude/
│   ├── skills/pilot-*/         # Installed skills
│   ├── pilot/                  # Framework internals
│   └── settings.json           # Hooks configuration
├── work/
│   ├── ROADMAP.md              # High-level planning
│   ├── milestones/
│   ├── sprints/
│   ├── specs/
│   ├── research/
│   └── plans/
├── runs/
│   └── YYYY-MM-DD.md           # Session logs
└── CLAUDE.md                   # Agent contract
```

## Beads Integration

### Why Beads?

- **Git-backed** - Tasks tracked alongside code
- **Dependency-aware** - DAG model prevents execution order issues
- **Multi-agent safe** - Hash-based IDs prevent merge conflicts
- **Agent-optimized** - JSON output for programmatic access

### Task Lifecycle

```
open → in_progress → closed
        ↓
      blocked (if dependencies not met)
```

### Key Commands

```bash
bd init                    # Initialize .beads/
bd create "Task title"     # Create task
bd ready                   # List actionable tasks
bd ready --json            # Machine-readable output
bd update <id> --status in_progress  # Claim task
bd dep add <id> --blocks <other>     # Add dependency
```

## Session Capsules

### Purpose

- **Crash Recovery** - Resume after unexpected interruption
- **Context Continuity** - Pick up where you left off
- **Progress Tracking** - See what was done

### Format

```markdown
# Session: 2026-01-20

## Tasks Worked
### Task: bd-a1b2
- Title: Implement auth
- Progress: Step 2/5

## Commits
- abc123 - feat(auth): add login endpoint

## Resume Context
- Current task: bd-a1b2
- Next action: /pilot-exec
```

## Governance Layer (Hooks)

Pilot AGI hooks are a **governance layer**, not workflow automation.
They enforce organizational policies without duplicating Claude Code's native capabilities.

### Hook Classification

| Hook | Type | Purpose |
|------|------|---------|
| session-start.js | Governance | Session coordination, policy context, task visibility |
| pre-tool-use.js | Governance | Enforce require_task, require_plan, protected_branches |
| user-prompt-submit.js | Governance | Semantic guardian - detect new work, ensure task tracking |
| quality-gate.js | Optional | Pre-commit checks (disabled by default - duplicates native) |

### Governance vs Workflow

**Governance hooks DO:**
- Enforce policy rules (block unauthorized edits)
- Inject context (task state, locked areas)
- Detect violations (new work without task)

**Governance hooks DON'T:**
- Suggest specific commands ("run /pilot-plan")
- Automate workflow steps
- Replace Claude Code native features

### Configuration

Governance behavior is controlled by `policy.yaml`:
- `enforcement.require_active_task` - Block edits without claimed task
- `enforcement.require_plan_approval` - Block edits without approved plan
- `enforcement.detect_new_scope` - Enable semantic guardian
- `quality_gates.enabled` - Enable optional quality checks (default: false)

## Token Efficiency Strategy

### Progressive Disclosure

1. **Tier 0** (always loaded): CLAUDE.md, current bd task
2. **Tier 1** (per task): Referenced spec section
3. **Tier 2** (on demand): Canonical patterns, specific files
4. **Tier 3** (rare): Full architecture docs

### Skill Constraints

- Each SKILL.md < 500 lines
- Load references on demand
- Summarize closed work in session capsules

## Update Mechanism

Updates are handled through standard npm mechanisms:

```bash
npm outdated -g pilot-agi    # Check for updates
npm update -g pilot-agi      # Install updates
```

The `/pilot-update` skill provides a convenient wrapper with changelog display.

## Git Branch Strategy

- `main` - Stable releases
- `release` - Push here triggers npm publish
- `dev` - Active development
