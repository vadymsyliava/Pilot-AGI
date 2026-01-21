---
name: pilot:scan
description: Analyze an existing codebase to understand its structure, patterns, and conventions. Use when joining an existing project or before major changes.
allowed-tools: Read, Glob, Grep, Bash
---

# Scan Codebase

You are analyzing an existing codebase to build understanding.

## Step 1: Identify Project Type

Look for configuration files to determine the project type:

```bash
ls -la
```

Check for:
- `package.json` - Node.js/JavaScript/TypeScript
- `requirements.txt` / `pyproject.toml` - Python
- `go.mod` - Go
- `Cargo.toml` - Rust
- `pom.xml` / `build.gradle` - Java
- `Gemfile` - Ruby

## Step 2: Analyze Structure

Map the directory structure:
```
Project Structure
────────────────────────────────────────────────────────────────
{project-name}/
├── src/           # Source code
│   ├── ...
├── tests/         # Tests
├── config/        # Configuration
└── ...
```

## Step 3: Identify Tech Stack

From config files, identify:
- **Framework**: (React, Next.js, Django, Express, etc.)
- **Language**: (TypeScript, Python, Go, etc.)
- **Database**: (PostgreSQL, MongoDB, etc.)
- **Testing**: (Jest, Pytest, etc.)
- **Build tools**: (Webpack, Vite, etc.)

## Step 4: Find Entry Points

Identify main entry points:
- `src/index.ts` or `src/main.ts`
- `app.py` or `main.py`
- `main.go`
- etc.

## Step 5: Detect Patterns

Look for architectural patterns:
- **API structure**: REST, GraphQL, tRPC
- **State management**: Redux, MobX, Zustand
- **Database access**: ORM, raw queries
- **Authentication**: JWT, sessions, OAuth

## Step 6: Note Conventions

Identify coding conventions:
- File naming (camelCase, kebab-case, etc.)
- Directory organization
- Import patterns
- Error handling patterns

## Step 7: Create Summary

If `.planning/` exists, create `.planning/research/codebase-scan.md`:

```markdown
# Codebase Analysis

## Overview
- **Project**: {name}
- **Type**: {web app / API / library / etc.}
- **Language**: {primary language}
- **Framework**: {main framework}

## Tech Stack
| Category | Technology |
|----------|------------|
| Language | {lang} |
| Framework | {framework} |
| Database | {db} |
| Testing | {test framework} |

## Structure
{directory tree}

## Entry Points
- Main: `{path}`
- API: `{path}`
- Tests: `{path}`

## Patterns
- {Pattern 1}
- {Pattern 2}

## Conventions
- Files: {naming convention}
- Imports: {style}
- Errors: {handling pattern}

## Notes
- {Important observation 1}
- {Important observation 2}
```

## Step 8: Report

```
════════════════════════════════════════════════════════════════
Codebase Analysis Complete
════════════════════════════════════════════════════════════════

{Project name} is a {type} built with {tech stack}.

Key findings:
- {Finding 1}
- {Finding 2}
- {Finding 3}

{If .planning exists: Full analysis saved to .planning/research/codebase-scan.md}

Next steps:
- Run /pilot:init to set up planning structure
- Or /pilot:plan to start working on a specific area
```

## Important Rules
- Don't read every file - sample intelligently
- Focus on understanding patterns, not memorizing code
- Note anything unusual or potentially problematic
- Keep the analysis actionable
