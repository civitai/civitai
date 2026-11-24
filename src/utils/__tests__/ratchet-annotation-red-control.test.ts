import { describe, expect, it } from 'vitest';

// Throwaway red control for the typecheck-tests ratchet annotations. Never merge.
describe('ratchet annotation red control', () => {
  it('has a deliberate type error', () => {
    const n: number = 'not a number';
    expect(n).toBeDefined();
  });
});
