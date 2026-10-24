import { expect, it } from 'vitest';

import { shim } from './factory-shim';

// Runs setup.ts's factory, which loads factory-dep.ts.
it('passes', () => {
  expect(shim).toBe('factory');
});
