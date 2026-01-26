# Pilot AGI

**Governance Layer for Claude Code** - Enterprise-grade compliance, approval workflows, and audit trails for AI-assisted development.

[![npm version](https://img.shields.io/npm/v/pilot-agi.svg)](https://www.npmjs.com/package/pilot-agi)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## What is Pilot AGI?

Pilot AGI is a **governance layer** that sits on top of Claude Code, providing enterprise compliance and oversight for AI-assisted development. While Claude Code provides powerful AI coding capabilities, Pilot AGI adds the guardrails organizations need.

### Pilot AGI vs Native Claude Code

| Capability | Claude Code (Native) | Pilot AGI (Governance) |
|------------|---------------------|------------------------|
| Code exploration | Plan Mode | Leverages native |
| Code editing | Direct edits | Requires approval |
| Task tracking | None | bd (beads) integration |
| Approval workflows | None | Configurable gates |
| Audit trails | None | Session capsules |
| Policy enforcement | None | policy.yaml DSL |
| Multi-agent coordination | None | Session management |
| Crash recovery | None | Context continuity |

**Key insight**: Pilot AGI doesn't duplicate Claude Code - it governs it.

---

## Core Governance Features

### 1. Approval Workflows

Every significant change requires explicit approval before execution:

```
/pilot-plan → (APPROVAL GATE) → /pilot-exec
```

High-risk operations trigger mandatory approval:
- Database migrations
- Authentication/authorization changes
- File deletions
- External API integrations
- Security-sensitive code

### 2. Audit Trails (Session Capsules)

Every action is logged to `runs/YYYY-MM-DD.md`:
- Who did what, when
- Task references
- Approval records
- Crash recovery context

Perfect for compliance audits and incident investigation.

### 3. Policy Enforcement

Define organization rules in `policy.yaml`:

```yaml
execution:
  require_plan_approval: true
  require_verification: true
  require_commit_per_step: true

approval_gates:
  - type: database_migration
    require: explicit_approval
  - type: auth_changes
    require: explicit_approval
  - type: delete_files
    require: explicit_approval

semantic_guardian:
  max_file_changes_per_step: 10
  require_test_for_new_code: true
```

### 4. Task Management (bd Integration)

Git-backed task tracking with [beads](https://github.com/steveyegge/beads):
- Single source of truth for work items
- Dependency management
- Priority ordering
- Commit linking

---

## Quick Start

### Installation

```bash
# Global install (recommended)
npx pilot-agi --global

# Project-local install
npx pilot-agi --local
```

### Initialize Governance

```bash
cd your-project

# Initialize task tracking
bd init

# View available commands
/pilot-help
```

---

## The Governed Workflow

### Daily Development

```
bd ready → /pilot-plan → (approve) → /pilot-exec → /pilot-commit → /pilot-close
```

1. **bd ready** - Pick top task (dependencies guarantee order)
2. **/pilot-plan** - Create implementation plan
3. **APPROVAL GATE** - Human review and approval
4. **/pilot-exec** - Execute one micro-step with verification
5. **/pilot-commit** - Create conventional commit with task reference
6. **/pilot-close** - Validate Definition of Done

### Autonomous Mode (with Guardrails)

```bash
/pilot-auto --max-tasks 10 --max-errors 3
```

Autonomous execution still respects:
- Approval gates (pauses for high-risk operations)
- Verification requirements
- Policy rules
- Session logging

---

## Skills Reference

### Governance & Control
| Skill | Purpose |
|-------|---------|
| `/pilot-plan` | Create implementation plan (requires approval) |
| `/pilot-approve` | Approve a pending plan |
| `/pilot-auto` | Start autonomous execution with guardrails |
| `/pilot-pause` | Pause autonomous execution |

### Workflow Execution
| Skill | Purpose |
|-------|---------|
| `/pilot-next` | Pick next ready task from bd |
| `/pilot-exec` | Execute one verified micro-step |
| `/pilot-commit` | Create conventional commit |
| `/pilot-review` | Quick code review checklist |
| `/pilot-close` | Validate DoD and close task |

### Project Setup
| Skill | Purpose |
|-------|---------|
| `/pilot-init` | Initialize project with smart questions |
| `/pilot-sprint` | Plan sprint with bd tasks |
| `/pilot-design` | Create/update design system |

### Utilities
| Skill | Purpose |
|-------|---------|
| `/pilot-status` | Show progress and suggest next action |
| `/pilot-session` | View session state and locks |
| `/pilot-serve` | Start local API server |
| `/pilot-help` | Show available commands |

---

## Enterprise Features

### Multi-Agent Coordination

When multiple Claude Code sessions work on the same project:
- **Task claiming** with leases prevents conflicts
- **Area locking** ensures no overlapping edits
- **Session heartbeats** detect abandoned work
- **Atomic claims** via bd prevent race conditions

### Session Management

```bash
# View active sessions
/pilot-session

# Check what's locked
curl http://localhost:3333/api/locks
```

### Kanban API

Local REST API for dashboards and monitoring:

```
GET /api/health     - Server status
GET /api/sessions   - Active sessions
GET /api/issues     - All bd tasks
GET /api/events     - Event stream
GET /api/locks      - Current locks
```

Start with `/pilot-serve`.

---

## Project Structure

```
your-project/
├── .beads/                 # Task database (git-backed)
├── .claude/
│   ├── pilot/
│   │   ├── policy.yaml     # Governance rules
│   │   ├── hooks/          # Session hooks
│   │   └── state/          # Runtime state
│   └── settings.json       # Claude Code config
├── work/
│   ├── ROADMAP.md          # Planning documents
│   ├── sprints/            # Sprint definitions
│   └── plans/              # Approved plans
├── runs/
│   └── YYYY-MM-DD.md       # Audit trail (session capsules)
└── CLAUDE.md               # Agent contract
```

---

## Configuration

### policy.yaml (Governance Rules)

```yaml
version: "1.0"

execution:
  require_plan_approval: true
  require_verification: true
  auto_commit: true

approval_gates:
  database_migration:
    require: explicit_approval
    notify: ["tech-lead"]
  auth_changes:
    require: explicit_approval
  production_deploy:
    require: explicit_approval

semantic_guardian:
  max_changes_per_step: 10
  forbidden_patterns:
    - "rm -rf"
    - "DROP TABLE"
```

### Token Discipline

Pilot AGI enforces efficient context usage:
- Skills are concise (<500 lines)
- Progressive disclosure (load on demand)
- Scoped reads (specific sections only)
- Session logs summarize closed work

---

## Why Governance Matters

### Without Pilot AGI
- AI makes changes without oversight
- No audit trail of what happened
- No way to enforce organization policies
- Multi-agent chaos
- Difficult incident investigation

### With Pilot AGI
- Every change approved before execution
- Complete audit trail
- Policy enforcement via DSL
- Coordinated multi-agent work
- Easy compliance and debugging

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for version history.

---

## Roadmap

### v2.0.0 (Current Development)
- [x] Governance framework with approval gates
- [x] Policy.yaml for rule definition
- [x] Session management and coordination
- [x] Audit trails (session capsules)
- [x] Autonomous mode with guardrails
- [x] Kanban API for monitoring

### v2.1.0 (Next)
- [ ] Enhanced policy DSL
- [ ] Teleport support for session capsules
- [ ] Quality gates integration
- [ ] Dashboard UI

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

### Development

```bash
git clone https://github.com/vadymsyliava/Pilot-AGI.git
cd Pilot-AGI
git checkout dev
npm install
npm link
```

---

## License

MIT - see [LICENSE](./LICENSE)

---

**Governance for Claude Code** - Ship with confidence.
