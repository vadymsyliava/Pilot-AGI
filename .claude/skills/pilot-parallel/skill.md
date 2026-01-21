---
name: pilot-parallel
description: Execute multiple independent tasks in parallel using sub-agents. Analyzes task independence, spawns workers, collects results.
argument-hint: [--dry-run to analyze without executing]
allowed-tools: Bash, Read, Write, Glob, Grep, Task, AskUserQuestion
---

# Parallel Task Executor

Execute multiple independent tasks simultaneously using sub-agents for maximum efficiency.

## Core Concept

Instead of working on tasks one-by-one, this skill:
1. **Analyzes** all ready tasks for independence
2. **Groups** tasks that can run in parallel (no conflicts)
3. **Spawns** sub-agents to work on each task
4. **Collects** results and reports to user

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

Tasks are INDEPENDENT if:
- They touch different files/directories
- They don't have bd dependencies on each other
- They don't modify shared configuration

Tasks are DEPENDENT if:
- They modify the same files
- One's output is another's input
- They both modify package.json or similar shared configs

### Analysis Method

For each task, extract likely files:
```
Task: "Create frontend agent validation rules"
→ Likely files: .claude/pilot/rules/frontend.yaml
→ Likely dirs: .claude/pilot/rules/

Task: "Create backend agent validation rules"
→ Likely files: .claude/pilot/rules/backend.yaml
→ Likely dirs: .claude/pilot/rules/

CONFLICT: Same directory, but different files
VERDICT: Can run in PARALLEL (different files)
```

```
Task: "Update package.json with test scripts"
Task: "Add build script to package.json"

CONFLICT: Same file (package.json)
VERDICT: Must run SEQUENTIALLY
```

## Step 3: Present Analysis

Display the analysis:

```
╔══════════════════════════════════════════════════════════════╗
║  PARALLEL EXECUTION ANALYSIS                                 ║
╚══════════════════════════════════════════════════════════════╝

READY TASKS: {N}

PARALLEL GROUP 1 (can run simultaneously)
────────────────────────────────────────────────────────────────
  • Pilot AGI-w6u: Frontend agent rules → .claude/pilot/rules/frontend.yaml
  • Pilot AGI-tdb: Backend agent rules  → .claude/pilot/rules/backend.yaml
  • Pilot AGI-1ss: Security agent rules → .claude/pilot/rules/security.yaml
  • Pilot AGI-c14: Review agent rules   → .claude/pilot/rules/review.yaml

  ✓ No file conflicts - all independent

ESTIMATED EFFICIENCY
────────────────────────────────────────────────────────────────
  Sequential: ~4 task cycles
  Parallel:   ~1 task cycle (4x faster)

  Token savings: Each sub-agent uses fresh context
────────────────────────────────────────────────────────────────
```

## Step 4: Confirm Parallel Execution

Use AskUserQuestion:

**Question**: "Execute 4 tasks in parallel?"

**Options**:
1. **Execute all in parallel** - Spawn sub-agents now
2. **Execute one at a time** - Traditional sequential
3. **Review tasks first** - Let me see what each will do
4. **Cancel** - Don't execute anything

## Step 5: Spawn Sub-Agents

When user confirms parallel execution, use the **Task tool** to spawn sub-agents:

```
For each task in parallel group:
  1. Create a detailed prompt for the sub-agent
  2. Use Task tool with run_in_background: true
  3. Track the agent ID
```

### Sub-Agent Prompt Template

```
You are implementing task {task_id}: {task_title}

CONTEXT:
- Project: Pilot AGI
- Milestone: {milestone}
- This is one of {N} parallel tasks

YOUR TASK:
{task_description}

CONSTRAINTS:
- Only modify files in: {allowed_paths}
- Do NOT modify: {forbidden_paths}
- Create implementation, don't just plan

DELIVERABLE:
- Create the necessary files
- Report what was created/modified
- Note any issues encountered

When done, summarize:
- Files created: [list]
- Files modified: [list]
- Status: success/partial/failed
- Notes: [any issues]
```

### Spawning Pattern

