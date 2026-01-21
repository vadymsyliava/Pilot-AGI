---
name: pilot:init
description: Initialize a new Pilot AGI project with guided setup. Use when starting a new project or adding Pilot AGI to an existing codebase.
allowed-tools: Read, Write, Bash, Glob, Grep
---

# Initialize Project

You are initializing a Pilot AGI project. Follow this workflow:

## Step 1: Understand the Project

Ask the user about their project:
1. What is this project? (Brief description)
2. What problem does it solve?
3. What's the tech stack? (Or detect from existing files)
4. What are the key features planned?

If `--from-readme` flag is present, read the README.md first and extract this info.
If `--minimal` flag is present, skip deep questions and create basic structure.

## Step 2: Analyze Existing Code (if any)

If there's existing code:
- Identify the tech stack from package.json, requirements.txt, go.mod, etc.
- Note existing patterns and conventions
- Find entry points and main modules

## Step 3: Create Planning Structure

Create the `.planning/` directory with these files:

### .planning/PROJECT.md
```markdown
# [Project Name]

## Vision
[One paragraph describing what this project is and why it exists]

## Problem Statement
[What problem does this solve?]

## Tech Stack
- [List technologies]

## Key Features
- [ ] Feature 1
- [ ] Feature 2
- [ ] Feature 3

## Success Criteria
- [How do we know this project is successful?]
```

### .planning/ROADMAP.md
```markdown
# Roadmap

## Milestone 1: [Name]

### Phase 1: [Name]
- [ ] Task 1
- [ ] Task 2

### Phase 2: [Name]
- [ ] Task 1
- [ ] Task 2

## Milestone 2: [Name]
(Future work)
```

### .planning/STATE.md
```markdown
# Project State

## Current Position
- Milestone: 1
- Phase: Not started
- Status: Initialized

## Session Log
- [Date]: Project initialized

## Token Usage
- Total: 0
- This session: 0
```

### .planning/config.json
```json
{
  "version": "0.1.0",
  "created": "[timestamp]",
  "settings": {
    "commit_planning_docs": false,
    "auto_verify": true,
    "token_budget_warning": 50000
  }
}
```

## Step 4: Create .gitignore Entry

Add to .gitignore (create if doesn't exist):
```
# Pilot AGI planning files
.planning/
```

## Step 5: Summary

After creating files, summarize:
- What was created
- Suggested next command: `/pilot:plan 1` to plan the first phase
- Remind about `/pilot:help` for all commands

## Important
- Keep responses concise
- Don't over-engineer the initial setup
- Let the user drive complexity
