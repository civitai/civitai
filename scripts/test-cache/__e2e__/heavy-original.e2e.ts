import { expect, it, vi } from 'vitest';

import type * as Heavy from './heavy';
import { heavy } from './heavy';

// A factory that calls importOriginal runs the real heavy.ts, so heavy-dep.ts must be keyed.
vi.mock('./heavy', async (importOriginal) => ({
  ...(await importOriginal<typeof Heavy>()),
  extra: 1,
}));

it('passes', () => {
  expect(heavy()).toBe(42);
});
