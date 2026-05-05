---
name: pilot-new-task
description: Create a new bd task from a description. Use when you have new work that needs to be tracked. Pairs with user-prompt-submit.js hook enforcement.
allowed-tools: Bash, Read, AskUserQuestion
---

# Create New Task

You are creating a new bd task to track work that needs to be done.

## When This Skill is Used

This skill is typically invoked when:
1. User-prompt-submit hook detected new scope and blocked direct implementation
2. User explicitly wants to create a new task
3. Work is discovered during implementation that should be a separate task

## Step 1: Understand the request

If the user already described what they want (e.g., in a blocked prompt), use that.

Otherwise, ask:

```
What would you like to work on?

Please describe:
1. What needs to be built or fixed
2. Why it's needed (context)
```

## Step 2: Classify the task type

Determine the type:
- **feat**: New feature or capability
- **fix**: Bug fix
- **refactor**: Code improvement without new features
- **test**: Adding or improving tests
- **docs**: Documentation changes
- **chore**: Maintenance, dependencies, etc.

## Step 3: Create the bd task

```bash
bd create "{title}" --description="{description}" --label "{type}"
```

Title format: `{verb} {what}` (imperative mood)
- Good: "Add user authentication", "Fix login redirect bug"
- Bad: "User authentication", "Login bug"

Example:
```bash
bd create "Add login page with OAuth support" \
  --description="Users need to sign in via Google OAuth. Include remember me checkbox and forgot password link." \
  --label "feat"
```

## Step 4: Link to milestone (optional)

If there's an active milestone, ask if the task should be linked:

```
Current milestone: {milestone name}

Should this task be part of this milestone?
- Yes, add to milestone
- No, standalone task
```

## Step 5: Display confirmation

```
╔══════════════════════════════════════════════════════════════╗
║  TASK CREATED                                                ║
╚══════════════════════════════════════════════════════════════╝

  ID:       {bd-xxxx}
  Title:    {title}
  Type:     {feat/fix/etc}
  Status:   Open

DESCRIPTION
────────────────────────────────────────────────────────────────
{description}
────────────────────────────────────────────────────────────────
```

## Step 6: Offer next steps

Use AskUserQuestion:

**Question**: "What would you like to do next?"

**Options**:
1. **Start implementation** - Claim task and create plan
2. **Create another task** - Add more tasks to the backlog
3. **View all tasks** - See the current backlog
4. **Done for now** - Return to conversation

If user picks "Start implementation":
1. Claim the task: `bd update {id} --status in_progress`
2. Proceed to planning (invoke pilot-plan behavior or guide user)

## Quick Mode

If user provides a clear, complete description, skip the questioning and create directly:

User: "Add a dark mode toggle to settings"
→ Create: `bd create "Add dark mode toggle to settings" --label "feat"`

## Important Rules

- Always use imperative mood for titles ("Add X" not "Adding X")
- Include enough context in description for future reference
- Don't create duplicate tasks - check if similar exists first
- Keep scope focused - one task = one deliverable
- If scope is too big, suggest breaking into multiple tasks
