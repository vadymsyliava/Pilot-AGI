---
name: pilot-test
description: Generate tests for functions, components, and user flows. Supports unit tests (Vitest), integration tests, and E2E tests (Playwright).
argument-hint: [target - file path, function name, or "coverage" to analyze gaps]
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion
---

# Test Generator

Generate tests for code. Be PROACTIVE - analyze what needs testing and generate appropriate tests.

## Templates Location

Templates are in `.claude/pilot/templates/testing/`:
- `vitest.config.template.ts` - Vitest configuration
- `setup.template.ts` - Test setup file
- `unit-test.template.ts` - Unit test for functions
- `component-test.template.tsx` - React component tests
- `playwright.config.template.ts` - Playwright configuration
- `e2e-test.template.ts` - E2E test flows

## Arguments

`$ARGUMENTS` can be:
- Empty - Suggest what to test based on context
- File path - Generate tests for that file
- Function/component name - Generate tests for that item
- `coverage` - Analyze coverage gaps
- `setup` - Initialize testing infrastructure

## Flow

### Step 1: Check testing infrastructure

```bash
cat package.json 2>/dev/null | grep -E '"vitest"|"playwright"' | head -5
ls tests/ test/ __tests__/ 2>/dev/null | head -5
```

If not configured, offer to set up using templates.

### Step 2: Determine test type

| Target | Test Type | Template |
|--------|-----------|----------|
| Utility function | Unit test | unit-test.template.ts |
| React component | Component test | component-test.template.tsx |
| User flow | E2E test | e2e-test.template.ts |
| API endpoint | Integration test | unit-test.template.ts |

### Step 3: Read the template

```bash
cat .claude/pilot/templates/testing/{template-name}
```

### Step 4: Generate test by replacing variables

Replace placeholders in template:
- `{{IMPORT_PATH}}` - Path to module
- `{{FUNCTION_NAME}}` - Function name
- `{{COMPONENT_NAME}}` - Component name
- `{{FLOW_NAME}}` - E2E flow name

### Step 5: Present and confirm

Show generated test, offer:
1. **Save & run** - Write and execute
2. **Save only** - Write without running
3. **Modify** - Adjust before saving
4. **Discard** - Try different approach

## Setup Command

When `$ARGUMENTS` is `setup`:

1. Copy `vitest.config.template.ts` to project root
2. Copy `setup.template.ts` to `tests/setup.ts`
3. Add scripts to package.json:
   ```json
   "test": "vitest",
   "test:coverage": "vitest run --coverage",
   "test:e2e": "playwright test"
   ```
4. Install dependencies

## Coverage Command

When `$ARGUMENTS` is `coverage`:

```bash
npm run test:coverage 2>/dev/null
```

Parse results, identify files below 80%, suggest tests.

## Important Rules

1. Be proactive - offer actions, not commands
2. Use templates from `.claude/pilot/templates/testing/`
3. Generate runnable tests, not pseudocode
4. Follow project conventions
5. Test behavior, not implementation
