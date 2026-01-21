# Pilot AGI

**AI-powered development framework for Claude Code** - Ship faster with structured workflows, not ceremony.

[![npm version](https://img.shields.io/npm/v/pilot-agi.svg)](https://www.npmjs.com/package/pilot-agi)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Why Pilot AGI?

Traditional AI coding assistants are reactive - they wait for you to tell them what to do. Pilot AGI is **proactive** - it plans, executes, and verifies work systematically.

### The Problem with "Vibe Coding"
- AI generates code without understanding context
- Quality degrades as context window fills
- No verification that code actually works
- Progress is lost between sessions

### The Pilot AGI Solution
- **Structured planning** before any code is written
- **Token-efficient** workflows that stay in the sweet spot
- **Built-in verification** at every step
- **Session persistence** - pick up right where you left off

---

## Quick Start

### Installation

```bash
# Global install (recommended)
npx pilot-agi --global

# Project-local install
npx pilot-agi --local
```

### First Project

```bash
# In Claude Code, run:
/pilot:init
```

This starts an interactive session to understand your project, then generates:
- `PROJECT.md` - Your vision and requirements
- `ROADMAP.md` - Milestones and phases
- `STATE.md` - Progress tracking

---

## Commands

Pilot AGI provides **10 intuitive commands**:

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `/pilot:init` | Initialize project | Starting a new project |
| `/pilot:scan` | Analyze codebase | Understanding existing code |
| `/pilot:milestone` | Manage milestones | Planning major releases |
| `/pilot:plan` | Plan work | Before implementing features |
| `/pilot:exec` | Execute plan | Implementing planned work |
| `/pilot:verify` | Verify completion | After implementing features |
| `/pilot:quick` | Ad-hoc tasks | Bug fixes, small changes |
| `/pilot:status` | Check progress | Seeing where you are |
| `/pilot:help` | Show help | Learning the system |
| `/pilot:update` | Update framework | Getting latest features |

### Workflow

The typical workflow is:

```
/pilot:init → /pilot:plan → /pilot:exec → /pilot:verify
     ↓              ↓            ↓             ↓
  Understand    Design     Implement      Confirm
   project      solution     code          works
```

For quick tasks:
```
/pilot:quick → done
```

---

## Detailed Command Reference

### `/pilot:init` - Initialize Project

Starts a conversational flow to understand your project:

```
/pilot:init
```

**What it does:**
1. Asks about your project vision
2. Identifies key requirements
3. Suggests milestones and phases
4. Creates planning documents

**Options:**
- `--from-readme` - Extract info from existing README
- `--minimal` - Skip deep questions, create basic structure

---

### `/pilot:scan` - Analyze Codebase

Builds understanding of an existing codebase:

```
/pilot:scan
```

**What it does:**
1. Identifies tech stack and patterns
2. Maps module dependencies
3. Finds conventions and standards
4. Creates codebase summary

---

### `/pilot:plan` - Plan Work

Creates detailed implementation plan for a phase:

```
/pilot:plan [phase-number]
/pilot:plan 2
```

**What it does:**
1. Researches requirements for the phase
2. Identifies files to modify
3. Creates step-by-step implementation plan
4. Waits for your approval before proceeding

---

### `/pilot:exec` - Execute Plan

Implements the approved plan:

```
/pilot:exec
```

**What it does:**
1. Executes each step in the plan
2. Runs tests after each change
3. Commits atomic changes
4. Updates progress in STATE.md

---

### `/pilot:verify` - Verify Completion

Confirms implementation meets requirements:

```
/pilot:verify
```

**What it does:**
1. Checks all planned items completed
2. Runs full test suite
3. Validates against requirements
4. Marks phase as complete or lists remaining work

---

### `/pilot:quick` - Ad-hoc Tasks

For small tasks that don't need full planning:

```
/pilot:quick fix the login button styling
/pilot:quick add error handling to API calls
```

**What it does:**
1. Understands the quick task
2. Implements with verification
3. Commits with clear message

---

### `/pilot:status` - Check Progress

Shows current project state:

```
/pilot:status
```

**Output includes:**
- Current milestone and phase
- Completed vs remaining work
- Session token usage
- Suggested next action

---

### `/pilot:update` - Update Framework

Updates Pilot AGI to latest version:

```
/pilot:update
```

**What it does:**
1. Checks for new version
2. Shows changelog
3. Updates installation
4. Preserves your settings

---

## Configuration

### Project Settings

Create `.planning/config.json`:

```json
{
  "commit_planning_docs": false,
  "auto_verify": true,
  "token_budget_warning": 50000,
  "preferred_model": "sonnet"
}
```

### Global Settings

Located at `~/.claude/pilot-config.json`:

```json
{
  "check_updates": true,
  "telemetry": false
}
```

---

## Project Structure

After `/pilot:init`, your project has:

```
your-project/
├── .planning/              # Pilot AGI state (gitignored)
│   ├── PROJECT.md          # Vision & requirements
│   ├── ROADMAP.md          # Milestones & phases
│   ├── STATE.md            # Current progress
│   ├── research/           # Domain research
│   ├── plans/              # Phase plans
│   └── sessions/           # Session recovery
└── ... your code ...
```

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for version history.

---

## Roadmap

### v0.1.0 (Current)
- [x] Core command structure
- [x] Project initialization
- [x] Basic planning workflow
- [x] npm distribution

### v0.2.0 (Next)
- [ ] Token usage tracking
- [ ] Cost estimation
- [ ] Session persistence
- [ ] Crash recovery

### v0.3.0 (Future)
- [ ] Team collaboration
- [ ] Custom templates
- [ ] Plugin system
- [ ] VS Code extension

---

## Contributing

Contributions welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) first.

### Development Setup

```bash
git clone https://github.com/vadymsyliava/Pilot-AGI.git
cd Pilot-AGI
git checkout dev
npm install
npm link
```

### Branch Strategy

- `main` - Stable releases
- `release` - Pre-release testing
- `dev` - Active development

---

## Support

- **Issues**: [GitHub Issues](https://github.com/vadymsyliava/Pilot-AGI/issues)
- **Discussions**: [GitHub Discussions](https://github.com/vadymsyliava/Pilot-AGI/discussions)

---

## License

MIT - see [LICENSE](./LICENSE)

---

**Built with Claude Code** - An Anthropic product
