---
name: pilot-parallel
description: Execute multiple independent tasks in parallel using sub-agents. Analyzes task independence, spawns workers, collects results.
argument-hint: [--dry-run to analyze without executing]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, TaskOutput, AskUserQuestion
---

# Parallel Task Executor

Execute multiple independent tasks simultaneously using sub-agents for maximum efficiency.

## Core Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      MASTER AGENT (You)                         │
│  - Analyzes tasks for independence                              │
│  - Provides context to sub-agents                               │
│  - Spawns sub-agents in parallel                                │
│  - Collects results and WRITES files                            │
│  - Has full permissions (user's session)                        │
└─────────────────────────────────────────────────────────────────┘
                              │
           ┌──────────────────┼──────────────────┐
           │                  │                  │
           ▼                  ▼                  ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│   SUB-AGENT 1   │ │   SUB-AGENT 2   │ │   SUB-AGENT 3   │
│                 │ │                 │ │                 │
│ • Fresh context │ │ • Fresh context │ │ • Fresh context │
│ • Task-specific │ │ • Task-specific │ │ • Task-specific │
│ • Returns content│ │ • Returns content│ │ • Returns content│
│ • No file writes│ │ • No file writes│ │ • No file writes│
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

## Key Principles

### 1. Fresh Context Per Sub-Agent
Each sub-agent starts with a **completely fresh context window**:
- No accumulated conversation history from master
- Only receives task-specific context you provide
- Maximum token window available for the task
- Isolated from other sub-agents

### 2. Collect-and-Write Pattern
Sub-agents **generate content**, master agent **writes files**:
- Sub-agents return file contents in their response
- Master agent reviews and writes with user's permissions
- No permission issues (sub-agents don't need Write access)
- Master can validate before committing to disk

### 3. Model Selection by Complexity
Choose the right model for the task:
- `model: "opus"` - Complex tasks requiring deep reasoning (default for implementation)
- `model: "sonnet"` - Standard tasks with clear requirements
- `model: "haiku"` - Simple, fast tasks (analysis, formatting)

## Step 1: Get Ready Tasks

```bash
bd ready --json 2>/dev/null
```

If less than 2 tasks, inform user parallel execution isn't needed.

## Step 2: Analyze Task Independence

For each task, determine:
- **Files it will touch** (based on task description)
- **Directories it operates in**
- **Dependencies** (already handled by bd)

### Independence Rules

Tasks are **INDEPENDENT** if:
- They touch different files/directories
- They don't have bd dependencies on each other
- They don't modify shared configuration

Tasks are **DEPENDENT** if:
- They modify the same files
- One's output is another's input
- They both modify package.json or similar shared configs

### Always Sequential (Never Parallel)

- Tasks modifying package.json
- Tasks modifying tsconfig.json
- Tasks modifying .env files
- Tasks with explicit bd dependencies
- Database migration tasks

### Always Parallelizable

- Creating new, independent files
- Agent rule files (different domains)
- Test files for different modules
- Documentation for different features

## Step 3: Present Analysis

```
╔══════════════════════════════════════════════════════════════╗
║  PARALLEL EXECUTION ANALYSIS                                 ║
╚══════════════════════════════════════════════════════════════╝

READY TASKS: {N}

PARALLEL GROUP 1 (can run simultaneously)
────────────────────────────────────────────────────────────────
  • task-id-1: Task title → target/file/path.ext
  • task-id-2: Task title → target/file/path.ext

  ✓ No file conflicts - all independent

MODEL SELECTION
────────────────────────────────────────────────────────────────
  Using: opus (complex implementation tasks)

  Each sub-agent gets:
  • Fresh context window (no history accumulation)
  • Full task description and requirements
  • Relevant codebase context
────────────────────────────────────────────────────────────────
```

## Step 4: Confirm Execution

Use AskUserQuestion:

**Question**: "Execute {N} tasks in parallel?"

**Options**:
1. **Execute all in parallel** - Spawn sub-agents now
2. **Execute one at a time** - Traditional sequential
3. **Review tasks first** - Show detailed task info
4. **Cancel** - Don't execute anything

## Step 5: Spawn Sub-Agents

**CRITICAL**: Call ALL Task tools in a **SINGLE message** for true parallelism.

### Sub-Agent Prompt Template (Collect Pattern)

```
You are a specialized sub-agent working on ONE specific task.

## Your Task
{task_id}: {task_title}

## Context
{Relevant context from master agent - files, patterns, requirements}

## What You Must Do
{Detailed task description}

## Output Format
You must return your work in this EXACT format so the master agent can write files:

### FILE: {relative/path/to/file.ext}
```{language}
{complete file contents}
```

### FILE: {another/file.ext}
```{language}
{complete file contents}
```

### SUMMARY
- Files to create: [list paths]
- Status: success | partial | failed
- Notes: [any issues or decisions made]

## Important
- Generate COMPLETE file contents (not snippets)
- Use the exact FILE: format above
- Do NOT attempt to write files yourself
- Focus on quality - the master agent will handle file operations
```

### Spawning Pattern

```javascript
// Spawn ALL sub-agents in a SINGLE message for true parallelism
Task({
  description: "Generate frontend rules",
  prompt: "...(full prompt with context)...",
  subagent_type: "general-purpose",
  model: "opus",  // Use opus for complex tasks
  run_in_background: true
})

Task({
  description: "Generate backend rules",
  prompt: "...(full prompt with context)...",
  subagent_type: "general-purpose",
  model: "opus",
  run_in_background: true
})

// All tasks spawned in parallel
```

## Step 6: Wait and Collect Results

After spawning, inform user:

```
╔══════════════════════════════════════════════════════════════╗
║  PARALLEL EXECUTION STARTED                                  ║
╚══════════════════════════════════════════════════════════════╝

Sub-agents working in parallel...
You'll be notified when each completes.
────────────────────────────────────────────────────────────────
```

Wait for task notifications, then use TaskOutput to collect:

```javascript
TaskOutput({ task_id: "{agent_id}", block: true })
```

## Step 7: Parse and Write Files

For each completed sub-agent:

1. **Parse the response** for `### FILE:` blocks
2. **Extract file paths** and contents
3. **Write files** using Write tool (master has permissions)
4. **Track results** for reporting

```javascript
// Parse pattern
const fileRegex = /### FILE: (.+)\n```\w*\n([\s\S]+?)```/g

// For each match:
Write({
  file_path: extractedPath,
  content: extractedContent
})
```

## Step 8: Report Results

```
╔══════════════════════════════════════════════════════════════╗
║  PARALLEL EXECUTION COMPLETE                                 ║
╚══════════════════════════════════════════════════════════════╝

RESULTS
────────────────────────────────────────────────────────────────
  ✓ task-id-1: Task title - SUCCESS
    Created: path/to/file.ext

  ✓ task-id-2: Task title - SUCCESS
    Created: path/to/file.ext

  ✗ task-id-3: Task title - FAILED
    Error: {reason}

SUMMARY
────────────────────────────────────────────────────────────────
  Tasks completed: {N}/{total}
  Files created: {count}
────────────────────────────────────────────────────────────────
```

## Step 9: Update Task Status

For each successful task:
```bash
bd update {task_id} --status closed
```

## Step 10: Offer Next Actions

Use AskUserQuestion:

**Question**: "Parallel execution complete. What's next?"

**Options**:
1. **Commit all changes** - Single commit for all parallel work
2. **Review changes** - Look at what was created
3. **Continue to next tasks** - Check for more work
4. **Retry failed** - If any tasks failed

## Error Handling

If a sub-agent fails or returns invalid format:
1. Log the error with details
2. Continue processing other agents
3. Report failures clearly
4. Offer individual retry option

## Dry Run Mode

When `$ARGUMENTS` contains `--dry-run`:
- Analyze tasks and show plan
- Show what would be spawned
- Do NOT actually spawn sub-agents
- Let user review before real execution

## Token Efficiency

Each sub-agent starts with **FRESH context**:
- No accumulated conversation history
- Only task-specific context loaded
- Maximum available token window
- Isolated processing = no cross-contamination

This is more efficient than one agent doing N tasks sequentially with growing context.

## Important Rules

1. **Verify independence** before parallel execution
2. **Use Task tool in SINGLE message** for true parallelism
3. **Use opus model** for complex implementation tasks
4. **Sub-agents return content**, master writes files
5. **Parse FILE: blocks** from sub-agent responses
6. **Handle partial failures** gracefully
7. **Report honestly** about what succeeded/failed
