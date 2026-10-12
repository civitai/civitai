import { expect, it } from 'vitest';

// A module whose evaluation throws inside a caught import still ran, and what it imported first
// shaped the result.
it('passes', async () => {
  await expect(import('./throws')).rejects.toThrow('never finishes loading (21)');
});
