/**
 * E2E Test Template (Playwright)
 *
 * Variables to replace:
 * - {{FLOW_NAME}} - Name of the user flow being tested
 * - {{BASE_URL}} - Starting URL for the flow
 */

import { test, expect, type Page } from '@playwright/test'

test.describe('{{FLOW_NAME}}', () => {
  // Run before each test in this describe block
  test.beforeEach(async ({ page }) => {
    // Navigate to starting point
    await page.goto('{{BASE_URL}}')
  })

  test('should complete the happy path', async ({ page }) => {
    // Step 1: Initial state
    await expect(page).toHaveTitle(/Expected Title/)
    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible()

    // Step 2: User action
    await page.getByRole('button', { name: 'Get Started' }).click()

    // Step 3: Fill form
    await page.getByLabel('Email').fill('test@example.com')
    await page.getByLabel('Password').fill('password123')

    // Step 4: Submit
    await page.getByRole('button', { name: 'Submit' }).click()

    // Step 5: Verify result
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByText('Welcome back')).toBeVisible()
  })

  test('should handle validation errors', async ({ page }) => {
    // Submit empty form
    await page.getByRole('button', { name: 'Submit' }).click()

    // Check for error messages
    await expect(page.getByText('Email is required')).toBeVisible()
    await expect(page.getByText('Password is required')).toBeVisible()
  })

  test('should handle server errors gracefully', async ({ page }) => {
    // Mock server error
    await page.route('**/api/endpoint', (route) => {
      route.fulfill({
        status: 500,
        body: JSON.stringify({ error: 'Internal server error' }),
      })
    })

    // Trigger the request
    await page.getByRole('button', { name: 'Submit' }).click()

    // Verify error handling UI
    await expect(page.getByText('Something went wrong')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  })

  test('should be responsive on mobile', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 })

    // Verify mobile layout
    await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible()

    // Open mobile menu
    await page.getByRole('button', { name: 'Menu' }).click()
    await expect(page.getByRole('navigation')).toBeVisible()
  })

  test('should be accessible', async ({ page }) => {
    // Check for accessible elements
    await expect(page.getByRole('main')).toBeVisible()
    await expect(page.getByRole('navigation')).toBeVisible()

    // Verify form labels
    await expect(page.getByLabel('Email')).toBeVisible()

    // Check keyboard navigation
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()
  })
})

// Authentication flow template
test.describe('Authentication', () => {
  test('user can sign up', async ({ page }) => {
    await page.goto('/signup')

    await page.getByLabel('Email').fill('newuser@example.com')
    await page.getByLabel('Password').fill('securepassword123')
    await page.getByLabel('Confirm Password').fill('securepassword123')
    await page.getByRole('button', { name: 'Create Account' }).click()

    await expect(page).toHaveURL(/\/welcome/)
  })

  test('user can log in', async ({ page }) => {
    await page.goto('/login')

    await page.getByLabel('Email').fill('existing@example.com')
    await page.getByLabel('Password').fill('password123')
    await page.getByRole('button', { name: 'Log In' }).click()

    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByText('Welcome back')).toBeVisible()
  })

  test('user can log out', async ({ page }) => {
    // Assume logged in state (use auth fixture in real tests)
    await page.goto('/dashboard')

    await page.getByRole('button', { name: 'Account' }).click()
    await page.getByRole('menuitem', { name: 'Log out' }).click()

    await expect(page).toHaveURL(/\/login/)
  })
})

// CRUD operations template
test.describe('Resource Management', () => {
  test('can create a new item', async ({ page }) => {
    await page.goto('/items')

    await page.getByRole('button', { name: 'Add Item' }).click()
    await page.getByLabel('Name').fill('New Item')
    await page.getByRole('button', { name: 'Save' }).click()

    await expect(page.getByText('New Item')).toBeVisible()
  })

  test('can edit an existing item', async ({ page }) => {
    await page.goto('/items')

    await page.getByRole('row', { name: /Existing Item/ }).getByRole('button', { name: 'Edit' }).click()
    await page.getByLabel('Name').clear()
    await page.getByLabel('Name').fill('Updated Item')
    await page.getByRole('button', { name: 'Save' }).click()

    await expect(page.getByText('Updated Item')).toBeVisible()
  })

  test('can delete an item', async ({ page }) => {
    await page.goto('/items')

    await page.getByRole('row', { name: /Item to Delete/ }).getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('button', { name: 'Confirm' }).click()

    await expect(page.getByText('Item to Delete')).not.toBeVisible()
  })
})
