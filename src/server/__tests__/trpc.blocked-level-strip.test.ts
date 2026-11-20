import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { publicProcedure, router } from '~/server/trpc';
import { getRequestBrowsingLevel, getServerBrowsingLevel } from '~/server/utils/browsing-level';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * The shared procedure middleware, driven through a real router: the Blocked bit reaches a
 * procedure's input only when a moderator sent it.
 */

const ALL = NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R | NsfwLevel.X | NsfwLevel.XXX;

const echo = router({
  levels: publicProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(z.object({ browsingLevel: z.number(), preCapBrowsingLevel: z.number().optional() }))
    .query(({ input }) => input),
});

const caller = (isModerator: boolean, signedIn = true) =>
  echo.createCaller({
    acceptableOrigin: true,
    user: signedIn
      ? { id: 7, isModerator, showNsfw: true, browsingLevel: ALL, onboarding: 0xff }
      : undefined,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: true },
    track: undefined,
  } as never);

describe('getRequestBrowsingLevel, from the saved level', () => {
  const saved = (isModerator: boolean, browsingLevel: number) =>
    getRequestBrowsingLevel({
      features: { canViewNsfw: true },
      user: { id: 7, isModerator, showNsfw: true, browsingLevel },
    } as never);

  it('keeps a saved level made of browsing bits (control)', () => {
    expect(saved(false, 13)).toBe(13);
  });

  it("drops the Blocked bit from a non-moderator's saved level", () => {
    expect(saved(false, 63)).toBe(31);
  });

  it("keeps the Blocked bit in a moderator's saved level", () => {
    expect(saved(true, 63)).toBe(63);
  });
});

describe('getServerBrowsingLevel, as SSR and direct callers read it', () => {
  const ssr = (isModerator: boolean, browsingLevel: number) =>
    getServerBrowsingLevel({
      canViewNsfw: true,
      user: { showNsfw: true, browsingLevel, isModerator },
    });

  it("drops the Blocked bit from a non-moderator's saved level, and keeps a moderator's", () => {
    expect(ssr(false, 63)).toBe(31);
    expect(ssr(true, 63)).toBe(63);
  });

  it('falls back to PG when only the Blocked bit was saved', () => {
    expect(ssr(false, NsfwLevel.Blocked)).toBe(NsfwLevel.PG);
  });
});

describe('procedure input browsing levels, signed in where mature content is allowed', () => {
  it('keeps a level made of browsing bits as sent (control)', async () => {
    expect(await caller(false).levels({ browsingLevel: 13 })).toEqual({ browsingLevel: 13 });
  });

  it('drops the Blocked bit a non-moderator sent, from both levels', async () => {
    expect(await caller(false).levels({ browsingLevel: 63, preCapBrowsingLevel: 63 })).toEqual({
      browsingLevel: 31,
      preCapBrowsingLevel: 31,
    });
  });

  it('keeps the Blocked bit a moderator sent', async () => {
    const level = ALL | NsfwLevel.Blocked;
    expect(await caller(true).levels({ browsingLevel: level, preCapBrowsingLevel: level })).toEqual(
      { browsingLevel: level, preCapBrowsingLevel: level }
    );
  });

  it('drops the Blocked bit from a level past 32 bits', async () => {
    const { browsingLevel } = await caller(false).levels({ browsingLevel: 2 ** 32 + 63 });
    expect(browsingLevel).toBe(31);
  });

  it('drops bits above the browsing levels', async () => {
    expect((await caller(false).levels({ browsingLevel: 64 | 16 })).browsingLevel).toBe(16);
  });

  it.each([-1, 1.5])(
    'refuses a level of %s rather than masking it into a valid one',
    async (level) => {
      await expect(caller(false).levels({ browsingLevel: level })).rejects.toThrow();
    }
  );

  it('holds a signed-out caller who sent the Blocked bit to PG', async () => {
    const { browsingLevel } = await caller(false, false).levels({ browsingLevel: 63 });
    expect(browsingLevel).toBe(NsfwLevel.PG);
  });
});
