import { beforeEach, describe, expect, it, vi } from 'vitest';

// Importing the real router reaches `~/env/client`, which validates at module load.
// Same pin as `model.router.edge-cache-chain.test.ts`.
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
  formatErrors: () => [],
}));

// Stub the one service the handler calls, so the real procedure chain (input
// middleware, schema, handler) runs without a database and the test can read the
// input the query would have been built from.
import type * as ModelService from '~/server/services/model.service';

const { getModelsWithImagesAndModelVersions } = vi.hoisted(() => ({
  getModelsWithImagesAndModelVersions: vi.fn(),
}));

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getModelsWithImagesAndModelVersions,
}));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { modelRouter } from '~/server/routers/model.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * `model.getAll`'s input merges `userPreferencesSchema`, whose `browsingLevel` is
 * optional with no default, and the models query filters on
 * `("nsfwLevel" & browsingLevel) != 0`. Without the handler's fill-in, a signed-in
 * caller on a domain that caps nothing who omits the level reaches that filter with
 * `undefined`, which binds as NULL and matches no row: an empty page and no error.
 *
 * The viewer's saved level (13 = PG|R|X) equals none of the shared flag constants,
 * so only the viewer's own level can produce it.
 */
const VIEWER_LEVEL = 13;

type User = { id: number; showNsfw: boolean; browsingLevel: number };

function callerFor(user: User | undefined, canViewNsfw: boolean) {
  return modelRouter.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: {
      browserTTL: 0,
      edgeTTL: 0,
      staleWhileRevalidate: 0,
      canCache: true,
      skip: false,
    },
    features: { canViewNsfw },
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
}

/** The `browsingLevel` the models query was asked for. */
async function levelQueried(
  user: User | undefined,
  canViewNsfw: boolean,
  input: { limit: number; browsingLevel?: number } = { limit: 5 }
) {
  await callerFor(user, canViewNsfw).getAll(input);
  expect(getModelsWithImagesAndModelVersions).toHaveBeenCalledTimes(1);
  return getModelsWithImagesAndModelVersions.mock.calls[0][0].input.browsingLevel;
}

beforeEach(() => {
  vi.clearAllMocks();
  getModelsWithImagesAndModelVersions.mockResolvedValue({
    items: [],
    nextCursor: undefined,
    isPrivate: false,
  });
  redisMock.redis.packed.get.mockResolvedValue(null);
  redisMock.redis.packed.set.mockResolvedValue(undefined);
  redisMock.redis.eval.mockResolvedValue(1);
});

describe('model.getAll called without a browsingLevel', () => {
  it('queries a signed-in viewer’s own level where mature content is allowed', async () => {
    const viewer = { id: 5, showNsfw: true, browsingLevel: VIEWER_LEVEL };
    expect(await levelQueried(viewer, true)).toBe(13);
  });

  it('queries PG for a signed-in viewer with mature content off', async () => {
    const viewer = { id: 5, showNsfw: false, browsingLevel: VIEWER_LEVEL };
    expect(await levelQueried(viewer, true)).toBe(1);
  });

  it('queries PG/PG-13 for a signed-in viewer on the SFW domain', async () => {
    const viewer = { id: 5, showNsfw: true, browsingLevel: VIEWER_LEVEL };
    expect(await levelQueried(viewer, false)).toBe(3);
  });

  it('queries PG for a signed-out caller', async () => {
    expect(await levelQueried(undefined, true)).toBe(1);
  });
});

describe('model.getAll called with a browsingLevel', () => {
  it('queries the level sent by a signed-in viewer where mature content is allowed', async () => {
    const viewer = { id: 5, showNsfw: true, browsingLevel: VIEWER_LEVEL };
    expect(await levelQueried(viewer, true, { limit: 5, browsingLevel: 4 })).toBe(4);
  });
});
