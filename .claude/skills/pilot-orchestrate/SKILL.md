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

---

# TASK DECOMPOSITION

For complex tasks, the orchestrator can decompose them into atomic subtasks with clear boundaries and dependencies.

## When to Decompose

Use task decomposition when:
- Task involves multiple distinct deliverables
- Task touches multiple files across domains
- Task has implicit dependencies between parts
- Task is too large for a single agent context

Skip decomposition when:
- Task is a single, atomic action
- Task clearly belongs to one domain
- Task has simple, linear execution

## Decomposition Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  COMPLEX TASK INPUT                                             │
│  "Build user profile page with avatar upload and settings"      │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP A: IDENTIFY ATOMIC ACTIONS                                │
│                                                                 │
│  Parse task to find distinct deliverables:                      │
│  • What components need to be created?                          │
│  • What API endpoints are required?                             │
│  • What data models need updating?                              │
│  • What tests should be written?                                │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP B: BUILD DEPENDENCY GRAPH (DAG)                           │
│                                                                 │
│  For each subtask, determine:                                   │
│  • What does it depend on? (must complete first)                │
│  • What does it block? (waits for this)                         │
│  • Can it run in parallel with others?                          │
│                                                                 │
│  Example DAG:                                                   │
│                                                                 │
│  [st-001: ProfilePage] ────┬────▶ [st-005: Tests]               │
│         │                  │                                    │
│         ▼                  │                                    │
│  [st-002: AvatarUpload] ───┼───▶ [st-004: POST /api/avatar]     │
│         │                  │                                    │
│         ▼                  ▼                                    │
│  [st-003: SettingsForm] ───▶ [st-006: PUT /api/profile]         │
│                                                                 │
│  Parallel groups: [st-002, st-003] (no shared dependencies)     │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP C: CREATE SUBTASK CONTRACTS                               │
│                                                                 │
│  For each subtask, define:                                      │
│  • ID, title, description                                       │
│  • Assigned agent (frontend, backend, etc.)                     │
│  • Required inputs (files, data from other subtasks)            │
│  • Expected outputs (files to create, data to pass)             │
│  • Validation requirements                                      │
│                                                                 │
│  Schema: .claude/pilot/schemas/subtask.yaml                     │
│  Output: .claude/pilot/schemas/subtask-output.yaml              │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP D: PRESENT DECOMPOSITION FOR APPROVAL                     │
└─────────────────────────────────────────────────────────────────┘
```

## Decomposition Step A: Identify Atomic Actions

Parse the task description to identify discrete units of work:

### Action Categories

| Category | Examples | Agent |
|----------|----------|-------|
| Create component | "Button", "Modal", "ProfileCard" | Frontend |
| Create page/route | "/profile", "/settings" | Frontend |
| Create API endpoint | "POST /api/users", "GET /api/profile" | Backend |
| Update schema | "Add avatar field to User model" | Backend |
| Write tests | "Test ProfilePage", "Test avatar upload" | Testing |
| Security review | "Review auth flow", "Audit inputs" | Security |

### Extraction Prompts

Ask yourself:
1. "What new files will be created?"
2. "What existing files will be modified?"
3. "What are the user-visible features?"
4. "What API changes are needed?"
5. "What should be tested?"

### Output Format

```yaml
atomic_actions:
  - action: "Create ProfilePage component"
    type: "create_component"
    agent: "frontend"
    files: ["src/app/profile/page.tsx"]

  - action: "Create AvatarUpload component"
    type: "create_component"
    agent: "frontend"
    files: ["src/components/features/AvatarUpload.tsx"]

  - action: "Create avatar upload endpoint"
    type: "create_api"
    agent: "backend"
    files: ["src/app/api/avatar/route.ts"]
```

## Decomposition Step B: Build Dependency Graph

Create a directed acyclic graph (DAG) of subtask dependencies.

### Dependency Rules

**A subtask depends on another if:**
- It imports/uses output from the other
- It needs data generated by the other
- It tests/reviews code from the other
- The task description implies order

**Subtasks are independent (can parallelize) if:**
- They don't share files
- They don't have input/output relationships
- They belong to different domains with no overlap

### Graph Construction

```
For each subtask S:
  For each other subtask T:
    If S.inputs includes T.outputs:
      Add edge T → S (T must complete before S)
    If S modifies files that T reads:
      Add edge S → T (S must complete before T)
