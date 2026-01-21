# Changelog

All notable changes to Pilot AGI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- Subagent coordination
- Custom templates
- Team collaboration features

---

## [0.2.0] - 2026-01-20

### Added
- **Beads (bd) Integration** - Tasks now use beads as single source of truth
- **Skills Architecture** - Migrated from commands/ to .claude/skills/
- **Session Capsules** - Crash recovery via runs/YYYY-MM-DD.md
- **Configurable Token Budget** - Settings in config.default.json
- **CLAUDE.md Agent Contract** - Defines canonical workflow

### Changed
- Restructured from `/pilot:*` commands to `/pilot-*` skills
- Planning docs moved to work/ directory
- Session hook now integrates with bd for context

### Skills
- `/pilot-next` - Pick next ready task from bd
- `/pilot-plan` - Create implementation plan
- `/pilot-exec` - Execute one micro-step
- `/pilot-commit` - Create conventional commit
- `/pilot-review` - Code review checklist
- `/pilot-close` - Validate DoD and close task
- `/pilot-research` - Research and document
- `/pilot-status` - Show progress
- `/pilot-update` - Update framework
- `/pilot-help` - Show help

---

## [0.1.0] - 2026-01-20

### Added
- Initial release
- Basic command structure
- npm distribution

---

## Links

- [GitHub Releases](https://github.com/vadymsyliava/Pilot-AGI/releases)
- [npm Package](https://www.npmjs.com/package/pilot-agi)
