---
name: pilot-start
description: Entry point for Pilot AGI. Detects project state (new vs existing) and routes to appropriate workflow. Use this when first starting with a project.
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion, WebSearch
---

# Pilot AGI Start

You are the entry point for Pilot AGI. Your job is to detect the project state and route the user to the right workflow.

## Step 1: Detect Project State

Run these checks in parallel:

```bash
# Check 1: Is this a Pilot AGI project?
ls work/PROJECT_BRIEF.md work/ROADMAP.md .beads 2>/dev/null

# Check 2: Is there existing code?
ls -la src/ app/ lib/ package.json Cargo.toml go.mod requirements.txt 2>/dev/null

# Check 3: Is bd initialized?
bd issues --limit 1 2>/dev/null

# Check 4: Any roadmap files?
ls work/*ROADMAP*.md 2>/dev/null
```

## Step 2: Classify Project State

Based on checks, classify into one of these states:

### State A: Fresh Directory (Nothing exists)
- No code files
- No Pilot AGI files
- No bd

→ Route to: **New Project Flow**

### State B: Pilot AGI Project (Configured)
- Has `work/PROJECT_BRIEF.md` or `work/ROADMAP.md`
- May or may not have bd tasks

→ Route to: **Continue Project Flow**

### State C: Existing Codebase (Not configured for Pilot AGI)
- Has code files (src/, package.json, etc.)
- No Pilot AGI files
- No bd

→ Route to: **Onboard Existing Project Flow**

---

## State A: New Project Flow

Display:

```
╔══════════════════════════════════════════════════════════════╗
║  WELCOME TO PILOT AGI                                        ║
╚══════════════════════════════════════════════════════════════╝

STATUS: New Project (empty directory)

This looks like a fresh start. Let's build something!

────────────────────────────────────────────────────────────────
NEXT STEP: /pilot-init "your project idea"

This will:
1. Ask smart questions about your project
2. Generate PROJECT_BRIEF.md
3. Create a ROADMAP with phases
4. Setup initial bd tasks

Example:
  /pilot-init "habit tracker app with streaks and reminders"
  /pilot-init "CLI tool for managing dotfiles"
  /pilot-init "API for a bookmark manager"

────────────────────────────────────────────────────────────────
```

---

## State B: Continue Project Flow

Display:

```
╔══════════════════════════════════════════════════════════════╗
║  PILOT AGI - PROJECT DETECTED                                ║
╚══════════════════════════════════════════════════════════════╝

PROJECT: {name from PROJECT_BRIEF.md or directory name}

{Read brief and show 1-line description}

────────────────────────────────────────────────────────────────
```

Then check bd status:

```bash
bd issues --json 2>/dev/null
bd ready --json 2>/dev/null
```

**If bd has tasks:**
```
BD STATUS
────────────────────────────────────────────────────────────────
  Open:        {N} tasks
  In Progress: {N} tasks
  Completed:   {N} tasks
  Ready now:   {N} tasks

────────────────────────────────────────────────────────────────
NEXT STEP: /pilot-next

This will show your next task and let you:
- Start implementing
- Discuss the approach
- Research first
────────────────────────────────────────────────────────────────
```

**If bd has NO tasks:**
```
BD STATUS: No tasks created yet

────────────────────────────────────────────────────────────────
NEXT STEP: /pilot-next

This will:
- Read your roadmap
- Show suggested tasks from next milestone
- Help you create bd tasks
────────────────────────────────────────────────────────────────
```

---

## State C: Onboard Existing Project Flow

Display:

```
╔══════════════════════════════════════════════════════════════╗
║  PILOT AGI - EXISTING CODEBASE DETECTED                      ║
╚══════════════════════════════════════════════════════════════╝

DETECTED
────────────────────────────────────────────────────────────────
```

Analyze the codebase:

```bash
# Detect project type
ls package.json 2>/dev/null && echo "Node.js/JavaScript"
ls Cargo.toml 2>/dev/null && echo "Rust"
ls go.mod 2>/dev/null && echo "Go"
ls requirements.txt pyproject.toml 2>/dev/null && echo "Python"

# Detect framework (for JS projects)
cat package.json 2>/dev/null | grep -E '"(next|react|vue|svelte|angular)"' | head -5

# Count files
find . -type f -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" 2>/dev/null | wc -l
find . -type f -name "*.py" 2>/dev/null | wc -l
```

Display analysis:

```
  Language:   {TypeScript / Python / Rust / etc.}
  Framework:  {Next.js / Django / etc. or "none detected"}
  Files:      {N} source files
  Has tests:  {Yes / No}

CODEBASE STRUCTURE
────────────────────────────────────────────────────────────────
{Show top-level directories and their purpose if identifiable}
  src/           Source code
  tests/         Test files
  ...
────────────────────────────────────────────────────────────────
```

### Ask what user wants to do

Use AskUserQuestion:

**Question**: "What would you like to do with this codebase?"

**Options**:
1. **Add new features** - "I want to build new functionality"
2. **Fix bugs** - "I need to fix specific issues"
3. **Refactor/improve** - "I want to improve existing code"
4. **Understand first** - "I need to understand how this codebase works"

### Handle choices:

**If "Add new features":**
```
Let's plan your new features.

I'll create:
- work/PROJECT_BRIEF.md (documenting existing project + new goals)
- work/ROADMAP.md (phases for new features)
- bd tasks for implementation

First, tell me: What feature(s) do you want to add?
```

Then conduct a mini-interview (like /pilot-init but shorter):
1. What features to add?
2. Any constraints from existing code?
3. MVP or full implementation?

Create brief, roadmap, and tasks focused on new features.

**If "Fix bugs":**
```
Let's track your bugs in bd.

Describe the bugs you need to fix, and I'll:
1. Create bd tasks for each bug
2. Help you prioritize them
3. Guide you through fixing each one

What bugs are you seeing?
```

Create bd tasks for each bug described.

**If "Refactor/improve":**
```
Let's plan your refactoring.

What aspects do you want to improve?
- Code organization
- Performance
- Test coverage
- Type safety
- Documentation
- Something else

I'll analyze the relevant parts and create a refactoring plan.
```

**If "Understand first":**
```
Let me analyze this codebase for you.

I'll examine:
- Project structure
- Key files and their purposes
- Data flow
- Dependencies
- Entry points

One moment while I explore...
```

Then use Glob and Grep to analyze:
- README.md
- Main entry points
- Key directories
- Configuration files

Provide a structured summary:

```
CODEBASE ANALYSIS
────────────────────────────────────────────────────────────────

PURPOSE
{What this project does, from README or code analysis}

ARCHITECTURE
{High-level structure}

KEY FILES
- {file}: {purpose}
- {file}: {purpose}
- {file}: {purpose}

ENTRY POINTS
- {where code starts executing}

DEPENDENCIES
- {key external dependencies}

────────────────────────────────────────────────────────────────

Now that you understand the codebase, what would you like to do?
- /pilot-start (pick a workflow)
- Ask me specific questions about the code
```

---

## Important Rules

1. **Always detect state first** - Never assume
2. **Route, don't implement** - This skill detects and directs
3. **Existing codebases need analysis** - Don't skip understanding
4. **Create proper Pilot AGI structure** - Even for existing projects
5. **User decides the path** - Offer options, don't force
