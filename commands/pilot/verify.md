---
name: pilot:verify
description: Verify that implementation meets requirements. Runs tests, checks requirements, confirms phase completion. Use after /pilot:exec completes.
allowed-tools: Read, Bash, Glob, Grep
---

# Verify Implementation

You are verifying that the implementation meets requirements.

## Step 1: Load Context

Read:
- `.planning/plans/phase-{N}-plan.md` - The plan with requirements
- `.planning/STATE.md` - Current progress
- `.planning/PROJECT.md` - Original requirements

## Step 2: Run Tests

Execute the test commands specified in the plan:
```bash
# Run project tests
npm test  # or appropriate test command
```

Report results:
```
Test Results
────────────────────────────────────────────────────────────────
  Passed:  {X}
  Failed:  {Y}
  Skipped: {Z}
```

If tests fail:
```
⚠ Some tests failed. Review the failures before marking complete.

Failed tests:
- {test name}: {reason}

Options:
1. Fix failures and re-verify
2. Mark as partial completion
3. Investigate further
```

## Step 3: Check Requirements

Go through each requirement in the plan:

```
Requirement Checklist
────────────────────────────────────────────────────────────────
  [✓] Requirement 1 - Verified: {how}
  [✓] Requirement 2 - Verified: {how}
  [✗] Requirement 3 - Issue: {what's missing}
```

## Step 4: Verify Files Changed

List the files that were modified:
```
Files Modified
────────────────────────────────────────────────────────────────
  + path/to/new-file.ts (created)
  ~ path/to/modified.ts (modified)
  - path/to/removed.ts (deleted)
```

Compare against what the plan specified.

## Step 5: Report Verification

### If All Passed
```
════════════════════════════════════════════════════════════════
✓ Phase {N} Verification PASSED
════════════════════════════════════════════════════════════════

All requirements met:
- {X} tests passing
- {Y} requirements verified
- {Z} files modified as planned

Phase {N} is complete!

Next: /pilot:plan {N+1} to continue with the next phase.
```

Update STATE.md:
```markdown
## Current Position
- Phase: {N}
- Status: Complete

## Completed Phases
- [x] Phase {N}: {Name} - Verified {date}
```

### If Issues Found
```
════════════════════════════════════════════════════════════════
⚠ Phase {N} Verification INCOMPLETE
════════════════════════════════════════════════════════════════

Issues found:
- {Issue 1}
- {Issue 2}

Options:
1. Fix issues and re-run /pilot:verify
2. Accept partial completion
3. Return to /pilot:exec to address issues
```

## Important Rules
- Be thorough but fair in verification
- Don't fail verification for minor issues
- Distinguish between blockers and nice-to-haves
- Always suggest clear next steps
