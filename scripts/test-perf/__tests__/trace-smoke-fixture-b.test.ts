/** Second fixture — see trace-smoke-fixture.test.ts. `trace-flush.test.ts` traces the three
 *  fixtures together on a THREAD pool, where every worker shares one pid, to prove that two
 *  workers cannot overwrite each other's snapshot. Kept trivial on purpose. */
import { describe, expect, it } from 'vitest';

describe('trace smoke fixture b', () => {
  it('exists so a traced run can occupy a second worker', () => {
    expect(true).toBe(true);
  });
});