```

### Cycle Detection

If the graph has cycles, decomposition is invalid. Break cycles by:
1. Merging related subtasks
2. Re-evaluating dependencies
3. Creating intermediate data contracts

### Parallel Groups

Identify sets of subtasks with no edges between them:

```
Group 1 (wave 1): [st-001]           # No dependencies
Group 2 (wave 2): [st-002, st-003]   # Both depend only on st-001
Group 3 (wave 3): [st-004, st-005]   # Depend on wave 2
```

## Decomposition Step C: Create Subtask Contracts

For each atomic action, create a contract following `.claude/pilot/schemas/subtask.yaml`:

### Contract Template

```yaml
subtask:
  id: "st-001"
  title: "Create ProfilePage component"
  description: |
    Build the main profile page that displays:
    - User avatar (uses AvatarUpload component)
    - Profile settings form (uses SettingsForm component)
    - Edit capabilities
  agent: "frontend"
  priority: "high"

inputs:
  - name: "design_tokens"
    source: "file:src/styles/tokens.css"
    required: true
  - name: "user_types"
    source: "file:src/types/user.ts"
    required: true

outputs:
  - path: "src/app/profile/page.tsx"
    type: "react_component"
    validation:
      - "uses_design_tokens"
      - "wcag_aa_compliant"
      - "has_loading_state"
      - "has_error_state"

dependencies:
  depends_on: []
  blocks: ["st-002", "st-003"]

execution:
  model: "opus"
  timeout_minutes: 10
```

## Decomposition Step D: Present for Approval

Display the decomposition plan:

```
╔══════════════════════════════════════════════════════════════╗
║  TASK DECOMPOSITION                                          ║
╚══════════════════════════════════════════════════════════════╝

ORIGINAL TASK: Build user profile page with avatar upload and settings

SUBTASKS (6 total)
────────────────────────────────────────────────────────────────

  WAVE 1 (parallel)
  ├── st-001: Create ProfilePage layout      [frontend]
  │           → src/app/profile/page.tsx
  │
  └── st-004: Define User types              [backend]
              → src/types/user.ts

  WAVE 2 (parallel, after wave 1)
  ├── st-002: Create AvatarUpload component  [frontend]
  │           → src/components/features/AvatarUpload.tsx
  │           depends: st-001
  │
  └── st-003: Create SettingsForm component  [frontend]
              → src/components/features/SettingsForm.tsx
              depends: st-001

  WAVE 3 (parallel, after wave 2)
  ├── st-005: Create avatar upload API       [backend]
  │           → src/app/api/avatar/route.ts
  │           depends: st-002, st-004
  │
  └── st-006: Create profile update API      [backend]
              → src/app/api/profile/route.ts
              depends: st-003, st-004

  POST-WORK (after all waves)
  └── st-007: Write tests for profile        [testing]
              depends: all above

DEPENDENCY GRAPH
────────────────────────────────────────────────────────────────

  st-001 ─────┬─────▶ st-002 ────┐
              │                   │
              └─────▶ st-003 ────┼───▶ st-006
                                 │
  st-004 ─────────────┬──────────┴───▶ st-005
                      │
                      └────────────────────────▶ st-007

────────────────────────────────────────────────────────────────
```

### Approval Options

Use AskUserQuestion:

**Question**: "Approve this decomposition?"

**Options**:
1. **Approve & execute** - Start executing waves
2. **Modify subtasks** - Adjust scope or dependencies
3. **Merge subtasks** - Combine related work
4. **Cancel** - Don't decompose, use simple orchestration

---

## Executing Decomposed Tasks

After approval, execute subtasks wave by wave:

### Wave Execution

```
For each wave:
  1. Spawn all subtasks in wave (parallel Task calls)
  2. Wait for all to complete
  3. Collect outputs
  4. Pass outputs to next wave as inputs
  5. Continue to next wave
```

### Inter-Subtask Data Passing

When a subtask produces data for another:

1. **Producer** includes `### DATA_OUTPUT:` block
2. **Orchestrator** parses and stores the data
3. **Consumer** receives data in its `inputs` context

Example flow:

```
st-004 produces:
### DATA_OUTPUT: user_types
```json
{
  "type": "typescript_types",
  "value": "export interface User { id: string; avatar?: string; }"
}
```

Orchestrator passes to st-005:
## Input from st-004: user_types
```typescript
export interface User { id: string; avatar?: string; }
```
```

### Progress Tracking

```
╔══════════════════════════════════════════════════════════════╗
║  DECOMPOSED EXECUTION IN PROGRESS                            ║
╚══════════════════════════════════════════════════════════════╝

WAVE 1 [████████████████████] COMPLETE
  ✓ st-001: ProfilePage layout
  ✓ st-004: User types

WAVE 2 [████████░░░░░░░░░░░░] IN PROGRESS
  ◐ st-002: AvatarUpload component
  ◐ st-003: SettingsForm component

WAVE 3 [░░░░░░░░░░░░░░░░░░░░] PENDING
  ○ st-005: Avatar upload API
  ○ st-006: Profile update API

POST-WORK [░░░░░░░░░░░░░░░░░░░░] PENDING
  ○ st-007: Tests
────────────────────────────────────────────────────────────────
```

---

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