```javascript
// Spawn all sub-agents in parallel (single message with multiple Task calls)
Task({
  description: "Implement frontend agent rules",
  prompt: "...",
  subagent_type: "general-purpose",
  run_in_background: true
})

Task({
  description: "Implement backend agent rules",
  prompt: "...",
  subagent_type: "general-purpose",
  run_in_background: true
})

// ... more tasks
```

**CRITICAL**: Call all Task tools in a SINGLE message to run them in parallel.

## Step 6: Monitor Progress

After spawning, show:

```
╔══════════════════════════════════════════════════════════════╗
║  PARALLEL EXECUTION STARTED                                  ║
╚══════════════════════════════════════════════════════════════╝

RUNNING SUB-AGENTS
────────────────────────────────────────────────────────────────
  [▓▓▓░░░░░░░] Agent 1: Frontend rules - working...
  [▓▓▓▓▓░░░░░] Agent 2: Backend rules - working...
  [▓▓░░░░░░░░] Agent 3: Security rules - working...
  [▓▓▓▓░░░░░░] Agent 4: Review rules - working...

Waiting for all agents to complete...
────────────────────────────────────────────────────────────────
```

## Step 7: Collect Results

When all agents complete, use TaskOutput to get results:

```bash
# For each agent, check output
TaskOutput(task_id: "{agent_id}", block: true)
```

Parse each result for:
- Files created/modified
- Success/failure status
- Any errors or warnings

## Step 8: Report Results

```
╔══════════════════════════════════════════════════════════════╗
║  PARALLEL EXECUTION COMPLETE                                 ║
╚══════════════════════════════════════════════════════════════╝

RESULTS
────────────────────────────────────────────────────────────────
  ✓ Pilot AGI-w6u: Frontend rules - SUCCESS
    Created: .claude/pilot/rules/frontend.yaml

  ✓ Pilot AGI-tdb: Backend rules - SUCCESS
    Created: .claude/pilot/rules/backend.yaml

  ✓ Pilot AGI-1ss: Security rules - SUCCESS
    Created: .claude/pilot/rules/security.yaml

  ✓ Pilot AGI-c14: Review rules - SUCCESS
    Created: .claude/pilot/rules/review.yaml

SUMMARY
────────────────────────────────────────────────────────────────
  Tasks completed: 4/4
  Files created: 4
  Time saved: ~75% (parallel vs sequential)
────────────────────────────────────────────────────────────────
```

## Step 9: Update Task Status

For each successful task:
```bash
bd update {task_id} --status closed
```

## Step 10: Offer Next Actions

Use AskUserQuestion:

**Question**: "All parallel tasks complete. What's next?"

**Options**:
1. **Commit all changes** - Single commit for all parallel work
2. **Review changes** - Look at what was created
3. **Continue to next tasks** - Check for more work
4. **Fix issues** - If any tasks failed

## Independence Heuristics

### File Pattern Recognition

| Task Description Contains | Likely Files |
|--------------------------|--------------|
| "frontend agent" | .claude/pilot/rules/frontend.* |
| "backend agent" | .claude/pilot/rules/backend.* |
| "component" | src/components/*.tsx |
| "test for X" | tests/**/X.test.ts |
| "API endpoint" | src/app/api/**/*.ts |

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

## Token Efficiency

Each sub-agent starts with FRESH context:
- No accumulated conversation history
- Only task-specific context loaded
- Maximum available token window

This is more efficient than one agent doing 4 tasks sequentially with growing context.

## Error Handling

If a sub-agent fails:
1. Mark that task as failed
2. Continue with successful tasks
3. Report which failed and why
4. Offer to retry failed tasks individually

## Dry Run Mode

When `$ARGUMENTS` contains `--dry-run`:
- Analyze tasks and show plan
- Do NOT spawn sub-agents
- Let user review before execution

## Important Rules

1. **Verify independence** before parallel execution
2. **Use Task tool in single message** for true parallelism
3. **Track all agent IDs** for result collection
4. **Handle partial failures** gracefully
5. **Report honestly** about what succeeded/failed
