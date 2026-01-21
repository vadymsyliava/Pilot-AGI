---
name: pilot-test
description: Generate tests for functions, components, and user flows. Supports unit tests (Vitest), integration tests, and E2E tests (Playwright).
argument-hint: [target - file path, function name, or "coverage" to analyze gaps]
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion
---

# Test Generator

You generate tests for code. Be PROACTIVE - analyze what needs testing and generate appropriate tests.

## Core Principle: Action-Oriented

Don't ask the user to run commands. Analyze, generate, and offer to run tests.

## Arguments

`$ARGUMENTS` can be:
- Empty - Analyze current task context and suggest what to test
- File path - Generate tests for that file
- Function/component name - Generate tests for that specific item
- `coverage` - Analyze coverage gaps and suggest tests

## Step 1: Detect Test Context

### 1.1: Check testing infrastructure

```bash
# Check if Vitest is configured
cat package.json 2>/dev/null | grep -E '"vitest"|"@vitest"' | head -3

# Check if Playwright is configured
cat package.json 2>/dev/null | grep -E '"playwright"|"@playwright"' | head -3

# Check test directories
ls -la tests/ test/ __tests__/ src/**/*.test.* src/**/*.spec.* 2>/dev/null | head -10
```

### 1.2: If no test infrastructure

```
╔══════════════════════════════════════════════════════════════╗
║  NO TEST INFRASTRUCTURE DETECTED                             ║
╚══════════════════════════════════════════════════════════════╝

This project doesn't have Vitest or Playwright configured yet.
```

Use AskUserQuestion:

**Question**: "Set up testing infrastructure first?"

**Options**:
1. **Set up Vitest** - For unit and integration tests
2. **Set up Playwright** - For E2E tests
3. **Set up both** - Full testing stack
4. **Skip for now** - Generate test files anyway (won't run)

Handle setup automatically if chosen.

## Step 2: Analyze Target

### 2.1: If argument is a file path

Read the file and identify:
- Functions that need testing
- Components that need testing
- Exports that need testing

```bash
# Example: analyze a TypeScript file
```

### 2.2: If argument is empty

Check current task context from bd:
```bash
bd issues --status in_progress --json 2>/dev/null
```

Look at recently modified files:
```bash
git diff --name-only HEAD~5 2>/dev/null | grep -E '\.(ts|tsx|js|jsx)$' | head -10
```

### 2.3: If argument is "coverage"

```bash
# Run coverage and parse results
npm run test:coverage 2>/dev/null || npx vitest run --coverage 2>/dev/null
```

Identify files with <80% coverage and suggest tests.

## Step 3: Determine Test Type

Based on analysis:

| File Type | Test Type | Framework |
|-----------|-----------|-----------|
| Utility function | Unit test | Vitest |
| React component | Component test | Vitest + Testing Library |
| API route | Integration test | Vitest |
| User flow | E2E test | Playwright |
| Hook | Hook test | Vitest + renderHook |

## Step 4: Generate Tests

### 4.1: Unit Test Template (Vitest)

For a function like `src/lib/utils.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { functionName } from '../src/lib/utils'

describe('functionName', () => {
  it('should handle normal input', () => {
    const result = functionName(input)
    expect(result).toBe(expected)
  })

  it('should handle edge case', () => {
    const result = functionName(edgeInput)
    expect(result).toBe(edgeExpected)
  })

  it('should throw on invalid input', () => {
    expect(() => functionName(invalidInput)).toThrow()
  })
})
```

### 4.2: Component Test Template (Vitest + Testing Library)

For a React component:

```typescript
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ComponentName } from '../src/components/ComponentName'

describe('ComponentName', () => {
  it('renders correctly', () => {
    render(<ComponentName />)
    expect(screen.getByRole('button')).toBeInTheDocument()
  })

  it('handles click events', async () => {
    const onClick = vi.fn()
    render(<ComponentName onClick={onClick} />)

    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('displays props correctly', () => {
    render(<ComponentName title="Test" />)
    expect(screen.getByText('Test')).toBeInTheDocument()
  })
})
```

### 4.3: Integration Test Template

For an API endpoint:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from '../src/server'

describe('API: /api/resource', () => {
  let server

  beforeAll(async () => {
    server = await createServer()
  })

  afterAll(async () => {
    await server.close()
  })

  it('GET returns list of resources', async () => {
    const response = await fetch('/api/resource')
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(Array.isArray(data)).toBe(true)
  })

  it('POST creates new resource', async () => {
    const response = await fetch('/api/resource', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test' })
    })

    expect(response.status).toBe(201)
  })
})
```

### 4.4: E2E Test Template (Playwright)

For a user flow:

```typescript
import { test, expect } from '@playwright/test'

