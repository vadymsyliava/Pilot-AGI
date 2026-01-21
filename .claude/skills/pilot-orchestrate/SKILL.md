---
name: pilot-orchestrate
description: Coordinate specialized agents for complex multi-domain tasks. Analyzes task requirements, routes to appropriate agents, and aggregates results.
argument-hint: [task description or bd task ID]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, TaskOutput, AskUserQuestion
---

# Agent Orchestrator

Coordinate specialized agents (frontend, backend, testing, security, review) for complex tasks that span multiple domains.

## When to Use

- Tasks touching both frontend AND backend
- Tasks requiring security review
- Complex features needing multiple perspectives
- Code reviews with quality gates

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     ORCHESTRATOR (You)                          │
│  1. Analyze task requirements                                   │
│  2. Classify task type                                          │
│  3. Select appropriate agents                                   │
│  4. Spawn agents (parallel or sequential)                       │
│  5. Collect and merge results                                   │
│  6. Write files to disk                                         │
└─────────────────────────────────────────────────────────────────┘
                              │
           ┌──────────────────┼──────────────────┐
           │                  │                  │
           ▼                  ▼                  ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │   FRONTEND   │  │   BACKEND    │  │   SECURITY   │
    │    AGENT     │  │    AGENT     │  │    AGENT     │
    │              │  │              │  │              │
    │ • UI/UX      │  │ • API design │  │ • Audit      │
    │ • Components │  │ • Database   │  │ • Vulnerabs  │
    │ • Styling    │  │ • Auth       │  │ • Best pracs │
    └──────────────┘  └──────────────┘  └──────────────┘
```

## Step 1: Load Agent Registry

```bash
cat .claude/pilot/agent-registry.json 2>/dev/null
```

If not found, inform user to run setup.

## Step 2: Get Task Context

If `$ARGUMENTS` contains a bd task ID:
```bash
bd show {task_id} --json
```

Otherwise, use the provided task description.

## Step 3: Classify Task

Analyze the task to determine:

### 3.1 File Patterns
What files will be touched?
- `components/`, `*.tsx` → Frontend
- `api/`, `server/`, `*.server.ts` → Backend
- `*.test.*`, `tests/` → Testing
- Security keywords → Security

### 3.2 Task Indicators
Look for keywords in the task description:

| Keywords | Agent |
|----------|-------|
| component, page, ui, button, form, style | Frontend |
| api, endpoint, database, auth, server | Backend |
| test, coverage, e2e, vitest | Testing |
| security, vulnerability, audit, xss | Security |
| review, quality, refactor, cleanup | Review |

### 3.3 Calculate Confidence

For each agent, calculate a match score (0-1):
- File pattern match: +0.4
- Task indicator match: +0.3 per keyword (max 0.6)
- Explicit mention: +1.0

Select agents with confidence >= 0.5

## Step 4: Present Analysis

```
╔══════════════════════════════════════════════════════════════╗
║  TASK ANALYSIS                                               ║
╚══════════════════════════════════════════════════════════════╝

TASK: {task title or description}

DETECTED DOMAINS
────────────────────────────────────────────────────────────────
  ✓ Frontend  (0.8 confidence) - UI components, styling
  ✓ Backend   (0.7 confidence) - API endpoints
  ○ Testing   (0.3 confidence) - Not primary focus
  ○ Security  (0.2 confidence) - Not primary focus

SELECTED AGENTS
────────────────────────────────────────────────────────────────
  Primary:   Frontend, Backend (parallel)
  Post-work: Testing, Review (after primary)

ORCHESTRATION PATTERN: full_stack_feature
────────────────────────────────────────────────────────────────
```

## Step 5: Confirm Agent Selection

Use AskUserQuestion:

**Question**: "Proceed with this agent configuration?"

**Options**:
1. **Execute with selected agents** - Start orchestrated execution
2. **Add more agents** - Include additional agents
3. **Remove agents** - Reduce scope
4. **Manual selection** - Choose agents explicitly

## Step 6: Prepare Agent Contexts

For each selected agent, prepare context:

### Frontend Agent Context
```
You are the Frontend Agent working on: {task}

## Your Rules
{Load from .claude/pilot/rules/frontend.yaml}

## Existing Components (check before creating new)
{List relevant components from codebase}

## Design Tokens
{Load design system if exists}

## Your Deliverables
- Component code with proper 'use client' directives
- Accessibility compliance (WCAG AA)
- Responsive design
- Loading and error states
```

### Backend Agent Context
```
You are the Backend Agent working on: {task}

## Your Rules
{Load from .claude/pilot/rules/backend.yaml}

## Database Schema
{Load relevant Prisma schema}

## Existing API Patterns
{Show existing endpoint patterns}

## Your Deliverables
- API endpoint with input validation (Zod)
- Proper error handling
- Authentication/authorization
- Database operations
```

### Security Agent Context
```
You are the Security Agent reviewing: {task}

## Your Rules
{Load from .claude/pilot/rules/security.yaml}

## Code to Review
{Relevant code sections}

