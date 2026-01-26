# Pilot AGI

**From idea to production with one command.** AI-powered development orchestrator that interviews you, plans your product, and builds it autonomously.

[![npm version](https://img.shields.io/npm/v/pilot-agi.svg)](https://www.npmjs.com/package/pilot-agi)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## One Command to Start

```bash
npx pilot-agi --global && /pilot-start
```

That's it. Pilot AGI will:
1. **Interview you** about your product vision
2. **Analyze** your business requirements
3. **Create** roadmap, milestones, and sprint backlog
4. **Build** your product with approval gates
5. **Coordinate** multiple AI agents seamlessly

---

## What Pilot AGI Does

| Phase | What Happens |
|-------|--------------|
| **Discovery** | Smart questions about your product, users, and goals |
| **Planning** | Creates PROJECT_BRIEF.md, ROADMAP.md, and sprint tasks |
| **Execution** | Builds features with plan → approve → execute → verify |
| **Coordination** | Runs 2-6 Claude Code windows without conflicts |
| **Quality** | Enforces policies, prevents duplicates, maintains consistency |

---

## How It Works

### Intelligent Hooks

Four hooks run automatically to enforce quality:

| Hook | Purpose |
|------|---------|
| `session-start` | Registers session, detects conflicts, loads context |
| `user-prompt-submit` | **Semantic Guardian** - detects new work, suggests existing tasks |
| `pre-tool-use` | Blocks edits without approved plan or claimed task |
| `quality-gate` | Validates changes before commit |

### Single Source of Truth

Everything stays synchronized:

```
.claude/pilot/
├── policy.yaml          # Governance rules
├── kb/                  # Knowledge base
│   ├── ROUTES.json      # All frontend routes
│   ├── OPENAPI.json     # All API endpoints
│   └── SCHEMA.json      # Database schema
└── state/               # Session coordination
    └── sessions/        # Active agent locks
```

No duplicate code. No conflicting changes. No forgotten context.

---

## Skills Reference

### Project Setup
| Skill | What It Does |
|-------|--------------|
| `/pilot-start` | Entry point - detects state, guides next step |
| `/pilot-init` | Interviews you, creates brief and roadmap |
| `/pilot-sprint` | Plans sprint with prioritized tasks |
| `/pilot-design` | Creates design system with components |

### Daily Workflow
| Skill | What It Does |
|-------|--------------|
| `/pilot-next` | Picks next task respecting dependencies |
| `/pilot-plan` | Creates implementation plan (requires approval) |
| `/pilot-exec` | Executes one verified micro-step |
| `/pilot-commit` | Creates conventional commit linked to task |
| `/pilot-close` | Validates Definition of Done |

### Autonomous Mode
| Skill | What It Does |
|-------|--------------|
| `/pilot-auto` | Runs tasks autonomously with guardrails |
| `/pilot-pause` | Stops autonomous execution gracefully |
| `/pilot-exec-sprint` | Parallel execution across agents |

### Governance
| Skill | What It Does |
|-------|--------------|
| `/pilot-approve` | Approves pending plan |
| `/pilot-review` | Code review checklist |
| `/pilot-session` | Shows active sessions and locks |
| `/pilot-claim` | Claims task with lease |
| `/pilot-release` | Releases task and locks |

### Research & Discovery
| Skill | What It Does |
|-------|--------------|
| `/pilot-research` | Deep research on a topic |
| `/pilot-research-sprint` | Researches all sprint tasks in parallel |
| `/pilot-discover` | Discovers product requirements |

### Utilities
| Skill | What It Does |
|-------|--------------|
| `/pilot-status` | Shows progress and next action |
| `/pilot-serve` | Starts Kanban API server |
| `/pilot-teleport` | Prepares context for session transfer |
| `/pilot-help` | Shows all commands |

---

## Multi-Agent Coordination

Run multiple Claude Code terminals on the same project:

```
Terminal 1: Working on frontend (locked: src/components/)
Terminal 2: Working on backend (locked: src/api/)
Terminal 3: Working on database (locked: prisma/)
```

**How it works:**
- Each session claims tasks with time-limited leases
- Area locking prevents file conflicts
- Heartbeats detect abandoned sessions
- Event stream keeps everyone synchronized

```bash
# Check who's working on what
/pilot-session

# Or via API
curl http://localhost:3333/api/locks
```

---

## The Workflow

```
/pilot-start
    ↓
"What are you building?" → Discovery interview
    ↓
PROJECT_BRIEF.md + ROADMAP.md created
    ↓
/pilot-sprint → Sprint tasks in bd (beads)
    ↓
/pilot-next → Claims top task
    ↓
/pilot-plan → Creates plan (APPROVAL REQUIRED)
    ↓
/pilot-exec → Executes step by step
    ↓
/pilot-commit → Atomic commits
    ↓
/pilot-close → Validates and closes task
    ↓
Repeat until done
```

Or just run `/pilot-auto` and watch it build.

---

## Policy Enforcement

Define rules in `policy.yaml`:

```yaml
enforcement:
  require_active_task: true      # No shadow work
  require_plan_approval: true    # Human oversight
  detect_new_scope: true         # Semantic guardian

approval_gates:
  database_migration: explicit   # Always ask
  auth_changes: explicit         # Security critical
  file_deletion: explicit        # Destructive

compliance_rules:
  hipaa: false                   # Enable for healthcare
  soc2: false                    # Enable for enterprise
  pci_dss: false                 # Enable for payments
```

---

## Why Pilot AGI?

| Problem | Solution |
|---------|----------|
| AI makes changes without oversight | Approval gates on every plan |
| No audit trail | Session capsules log everything |
| Duplicate code across features | Knowledge base tracks all patterns |
| Multiple agents conflict | Task claims and area locks |
| Context lost between sessions | Teleport and session state |
| Inconsistent architecture | Single source of truth for APIs, routes, schema |

---

## Project Structure

```
your-project/
├── .beads/              # Git-backed task database
├── .claude/pilot/
│   ├── policy.yaml      # Your governance rules
│   ├── hooks/           # Automatic enforcement
│   ├── kb/              # Knowledge base (auto-generated)
│   └── state/           # Session coordination
├── work/
│   ├── PROJECT_BRIEF.md # Your product vision
│   ├── ROADMAP.md       # Milestones and phases
│   └── plans/           # Approved implementation plans
├── runs/
│   └── YYYY-MM-DD.md    # Daily audit trail
└── CLAUDE.md            # Agent instructions
```

---

## Quick Commands

```bash
# Install globally
npx pilot-agi --global

# Start a new project
/pilot-start

# Check status anytime
/pilot-status

# Run autonomously
/pilot-auto

# See what's locked
/pilot-session
```

---

## Links

- [Changelog](./CHANGELOG.md)
- [Contributing](./CONTRIBUTING.md)
- [License](./LICENSE) (MIT)

---

**Pilot AGI** - Your AI development team, synchronized.
