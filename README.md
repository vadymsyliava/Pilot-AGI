# Pilot AGI

**AI-powered development framework for Claude Code** - Structured workflows that ship.

[![npm version](https://img.shields.io/npm/v/pilot-agi.svg)](https://www.npmjs.com/package/pilot-agi)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## What is Pilot AGI?

Pilot AGI brings structure to AI-assisted development:

- **Beads (bd) Integration** - Git-backed task management as single source of truth
- **Plan → Approve → Execute → Verify** - The canonical loop that prevents drift
- **Session Capsules** - Crash recovery and context continuity
- **Token Efficiency** - Progressive disclosure, load only what's needed

---

## Quick Start

### One-Command Installation

```bash
# Global install (recommended) - automatically installs beads (bd) if needed
npx pilot-agi --global

# Project-local install
npx pilot-agi --local
```

The installer will automatically install [beads](https://github.com/steveyegge/beads) (task management) if not already present, using Homebrew, npm, or go install.

### Initialize Your Project

```bash
# Navigate to your project
cd your-project

# Initialize beads for task tracking
bd init

# Start using Pilot AGI skills in Claude Code
/pilot-help
```

---

## The Canonical Loop

### New Project
```
/pilot-init → /pilot-sprint → bd ready → /pilot-plan → ...
```

### Daily Work
```
bd ready → /pilot-plan → (approve) → /pilot-exec → /pilot-commit → /pilot-close
```

1. **/pilot-init** - Initialize project with smart questions (once per project)
2. **/pilot-sprint** - Plan sprint with bd tasks
3. **bd ready** - Pick top task (dependencies guarantee order)
4. **/pilot-plan** - Create implementation plan, wait for approval
5. **/pilot-exec** - Execute one micro-step with verification
6. **/pilot-commit** - Create conventional commit linked to bd issue
7. **/pilot-close** - Validate Definition of Done, close bd issue

---

## Skills

### Project Setup
| Skill | Purpose |
|-------|---------|
| `/pilot-init` | Initialize project with smart questions |
| `/pilot-sprint` | Plan sprint with bd tasks |
| `/pilot-design` | Create/update design system with shadcn/ui |

### Workflow
| Skill | Purpose |
|-------|---------|
| `/pilot-next` | Pick next ready task from bd |
| `/pilot-plan` | Create implementation plan for task |
| `/pilot-exec` | Execute one micro-step |
| `/pilot-commit` | Create conventional commit |
| `/pilot-review` | Quick code review checklist |
| `/pilot-close` | Validate DoD and close task |

### Utilities
| Skill | Purpose |
|-------|---------|
| `/pilot-research` | Research topic, save to work/research/ |
| `/pilot-status` | Show progress and suggest next action |
| `/pilot-update` | Update Pilot AGI |
| `/pilot-help` | Show help |

---

## Project Structure

```
your-project/
├── .beads/                 # Task database (bd init)
├── .claude/
│   ├── skills/pilot-*/     # Pilot AGI skills
│   ├── pilot/              # Framework internals
│   │   ├── hooks/          # Session hooks
│   │   ├── templates/      # Planning templates
│   │   └── config.default.json
│   └── settings.json       # Hooks configuration
├── work/
│   ├── ROADMAP.md          # High-level planning
│   ├── milestones/         # Milestone specs
│   ├── sprints/            # Sprint planning
│   ├── specs/              # Feature specifications
│   ├── research/           # Research outputs
│   └── plans/              # Approved implementation plans
├── runs/
│   └── YYYY-MM-DD.md       # Session capsules
└── CLAUDE.md               # Agent contract
```

---

## Key Concepts

### Beads as Task SSOT

Tasks live in beads (bd), not markdown files:
```bash
bd create "Implement user auth"    # Create task
bd ready                           # List actionable tasks
bd update bd-a1b2 --status in_progress  # Claim task
bd issues                          # Query all tasks
```

### Session Capsules

Every action logged to `runs/YYYY-MM-DD.md` for:
- Crash recovery
- Context continuity
- Progress tracking

### Token Discipline

- Skills are concise (<500 lines)
- Progressive disclosure (load on demand)
- Scoped reads (specific sections, not whole files)
- Session logs summarize, don't carry full context

---

## Configuration

`.claude/pilot/config.default.json`:
```json
{
  "token_budget": {
    "warning_threshold": 50000,
    "target_range": { "min": 20000, "max": 80000 }
  },
  "planning": {
    "require_approval": true,
    "max_steps_per_plan": 10
  }
}
```

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for version history.

---

## Roadmap

### v0.0.4 (Current)
- [x] `/pilot-design` - Design system generation
- [x] Component registry with patterns and rules
- [x] Design system page template
- [x] shadcn/ui integration

### v0.0.3
- [x] `/pilot-init` - Project initialization with smart questions
- [x] `PROJECT_BRIEF.md` generation
- [x] Roadmap generation
- [x] `/pilot-sprint` - Sprint planning with bd tasks
- [x] Research phase automation

### v0.0.5 (Next)
- [ ] `/pilot-test` - Test generation
- [ ] Vitest + Playwright integration
- [ ] Coverage enforcement

### v0.1.0
- [ ] Full agent orchestration
- [ ] Quality gates
- [ ] Duplicate detection

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

**Built for Claude Code**
