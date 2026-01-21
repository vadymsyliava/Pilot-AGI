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

### Prerequisites

Install [beads](https://github.com/steveyegge/beads) (task management):
```bash
curl -fsSL https://beads.dev/install.sh | bash
```

### Installation

```bash
# Global install (recommended)
npx pilot-agi --global

# Project-local install
npx pilot-agi --local
```

### Initialize Project

```bash
# Initialize beads for task tracking
bd init

# Start using Pilot AGI skills
/pilot-help
```

---

## The Canonical Loop

```
bd ready → /pilot-plan → (approve) → /pilot-exec → /pilot-commit → /pilot-close
```

1. **bd ready** - Pick top task (dependencies guarantee order)
2. **/pilot-plan** - Create implementation plan, wait for approval
3. **/pilot-exec** - Execute one micro-step with verification
4. **/pilot-commit** - Create conventional commit linked to bd issue
5. **/pilot-close** - Validate Definition of Done, close bd issue

---

## Skills

| Skill | Purpose |
|-------|---------|
| `/pilot-next` | Pick next ready task from bd |
| `/pilot-plan` | Create implementation plan for task |
| `/pilot-exec` | Execute one micro-step |
| `/pilot-commit` | Create conventional commit |
| `/pilot-review` | Quick code review checklist |
| `/pilot-close` | Validate DoD and close task |
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

### v0.2.0 (Current)
- [x] Beads (bd) integration
- [x] Skills-based architecture
- [x] Session capsule system
- [x] Configurable token budget

### v0.3.0 (Next)
- [ ] Subagent coordination
- [ ] Custom templates
- [ ] Team collaboration

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
