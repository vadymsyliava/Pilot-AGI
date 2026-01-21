# Contributing to Pilot AGI

Thank you for your interest in contributing to Pilot AGI!

## Getting Started

### Prerequisites

- Node.js 18+
- Git
- Claude Code (for testing commands)

### Development Setup

```bash
# Clone the repository
git clone https://github.com/vadymsyliava/Pilot-AGI.git
cd Pilot-AGI

# Switch to dev branch
git checkout dev

# Install dependencies
npm install

# Link for local testing
npm link
```

### Testing Your Changes

```bash
# Run the test suite
npm test

# Test installation locally
npx . --local

# Verify commands work in Claude Code
# (restart Claude Code after installation)
```

## Branch Strategy

- **`main`** - Stable releases only. Never push directly.
- **`release`** - Pre-release testing. Push here triggers release workflow.
- **`dev`** - Active development. Create PRs against this branch.

### Workflow

1. Fork the repository
2. Create a feature branch from `dev`: `git checkout -b feat/my-feature dev`
3. Make your changes
4. Commit using conventional commits
5. Push and create a PR against `dev`

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/).

### Format

```
type(scope): description

[optional body]

[optional footer]
```

### Types

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation only
- `style:` - Formatting (no code change)
- `refactor:` - Code restructuring
- `perf:` - Performance improvement
- `test:` - Adding tests
- `build:` - Build system changes
- `ci:` - CI configuration
- `chore:` - Maintenance

### Examples

```
feat(commands): add /pilot:quick for ad-hoc tasks

fix(hooks): resolve Windows path issue in session-start

docs(readme): update installation instructions
```

## Adding a New Command

1. Create the command file in `commands/pilot/`:

```markdown
---
name: pilot:mycommand
description: Brief description of what this command does.
allowed-tools: Read, Write, Bash
---

# My Command

Instructions for Claude when this command is invoked...
```

2. Add documentation in README.md
3. Add entry to CHANGELOG.md (under Unreleased)
4. Test the command in Claude Code

## Code Style

- Keep command files concise (<500 lines)
- Use clear, actionable instructions
- Include examples where helpful
- Follow existing patterns

## Testing

- Test on macOS, Linux, and Windows if possible
- Verify commands work with fresh installation
- Check that update mechanism works

## Release Process

1. Changes accumulate in `dev`
2. When ready for release:
   - Update version in `package.json`
   - Update `CHANGELOG.md` with release date
   - Create PR from `dev` to `release`
3. Merging to `release` triggers:
   - CI tests
   - Merge to `main`
   - npm publish
   - GitHub Release

## Questions?

- Open a [GitHub Issue](https://github.com/vadymsyliava/Pilot-AGI/issues)
- Start a [Discussion](https://github.com/vadymsyliava/Pilot-AGI/discussions)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
