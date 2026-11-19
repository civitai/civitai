import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as CollectionService from '~/server/services/collection.service';
import { NsfwLevel } from '~/server/common/enums';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type * as ModelService from '~/server/services/model.service';

/**
 * A model's showcase collection is shown to whoever `collection.getById` would show the collection
 * to, and a removal from a collection clears the showcase only when it named that collection.
 */

const { viewerLevel, coverRulesAllow } = vi.hoisted(() => ({
  viewerLevel: vi.fn(),
  coverRulesAllow: vi.fn(),
}));
vi.mock('~/server/utils/browsing-level', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  relatedPostsBrowsingLevel: viewerLevel,
}));
vi.mock('~/server/services/blocked-browsing-tags.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isCoverShownByBrowsingRules: coverRulesAllow,
}));
const { readModelMeta, permissions, getCollectionById, saveItemInCollections } = vi.hoisted(() => ({
  readModelMeta: vi.fn(),
  permissions: vi.fn(),
  getCollectionById: vi.fn(),
  saveItemInCollections: vi.fn(),
}));

vi.mock('~/server/services/hot-reads-5.reads', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readModelMetaViaKysely: readModelMeta,
}));
vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getUserCollectionPermissionsById: permissions,
  getCollectionById,
  getCollectionItemCount: vi.fn(async () => [{ count: 3 }]),
  saveItemInCollections,
}));
// Reached at import through the orchestrator caller, which throws without a token.
vi.mock('~/server/services/training.service', () => ({}));
// The handler starts the clear without awaiting it; the tests await the one it started.
const clears = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock('~/server/services/model.service', async (importOriginal) => {
  const actual = await importOriginal<typeof ModelService>();
  return {
    ...actual,
    clearModelShowcaseAfterRemoval: (
      args: Parameters<typeof actual.clearModelShowcaseAfterRemoval>[0]
    ) => {
      const clear = actual.clearModelShowcaseAfterRemoval(args);
      clears.push(clear);
      return clear;
    },
  };
});

const { getModelCollectionShowcaseHandler } = await import('~/server/controllers/model.controller');
const { saveItemHandler } = await import('~/server/controllers/collection.controller');

const MODEL = 42;
const MODEL_OWNER = 5;
const SHOWCASE = 9;
const OTHER_COLLECTION = 10;
const COLLECTION_OWNER = 6;

const noAccess = { read: false, write: false, manage: false };

describe('the showcase collection shown on a model page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readModelMeta.mockResolvedValue({ id: MODEL, meta: { showcaseCollectionId: SHOWCASE } });
    getCollectionById.mockResolvedValue({ id: SHOWCASE, name: 'Showcase' });
  });

  const show = (user?: { id: number }) =>
    getModelCollectionShowcaseHandler({ input: { id: MODEL }, ctx: { user } as never });

  it('is nothing to a viewer who cannot see a private collection', async () => {
    permissions.mockResolvedValue(noAccess);
    await expect(show({ id: 77 })).resolves.toBeNull();
    expect(permissions).toHaveBeenCalledWith({ id: SHOWCASE, userId: 77, isModerator: false });
    expect(getCollectionById).not.toHaveBeenCalled();
  });

  it('is shown to a contributor who can only write to it, without a count of its items', async () => {
    permissions.mockResolvedValue({ ...noAccess, write: true });
    await expect(show({ id: 77 })).resolves.toMatchObject({ id: SHOWCASE, itemCount: null });
  });

  it('is shown to a signed-out viewer when the collection is public (control)', async () => {
    permissions.mockResolvedValue({ ...noAccess, read: true });
    await expect(show()).resolves.toMatchObject({ id: SHOWCASE, name: 'Showcase', itemCount: 3 });
  });

  const moderator = { id: 88, isModerator: true };
  const key = (tokenScope: bigint) => ({
    apiKeyId: 9,
    apiKeyType: 'User',
    subject: { type: 'apiKey', id: 9 },
    tokenScope,
  });
  it.each([
    ['a session', {}, true],
    ['a full-access key', key(33554431n), true],
    ['a scoped key', key(1n), false],
    [
      'an app token',
      {
        apiKeyId: 9,
        apiKeyType: 'Access',
        subject: { type: 'oauth', id: 'c' },
        tokenScope: 33554431n,
      },
      false,
    ],
  ] as const)('asks as a moderator only on %s', async (_label, credential, asModerator) => {
    permissions.mockResolvedValue(noAccess);
    await getModelCollectionShowcaseHandler({
      input: { id: MODEL },
      ctx: { user: moderator, ...credential } as never,
    });
    expect(permissions).toHaveBeenCalledWith({
      id: SHOWCASE,
      userId: 88,
      isModerator: asModerator,
    });
  });
});

