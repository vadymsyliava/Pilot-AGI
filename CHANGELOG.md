# Changelog

All notable changes to Pilot AGI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- `/pilot-test` - Test generation
- Vitest + Playwright integration
- Coverage enforcement
- Agent orchestration

---

## [0.0.4] - 2026-01-21

### Added
- **`/pilot-design`** - Design system generation skill
  - Full design system setup with design tokens
  - shadcn/ui component installation and configuration
  - Tailwind CSS integration with CSS custom properties
  - Design system showcase page generation
  - Support for incremental component addition
- **Component Registry** - Track all UI components
  - `component-registry.json` template with component metadata
  - Patterns for form fields, loading states, error handling
  - Rules to prevent duplicates and enforce design tokens
- **Design System Page Template** - Visual showcase
  - Colors, typography, spacing documentation
  - All component variants displayed
  - Interactive examples
  - Dark mode support

### Templates
- `component-registry.json` - Component metadata and patterns
- `design-system-page.tsx` - Showcase page template

### Changed
- README updated with v0.0.4 features and `/pilot-design` skill

---

## [0.0.3] - 2026-01-21

### Added
- **`/pilot-init`** - Initialize projects with intelligent questioning
  - AI-powered pitch analysis (project type, domain, complexity)
  - Tiered questions (essential, technical, context)
  - Tech stack recommendations
  - Automatic PROJECT_BRIEF.md generation
  - ROADMAP.md generation with milestones
- **`/pilot-sprint`** - Sprint planning with bd integration
  - Auto-research for technical decisions
  - Task breakdown with acceptance criteria
  - Dependency mapping
  - Sprint files in work/sprints/
- **Templates** - PROJECT_BRIEF.md and sprint.md templates
- **Research automation** - Integrated into sprint planning

### Changed
- Updated `/pilot-help` with new skills and workflow
- README updated with v0.0.3 features
- Canonical workflow now starts with `/pilot-init`

---

## [0.0.2] - 2026-01-20

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

## [0.0.1] - 2026-01-20

### Added
- Initial release
- Basic command structure
- npm distribution

---

## Links

- [GitHub Releases](https://github.com/vadymsyliava/Pilot-AGI/releases)
- [npm Package](https://www.npmjs.com/package/pilot-agi)
