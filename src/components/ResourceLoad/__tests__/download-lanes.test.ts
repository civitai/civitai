import { describe, expect, it } from 'vitest';
import { formatLaneSpeed } from '~/components/ResourceLoad/download-lanes';

describe('formatLaneSpeed', () => {
  it('reports a cap it was given', () => {
    expect(formatLaneSpeed(20_000_000, 'low')).toBe('up to 160 Mbps');
  });

  it('says nothing when the cap was not reported', () => {
    expect(formatLaneSpeed(undefined, 'low')).toBeUndefined();
    expect(formatLaneSpeed(undefined, 'high')).toBeUndefined();
  });

  it('reads null as uncapped only on the boosted lane', () => {
    expect(formatLaneSpeed(null, 'high')).toBe('no speed cap');
  });

  // Calling an absent figure "no speed cap" on the free lane advertises the slowest lane as the
  // fastest — the one string in this component that must never appear there.
  it('does not call a slower lane uncapped when its rate is absent', () => {
    expect(formatLaneSpeed(null, 'low')).toBeUndefined();
    expect(formatLaneSpeed(null, 'normal')).toBeUndefined();
    expect(formatLaneSpeed(null, undefined)).toBeUndefined();
  });
});
