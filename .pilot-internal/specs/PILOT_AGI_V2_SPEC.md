# Pilot AGI v2.0 - Comprehensive Specification

> **Vision**: An AGI-like autonomous development framework that guides users from idea to production-ready product with minimal intervention.

**Created**: 2026-01-21
**Status**: Draft for Review

---

## Executive Summary

Pilot AGI v2.0 transforms from a skill-based workflow into a **fully autonomous development orchestrator** that:

1. **Detects context automatically** - New project vs existing, session state, locked files
2. **Guides users through discovery** - Diamond methodology, personas, competitive analysis
3. **Maintains living knowledge** - UI maps, API catalog, DB schema, architecture diagrams
4. **Enforces quality proactively** - No silent changes, everything tracked and approved
5. **Supports multi-agent parallelism** - 2-6 Claude Code terminals working safely
6. **Works autonomously after approval** - Research, plan, execute, commit loop

```
User sends message → Orchestrator detects intent → Routes to workflow → Autonomous execution
```

---

## Table of Contents

1. [Core Architecture](#core-architecture)
2. [Phase 1: Proactive Enforcement](#phase-1-proactive-enforcement)
3. [Phase 2: Multi-Session Safety](#phase-2-multi-session-safety)
4. [Phase 3: Knowledge Base SSOT](#phase-3-knowledge-base-ssot)
5. [Phase 4: Diamond Discovery Process](#phase-4-diamond-discovery-process)
6. [Phase 5: Autonomous Execution](#phase-5-autonomous-execution)
7. [Phase 6: Kanban API Foundation](#phase-6-kanban-api-foundation)
8. [Task Hierarchy Model](#task-hierarchy-model)
9. [Master Agent Architecture](#master-agent-architecture)
10. [Implementation Roadmap](#implementation-roadmap)

---

## Core Architecture

### Directory Structure (v2.0)

```
project/
├── .beads/                          # Task database (bd)
├── .claude/
│   ├── settings.json                # Hook configuration
│   └── pilot/
│       ├── policy.yaml              # Governance rules SSOT
│       ├── config.json              # Framework configuration
│       │
│       ├── state/                   # Runtime state
│       │   ├── active_task.json     # Current claimed task
│       │   └── sessions/            # Session state files
│       │       └── <session_id>.json
│       │
│       ├── locks/                   # Area/file locks
│       │   └── areas/
│       │       └── <area>.lock
│       │
│       ├── kb/                      # Knowledge Base SSOT
│       │   ├── ui/
│       │   │   ├── ROUTES.generated.json
│       │   │   ├── NAV.yaml
│       │   │   └── PAGES.yaml
│       │   ├── api/
│       │   │   ├── openapi.yaml
│       │   │   └── asyncapi.yaml    # Optional
│       │   ├── data/
│       │   │   └── schema.prisma    # OR schema.dbml
│       │   └── arch/
│       │       ├── workspace.dsl    # Structurizr C4
│       │       └── dataflows.md     # Mermaid diagrams
│       │
│       ├── discovery/               # Diamond methodology outputs
│       │   ├── PERSONAS.yaml
│       │   ├── COMPETITORS.md
│       │   ├── INSIGHTS.md
│       │   └── FEATURES_BACKLOG.yaml
│       │
│       ├── hooks/                   # Enforcement hooks
│       │   ├── session_start.js
│       │   ├── user_prompt_submit.js
│       │   ├── pre_tool_use.js
│       │   └── gates/               # Quality gates
│       │
│       ├── rules/                   # Agent validation rules
│       │   ├── frontend.yaml
│       │   ├── backend.yaml
│       │   ├── database.yaml
│       │   └── security.yaml
│       │
│       ├── agents/                  # Master agent definitions
│       │   ├── frontend-master.md
│       │   ├── backend-master.md
│       │   └── database-master.md
│       │
│       └── skills/                  # Skill definitions
│
├── work/
│   ├── PROJECT_BRIEF.md             # Product definition
│   ├── ROADMAP.md                   # High-level phases
│   ├── canon/                       # Canonical patterns
│   │   ├── PRINCIPLES.md
│   │   └── registry.json
│   ├── milestones/                  # Milestone definitions
│   │   └── M1-mvp.md
│   ├── sprints/                     # Sprint planning
│   │   └── sprint-001.md
│   ├── specs/                       # Feature specifications
│   ├── research/                    # Research outputs
│   └── plans/                       # Approved implementation plans
│
├── runs/                            # Session logs
│   ├── sessions.jsonl               # Event stream
│   └── YYYY-MM-DD.md                # Daily capsules
│
└── CLAUDE.md                        # Agent contract
```

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USER MESSAGE                                 │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    SESSION START HOOK                                │
│  • Generate/load session_id                                          │
│  • Check for active sessions & locked files                          │
│  • Load context: brief, roadmap, current tasks                       │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  USER PROMPT SUBMIT HOOK                             │
│  • Classify intent (new project / continue / new task / question)    │
│  • Route to appropriate workflow                                     │
│  • Block if trying to work on locked files                          │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
              ▼                   ▼                   ▼
     ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
     │  NEW PROJECT   │  │ CONTINUE WORK  │  │   NEW TASK     │
     │                │  │                │  │                │
     │ Diamond Flow   │  │ /pilot-next    │  │ /pilot-new-task│
     │ → Brief        │  │ → Claim task   │  │ → Create issue │
     │ → Roadmap      │  │ → Execute      │  │ → Plan         │
     └────────────────┘  └────────────────┘  └────────────────┘
```

---

## Phase 1: Proactive Enforcement

### Goal

Guarantee no work happens silently:
- No edits without an active claimed bd task
- No edits without an approved plan (when required)
- Any "new request" becomes a proposed bd issue
- Every micro-step produces commit + log + bd update

### Policy Rules (v1)

```yaml
# .claude/pilot/policy.yaml
version: "1.0"

enforcement:
  # R1: Must have active task to edit
  require_active_task: true

  # R2: Must have approved plan for complex tasks
  require_plan_approval: true
  plan_approval_threshold: "medium"  # low, medium, high

  # R3: No direct edits to main branch
  protected_branches:
    - main
    - master
    - production

  # R4: New scope triggers task proposal
  detect_new_scope: true
  new_scope_keywords:
    - "add feature"
    - "implement"
    - "create new"
    - "build"
    - "fix bug"

execution:
  # R5: Micro-step requirements
  require_verification: true
  require_commit_per_step: true
  require_run_log_update: true
  require_bd_update: true

areas:
  frontend:
    paths: ["src/app/**", "src/components/**", "src/styles/**"]
    agent: "frontend-master"
  backend:
    paths: ["src/api/**", "src/server/**", "src/lib/**"]
    agent: "backend-master"
  database:
    paths: ["prisma/**", "src/db/**", "migrations/**"]
    agent: "database-master"
  infra:
    paths: [".github/**", "docker/**", "infra/**"]
    agent: null
```

### Hook Implementations

#### 1. Session Start Hook

```javascript
// .claude/pilot/hooks/session_start.js
// Runs when Claude Code session begins

module.exports = async function sessionStart(context) {
  const sessionId = generateSessionId();

  // 1. Register session
  await appendToJsonl('.pilot/sessions.jsonl', {
    ts: new Date().toISOString(),
    type: 'session_started',
    session_id: sessionId,
    cwd: process.cwd(),
    agent: 'claude-code',
    pid: process.pid
  });

  // 2. Check for other active sessions
  const activeSessions = await getActiveSessions();
  const lockedFiles = await getLockedFiles(activeSessions);

  // 3. Load context
  const brief = await loadIfExists('work/PROJECT_BRIEF.md');
  const roadmap = await loadIfExists('work/ROADMAP.md');
  const activeTasks = await bd('issues --status in_progress --json');
  const readyTasks = await bd('ready --json');

  // 4. Return context to Claude
  return {
    decision: 'continue',
    session_id: sessionId,
    context: {
      has_project: !!brief,
      active_sessions: activeSessions.length,
      locked_files: lockedFiles,
      active_tasks: activeTasks,
      ready_tasks: readyTasks.length,
      resume_hint: await getResumeHint()
    }
  };
};
```

#### 2. User Prompt Submit Hook

```javascript
// .claude/pilot/hooks/user_prompt_submit.js
// Runs when user sends a message

module.exports = async function userPromptSubmit({ prompt }) {
  const policy = await loadPolicy();
  const sessionState = await loadSessionState();

  // 1. Classify intent
  const intent = classifyIntent(prompt, policy);

  // 2. Route based on intent
  switch (intent.type) {
    case 'new_project':
      return {
        decision: 'continue',
        message: `Detected new project request. Starting discovery process...

Run: /pilot-init to begin the guided setup.`
      };

    case 'new_scope':
      if (policy.enforcement.detect_new_scope) {
        return {
          decision: 'continue',
          message: `This looks like new work. Let me propose a task first.

Run: /pilot-new-task "${intent.summary}"`
        };
      }
      break;

    case 'continue_work':
      if (!sessionState.active_task) {
        return {
          decision: 'continue',
          message: `No active task claimed. Let me find the next task.

Run: /pilot-next`
        };
      }
      break;

    case 'question':
      // Allow questions without task
      return { decision: 'continue' };
  }

  return { decision: 'continue' };
};
```

#### 3. Pre-Tool Use Hook (Edit/Write Enforcement)

```javascript
// .claude/pilot/hooks/pre_tool_use.js
// Runs before Edit/Write tools

module.exports = async function preToolUse({ tool, input }) {
  if (!['Edit', 'Write'].includes(tool)) {
    return { decision: 'allow' };
  }

  const policy = await loadPolicy();
  const sessionState = await loadSessionState();
  const filePath = input.file_path;

  // R1: Check active task
  if (policy.enforcement.require_active_task) {
    if (!sessionState.active_task) {
      return {
        decision: 'block',
        message: `Cannot edit without an active task.

Run: /pilot-next to claim a task first.`
      };
    }
  }

  // R2: Check plan approval
  if (policy.enforcement.require_plan_approval) {
    const task = await bd(`show ${sessionState.active_task} --json`);
    if (task.requires_plan_approval && !task.plan?.approved) {
      return {
        decision: 'block',
        message: `Task requires plan approval before editing.

Run: /pilot-plan to create and get approval.`
      };
    }
  }

  // R3: Check branch protection
  const branch = await getCurrentBranch();
  if (policy.enforcement.protected_branches.includes(branch)) {
    return {
      decision: 'block',
      message: `Cannot edit on protected branch '${branch}'.

Create a feature branch: git checkout -b feature/${sessionState.active_task}`
    };
  }

  // R4: Check file locks (multi-session)
  const lock = await checkFileLock(filePath);
  if (lock && lock.session_id !== sessionState.session_id) {
    return {
      decision: 'block',
      message: `File is locked by another session.

Locked by: ${lock.session_id}
Task: ${lock.task_id}
Expires: ${lock.expires_at}

Wait for the other session to complete or run: /pilot-release-lock ${filePath}`
    };
  }

  return { decision: 'allow' };
};
```

### Core Skills (Phase 1)

| Skill | Purpose |
|-------|---------|
| `/pilot-help` | Show available commands and current state |
| `/pilot-status` | Display session, tasks, locks, progress |
| `/pilot-next` | Pick and claim next ready task |
| `/pilot-plan` | Create micro-step implementation plan |
| `/pilot-approve` | Mark plan as approved |
| `/pilot-exec` | Execute ONE micro-step with verification |
| `/pilot-commit` | Create conventional commit |
| `/pilot-close` | Validate DoD, close task |
| `/pilot-new-task` | Propose and create new task |

### Definition of Done (Phase 1)

- [ ] Edit/Write blocked without active task
- [ ] Edit/Write blocked without approved plan (when required)
- [ ] Edit/Write blocked on protected branches
- [ ] New scope prompts trigger task proposal
- [ ] Micro-step loop works: plan → approve → exec → commit → close
- [ ] Run log updated after each action
- [ ] bd status updated automatically

---

## Phase 2: Multi-Session Safety

### Goal

Allow 2-6 Claude Code terminals to work concurrently without collisions.

### Session Management

```yaml
# Session state file: .claude/pilot/state/sessions/<session_id>.json
{
  "session_id": "S-abc123",
  "started_at": "2026-01-21T21:05:00Z",
  "last_heartbeat": "2026-01-21T21:35:00Z",
  "status": "active",
  "claimed_task": "BD-123",
  "locked_areas": ["backend"],
  "locked_files": ["src/api/users.ts"],
  "branch": "feature/BD-123-user-auth"
}
```

### Event Stream (JSONL)

```jsonl
{"ts":"2026-01-21T21:05:00Z","type":"session_started","session_id":"S-abc123","pid":12345}
{"ts":"2026-01-21T21:06:00Z","type":"task_claimed","session_id":"S-abc123","task":"BD-123","area":"backend","lease_min":30}
{"ts":"2026-01-21T21:15:00Z","type":"heartbeat","session_id":"S-abc123","task":"BD-123"}
{"ts":"2026-01-21T21:36:00Z","type":"task_completed","session_id":"S-abc123","task":"BD-123","commit":"abc1234"}
{"ts":"2026-01-21T21:37:00Z","type":"session_ended","session_id":"S-abc123","reason":"user_exit"}
```

### Claim/Lease Protocol

1. **Claim**: Session requests task
   - Set `assignee: <session_id>` in bd
   - Set `lease_expires_at: now + 30min`
   - Lock task's area (if defined)
   - Record in event stream

2. **Heartbeat**: Every 5 minutes
   - Extend lease by 30 minutes
   - Update `last_heartbeat` in session state

3. **Release**: Task completed or abandoned
   - Clear assignee
   - Remove area lock
   - Record in event stream

4. **Lease Expiry**: If no heartbeat
   - Another session may claim after expiry
   - Original session warned on next action

### Area Locks

```javascript
// .claude/pilot/locks/areas/backend.lock
{
  "area": "backend",
  "session_id": "S-abc123",
  "task_id": "BD-123",
  "locked_at": "2026-01-21T21:06:00Z",
  "expires_at": "2026-01-21T21:36:00Z",
  "paths": ["src/api/**", "src/server/**"]
}
```

### New Skills (Phase 2)

| Skill | Purpose |
|-------|---------|
| `/pilot-session` | Show current session ID and status |
| `/pilot-claim <id>` | Explicitly claim a task |
| `/pilot-release` | Release current task and locks |
| `/pilot-heartbeat` | Manual heartbeat (usually automatic) |
| `/pilot-sessions` | List all active sessions |

### Definition of Done (Phase 2)

- [ ] Each terminal gets unique session ID
- [ ] Tasks can only be claimed by one session
- [ ] Area locks prevent conflicts
- [ ] Leases expire and allow re-claim
- [ ] Event stream records all session activity
- [ ] `/pilot-sessions` shows all active work

---

## Phase 3: Knowledge Base SSOT

### Goal

Maintain always-current product knowledge that agents load before any work.

### UI Knowledge (`kb/ui/`)

#### ROUTES.generated.json (Auto-generated)

```json
{
  "generated_at": "2026-01-21T21:00:00Z",
  "framework": "next.js",
  "routes": [
    {
      "path": "/",
      "file": "src/app/page.tsx",
      "type": "page"
    },
    {
      "path": "/dashboard",
      "file": "src/app/dashboard/page.tsx",
      "type": "page",
      "auth_required": true
    },
    {
      "path": "/api/users",
      "file": "src/app/api/users/route.ts",
      "type": "api",
      "methods": ["GET", "POST"]
    }
  ]
}
```

#### NAV.yaml (Human-authored)

```yaml
# Navigation structure
primary:
  - label: "Dashboard"
    path: "/dashboard"
    icon: "home"
    auth: required
  - label: "Settings"
    path: "/settings"
    icon: "cog"
    auth: required

footer:
  - label: "Privacy"
    path: "/privacy"
  - label: "Terms"
    path: "/terms"
```

#### PAGES.yaml (Human-authored)

```yaml
pages:
  dashboard:
    path: "/dashboard"
    purpose: "{page_purpose}"
    sections:
      - name: "{section_name}"
        description: "{section_description}"
        actions: ["{action_1}", "{action_2}"]
      - name: "{section_name_2}"
        description: "{section_description_2}"
    data_dependencies:
      - "{data_source_1}"
      - "{data_source_2}"
    permissions: ["authenticated"]
```

### API Knowledge (`kb/api/`)

#### openapi.yaml (OpenAPI 3.1)

```yaml
openapi: 3.1.0
info:
  title: {Project Name} API
  version: 1.0.0
paths:
  /api/{resources}:
    get:
      summary: List all {resources}
      responses:
        '200':
          description: List of {resources}
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/{Resource}'
    post:
      summary: Create a {resource}
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Create{Resource}Input'
      responses:
        '201':
          description: Created {resource}

components:
  schemas:
    {Resource}:
      type: object
      properties:
        id:
          type: string
        name:
          type: string
        # ... other fields specific to your domain
        createdAt:
          type: string
          format: date-time
```

### Database Knowledge (`kb/data/`)

#### schema.prisma (if using Prisma)

```prisma
model {Entity} {
  id          String       @id @default(cuid())
  name        String
  // ... domain-specific fields
  archived    Boolean      @default(false)
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  {relations} {RelatedEntity}[]
}

model {RelatedEntity} {
  id          String   @id @default(cuid())
  {entityId}  String
  {entity}    {Entity} @relation(fields: [{entityId}], references: [id])
  // ... domain-specific fields
  createdAt   DateTime @default(now())

  @@unique([{entityId}, {uniqueField}])
}
```

#### schema.dbml (alternative)

```dbml
Table {entities} {
  id varchar [pk]
  name varchar [not null]
  // ... domain-specific fields
  archived boolean [default: false]
  created_at timestamp [default: `now()`]
  updated_at timestamp
}

Table {related_entities} {
  id varchar [pk]
  {entity}_id varchar [ref: > {entities}.id]
  // ... domain-specific fields
  created_at timestamp [default: `now()`]

  indexes {
    ({entity}_id, {unique_field}) [unique]
  }
}
```

### Architecture Knowledge (`kb/arch/`)

#### workspace.dsl (Structurizr C4)

```dsl
workspace "{Project Name}" {
  model {
    user = person "User" "{user_description}"

    system = softwareSystem "{Project Name}" {
      webApp = container "Web App" "{framework}" "React"
      api = container "API" "{api_framework}" "Node.js"
      db = container "Database" "{database}" "{storage_type}"
    }

    user -> webApp "Uses"
    webApp -> api "Calls"
    api -> db "Reads/Writes"
  }

  views {
    systemContext system {
      include *
      autoLayout
    }
    container system {
      include *
      autoLayout
    }
  }
}
```

### KB Sync & Verify

```bash
# Regenerate auto-generated files
pilot kb sync

# Verify KB is current (fails if drift detected)
pilot kb verify
```

### New Skills (Phase 3)

| Skill | Purpose |
|-------|---------|
| `/pilot-kb-sync` | Regenerate auto-generated KB files |
| `/pilot-kb-verify` | Check KB is up-to-date |
| `/pilot-kb-show` | Display current product knowledge |

### Definition of Done (Phase 3)

- [ ] Routes auto-generated from filesystem
- [ ] OpenAPI linted with Spectral
- [ ] Schema validated (Prisma or DBML)
- [ ] KB sync command works
- [ ] KB verify fails on drift
- [ ] Agents load KB context before work

---

## Phase 4: Diamond Discovery Process

### Goal

Guide users through product discovery before any code is written.

### Diamond Methodology Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         DISCOVER                                     │
│  • Understand the problem space                                      │
│  • Research competitors                                              │
│  • Identify target users                                             │
│  • Gather insights                                                   │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          DEFINE                                      │
│  • Create personas                                                   │
│  • Define problem statements                                         │
│  • Prioritize features                                               │
│  • Set success criteria                                              │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         DEVELOP                                      │
│  • Create PROJECT_BRIEF.md                                           │
│  • Define tech stack                                                 │
│  • Create ROADMAP.md                                                 │
│  • Plan milestones & sprints                                         │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         DELIVER                                      │
│  • Approve plan                                                      │
│  • Begin autonomous execution                                        │
│  • Build MVP                                                         │
│  • Iterate                                                           │
└─────────────────────────────────────────────────────────────────────┘
```

### Discovery Outputs

#### PERSONAS.yaml

```yaml
personas:
  - id: "{persona_id}"
    name: "{Persona Name}"
    type: primary  # primary | secondary | edge_case
    description: "{brief_description}"
    demographics:
      age_range: "{age_range}"
      tech_savvy: "{low|moderate|high}"
      device: "{device_preference}"
    goals:
      - "{goal_1}"
      - "{goal_2}"
      - "{goal_3}"
    frustrations:
      - "{frustration_1}"
      - "{frustration_2}"
      - "{frustration_3}"
    behaviors:
      - "{behavior_1}"
      - "{behavior_2}"
      - "{behavior_3}"
    quotes:
      - "{quote_1}"
      - "{quote_2}"
```

#### COMPETITORS.md

```markdown
# Competitive Analysis

## Direct Competitors

### {Competitor 1}
- **Strengths**: {strength_1}, {strength_2}
- **Weaknesses**: {weakness_1}, {weakness_2}
- **Pricing**: {pricing_model}
- **Key Features**: {feature_1}, {feature_2}

### {Competitor 2}
- **Strengths**: {strength_1}, {strength_2}
- **Weaknesses**: {weakness_1}, {weakness_2}
- **Pricing**: {pricing_model}
- **Key Features**: {feature_1}, {feature_2}

## Indirect Competitors

### {Indirect Competitor}
- **Strengths**: {strength_1}, {strength_2}
- **Weaknesses**: {weakness_1}, {weakness_2}
- **Key Features**: {feature_1}, {feature_2}

## Our Differentiation

| Feature | Us | {Competitor 1} | {Competitor 2} |
|---------|-----|----------------|----------------|
| {differentiator_1} | ✅ | ❌ | ❌ |
| {differentiator_2} | ✅ | ✅ | ❌ |
| {differentiator_3} | ✅ | ❌ | ✅ |
```

#### INSIGHTS.md

```markdown
# User Research Insights

## Key Findings

### 1. {Key Finding Title}
> "{User quote supporting finding}"

Users experience {problem} when:
- {condition_1}
- {condition_2}
- {condition_3}

### 2. {Key Finding Title 2}

Most requested features:
1. {feature_1} ({percentage}%)
2. {feature_2} ({percentage}%)
3. {feature_3} ({percentage}%)

### 3. {Key Finding Title 3}

- {statistic_1}
- {statistic_2}
- {insight_from_research}

## Opportunities

1. **{opportunity_1}** - {description}
2. **{opportunity_2}** - {description}
3. **{opportunity_3}** - {description}
```

#### FEATURES_BACKLOG.yaml

```yaml
# Features identified during discovery
# Status: proposed | approved | building | shipped | rejected

features:
  # MVP (approved)
  - id: "F-001"
    title: "{feature_title}"
    status: approved
    priority: P0
    persona: "{persona_id}"
    milestone: "M1-mvp"
    description: "{feature_description}"

  - id: "F-002"
    title: "{feature_title}"
    status: approved
    priority: P0
    persona: "{persona_id}"
    milestone: "M1-mvp"

  # Post-MVP (proposed)
  - id: "F-010"
    title: "{future_feature}"
    status: proposed
    priority: P2
    persona: "{persona_id}"
    milestone: null
    notes: "{consideration_or_tradeoff}"

  - id: "F-011"
    title: "{rejected_feature}"
    status: rejected
    priority: null
    reason: "{reason_for_rejection}"
```

### Discovery Skills

| Skill | Purpose |
|-------|---------|
| `/pilot-discover` | Start discovery process with questions |
| `/pilot-research` | Run competitive analysis |
| `/pilot-personas` | Create user personas |
| `/pilot-insights` | Gather and synthesize insights |
| `/pilot-define` | Create problem statements and priorities |
| `/pilot-brief` | Generate PROJECT_BRIEF.md |

### Definition of Done (Phase 4)

- [ ] Discovery flow asks smart questions
- [ ] Competitive analysis auto-researched
- [ ] Personas created with needs/wants
- [ ] Insights documented
- [ ] Features backlog populated
- [ ] All discovery files saved
- [ ] User can review before proceeding

---

## Phase 5: Autonomous Execution

### Goal

After plan approval, AI works autonomously with minimal user intervention.

### Autonomous Loop

```
┌─────────────────────────────────────────────────────────────────────┐
│                    AUTONOMOUS EXECUTION LOOP                         │
└─────────────────────────────────────────────────────────────────────┘

For each task in sprint:

1. CONTEXT LOAD
   ├── Load PROJECT_BRIEF.md (what we're building)
   ├── Load ROADMAP.md (current phase)
   ├── Load KB (UI/API/DB state)
   ├── Load task details from bd
   └── Load related completed tasks (context)

2. RESEARCH (if needed)
   ├── Web search for best practices
   ├── Check documentation
   └── Store findings in work/research/

3. PLAN
   ├── Create micro-step plan
   ├── Identify files to create/modify
   ├── Define verification for each step
   └── Store in task body or work/plans/

4. EXECUTE (per micro-step)
   ├── Spawn appropriate master agent (frontend/backend/db)
   ├── Agent loads its rules + KB context
   ├── Agent implements step
   ├── Run verification
   ├── Update run log
   └── Commit changes

5. COMPLETE
   ├── Validate DoD
   ├── Update KB if needed (new routes, API changes)
   ├── Close task
   └── Pick next task

REPEAT until sprint complete
```

### Master Agent Context Loading

Each master agent (frontend, backend, database) automatically loads:

```javascript
// Context loaded before any work
const masterAgentContext = {
  // 1. Product understanding
  brief: await load('work/PROJECT_BRIEF.md'),
  roadmap: await load('work/ROADMAP.md'),
  currentMilestone: await getCurrentMilestone(),

  // 2. Knowledge base
  kb: {
    ui: await load('.claude/pilot/kb/ui/'),
    api: await load('.claude/pilot/kb/api/openapi.yaml'),
    db: await load('.claude/pilot/kb/data/schema.prisma'),
    arch: await load('.claude/pilot/kb/arch/')
  },

  // 3. Task context
  currentTask: await bd('show current --json'),
  relatedTasks: await bd('related current --json'),
  recentChanges: await git('log --oneline -10'),

  // 4. Agent rules
  rules: await load(`.claude/pilot/rules/${agentType}.yaml`),

  // 5. Canonical patterns
  patterns: await load('work/canon/registry.json')
};
```

### Parallel Execution

For independent tasks, spawn multiple agents:

```
┌─────────────────────────────────────────────────────────────────────┐
│                       ORCHESTRATOR                                   │
│  Analyzes task dependencies, spawns parallel agents                  │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │   FRONTEND   │   │   BACKEND    │   │   DATABASE   │
   │    MASTER    │   │    MASTER    │   │    MASTER    │
   │              │   │              │   │              │
   │ Task: UI     │   │ Task: API    │   │ Task: Schema │
   │ Files: tsx   │   │ Files: ts    │   │ Files: prisma│
   └──────────────┘   └──────────────┘   └──────────────┘
          │                   │                   │
          └───────────────────┼───────────────────┘
                              │
                              ▼
                     ┌──────────────┐
                     │   AGGREGATE  │
                     │   RESULTS    │
                     └──────────────┘
```

### Approval Gates

Even in autonomous mode, certain actions require approval:

```yaml
# Approval gates in policy.yaml
approval_gates:
  # Always require approval
  always:
    - "delete_file"
    - "modify_package_json"
    - "modify_env_files"
    - "database_migration"

  # Require approval if high risk
  conditional:
    - action: "create_new_utility"
      condition: "similar_exists"
      message: "Similar utility exists. Create anyway?"

    - action: "large_refactor"
      condition: "files_changed > 10"
      message: "This will modify {n} files. Proceed?"
```

### New Skills (Phase 5)

| Skill | Purpose |
|-------|---------|
| `/pilot-auto` | Start autonomous execution |
| `/pilot-pause` | Pause autonomous loop |
| `/pilot-gate` | Manual approval gate |

### Definition of Done (Phase 5)

- [ ] Autonomous loop executes tasks without prompts
- [ ] Master agents load full context before work
- [ ] Research happens automatically when needed
- [ ] Parallel execution for independent tasks
- [ ] Approval gates stop for high-risk actions
- [ ] Progress visible in run logs

---

## Phase 6: Kanban API Foundation

### Goal

Provide API for future Kanban UI without building UI yet.

### Local Server

```bash
# Start API server
pilot serve --port 3333
```

### Endpoints (v1 - Read Only)

```
GET /api/sessions
  → List active sessions with status

GET /api/issues
  → List all bd issues with status

GET /api/issues/:id
  → Get issue details

GET /api/events?since=<timestamp>
  → Stream events from sessions.jsonl

GET /api/kb
  → Get knowledge base summary

GET /api/locks
  → List current file/area locks
```

### Response Examples

```json
// GET /api/sessions
{
  "sessions": [
    {
      "id": "S-abc123",
      "status": "active",
      "task": "BD-123",
      "area": "backend",
      "started_at": "2026-01-21T21:05:00Z",
      "last_heartbeat": "2026-01-21T21:35:00Z"
    }
  ]
}

// GET /api/issues
{
  "issues": [
    {
      "id": "BD-123",
      "title": "Implement user auth",
      "status": "in_progress",
      "assignee": "S-abc123",
      "epic": "E-001",
      "priority": "P1",
      "area": "backend"
    }
  ]
}
```

### Definition of Done (Phase 6)

- [ ] `pilot serve` starts local server
- [ ] Read-only endpoints return correct data
- [ ] Events can be streamed
- [ ] No UI shipped (API only)

---

## Task Hierarchy Model

### Hierarchy Levels

```
MILESTONE (M)
└── EPIC (E)
    └── TASK (T)
        └── SUBTASK (S)
```

### bd Issue Types

```yaml
# Milestone
id: M-001
type: milestone
title: "MVP Release"
target: "2026-02-15"
children:
  - E-001
  - E-002

# Epic
id: E-001
type: epic
title: "User Authentication"
milestone: M-001
children:
  - T-001
  - T-002
  - T-003

# Task
id: T-001
type: task
title: "Implement login form"
epic: E-001
priority: P1
area: frontend
children:
  - S-001
  - S-002

# Subtask
id: S-001
type: subtask
title: "Create LoginForm component"
parent: T-001
```

### Visibility Commands

```bash
# Show full hierarchy
bd tree

# Show milestone progress
bd milestone M-001

# Show epic with tasks
bd epic E-001

# Show task with subtasks
bd show T-001 --children
```

---

## Master Agent Architecture

### Agent Definition

```yaml
# .claude/pilot/agents/frontend-master.md

name: Frontend Master Agent
type: master
domain: frontend

context_load:
  - work/PROJECT_BRIEF.md
  - work/ROADMAP.md
  - .claude/pilot/kb/ui/
  - .claude/pilot/rules/frontend.yaml
  - work/canon/registry.json

capabilities:
  - Create React components
  - Implement pages and routes
  - Style with Tailwind CSS
  - Write component tests
  - Ensure accessibility (WCAG AA)

must:
  - Check component registry before creating new
  - Use design tokens, never hardcoded values
  - Include loading and error states
  - Pass Lighthouse accessibility audit
  - Update PAGES.yaml when adding routes

must_not:
  - Create duplicate components
  - Use inline styles
  - Skip responsive design
  - Ignore mobile breakpoints

output_format:
  files:
    - "### FILE: {path}"
    - "```{language}"
    - "{content}"
    - "```"
  summary:
    - "### SUMMARY"
    - "- Files created: [list]"
    - "- KB updates needed: [list]"
    - "- Tests added: [list]"
```

### Agent Selection

```javascript
// Orchestrator selects agent based on task area
function selectAgent(task) {
  const area = task.area || classifyTaskArea(task);

  switch (area) {
    case 'frontend':
      return loadAgent('frontend-master');
    case 'backend':
      return loadAgent('backend-master');
    case 'database':
      return loadAgent('database-master');
    default:
      return loadAgent('general-purpose');
  }
}
```

---

## Implementation Roadmap

### Sprint 1: Foundation (Phase 1)

**Goal**: Basic enforcement works

| Task | Priority | Status |
|------|----------|--------|
| Create policy.yaml schema | P0 | pending |
| Implement session_start hook | P0 | pending |
| Implement pre_tool_use hook | P0 | pending |
| Implement user_prompt_submit hook | P0 | pending |
| Update /pilot-next with claim | P0 | pending |
| Create /pilot-approve skill | P1 | pending |
| Create /pilot-new-task skill | P1 | pending |

### Sprint 2: Multi-Session (Phase 2)

**Goal**: Multiple terminals work safely

| Task | Priority | Status |
|------|----------|--------|
| Session ID generation | P0 | pending |
| Session state management | P0 | pending |
| Task claim/lease protocol | P0 | pending |
| Area locking | P1 | pending |
| Event stream (JSONL) | P1 | pending |
| /pilot-session skill | P1 | pending |

### Sprint 3: Knowledge Base (Phase 3)

**Goal**: Product knowledge always current

| Task | Priority | Status |
|------|----------|--------|
| KB directory structure | P0 | pending |
| Route auto-generation | P0 | pending |
| OpenAPI integration | P1 | pending |
| Schema validation | P1 | pending |
| /pilot-kb-sync skill | P1 | pending |
| /pilot-kb-verify skill | P1 | pending |

### Sprint 4: Discovery (Phase 4)

**Goal**: Diamond methodology works

| Task | Priority | Status |
|------|----------|--------|
| /pilot-discover skill | P0 | pending |
| Competitive research automation | P1 | pending |
| Persona template & generation | P1 | pending |
| Insights gathering | P1 | pending |
| Features backlog management | P1 | pending |

### Sprint 5: Autonomous (Phase 5)

**Goal**: AI works independently

| Task | Priority | Status |
|------|----------|--------|
| Master agent definitions | P0 | pending |
| Context auto-loading | P0 | pending |
| Autonomous loop | P0 | pending |
| Parallel agent spawning | P1 | pending |
| Approval gates | P1 | pending |

### Sprint 6: API (Phase 6)

**Goal**: Kanban API ready

| Task | Priority | Status |
|------|----------|--------|
| pilot serve command | P1 | pending |
| Read-only endpoints | P1 | pending |
| Event streaming | P2 | pending |

---

## Success Metrics

| Metric | Target |
|--------|--------|
| New project → first commit | < 15 minutes |
| Task completion (autonomous) | > 80% success |
| Multi-session conflicts | 0 |
| KB drift (detected) | 100% |
| User interventions required | < 5 per day |

---

## Open Questions

1. Should discovery be mandatory for new projects?
2. How aggressive should lease expiry be?
3. Should KB verify block commits or just warn?
4. What's the right granularity for area locks?

---

*Draft created: 2026-01-21*
*Status: Awaiting Review*
