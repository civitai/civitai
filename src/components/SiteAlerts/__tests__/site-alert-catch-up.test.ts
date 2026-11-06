import { describe, expect, it } from 'vitest';
import { catchUpInterval } from '~/components/SiteAlerts/SiteAlertStrips';

const state = (version: number | undefined, dataUpdateCount = 1, errorUpdateCount = 0) => ({
  data: version === undefined ? undefined : { version },
  dataUpdateCount,
  errorUpdateCount,
});

describe('catchUpInterval', () => {
  it('asks again while the answer is older than the version the browser saw', () => {
    expect(catchUpInterval(state(4), 5)).toBe(3_000);
  });

  it('stops once the answer is current, or before there is one', () => {
    expect(catchUpInterval(state(5), 5)).toBe(false);
    expect(catchUpInterval(state(undefined, 0), 5)).toBe(false);
  });

  // A version that went backwards never catches up; without the cap every open tab would poll
  // the origin every 3 s until the next save.
  it('gives up after a few attempts, counting failed ones', () => {
    expect(catchUpInterval(state(0, 4, 0), 5)).toBe(3_000);
    expect(catchUpInterval(state(0, 5, 0), 5)).toBe(false);
    expect(catchUpInterval(state(0, 2, 3), 5)).toBe(false);
  });
});