describe("the showcase collection's cover", () => {
  const cover = (nsfwLevel: number) => ({
    id: 70,
    userId: 6,
    nsfwLevel,
    tags: [{ tag: { id: 1 } }],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    readModelMeta.mockResolvedValue({ id: MODEL, meta: { showcaseCollectionId: SHOWCASE } });
    permissions.mockResolvedValue({ ...noAccess, read: true });
    viewerLevel.mockReturnValue(sfwBrowsingLevelsFlag);
    coverRulesAllow.mockResolvedValue(true);
  });

  const show = () =>
    getModelCollectionShowcaseHandler({ input: { id: MODEL }, ctx: { user: { id: 77 } } as never });

  it('is left out for a viewer whose browsing level excludes it', async () => {
    getCollectionById.mockResolvedValue({ id: SHOWCASE, image: cover(NsfwLevel.R) });
    await expect(show()).resolves.toMatchObject({ id: SHOWCASE, image: null });
  });

  it("is left out when the viewer's browsing rules hide it", async () => {
    getCollectionById.mockResolvedValue({ id: SHOWCASE, image: cover(NsfwLevel.PG) });
    coverRulesAllow.mockResolvedValue(false);
    await expect(show()).resolves.toMatchObject({ image: null });
    const viewerCtx = expect.objectContaining({ user: { id: 77 } });
    expect(coverRulesAllow).toHaveBeenCalledWith(cover(NsfwLevel.PG), viewerCtx);
    expect(viewerLevel).toHaveBeenCalledWith(viewerCtx, undefined);
  });

  it('does not pass on whether a cover was withheld', async () => {
    getCollectionById.mockResolvedValue({ id: SHOWCASE, image: null, coverHidden: true });
    const result = await show();
    expect(result).not.toHaveProperty('coverHidden');
  });

  it("is shown when within the viewer's level and rules (control)", async () => {
    getCollectionById.mockResolvedValue({ id: SHOWCASE, image: cover(NsfwLevel.PG) });
    await expect(show()).resolves.toMatchObject({ image: { id: 70 } });
  });

  it('is shown to a viewer whose level includes it (control)', async () => {
    viewerLevel.mockReturnValue(allBrowsingLevelsFlag);
    getCollectionById.mockResolvedValue({ id: SHOWCASE, image: cover(NsfwLevel.R) });
    await expect(show()).resolves.toMatchObject({ image: { id: 70 } });
  });

  it('is judged as servable for the viewer asking', async () => {
    getCollectionById.mockResolvedValue({ id: SHOWCASE, image: null });
    await show();
    expect(getCollectionById).toHaveBeenCalledWith({
      input: { id: SHOWCASE },
      viewer: { id: 77 },
    });
  });
});

describe('removing a model from a collection', () => {
  let storedMeta: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    clears.length = 0;
    storedMeta = { showcaseCollectionId: SHOWCASE };
    saveItemInCollections.mockResolvedValue('removed');
    const model = () => ({ id: MODEL, userId: MODEL_OWNER, meta: storedMeta });
    for (const db of [dbMock.dbRead, dbMock.dbWrite]) {
      db.model.findUnique.mockImplementation((async () => model()) as never);
      db.model.findFirst.mockImplementation((async () => model()) as never);
    }
    dbMock.dbWrite.collectionItem.findFirst.mockResolvedValue(null);
    dbMock.dbWrite.model.update.mockImplementation((async ({
      data,
    }: {
      data: { meta: Record<string, unknown> };
    }) => {
      storedMeta = data.meta;
      return { id: MODEL, userId: MODEL_OWNER, meta: data.meta };
    }) as never);
  });

  const remove = (userId: number, collectionId: number) =>
    saveItemHandler({
      input: {
        type: 'Model',
        modelId: MODEL,
        collections: [],
        removeFromCollectionIds: [collectionId],
      },
      ctx: {
        user: { id: userId, isModerator: false },
        ip: '127.0.0.1',
        features: { userChallenges: false },
      },
    } as never);

  const settle = async () => {
    expect(clears).toHaveLength(1);
    await clears[0];
  };

  it("clears the showcase when the collection's owner removes the model from it", async () => {
    await remove(COLLECTION_OWNER, SHOWCASE);
    await settle();
    expect(storedMeta.showcaseCollectionId).toBeNull();
  });

  it('clears the showcase when the model owner removes the model from it (control)', async () => {
    await remove(MODEL_OWNER, SHOWCASE);
    await settle();
    expect(storedMeta.showcaseCollectionId).toBeNull();
  });

  it('keeps the showcase when the model leaves a different collection', async () => {
    await remove(MODEL_OWNER, OTHER_COLLECTION);
    await settle();
    expect(storedMeta.showcaseCollectionId).toBe(SHOWCASE);
    expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
  });

  it('keeps the showcase when the model is still listed there', async () => {
    dbMock.dbWrite.collectionItem.findFirst.mockResolvedValue({ id: 1 } as never);
    await remove(MODEL_OWNER, SHOWCASE);
    await settle();
    expect(storedMeta.showcaseCollectionId).toBe(SHOWCASE);
  });
});