## Your Deliverables
- Security vulnerabilities found
- OWASP compliance check
- Recommendations for fixes
```

## Step 7: Spawn Agents

**CRITICAL**: Use Task tool with ALL agents in a SINGLE message for true parallelism.

### Agent Prompt Template

```
You are a specialized {agent_name} working on a specific task.

## Task
{task_description}

## Your Domain Rules
{agent_rules from yaml file}

## Codebase Context
{relevant files and patterns}

## Output Format
Return your work in this EXACT format:

### FILE: {relative/path/to/file.ext}
```{language}
{complete file contents}
```

### ANALYSIS (if applicable)
- Issues found: [list]
- Recommendations: [list]
- Confidence: high|medium|low

### SUMMARY
- Files to create/modify: [list paths]
- Status: success | partial | failed
- Notes: [any decisions or issues]

## Important
- Generate COMPLETE file contents
- Follow all domain rules strictly
- Do NOT write files yourself
- Return content for orchestrator to write
```

### Spawning Pattern

```javascript
// Spawn ALL selected agents in parallel
Task({
  description: "Frontend: {task}",
  prompt: "{full frontend context}",
  subagent_type: "general-purpose",
  model: "opus",
  run_in_background: true
})

Task({
  description: "Backend: {task}",
  prompt: "{full backend context}",
  subagent_type: "general-purpose",
  model: "opus",
  run_in_background: true
})
```

## Step 8: Monitor Progress

```
╔══════════════════════════════════════════════════════════════╗
║  ORCHESTRATION IN PROGRESS                                   ║
╚══════════════════════════════════════════════════════════════╝

AGENTS WORKING
────────────────────────────────────────────────────────────────
  [▓▓▓░░░░░░░] Frontend Agent - Processing...
  [▓▓▓▓▓░░░░░] Backend Agent  - Processing...

You'll be notified when agents complete.
────────────────────────────────────────────────────────────────
```

## Step 9: Collect Results

Use TaskOutput to retrieve each agent's work:

```javascript
TaskOutput({ task_id: "{agent_id}", block: true })
```

### Parse Agent Output

Look for `### FILE:` blocks in the response:
```javascript
const fileRegex = /### FILE: (.+)\n```\w*\n([\s\S]+?)```/g
```

### Conflict Detection

If multiple agents modify the same file:
1. Flag the conflict
2. Show both versions
3. Ask user to resolve or merge

## Step 10: Write Files

For each successful agent output:

1. Parse FILE blocks
2. Validate content (syntax, rules)
3. Write to disk using Write tool
4. Track written files

```javascript
Write({
  file_path: absolutePath,
  content: fileContent
})
```

## Step 11: Run Post-Agents

After primary agents complete, run post-work agents:

### Testing Agent
```
Review the code created by Frontend/Backend agents and generate:
- Unit tests for new functions
- Integration tests for API endpoints
- Component tests for UI
```

### Review Agent
```
Review all changes for:
- Code quality compliance
- Pattern consistency
- Performance issues
- Security concerns
```

## Step 12: Report Results

```
╔══════════════════════════════════════════════════════════════╗
║  ORCHESTRATION COMPLETE                                      ║
╚══════════════════════════════════════════════════════════════╝

AGENT RESULTS
────────────────────────────────────────────────────────────────
  ✓ Frontend Agent - SUCCESS
    Created: src/components/Feature.tsx
    Created: src/components/Feature.module.css

  ✓ Backend Agent - SUCCESS
    Created: src/app/api/feature/route.ts
    Modified: prisma/schema.prisma

  ✓ Testing Agent - SUCCESS
    Created: src/components/Feature.test.tsx

  ⚠ Review Agent - WARNINGS
    [SHOULD FIX] Missing error boundary in Feature.tsx
    [SUGGESTION] Consider memoizing expensive calculation

SUMMARY
────────────────────────────────────────────────────────────────
  Agents run:      4
  Files created:   4
  Files modified:  1
  Warnings:        2
  Errors:          0
────────────────────────────────────────────────────────────────
```

## Step 13: Offer Next Actions

Use AskUserQuestion:

**Question**: "Orchestration complete. What's next?"

**Options**:
1. **Commit all changes** - Single commit for orchestrated work
2. **Fix warnings** - Address review agent warnings
3. **Run tests** - Execute generated tests
4. **Continue to next task** - Move on

## Error Handling

### Agent Failure
If an agent fails:
1. Log the error with context
2. Continue with other agents
3. Report partial results
4. Offer retry option

### Conflict Resolution
If agents conflict:
1. Identify conflicting files
2. Show diff of conflicts
3. Ask user to choose or merge
4. Continue with resolved version

## Orchestration Patterns

### full_stack_feature
```
Frontend + Backend (parallel)
    ↓
Testing + Review (sequential)
```

### api_only
```
Backend (single)
    ↓
Security → Testing (sequential)
```

### security_audit
```
Security (single)
    ↓
Review (post)
```

## Important Rules

1. **Load agent rules** before spawning
2. **Parallel when possible** - Use single message for multiple Task calls
3. **Detect conflicts** before writing
4. **Post-agents validate** primary agent work
5. **Report honestly** about successes and failures
6. **User decides** on conflict resolution
