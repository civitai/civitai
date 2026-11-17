import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as CollectionService from '~/server/services/collection.service';

/**
 * A model's showcase collection is shown to whoever `collection.getById` would show the collection
 * to, and a removal from a collection clears the showcase only when it named that collection.
 */

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
    expect(permissions).toHaveBeenCalledWith({ id: SHOWCASE, userId: 77, isModerator: undefined });
    expect(getCollectionById).not.toHaveBeenCalled();
  });

  it('is shown to a contributor who can only write to it, as collection.getById shows them', async () => {
    permissions.mockResolvedValue({ ...noAccess, write: true });
    await expect(show({ id: 77 })).resolves.toMatchObject({ id: SHOWCASE, itemCount: 3 });
  });

  it('is shown to a signed-out viewer when the collection is public (control)', async () => {
    permissions.mockResolvedValue({ ...noAccess, read: true });
    await expect(show()).resolves.toMatchObject({ id: SHOWCASE, name: 'Showcase', itemCount: 3 });
  });
});

describe('removing a model from a collection', () => {
  let storedMeta: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
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

  // The clear runs in the background after the response.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

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
