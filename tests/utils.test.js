import { describe, it, expect } from 'vitest';
import { newHelper } from '../src/utils.js';

describe('newHelper', () => {
  it('doubles input', () => {
    expect(newHelper(5)).toBe(10);
  });
});
