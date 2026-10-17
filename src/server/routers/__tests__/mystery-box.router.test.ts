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
import { openMysteryBoxInput } from '~/server/schema/mystery-box.schema';
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
  input: { boxItemId: string; expectedVersion: number } = { boxItemId: '501', expectedVersion: 3 },
  ctx: { user?: typeof holder | null; apiKeyId?: number | null } = {}
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
      ...ctx,
    } as never)
    .open(input);

const rejectsWithCode = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toMatchObject({ code });
};

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

  it.each([['0'], ['-1'], ['1.5'], ['9223372036854775808'], ['99999999999999999999'], ['abc']])(
    'refuses box id %s as a bad request, before the service',
    async (boxItemId) => {
      await rejectsWithCode(
        open({ mysteryBox: true }, {}, { boxItemId, expectedVersion: 3 }),
        'BAD_REQUEST'
      );
      expect(mockOpen).not.toHaveBeenCalled();
    }
  );

  it.each([[0], [-1], [1.5]])('refuses expected version %s', async (expectedVersion) => {
    await rejectsWithCode(
      open({ mysteryBox: true }, {}, { boxItemId: '501', expectedVersion }),
      'BAD_REQUEST'
    );
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it.each([['1.5'], ['abc'], ['99999999999999999999']])(
    'the schema answers box id %s with an issue, not a thrown error',
    (boxItemId) => {
      // zod runs the refine even after the regex fails, so a BigInt() there would throw.
      expect(openMysteryBoxInput.safeParse({ boxItemId, expectedVersion: 3 }).success).toBe(false);
    }
  );

  it('accepts the largest BIGINT id', async () => {
    await open({ mysteryBox: true }, {}, { boxItemId: '9223372036854775807', expectedVersion: 3 });
    expect(mockOpen).toHaveBeenCalledTimes(1);
  });

  it('refuses a signed-out caller and an API key', async () => {
    await rejectsWithCode(
      open({ mysteryBox: true }, {}, undefined, { user: null }),
      'UNAUTHORIZED'
    );
    await rejectsWithCode(open({ mysteryBox: true }, {}, undefined, { apiKeyId: 7 }), 'FORBIDDEN');
    expect(mockOpen).not.toHaveBeenCalled();
  });
});
