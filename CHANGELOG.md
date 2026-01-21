# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- Token usage tracking and cost estimation
- Session persistence and crash recovery
- Team collaboration features

---

## [0.1.0] - 2026-01-20

### Added
- **Initial release of Pilot AGI**
- Core command structure with 10 intuitive commands:
  - `/pilot:init` - Initialize project with guided setup
  - `/pilot:scan` - Analyze existing codebase
  - `/pilot:milestone` - Manage project milestones
  - `/pilot:plan` - Create detailed implementation plans
  - `/pilot:exec` - Execute approved plans
  - `/pilot:verify` - Verify implementation completion
  - `/pilot:quick` - Handle ad-hoc tasks
  - `/pilot:status` - Check project progress
  - `/pilot:help` - Display help and documentation
  - `/pilot:update` - Update to latest version
- npm distribution via `npx pilot-agi`
- Global and local installation options
- Project state management in `.planning/` directory
- Template files for PROJECT.md, ROADMAP.md, STATE.md
- SessionStart hook for update notifications
- MIT license

### Technical
- Node.js 18+ requirement
- Husky for git hooks
- Conventional commits enforcement
- Semantic release automation

---

## Version History

| Version | Date | Highlights |
|---------|------|------------|
| 0.1.0 | 2026-01-20 | Initial release |

---

## Upgrade Guide

### From Pre-release to 0.1.0

If you were using a pre-release version:

```bash
# Update to latest
npx pilot-agi --global

# Or in Claude Code
/pilot:update
```

---

## Links

- [GitHub Releases](https://github.com/vadymsyliava/Pilot-AGI/releases)
- [npm Package](https://www.npmjs.com/package/pilot-agi)
