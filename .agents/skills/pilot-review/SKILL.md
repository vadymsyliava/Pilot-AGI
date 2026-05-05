---
name: pilot-review
description: Quick code review checklist for recent changes. Focuses on diff, checks for common issues, canonical violations, and missing tests. Use before or after committing.
allowed-tools: Read, Bash, Glob, Grep
---

# Code Review

You are performing a quick code review of recent changes.

## Step 1: Get the diff

```bash
git diff HEAD~1  # or git diff if uncommitted
```

## Step 2: Run review checklist

Go through each item:

```
╔══════════════════════════════════════════════════════════════╗
║  CODE REVIEW                                                 ║
╚══════════════════════════════════════════════════════════════╝

FUNCTIONALITY
────────────────────────────────────────────────────────────────
  [ ] Changes match the stated goal
  [ ] Edge cases handled
  [ ] Error handling present where needed

CODE QUALITY
────────────────────────────────────────────────────────────────
  [ ] Follows existing patterns in codebase
  [ ] No code duplication introduced
  [ ] No unused imports/variables
  [ ] Clear naming conventions

SECURITY
────────────────────────────────────────────────────────────────
  [ ] No hardcoded secrets/credentials
  [ ] Input validation where needed
  [ ] No SQL injection / XSS vulnerabilities

TESTS
────────────────────────────────────────────────────────────────
  [ ] Tests added for new functionality
  [ ] Existing tests still pass
  [ ] Edge cases covered

CANONICAL COMPLIANCE
────────────────────────────────────────────────────────────────
  [ ] Matches patterns in work/specs/
  [ ] No reinventing existing solutions
```

## Step 3: Check for canonical patterns

Search for similar existing code:
```bash
# Look for patterns that might already exist
```

If the change duplicates existing functionality, flag it:
```
⚠ Potential duplicate of existing pattern

Found similar code in: {file}:{line}
Consider: Refactoring to use existing {pattern}
```

## Step 4: Report findings

```
REVIEW SUMMARY
════════════════════════════════════════════════════════════════

  Status: {PASS / CONCERNS}

  ✓ {passing item}
  ✓ {passing item}
  ⚠ {concern: description}
  ✗ {issue: description}

{If concerns or issues:}
RECOMMENDATIONS
────────────────────────────────────────────────────────────────
  1. {recommendation}
  2. {recommendation}

────────────────────────────────────────────────────────────────
Next:
  • Address concerns before proceeding
  • /pilot-commit if not yet committed
  • /pilot-exec to continue
  • /pilot-close if task complete
```

## Step 5: Update session capsule

Append to `runs/YYYY-MM-DD.md`:

```markdown
### Review: {HH:MM}
- Status: {PASS/CONCERNS}
- Issues: {list if any}
```

## Important Rules
- Be thorough but not pedantic
- Focus on the diff, not unrelated code
- Flag security issues immediately
- Suggest, don't demand (user makes final call)
- Check canonical patterns before flagging duplication
