---
name: pilot-commit
description: Create a small, conventional commit for the current micro-step. Links commit to bd issue ID. Use after each verified step.
allowed-tools: Bash, Read
---

# Create Commit

You are creating a conventional commit for the current micro-step.

## Step 1: Get current context

Read session capsule to find:
- Current bd task ID
- Current step name
- Files changed

```bash
git status
git diff --staged
```

## Step 2: Stage changes

If changes aren't staged:
```bash
git add -A
```

## Step 3: Generate commit message

Format: `type(scope): description [bd-xxxx]`

**Types:**
- `feat:` - New feature
- `fix:` - Bug fix
- `refactor:` - Code restructuring
- `test:` - Adding tests
- `docs:` - Documentation
- `chore:` - Maintenance

**Scope:** Module or area affected

**Description:** What this step accomplished (imperative mood)

**Footer:** Always include bd issue ID

Example:
```
feat(auth): add JWT validation middleware [bd-a1b2]
```

## Step 4: Preview commit

Display:
```
╔══════════════════════════════════════════════════════════════╗
║  COMMIT PREVIEW                                              ║
╚══════════════════════════════════════════════════════════════╝

  Message:
    {type}({scope}): {description} [{bd-id}]

  Files:
    {staged files list}

  Diff summary:
    {insertions} insertions, {deletions} deletions

────────────────────────────────────────────────────────────────
Create this commit? (yes / no / edit message)
```

## Step 5: Create commit

```bash
git commit -m "{commit message}"
```

## Step 6: Update session capsule

Append to `runs/YYYY-MM-DD.md`:

```markdown
### Commit: {HH:MM}
- Hash: {short hash}
- Message: {commit message}
- Files: {N} changed
```

## Step 7: Report

```
────────────────────────────────────────────────────────────────
✓ Committed: {short hash}

  {commit message}

Next:
  • /pilot-exec to continue with next step
  • /pilot-review for code review
  • /pilot-close if task is complete
────────────────────────────────────────────────────────────────
```

## Important Rules
- One commit per micro-step (atomic commits)
- Always include bd issue ID in commit message
- Use conventional commit format
- Never commit secrets or credentials
- Review diff before committing
