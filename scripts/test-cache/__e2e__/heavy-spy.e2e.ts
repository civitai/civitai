import { expect, it, vi } from 'vitest';

import { heavy } from './heavy';

// { spy: true } runs the real heavy.ts, under a `mock:` id rather than its own.
vi.mock('./heavy', { spy: true });

it('passes', () => {
  expect(heavy()).toBe(42);
  expect(vi.isMockFunction(heavy)).toBe(true);
});
