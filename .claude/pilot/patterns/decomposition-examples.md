# Task Decomposition Patterns

This document provides examples of how to decompose common task types into atomic subtasks with proper dependencies.

---

## Pattern 1: Full-Stack Feature

**Example Task**: "Build user profile page with avatar upload and settings"

### Decomposition

```yaml
subtasks:
  # Wave 1: Foundation (no dependencies)
  - id: st-001
    title: Define User types and interfaces
    agent: backend
    outputs:
      - path: src/types/user.ts
        data: user_types
    depends_on: []

  - id: st-002
    title: Create ProfilePage layout
    agent: frontend
    outputs:
      - path: src/app/profile/page.tsx
    depends_on: []

  # Wave 2: Components (depend on foundation)
  - id: st-003
    title: Create AvatarUpload component
    agent: frontend
    inputs:
      - source: subtask:st-001  # needs user types
    outputs:
      - path: src/components/features/AvatarUpload.tsx
    depends_on: [st-001]

  - id: st-004
    title: Create SettingsForm component
    agent: frontend
    inputs:
      - source: subtask:st-001  # needs user types
    outputs:
      - path: src/components/features/SettingsForm.tsx
    depends_on: [st-001]

  # Wave 3: API endpoints (depend on types and components)
  - id: st-005
    title: Create avatar upload API
    agent: backend
    inputs:
      - source: subtask:st-001
    outputs:
      - path: src/app/api/avatar/route.ts
    depends_on: [st-001, st-003]

  - id: st-006
    title: Create profile update API
    agent: backend
    inputs:
      - source: subtask:st-001
    outputs:
      - path: src/app/api/profile/route.ts
    depends_on: [st-001, st-004]

  # Wave 4: Integration (connect everything)
  - id: st-007
    title: Integrate components into ProfilePage
    agent: frontend
    depends_on: [st-002, st-003, st-004, st-005, st-006]

  # Post-work: Testing
  - id: st-008
    title: Write tests for profile feature
    agent: testing
    depends_on: [st-007]
```

### Dependency Graph

```
st-001 (types) ─────┬─────────────────────────────┐
      │             │                             │
      │             ▼                             ▼
      │      st-003 (AvatarUpload)         st-004 (SettingsForm)
      │             │                             │
      │             ▼                             ▼
      │      st-005 (avatar API)           st-006 (profile API)
      │             │                             │
      │             └──────────┬──────────────────┘
      │                        │
      │                        ▼
      └───────────────▶ st-007 (integration)
                              │
                              ▼
                        st-008 (tests)

st-002 (layout) ──────────────────────────────────▲
```

### Execution Waves

| Wave | Subtasks | Parallel? |
|------|----------|-----------|
| 1 | st-001, st-002 | Yes |
| 2 | st-003, st-004 | Yes |
| 3 | st-005, st-006 | Yes |
| 4 | st-007 | No (integration) |
| Post | st-008 | No (needs all code) |

---

## Pattern 2: API-Only Feature

**Example Task**: "Create REST API for product inventory with CRUD operations"

### Decomposition

```yaml
subtasks:
  # Wave 1: Schema
  - id: st-001
    title: Define Product schema in Prisma
    agent: backend
    outputs:
      - path: prisma/schema.prisma (update)
        data: product_schema
    depends_on: []

  # Wave 2: Types (after schema)
  - id: st-002
    title: Generate and export Product types
    agent: backend
    inputs:
      - source: subtask:st-001
    outputs:
      - path: src/types/product.ts
        data: product_types
    depends_on: [st-001]

  # Wave 3: CRUD endpoints (all parallel, depend on types)
  - id: st-003
    title: Create GET /api/products endpoint (list)
    agent: backend
    inputs:
      - source: subtask:st-002
    outputs:
      - path: src/app/api/products/route.ts
    depends_on: [st-002]

  - id: st-004
    title: Create GET /api/products/[id] endpoint (single)
    agent: backend
    inputs:
      - source: subtask:st-002
    outputs:
      - path: src/app/api/products/[id]/route.ts
    depends_on: [st-002]

  - id: st-005
    title: Create POST /api/products endpoint (create)
    agent: backend
    inputs:
      - source: subtask:st-002
    outputs:
      - path: src/app/api/products/route.ts (update)
    depends_on: [st-002]

  - id: st-006
    title: Create PUT /api/products/[id] endpoint (update)
    agent: backend
    inputs:
      - source: subtask:st-002
    outputs:
      - path: src/app/api/products/[id]/route.ts (update)
    depends_on: [st-002]

  - id: st-007
    title: Create DELETE /api/products/[id] endpoint
    agent: backend
    inputs:
      - source: subtask:st-002
    outputs:
      - path: src/app/api/products/[id]/route.ts (update)
    depends_on: [st-002]

  # Post-work
  - id: st-008
    title: Security audit of product endpoints
    agent: security
    depends_on: [st-003, st-004, st-005, st-006, st-007]

  - id: st-009
    title: Write API integration tests
    agent: testing
    depends_on: [st-003, st-004, st-005, st-006, st-007]
```

### Note on File Conflicts

Subtasks st-003 and st-005 both touch `route.ts`. Options:
1. **Merge them** into single subtask for the file
2. **Sequential execution** (st-003 → st-005)
3. **Smart merge** by orchestrator (preferred)

---

## Pattern 3: UI-Only Feature

**Example Task**: "Create a dashboard with analytics widgets"

