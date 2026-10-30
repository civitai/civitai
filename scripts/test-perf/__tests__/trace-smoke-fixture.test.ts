/**
 * Fixture, not a real test. `trace-flush.test.ts` spawns a traced vitest run against THIS file and
 * asserts a snapshot lands on disk, so the file has to be a real member of the `unit` project
 * (matched by its `scripts/**\/*.test.ts` include) and has to be cheap to import — the point is to
 * exercise the tracer's flush path, not anything in the app graph.
 *
 * It costs one trivial assertion in the normal suite. That is the price of the traced run having
 * something to trace.
 */
import { describe, expect, it } from 'vitest';

import { tracedFixtureMarker } from '../trace-smoke-fixture-module';

describe('trace smoke fixture', () => {
  it('imports a first-party module so the tracer has a body to bracket', () => {
    expect(tracedFixtureMarker).toBe('traced');
  });
});
