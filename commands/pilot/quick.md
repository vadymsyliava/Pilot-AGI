---
name: pilot:quick
description: Handle ad-hoc tasks without full planning cycle. For bug fixes, small features, config changes. Use for tasks that don't warrant a full phase.
argument-hint: [task description]
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Quick Task

You are handling an ad-hoc task without full planning overhead.

## Arguments
- `$ARGUMENTS` contains the task description

## Step 1: Understand Task

Parse the task description and identify:
- What needs to be done
- Which files are likely involved
- Expected outcome

```
Quick Task
────────────────────────────────────────────────────────────────
Task: {parsed task description}
```

## Step 2: Investigate

Quickly investigate the codebase to understand:
- Where the change needs to happen
- What existing patterns to follow
- Any potential impacts

Keep investigation brief - this is a quick task.

## Step 3: Implement

Make the changes:
1. Keep changes minimal and focused
2. Follow existing code patterns
3. Don't scope creep - stick to what was asked

## Step 4: Verify

Run relevant tests or verification:
```bash
npm test  # or appropriate command
```

Quick manual verification:
- Does the change work as expected?
- Are there any obvious issues?

## Step 5: Commit

Create an atomic commit:
```bash
git add -A
git commit -m "fix: {brief description}"
```

Use appropriate commit type:
- `fix:` for bug fixes
- `feat:` for small features
- `chore:` for config/maintenance
- `docs:` for documentation

## Step 6: Report

```
════════════════════════════════════════════════════════════════
✓ Quick Task Complete
════════════════════════════════════════════════════════════════

Task: {description}
Changes:
- {file}: {what changed}

Commit: {commit hash}

{Any notes or follow-up suggestions}
```

## Step 7: Log (Optional)

If `.planning/` exists, append to STATE.md:
```markdown
## Recent Quick Tasks
- [{date}] {task description} - {commit hash}
```

## Important Rules
- Keep it quick - don't over-engineer
- If task is too complex, suggest using /pilot:plan instead
- Always commit changes
- Don't break existing functionality
- Ask for clarification if task is ambiguous
