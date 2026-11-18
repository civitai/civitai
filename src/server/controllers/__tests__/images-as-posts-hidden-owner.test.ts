import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ImageService from '~/server/services/image.service';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const { fetches } = vi.hoisted(() => ({
  fetches: vi.fn(async () => ({ items: [], nextCursor: undefined })),
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImages: fetches,
  getAllImagesIndex: fetches,
}));
vi.mock('~/server/services/model.service', () => ({
  getGallerySettingsByModelId: async () => ({ pinnedPosts: {}, hiddenImages: { 10: [7, 8] } }),
  getHeldGalleryLevel: async () => undefined,
  isModelGalleryWithheld: async () => false,
}));
vi.mock('~/server/services/promotion.service', () => ({
  getSponsoredGalleryPost: async () => undefined,
}));

const { getImagesAsPostsInfiniteHandler } = await import('~/server/controllers/image.controller');

const OWNER = 5;

function run({
  hidden = true,
  user,
  subject,
  credential,
}: {
  hidden?: boolean;
  user?: { id: number; isModerator?: boolean };
  subject?: unknown;
  credential?: object;
}) {
  return getImagesAsPostsInfiniteHandler({
    input: {
      limit: 10,
      modelId: 1,
      modelVersionId: 10,
      hidden,
      include: [],
      browsingLevel: allBrowsingLevelsFlag,
    } as never,
    ctx: { user, subject, ...credential, features: {}, req: { headers: {} } } as never,
  });
}

const userKey = (tokenScope: bigint) => ({
  subject: { type: 'apiKey', id: 1 },
  apiKeyId: 1,
  apiKeyType: 'User',
  tokenScope,
});

const fetchedIds = () =>
  (fetches.mock.calls as unknown as [{ ids?: number[] }][]).map(([args]) => args.ids);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.model.findUnique.mockResolvedValue({ userId: OWNER } as never);
  dbMock.dbRead.resourceReview.findMany.mockResolvedValue([] as never);
});

describe('getImagesAsPostsInfiniteHandler with hidden images', () => {
  it("lists a model's hidden images for its owner", async () => {
    await run({ user: { id: OWNER } });

    expect(dbMock.dbRead.model.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1 } })
    );
    expect(fetchedIds()[0]).toEqual([7, 8]);
  });

  it("lists them for its owner's full-access key", async () => {
    await run({ user: { id: OWNER }, credential: userKey(TokenScope.Full) });

    expect(fetchedIds()[0]).toEqual([7, 8]);
  });

  it("lists nothing for its owner's scoped key", async () => {
    const result = await run({
      user: { id: OWNER },
      credential: userKey(TokenScope.ModelsRead | TokenScope.MediaRead),
    });

    expect(result).toEqual({ nextCursor: undefined, items: [] });
    expect(fetches).not.toHaveBeenCalled();
  });

  it('lists them for a moderator', async () => {
    await run({ user: { id: 99, isModerator: true } });

    expect(fetchedIds()[0]).toEqual([7, 8]);
  });

  it.each([
    ['another user', { id: 99 }, undefined],
    ['a signed-out visitor', undefined, undefined],
    [
      'a moderator through an app they authorised',
      { id: 99, isModerator: true },
      { type: 'oauth' },
    ],
  ])('lists nothing for %s', async (_, user, subject) => {
    const result = await run({ user, subject });

    expect(result).toEqual({ nextCursor: undefined, items: [] });
    expect(fetches).not.toHaveBeenCalled();
  });

  it('lists nothing when the model cannot be found', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue(null as never);

    const result = await run({ user: { id: 99 } });

    expect(result).toEqual({ nextCursor: undefined, items: [] });
    expect(fetches).not.toHaveBeenCalled();
  });

  it("still serves another user the model's visible gallery", async () => {
    await run({ hidden: false, user: { id: 99 } });

    expect(fetches).toHaveBeenCalled();
    expect(fetchedIds()[0]).toBeUndefined();
    expect(dbMock.dbRead.model.findUnique).not.toHaveBeenCalled();
  });
});
