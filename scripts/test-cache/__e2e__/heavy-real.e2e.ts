import { expect, it } from 'vitest';

import { heavy } from './heavy';
import { sibling } from './sibling';

// Loads heavy.ts and sibling.ts for real, so the run's shared module graph carries heavy-dep.ts and
// sibling-dep.ts under them.
it('passes', () => {
  expect(heavy()).toBe(42);
  expect(sibling()).toBe(7);
});
