---
name: pilot:plan
description: Create a detailed implementation plan for a phase. Researches requirements, identifies files to modify, creates step-by-step plan. Use before implementing any significant work.
argument-hint: [phase-number]
allowed-tools: Read, Write, Glob, Grep, Task
---

# Plan Phase

You are creating an implementation plan for a phase.

## Arguments
- `$ARGUMENTS` contains the phase number (e.g., "1", "2")
- If no argument, plan the next unplanned phase from ROADMAP.md

## Step 1: Identify Phase

Read `.planning/ROADMAP.md` to find the phase details:
- Phase number and name
- Listed tasks/features
- Dependencies on previous phases

## Step 2: Research

Before planning, understand:
1. **Requirements**: What exactly needs to be built?
2. **Existing Code**: What patterns exist? What files will change?
3. **Dependencies**: What external libraries/APIs are needed?
4. **Risks**: What could go wrong?

Use tools to explore:
- `Glob` to find relevant files
- `Grep` to find patterns
- `Read` to understand existing code

## Step 3: Create Plan

Write a plan to `.planning/plans/phase-{N}-plan.md`:

```markdown
# Phase {N} Plan: {Name}

## Overview
[1-2 sentences describing what this phase accomplishes]

## Requirements
- [ ] Requirement 1
- [ ] Requirement 2

## Implementation Steps

### Step 1: [Name]
**Goal**: [What this step accomplishes]
**Files**:
- `path/to/file.ts` - [What changes]
**Verification**: [How to verify this step worked]

### Step 2: [Name]
**Goal**: [What this step accomplishes]
**Files**:
- `path/to/file.ts` - [What changes]
**Verification**: [How to verify this step worked]

[Continue for all steps...]

## Testing Strategy
- [ ] Test 1
- [ ] Test 2

## Risks & Mitigations
- **Risk**: [What could go wrong]
  **Mitigation**: [How to prevent/handle it]

## Dependencies
- [External library/API if needed]

## Estimated Complexity
[Low / Medium / High]
```

## Step 4: Update State

Update `.planning/STATE.md`:
```markdown
## Current Position
- Phase: {N} - {Name}
- Status: Planning Complete - Awaiting Approval
```

## Step 5: Present for Approval

Show the plan summary and ask:
```
Plan created for Phase {N}: {Name}

Summary:
- {X} implementation steps
- {Y} files to modify
- Complexity: {Low/Medium/High}

Review the full plan: .planning/plans/phase-{N}-plan.md

Ready to proceed? (yes/no/edit)
```

## Important Rules
- Never start implementation without approval
- Keep plans specific and actionable
- Each step should be small enough to verify independently
- Don't over-plan - leave room for discovery during implementation
