# Pilot AGI Architecture

## Design Philosophy

Pilot AGI is built on three core principles:

1. **Simplicity Over Complexity** - Fewer commands that do more
2. **Token Efficiency** - Progressive disclosure, minimal context loading
3. **Robust State** - Crash recovery, persistent sessions, clear state

## Command Structure

| Command | Purpose |
|---------|---------|
| `/pilot:init` | Initialize project |
| `/pilot:scan` | Analyze codebase |
| `/pilot:milestone` | Milestone management |
| `/pilot:plan` | Plan work |
| `/pilot:exec` | Execute plan |
| `/pilot:verify` | Verify completion |
| `/pilot:quick` | Ad-hoc tasks |
| `/pilot:status` | Check progress |
| `/pilot:help` | Show help |
| `/pilot:update` | Update framework |

## Directory Structure

```
pilot-agi/                    # npm package root
├── bin/
│   └── install.js            # npx installer
├── commands/pilot/           # Claude Code commands
│   ├── init.md
│   ├── scan.md
│   ├── milestone.md
│   ├── plan.md
│   ├── exec.md
│   ├── verify.md
│   ├── quick.md
│   ├── status.md
│   ├── help.md
│   └── update.md
├── skills/pilot/             # Core skill logic
│   ├── SKILL.md
│   ├── workflows/
│   │   ├── init.md
│   │   ├── plan.md
│   │   ├── execute.md
│   │   └── verify.md
│   ├── templates/
│   │   ├── PROJECT.md
│   │   ├── ROADMAP.md
│   │   └── STATE.md
│   └── prompts/
│       └── system.md
├── hooks/
│   ├── session-start.js      # Update check + context injection
│   └── post-tool.js          # State tracking
├── agents/
│   ├── researcher.md
│   ├── planner.md
│   ├── executor.md
│   └── reviewer.md
├── package.json
├── README.md
├── CHANGELOG.md
├── LICENSE
└── VERSION
```

## Project Structure (created by /pilot:init)

```
.planning/                    # Project state (gitignored by default)
├── PROJECT.md                # Vision & requirements
├── ROADMAP.md                # Milestones & phases
├── STATE.md                  # Current progress & session memory
├── research/                 # Domain research outputs
├── plans/                    # Phase plans
├── sessions/                 # Session logs for recovery
└── config.json               # Project settings
```

## State Management

### Session Persistence
- Every significant action writes to `.planning/sessions/`
- Crash recovery reads last session state
- Token usage tracked per session

### State File Format (STATE.md)
```markdown
# Project State

## Current Position
- Milestone: M1 - Core Features
- Phase: 2 - Authentication
- Task: Implement JWT validation

## Progress
- [x] Phase 1: Project Setup
- [ ] Phase 2: Authentication (in progress)
- [ ] Phase 3: API Endpoints

## Session
- Started: 2026-01-20 10:00
- Tokens used: 12,450
- Last action: Completed login endpoint
```

## Token Efficiency Strategy

1. **Lazy Loading** - Only load context when needed
2. **Scoped Reads** - Read specific file sections, not entire files
3. **Cached Analysis** - Don't re-analyze unchanged code
4. **Minimal Prompts** - Skills are concise (<500 lines)

## Update Mechanism

1. **SessionStart hook** checks npm registry for new versions
2. **Notification** shown if update available
3. **/pilot:update** downloads and installs new version
4. **CHANGELOG.md** shown to user with what's new
5. **VERSION** file tracks installed version

## Git Integration

### Branch Strategy
- `main` - Stable releases only
- `release` - Pre-release testing
- `dev` - Active development

### Auto-Release Flow
1. Push to `release` branch
2. GitHub Action runs tests
3. If tests pass, merge to `main`
4. Publish to npm with new version
5. Create GitHub Release with changelog
6. Users get update notification on next session
