import { describe, expect, it, vi } from 'vitest';

vi.mock('~/server/services/feature-flags.service', () => ({ getFeatureFlags: vi.fn() }));

import { isV1KnightsLive } from '~/server/games/new-order/v1-gate';
import { getFeatureFlags } from '~/server/services/feature-flags.service';

describe('isV1KnightsLive', () => {
  it('is true while newOrderGame is on', () => {
    vi.mocked(getFeatureFlags).mockReturnValue({ newOrderGame: true } as never);
    expect(isV1KnightsLive()).toBe(true);
  });

  it('is false when newOrderGame is off or absent from the sparse flag payload', () => {
    vi.mocked(getFeatureFlags).mockReturnValue({} as never);
    expect(isV1KnightsLive()).toBe(false);
  });
});