### Decomposition

```yaml
subtasks:
  # Wave 1: Layout and shared components
  - id: st-001
    title: Create DashboardLayout component
    agent: frontend
    outputs:
      - path: src/app/dashboard/layout.tsx
    depends_on: []

  - id: st-002
    title: Create WidgetCard base component
    agent: frontend
    outputs:
      - path: src/components/dashboard/WidgetCard.tsx
        data: widget_card_props
    depends_on: []

  # Wave 2: Individual widgets (all parallel)
  - id: st-003
    title: Create MetricsWidget component
    agent: frontend
    inputs:
      - source: subtask:st-002
    outputs:
      - path: src/components/dashboard/MetricsWidget.tsx
    depends_on: [st-002]

  - id: st-004
    title: Create ChartWidget component
    agent: frontend
    inputs:
      - source: subtask:st-002
    outputs:
      - path: src/components/dashboard/ChartWidget.tsx
    depends_on: [st-002]

  - id: st-005
    title: Create RecentActivityWidget component
    agent: frontend
    inputs:
      - source: subtask:st-002
    outputs:
      - path: src/components/dashboard/RecentActivityWidget.tsx
    depends_on: [st-002]

  # Wave 3: Dashboard page
  - id: st-006
    title: Create DashboardPage with widget grid
    agent: frontend
    depends_on: [st-001, st-003, st-004, st-005]

  # Post-work
  - id: st-007
    title: Write component tests
    agent: testing
    depends_on: [st-003, st-004, st-005, st-006]
```

---

## Pattern 4: Refactoring

**Example Task**: "Refactor authentication to use NextAuth.js"

### Decomposition

```yaml
subtasks:
  # Wave 1: Setup (no dependencies)
  - id: st-001
    title: Configure NextAuth.js
    agent: backend
    outputs:
      - path: src/app/api/auth/[...nextauth]/route.ts
      - path: src/lib/auth.ts
        data: auth_config
    depends_on: []

  - id: st-002
    title: Create auth types and utilities
    agent: backend
    outputs:
      - path: src/types/auth.ts
        data: auth_types
    depends_on: []

  # Wave 2: Middleware and providers
  - id: st-003
    title: Create auth middleware
    agent: backend
    inputs:
      - source: subtask:st-001
    outputs:
      - path: src/middleware.ts
    depends_on: [st-001]

  - id: st-004
    title: Create SessionProvider wrapper
    agent: frontend
    inputs:
      - source: subtask:st-001
    outputs:
      - path: src/components/providers/SessionProvider.tsx
    depends_on: [st-001]

  # Wave 3: Update existing code
  - id: st-005
    title: Update login page to use NextAuth
    agent: frontend
    depends_on: [st-001, st-004]

  - id: st-006
    title: Update protected routes to use middleware
    agent: backend
    depends_on: [st-003]

  # Wave 4: Cleanup
  - id: st-007
    title: Remove old auth implementation
    agent: review
    depends_on: [st-005, st-006]

  # Post-work
  - id: st-008
    title: Test auth flows
    agent: testing
    depends_on: [st-007]
```

---

## Anti-Patterns to Avoid

### 1. Over-Decomposition

**Bad**: Breaking a single component into 10 subtasks

```yaml
# DON'T DO THIS
subtasks:
  - title: Create Button.tsx file
  - title: Add Button props interface
  - title: Add Button component function
  - title: Add Button styles
  - title: Export Button
```

**Good**: Keep atomic actions meaningful

```yaml
# DO THIS
subtasks:
  - title: Create Button component with variants
    outputs:
      - path: src/components/ui/Button.tsx
```

### 2. Missing Dependencies

**Bad**: Not specifying that API needs types

```yaml
subtasks:
  - id: st-001
    title: Create user types
  - id: st-002
    title: Create user API
    depends_on: []  # WRONG! Should depend on st-001
```

### 3. Circular Dependencies

**Bad**: Creating cycles in the graph

```yaml
subtasks:
  - id: st-001
    depends_on: [st-002]  # CYCLE!
  - id: st-002
    depends_on: [st-001]  # CYCLE!
```

### 4. Single-Agent Overkill

**Bad**: Decomposing a simple single-agent task

```yaml
# Task: "Add loading spinner to button"
# DON'T decompose this - it's one small change
```

---

## Quick Reference: When to Decompose

| Complexity | Files | Domains | Decompose? |
|------------|-------|---------|------------|
| Simple | 1-2 | 1 | No |
| Moderate | 3-4 | 1 | Optional |
| Moderate | 2-3 | 2 | Yes |
| Complex | 5+ | 1+ | Yes |
| Refactor | Any | Any | Usually Yes |

---

## Data Flow Between Subtasks

### Example: Types → Component → API

```
st-001 (types)
    │
    │ DATA_OUTPUT: user_types
    │ {
    │   "User": "interface User { id: string; name: string; }",
    │   "UserInput": "type UserInput = Omit<User, 'id'>"
    │ }
    │
    ├───────────────────────────────────────┐
    │                                       │
    ▼                                       ▼
st-002 (component)                    st-003 (API)
    │                                       │
    │ Receives in context:                  │ Receives in context:
    │ ## Input: user_types                  │ ## Input: user_types
    │ ```typescript                         │ ```typescript
    │ interface User { ... }                │ interface User { ... }
    │ ```                                   │ ```
```

This ensures type consistency across the feature without manual copy-paste.
