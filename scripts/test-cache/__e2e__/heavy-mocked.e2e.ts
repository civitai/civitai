import { expect, it, vi } from 'vitest';

import { heavy } from './heavy';

// Replaces heavy.ts with a factory, so heavy-dep.ts never loads here, whatever the sibling
// heavy-real.e2e.ts attached to heavy.ts in the shared graph.
vi.mock('./heavy', () => ({ heavy: () => 1 }));

it('passes', () => {
  expect(heavy()).toBe(1);
});
