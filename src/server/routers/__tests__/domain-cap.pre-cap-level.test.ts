import { describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { getInfiniteImagesSchema } from '~/server/schema/image.schema';
import { publicProcedure, router } from '~/server/trpc';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const PG = NsfwLevel.PG;
const SFW = NsfwLevel.PG | NsfwLevel.PG13;
const EVERYTHING = allBrowsingLevelsFlag;

/**
 * A model gallery's sponsored post is fetched at `preCapBrowsingLevel`, which
 * the client sets. This runs it through the real public procedure chain and the
 * real gallery input schema, so it fails if `applyDomainFeature` stops clamping
 * it, computes the audience wrongly, or the schema stops carrying the field.
 */
const probe = router({
  echo: publicProcedure.input(getInfiniteImagesSchema).query(({ input }) => input),
});

function callerFor(user: { id: number } | undefined, canViewNsfw: boolean) {
  return probe.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { canViewNsfw },
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
}

describe('applyDomainFeature on a gallery request asking for every level', () => {
  it.each([
    ['signed out on the SFW domain', undefined, false, PG],
    ['signed out on a mature domain', undefined, true, PG],
    ['signed in on the SFW domain', { id: 5 }, false, SFW],
    ['signed in on a mature domain', { id: 5 }, true, EVERYTHING],
  ] as const)('%s', async (_label, user, canViewNsfw, expected) => {
    const input = await callerFor(user, canViewNsfw).echo({
      browsingLevel: EVERYTHING,
      preCapBrowsingLevel: EVERYTHING,
    });
    expect(input.browsingLevel).toBe(expected);
    expect(input.preCapBrowsingLevel).toBe(expected);
  });
});
