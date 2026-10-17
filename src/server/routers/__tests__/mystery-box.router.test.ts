import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MysteryBoxService from '~/server/services/mystery-box.service';

/**
 * The kill switch and region block reach the open here: the router reads the `mysteryBox` flag and
 * the holder's country, and the service trusts what it is handed. Driven through `createCaller` so
 * the real procedure builds the arguments.
 */

const { mockOpen } = vi.hoisted(() => ({ mockOpen: vi.fn(async () => ({ replayed: false })) }));

vi.mock('~/server/services/mystery-box.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MysteryBoxService>()),
  openMysteryBox: mockOpen,
}));

import { mysteryBoxRouter } from '../mystery-box.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const holder = {
  id: 2,
  isModerator: false,
  tier: 'free',
  username: 'holder',
  onboarding: 0x1f,
  email: 'holder@example.com',
  emailVerified: new Date(),
};

const open = (
  features: Record<string, boolean>,
  headers: Record<string, string> = {},
  input: { boxItemId: string; expectedVersion: number } = { boxItemId: '501', expectedVersion: 3 }
) =>
  mysteryBoxRouter
    .createCaller({
      acceptableOrigin: true,
      user: holder,
      apiKeyId: null,
      tokenScope: TokenScope.Full,
      req: { headers } as never,
      res: { setHeader: () => undefined } as never,
      cache: { edgeTTL: 0 },
      features: features as never,
      track: undefined,
    } as never)
    .open(input);

describe('mysteryBox.open hands the service the flag, the country and the holder', () => {
  beforeEach(() => mockOpen.mockClear());

  it('passes the mysteryBox flag through, on and off', async () => {
    await open({ mysteryBox: true });
    await open({ mysteryBox: false });
    expect(
      mockOpen.mock.calls.map(([arg]) => (arg as { mysteryBoxEnabled?: boolean }).mysteryBoxEnabled)
    ).toEqual([true, false]);
  });

  it('passes the country from the request and the signed-in user', async () => {
    await open({ mysteryBox: true }, { 'cf-ipcountry': 'BE' });
    expect(mockOpen).toHaveBeenCalledWith({
      boxItemId: '501',
      expectedVersion: 3,
      userId: holder.id,
      mysteryBoxEnabled: true,
      countryCode: 'BE',
    });
  });

  it.each([['0'], ['-1'], ['1.5'], ['9223372036854775808'], ['abc']])(
    'refuses box id %s before the service',
    async (boxItemId) => {
      await expect(
        open({ mysteryBox: true }, {}, { boxItemId, expectedVersion: 3 })
      ).rejects.toThrow();
      expect(mockOpen).not.toHaveBeenCalled();
    }
  );

  it('accepts the largest BIGINT id', async () => {
    await open({ mysteryBox: true }, {}, { boxItemId: '9223372036854775807', expectedVersion: 3 });
    expect(mockOpen).toHaveBeenCalledTimes(1);
  });
});
