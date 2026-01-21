/**
 * Unit Test Template for Functions
 *
 * Variables to replace:
 * - {{IMPORT_PATH}} - Path to the module being tested
 * - {{FUNCTION_NAME}} - Name of the function being tested
 * - {{FUNCTION_NAME_PASCAL}} - PascalCase version for describe block
 */

import { describe, it, expect, vi } from 'vitest'
import { {{FUNCTION_NAME}} } from '{{IMPORT_PATH}}'

describe('{{FUNCTION_NAME_PASCAL}}', () => {
  // Happy path tests
  describe('when given valid input', () => {
    it('should return expected result', () => {
      // Arrange
      const input = /* TODO: valid input */
      const expected = /* TODO: expected output */

      // Act
      const result = {{FUNCTION_NAME}}(input)

      // Assert
      expect(result).toEqual(expected)
    })

    it('should handle multiple valid inputs', () => {
      const testCases = [
        { input: /* TODO */, expected: /* TODO */ },
        { input: /* TODO */, expected: /* TODO */ },
        { input: /* TODO */, expected: /* TODO */ },
      ]

      testCases.forEach(({ input, expected }) => {
        expect({{FUNCTION_NAME}}(input)).toEqual(expected)
      })
    })
  })

  // Edge cases
  describe('edge cases', () => {
    it('should handle empty input', () => {
      // TODO: Test with empty/null/undefined
      expect({{FUNCTION_NAME}}(null)).toBe(/* expected */)
    })

    it('should handle boundary values', () => {
      // TODO: Test min/max values, empty arrays, etc.
    })
  })

  // Error cases
  describe('error handling', () => {
    it('should throw on invalid input', () => {
      expect(() => {{FUNCTION_NAME}}(/* invalid */)).toThrow()
    })

    it('should throw with descriptive message', () => {
      expect(() => {{FUNCTION_NAME}}(/* invalid */)).toThrow(/expected error message/)
    })
  })

  // Async functions (if applicable)
  describe('async behavior', () => {
    it('should resolve with expected value', async () => {
      const result = await {{FUNCTION_NAME}}(/* input */)
      expect(result).toEqual(/* expected */)
    })

    it('should reject on error', async () => {
      await expect({{FUNCTION_NAME}}(/* bad input */)).rejects.toThrow()
    })
  })
})
