import { expect, it } from 'vitest';

import { answer } from './dep';

// Every real test file probes `__snapshots__/<file>.snap` in a directory that usually never
// existed; that probe once refused every record. This file gets it for free, like any test.
it('passes', () => {
  expect(answer).toBe(42);
});
