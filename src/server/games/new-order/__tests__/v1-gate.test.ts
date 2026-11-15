import { describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

const { isFlipt } = vi.hoisted(() => ({ isFlipt: vi.fn() }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt,
}));

import { isV1KnightsLive } from '~/server/games/new-order/v1-gate';

describe('isV1KnightsLive', () => {
  it('is over once the Knights app flag is on for an anonymous entity', async () => {
    isFlipt.mockResolvedValue(true);
    expect(await isV1KnightsLive()).toBe(false);
    expect(isFlipt).toHaveBeenCalledWith('knights-of-new-order-app', 'anonymous');
  });

  it('is live while the flag is off or only a tester segment has it', async () => {
    isFlipt.mockResolvedValue(false);
    expect(await isV1KnightsLive()).toBe(true);
  });

  it('stays live when Flipt errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    isFlipt.mockRejectedValue(new Error('flipt down'));
    expect(await isV1KnightsLive()).toBe(true);
  });
});
