import { describe, expect, it } from 'vitest';

// Throwaway red control for the github-actions vitest reporter. Never merged.
describe('annotation red control', () => {
  it('fails on purpose so the reporter annotates it', () => {
    expect(1 + 1).toBe(3);
  });
});
