# Semantic Guardian: Pilot AGI's Unique Differentiator

**The Semantic Guardian is what makes Pilot AGI different from raw Claude Code.**

While Claude Code provides powerful AI coding capabilities, the Semantic Guardian adds governance and oversight that enterprises require.

---

## What is the Semantic Guardian?

The Semantic Guardian is a hook (`user-prompt-submit.js`) that runs on every user prompt. It:

1. **Detects new work requests** - Distinguishes between questions and implementation requests
2. **Injects governance context** - Reminds Claude about active tasks and workflow state
3. **Suggests existing tasks** - Shows relevant tasks that match the user's intent
4. **Guides toward compliance** - Ensures work is tracked in bd before execution

---

## Why This Matters

### Without Semantic Guardian (Raw Claude Code)

```
User: "Add a dark mode toggle"
Claude: [Immediately starts coding]
```

Result:
- No task tracking (audit gap)
- No approval workflow
- No record of what was changed or why
- "Shadow work" that's hard to trace

### With Semantic Guardian (Pilot AGI)

```
User: "Add a dark mode toggle"
Claude: I see you're requesting new work, but there's no active task.

Related tasks that might match:
  → [BD-123] Implement theme switching
  → [BD-456] Add user preferences panel

Would you like to:
  • Start working on BD-123 (theme switching)?
  • Create a new task with /pilot-new-task?
```

Result:
- Work is tracked from the start
- Approval workflow kicks in
- Full audit trail
- Clear task ownership

---

## How It Works

### 1. Quick Heuristics (Instant, 0 tokens)

Pass-through without injection:
- Pilot/GSD commands (`/pilot-*`, `/gsd-*`)
- Questions (starts with "what", "where", "how", etc.)
- Acknowledgements ("yes", "ok", "proceed", etc.)
- Code reviews ("review", "check", "analyze")
- Task references (contains `bd-xxx` or task ID)

### 2. Context Injection (~300 tokens)

For uncertain prompts, inject:
```xml
<pilot-context>
Project: Governance Layer for Claude Code

Active task: none
Ready tasks: [BD-123] Implement theme, [BD-456] Add preferences

Possibly related tasks:
  → [BD-123] Implement theme switching

SEMANTIC GUARDIAN EVALUATION:
- If requesting NEW work not matching any task → guide user to /pilot-new-task
- If matches an existing ready task → suggest /pilot-next
- GOVERNANCE: Creating a task first ensures audit trail and approval workflow

Pilot AGI ensures governance over Claude Code for compliance.
</pilot-context>
```

### 3. Claude Evaluation

Claude reads the context and:
- Recognizes this is a governance-aware project
- Checks if the request matches existing tasks
- Guides user toward proper workflow
- Only proceeds with "shadow work" if explicitly okayed

---

## Task Matching Algorithm

The guardian uses keyword matching to find relevant tasks:

```javascript
// Extract keywords from prompt
"add a dark mode toggle" → ["dark", "mode", "toggle"]

// Match against task titles
"Implement theme switching" → matches "mode" → score: 1
"Add user preferences" → no matches → score: 0

// Return top 3 matches
```

This helps users discover that their request might already be tracked.

---

## Configuration

Enable/disable in `policy.yaml`:

```yaml
enforcement:
  detect_new_scope: true  # Enable semantic guardian
```

When enabled:
- All user prompts are evaluated
- Context is injected for uncertain prompts
- Claude guides toward workflow compliance

When disabled:
- Prompts pass through unchanged
- No governance overhead
- Suitable for quick prototyping

---

## Integration Points

### With Native Claude Code Features

The Semantic Guardian works alongside Claude Code's native features:

| Feature | Claude Code | Semantic Guardian |
|---------|------------|-------------------|
| Plan Mode | Exploration | Adds approval requirement |
| Task List | Task tracking | Suggests relevant tasks |
| Background Tasks | Parallel execution | Ensures task coverage |

### With Native Task List

When Claude's native Task List is used, the guardian:
1. Shows both bd tasks AND native tasks in context
2. Suggests creating bd tasks for governance tracking
3. Helps maintain single source of truth in bd

---

## Unique Value Proposition

**What Claude Code does**: AI-powered coding assistance

**What Semantic Guardian adds**:
- Governance (approval workflows)
- Compliance (audit trails)
- Coordination (multi-agent via bd)
- Context (project + task awareness)

This is the core of Pilot AGI's value: **we don't replace Claude Code, we govern it**.

---

## Files

- `.claude/pilot/hooks/user-prompt-submit.js` - Main hook
- `.claude/pilot/hooks/lib/cache.js` - Context building
- `.claude/pilot/hooks/lib/policy.js` - Policy loading
- `.claude/pilot/policy.yaml` - Configuration

---

*The Semantic Guardian is what makes Pilot AGI enterprise-ready.*
