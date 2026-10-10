import { expect, it } from 'vitest';

import { heavy } from './heavy';

// Loads heavy.ts for real, so the run's shared module graph carries heavy-dep.ts under it.
it('passes', () => {
  expect(heavy()).toBe(42);
});
