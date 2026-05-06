# Pilot AGI

**From idea to production with one command.** Pilot AGI is an open-source orchestration layer for Claude Code that interviews you, plans your product, creates a task graph, and coordinates AI agents until the work is shipped.

[![npm version](https://img.shields.io/npm/v/pilot-agi.svg)](https://www.npmjs.com/package/pilot-agi)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

![Pilot AGI demo](docs/assets/pilot-agi-demo.gif)

## What It Does

Pilot AGI gives AI coding agents the missing production workflow: discovery, planning, task tracking, approval gates, parallel execution, quality checks, PR automation, and persistent memory.

| You provide | Pilot AGI creates | Agents do |
|-------------|-------------------|-----------|
| A product idea or existing repo | `PROJECT_BRIEF.md`, `ROADMAP.md`, sprint tasks, policies | Build, test, commit, open PRs, monitor CI |

Use it when you want AI agents to work like a governed development team instead of a chat window with repo access.

## Quick Start

```bash
npx pilot-agi --global && /pilot-start
```

In a new project, Pilot AGI interviews you and generates the product brief, roadmap, milestones, and first sprint. In an existing repo, it reads the codebase, enforces task-first development, and starts coordinating work through `/pilot-next`, `/pilot-plan`, `/pilot-exec`, and `/pilot-close`.

## Why It Matters

- **No shadow work:** every change is tied to a `bd` task and an approved plan.
- **Parallel agents without chaos:** sessions claim tasks, lock areas, and work in isolated git worktrees.
- **Production guardrails:** tests, linting, quality gates, budget tracking, and escalation paths are built in.
- **Context survives:** agents checkpoint, respawn, and learn from persistent project memory.
- **Shipping is included:** Pilot AGI can push branches, open PRs, watch CI, merge green work, and clean up.

---

## Core Capabilities

### Multi-Agent Parallelism
Spawns up to 6 AI agent sessions working on different tasks simultaneously. Each agent operates in an isolated git worktree, so there are no merge conflicts during parallel work. A persistent **PM Daemon** acts as project manager: assigning tasks, detecting drift, gating merges, and handling escalations automatically.

### Intelligent Task Scheduling
Every task is scored across multiple factors before assignment:
- **Skill match** (55%) — routes tasks to the agent best suited for the work
- **Load balancing** (20%) — distributes work evenly across agents
- **Affinity** (15%) — agents that previously worked on related code get priority
- **Cost efficiency** (10%) — minimizes token spend per task

Starvation prevention ensures no task waits indefinitely.

### Enforced Plan-Before-Code
No agent can write code without an approved plan. The workflow is:

```
Plan created → Human approves → Agent executes → Verification runs → Commit
```

This prevents agents from going rogue, producing throwaway code, or drifting from requirements.

### Checkpoint & Respawn
Agents automatically save progress when context pressure gets high (60%+ usage). The PM Daemon detects checkpoint exits and respawns the agent with full context restored — including research, plan state, and partial work. Up to 10 respawns per task (configurable), with human escalation if the limit is reached.

### Cost & Budget Tracking
Token usage is tracked per-task, per-agent, and per-day with configurable budgets. When a budget threshold is hit, the system progressively escalates: warning → block → reassign → human notification. No surprise bills.

### Semantic Merge Resolution
When agents' work needs to be merged, Pilot AGI understands code structure — not just lines. It has language-aware parsers for JavaScript, TypeScript, Python, Go, and Rust that can:
- Combine additive changes automatically
- Resolve import merges intelligently
- Detect contradictory edits and escalate them
- Score confidence on each resolution (auto-resolve above 85%, escalate below 60%)

### Auto-Escalation Engine
Problems are handled progressively, not ignored:

| Event | Escalation Path |
|-------|-----------------|
| Plan drift | warning → block → reassign → human |
| Test failure | warning → block → reassign → human |
| Budget exceeded | warning → block → reassign → human |
| Merge conflict | auto-resolve → AI fallback → human |
| Agent unresponsive | ping → reassign → human |

Auto-de-escalation kicks in when conditions clear.

### PR Automation
When a task is complete, Pilot AGI can automatically:
- Validate commit format and task references
- Push to remote and create a pull request
- Monitor CI checks
- Auto-merge when all checks pass
- Clean up branches after merge

### Autonomous Code Quality
Every merge triggers a full quality sweep:
- **Duplicate detection** — token-based similarity analysis, blocks >70%, warns >50%
- **Dead code detection** — AST-based analysis finds unreachable code
- **Naming consistency** — enforces project conventions across the codebase
- **Pattern compliance** — canonical pattern registry with evolution tracking
- **Quality regression prevention** — per-area score floors block regressing commits, with grace periods for new features
- **Quality-to-Soul feedback** — quality metrics feed into agent learning so the same mistakes aren't repeated

### Agent Identity & Learning (SOUL.md)
Each agent maintains a persistent identity with lessons learned from post-mortems, user corrections, and peer reviews. Seven role-specific personalities (frontend, backend, testing, security, design, review, PM) with configurable traits like risk tolerance, testing preference, and decision style. Agents improve over time, developing best practices specific to your codebase.

### Terminal Orchestration
Native macOS terminal control for spawning and monitoring agent sessions:
- **Dual provider** — AppleScript (Terminal.app) and iTerm2 with auto-detection
- **Tab management** — create, select, inject text, read output, detect state (working/idle/stalled)
- **Daemon-spawned agents** — PM Daemon launches headless `claude -p` sessions with full context injection
- **Telegram bridge** — async notifications for off-hours monitoring

### Adaptive Plan Approval
Not every plan needs human review. A confidence scorer evaluates risk:
- **Auto-approve** (>85% confidence) — routine, low-risk, familiar code areas
- **Notify & proceed** (60-85%) — medium risk, logs for review
- **Require approval** (<60%) — high risk, blocks until human confirms

Scoring factors: scope (files/lines), code area familiarity, historical success rate, risk tags (auth, data loss, security), novelty.

### Overnight Mode
Queue up a sprint's worth of tasks, walk away, and come back to completed work. The PM Daemon keeps agents running, respawning them as needed, handling failures, and escalating only what truly requires human attention.

---

## New Project vs Existing Product

### Starting fresh

```bash
npx pilot-agi --global && /pilot-start
```

Pilot AGI will interview you about what you're building, then generate:
- `PROJECT_BRIEF.md` — your product vision and requirements
- `ROADMAP.md` — milestones broken into phases
- Sprint backlogs with prioritized, dependency-ordered tasks

From there, agents pick up tasks and start building. This is the smoothest path — everything is structured from day one.

### Adding to an existing codebase

```bash
npx pilot-agi --global && /pilot-start
```

Same command. Pilot AGI detects your existing code and adapts:
- Your codebase patterns are respected (agents read before writing)
- Hooks enforce discipline immediately: no edits without a plan, no commits without task IDs
- You define your roadmap and create tasks with `/pilot-new-task` or `/pilot-sprint`
- The knowledge base auto-populates from your existing routes, APIs, and schemas

The main difference: new projects get the full structured workflow generated automatically. Existing projects get all the orchestration benefits, but you bootstrap the task graph yourself by pointing Pilot AGI at what needs to be done next.

---

## What Pilot AGI Does

| Phase | What Happens |
|-------|--------------|
| **Discovery** | Smart questions about your product, users, and goals |
| **Planning** | Creates PROJECT_BRIEF.md, ROADMAP.md, and sprint tasks |
| **Execution** | Builds features with plan → approve → execute → verify |
| **Coordination** | Runs 2-6 agent sessions in parallel without conflicts |
| **Quality** | Post-merge sweep detects duplicates, dead code, naming issues, pattern drift |
| **Learning** | Agent souls capture lessons, post-mortems feed improvements, quality scores trend upward |
| **Shipping** | PR automation pushes, creates PRs, monitors CI, auto-merges when green |

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

Run multiple agent terminals on the same project:

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
| AI agents make changes without oversight | Approval gates on every plan |
| No audit trail of what was done or why | Session capsules log everything |
| Duplicate code across features | Knowledge base tracks all patterns |
| Multiple agents conflict on the same files | Task claims and area locks |
| Context lost between sessions or crashes | Checkpoints + auto-respawn with full context |
| Inconsistent architecture as project grows | Single source of truth for APIs, routes, schema |
| Runaway token costs | Per-task budgets with automatic escalation |
| Merge conflicts from parallel work | Semantic merge resolution understands code structure |
| No one monitors agent quality | PM Daemon detects drift and enforces standards |

---

## Project Structure

```
your-project/
├── .beads/              # Git-backed task database
├── .claude/pilot/
│   ├── policy.yaml      # Your governance rules
│   ├── hooks/           # Automatic enforcement (4 hooks + 6 gates)
│   │   └── lib/         # Core modules (50+ files)
│   ├── agent-registry.json  # 7 agent roles + orchestration patterns
│   ├── souls/           # Agent identity files (per-role SOUL.md)
│   ├── kb/              # Knowledge base (auto-generated)
│   ├── memory/          # Shared agent memory (channels + schemas)
│   ├── messages/        # Inter-agent event bus
│   └── state/           # Sessions, costs, escalations, artifacts
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