test.describe('User Flow: Authentication', () => {
  test('user can log in', async ({ page }) => {
    await page.goto('/login')

    await page.fill('[name="email"]', 'test@example.com')
    await page.fill('[name="password"]', 'password123')
    await page.click('button[type="submit"]')

    await expect(page).toHaveURL('/dashboard')
    await expect(page.getByText('Welcome')).toBeVisible()
  })

  test('user can log out', async ({ page }) => {
    // Assume logged in
    await page.goto('/dashboard')
    await page.click('[data-testid="logout-button"]')

    await expect(page).toHaveURL('/login')
  })
})
```

## Step 5: Present Generated Tests

Display the generated test:

```
╔══════════════════════════════════════════════════════════════╗
║  GENERATED TEST                                              ║
╚══════════════════════════════════════════════════════════════╝

FILE: tests/unit/utils.test.ts
TYPE: Unit Test (Vitest)

────────────────────────────────────────────────────────────────
{test code}
────────────────────────────────────────────────────────────────
```

Use AskUserQuestion:

**Question**: "What would you like to do with this test?"

**Options**:
1. **Save & run** - Write file and execute test
2. **Save only** - Write file without running
3. **Modify** - Adjust the test before saving
4. **Discard** - Don't save, try different approach

## Step 6: Run Tests (if chosen)

```bash
# Run the specific test
npx vitest run tests/unit/utils.test.ts

# Or for Playwright
npx playwright test tests/e2e/auth.spec.ts
```

Report results:

```
╔══════════════════════════════════════════════════════════════╗
║  TEST RESULTS                                                ║
╚══════════════════════════════════════════════════════════════╝

  ✓ 3 tests passed
  ✗ 1 test failed

FAILURES
────────────────────────────────────────────────────────────────
  • functionName > should handle edge case
    Expected: true
    Received: false
────────────────────────────────────────────────────────────────
```

Use AskUserQuestion:

**Question**: "Test failed. What next?"

**Options**:
1. **Fix the code** - The implementation has a bug
2. **Fix the test** - The test expectation is wrong
3. **Skip for now** - Move on, fix later

## Step 7: Coverage Report

If running coverage analysis:

```
╔══════════════════════════════════════════════════════════════╗
║  COVERAGE REPORT                                             ║
╚══════════════════════════════════════════════════════════════╝

SUMMARY
────────────────────────────────────────────────────────────────
  Statements: 78% (target: 80%)
  Branches:   65% (target: 80%)
  Functions:  82% (target: 80%)
  Lines:      79% (target: 80%)

FILES BELOW TARGET
────────────────────────────────────────────────────────────────
  src/lib/utils.ts         45%  ← needs tests
  src/components/Form.tsx  62%  ← needs tests
  src/hooks/useAuth.ts     70%  ← close to target
────────────────────────────────────────────────────────────────
```

Use AskUserQuestion:

**Question**: "Generate tests for uncovered files?"

**Options**:
1. **Generate all** - Create tests for all files below target
2. **Pick files** - Let me choose which files
3. **Skip** - I'll handle coverage later

## Important Rules

1. **Be proactive** - Don't wait for commands, offer actions
2. **Generate runnable tests** - Not pseudocode
3. **Follow project conventions** - Match existing test style
4. **Test behavior, not implementation** - Focus on what, not how
5. **Include edge cases** - Empty, null, error states
6. **Keep tests focused** - One concept per test
