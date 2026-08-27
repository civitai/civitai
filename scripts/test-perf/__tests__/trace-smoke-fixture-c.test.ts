/** Third fixture — see trace-smoke-fixture.test.ts. Three files is the smallest number that makes
 *  a lost snapshot unambiguous: with two, a scheduler that hands both to one worker looks the same
 *  as an overwrite. Kept trivial on purpose. */
import { describe, expect, it } from 'vitest';

describe('trace smoke fixture c', () => {
  it('exists so a traced run can occupy a third worker', () => {
    expect(true).toBe(true);
  });
});
