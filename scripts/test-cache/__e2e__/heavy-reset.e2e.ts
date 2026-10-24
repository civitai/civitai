import { afterEach, expect, it, vi } from 'vitest';

import { heavy } from './heavy';
import { sibling } from './sibling';

// vi.resetModules() clears every module's evaluated state before the cache tracker reads it, the
// shape of 57 real test files. heavy.ts must still count as loaded, and sibling.ts, which this file
// factory-mocks, must still not.
vi.mock('./sibling', () => ({ sibling: () => 1 }));

afterEach(() => {
  vi.resetModules();
});

it('passes', () => {
  expect(heavy()).toBe(42);
  expect(sibling()).toBe(1);
});
