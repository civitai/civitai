import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as Caches from '~/server/redis/caches';
import type * as ImageService from '~/server/services/image.service';
import type * as TagService from '~/server/services/tag.service';
import type { SessionUser } from '~/types/session';

const { getImageMetricsObject, getPostDetailRow, getUserWithCosmetics } = vi.hoisted(() => ({
  getImageMetricsObject: vi.fn(),
  getPostDetailRow: vi.fn(),
  getUserWithCosmetics: vi.fn(),
}));
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads6>()),
  getPostDetailRow,
  getUserWithCosmetics,
}));

vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
  getKyselyWithoutLag: vi.fn(async () => (await import('~/server/db/kyselyDb')).kyselyRead),
}));
vi.mock('~/server/services/tag.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TagService>()),
  getVotableImageTags: vi.fn(async () => []),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImageMetricsObject,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return {
    ...actual,
    thumbnailCache: { ...actual.thumbnailCache, fetch: vi.fn(async () => ({})) },
  };
});

import {
  getPostEditDetail,
  getPostEditImages,
  withReactionCounts,
} from '~/server/services/post.service';

const metric = (
  imageId: number,
  like: number | null,
  heart: number | null,
  laugh: number | null = null,
  cry: number | null = null
) => ({
  imageId,
  reactionLike: like,
  reactionHeart: heart,
  reactionLaugh: laugh,
  reactionCry: cry,
});
const past = new Date(Date.now() - 86_400_000);
const future = new Date(Date.now() + 86_400_000);

describe('withReactionCounts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sums the reaction types of a published post in one metrics read', async () => {
    getImageMetricsObject.mockResolvedValue({
      1: metric(1, 3, 2, 1, 1),
      2: metric(2, null, null),
    });

    const result = await withReactionCounts([{ id: 1 }, { id: 2 }, { id: 3 }], past);

    expect(getImageMetricsObject).toHaveBeenCalledTimes(1);
    // 1: 3 + 2 + 1 + 1, all four types. 2: every field null means unknown, not 0. 3: the read did not resolve it.
    expect(result).toEqual([{ id: 1, reactionCount: 7 }, { id: 2 }, { id: 3 }]);
  });

  it('reads nothing for a draft or a scheduled post', async () => {
    await withReactionCounts([{ id: 1 }], null);
    await withReactionCounts([{ id: 1 }], future);

    expect(getImageMetricsObject).not.toHaveBeenCalled();
  });
});

describe('combinePostEditImageData, shared with the upload path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads no metrics through getPostEditImages (addPostImage itself is not run here)', async () => {
    vi.mocked(dbMock.dbRead.image.findMany).mockResolvedValue([
      { id: 1, index: 1, tools: [], techniques: [] },
    ] as never);

    const images = await getPostEditImages({
      id: 1,
      user: { id: 1 } as SessionUser,
      servableLevels: allBrowsingLevelsFlag,
    });

    expect(images).toHaveLength(1);
    expect(getImageMetricsObject).not.toHaveBeenCalled();
  });
});

describe('getPostEditDetail', () => {
  beforeEach(() => vi.clearAllMocks());

  const givenPost = (publishedAt: Date | null) => {
    getPostDetailRow.mockResolvedValue({
      id: 1,
      publishedAt,
      modelVersionId: null,
      publishedModelVersionId: null,
      userId: 7,
      tags: [],
    });
    getUserWithCosmetics.mockResolvedValue({
      id: 7,
      username: 'owner',
      deletedAt: null,
      image: null,
      profilePictureId: null,
      cosmetics: [],
    });
    vi.mocked(dbMock.dbRead.image.findMany).mockResolvedValue([
      { id: 1, index: 1, tools: [], techniques: [] },
    ] as never);
  };
  const owner = { id: 7, isModerator: false } as SessionUser;

  it('puts the reaction count on each image of a published post', async () => {
    givenPost(past);
    getImageMetricsObject.mockResolvedValue({ 1: metric(1, 4, 1) });

    const post = await getPostEditDetail({
      id: 1,
      user: owner,
      servableLevels: allBrowsingLevelsFlag,
    });

    expect(post.images[0].reactionCount).toBe(5);
  });

  it('reads no metrics for a draft', async () => {
    givenPost(null);

    const post = await getPostEditDetail({
      id: 1,
      user: owner,
      servableLevels: allBrowsingLevelsFlag,
    });

    expect(post.images[0].reactionCount).toBeUndefined();
    expect(getImageMetricsObject).not.toHaveBeenCalled();
  });
});

// post.getEdit through the router, with getPostEditImages' real `where` on an in-process Postgres:
// the owner's own held image is in their editor on a session, not on a MediaRead-scoped key.
describe("post.getEdit and the owner's held image", () => {
  const OWNER = 7;
  const CLEAN = 1;
  const HELD = 2;
  let harness: Awaited<ReturnType<typeof startPglitePrisma>>;

  beforeAll(async () => {
    harness = await startPglitePrisma(`
      CREATE TABLE "Image" (
        id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "nsfwLevel" int NOT NULL DEFAULT 1,
        "needsReview" text
      );
    `);
    await harness.pg.exec(`
      INSERT INTO "Image" (id, "userId", "postId", "needsReview") VALUES
        (${CLEAN}, ${OWNER}, 1, NULL), (${HELD}, ${OWNER}, 1, 'csam');
    `);
  }, 60_000);
  afterAll(() => harness.stop());

  beforeEach(() => {
    vi.clearAllMocks();
    getPostDetailRow.mockResolvedValue({
      id: 1,
      publishedAt: null,
      modelVersionId: null,
      publishedModelVersionId: null,
      userId: OWNER,
      tags: [],
    });
    getUserWithCosmetics.mockResolvedValue({
      id: OWNER,
      username: 'owner',
      deletedAt: null,
      image: null,
      profilePictureId: null,
      cosmetics: [],
    });
    vi.mocked(dbMock.dbRead.image.findMany).mockImplementation((async (args: { where: object }) =>
      (await harness.prisma.image.findMany({ where: args.where, select: { id: true } })).map(
        (row) => ({ ...row, index: row.id, tools: [], techniques: [] })
      )) as never);
  });

  const scopedKey = {
    apiKeyId: 7,
    apiKeyType: 'User',
    subject: { type: 'apiKey', id: 7 },
    tokenScope: TokenScope.MediaRead,
  };
  const editorImageIds = async (scoped: boolean) => {
    const { postRouter } = await import('~/server/routers/post.router');
    const caller = postRouter.createCaller({
      user: { id: OWNER, tier: 'free', username: 'owner', muted: false, onboarding: 0xff },
      acceptableOrigin: true,
      tokenScope: TokenScope.Full,
      apiKeyId: null,
      ...(scoped ? scopedKey : {}),
      req: { headers: {} },
      res: { setHeader: () => undefined },
      cache: { edgeTTL: 0 },
      features: { canViewNsfw: true, trpcFlagGuardPerRequest: true },
      track: { action: vi.fn(() => Promise.resolve(true)) },
    } as never);
    const post = await caller.getEdit({ id: 1 });
    return post.images.map((i: { id: number }) => i.id).sort();
  };

  it('shows it to the owner on a session', async () => {
    expect(await editorImageIds(false)).toEqual([CLEAN, HELD]);
  }, 60_000);

  it('keeps it from the owner on a MediaRead-scoped key', async () => {
    expect(await editorImageIds(true)).toEqual([CLEAN]);
  }, 60_000);
});
