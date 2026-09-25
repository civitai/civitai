import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as SearchIndex from '~/server/search-index';
import type * as HomeBlockCache from '~/server/services/home-block-cache.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { saveCollectionItemInputSchema } from '~/server/schema/collection.schema';

const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndex>()),
  collectionsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/home-block-cache.service', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeBlockCache>()),
  homeBlockCacheBust: vi.fn(),
}));

const { saveItemInCollections, checkUserOwnsCollectionAndItem, removeCollectionItem } =
  await import('~/server/services/collection.service');

const USER_ID = 4944;
const MODEL3D_ID = 7101;
const COLLECTION_ID = 17567140;

const collectionRow = (over: Record<string, unknown> = {}) => ({
  id: COLLECTION_ID,
  name: 'My 3D models',
  userId: USER_ID,
  type: 'Model3D',
  mode: null,
  read: 'Private',
  write: 'Private',
  metadata: {},
  tags: [],
  ...over,
});

const permissionRow = {
  id: COLLECTION_ID,
  userId: USER_ID,
  write: 'Private',
  read: 'Private',
  type: 'Model3D',
};

const save = () =>
  saveItemInCollections({
    input: {
      model3dId: MODEL3D_ID,
      type: 'Model3D',
      userId: USER_ID,
      collections: [{ collectionId: COLLECTION_ID }],
      removeFromCollectionIds: [],
    },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockDbRead.collectionItem.findMany.mockResolvedValue([]);
  mockDbRead.$queryRaw.mockResolvedValue([permissionRow]);
  mockDbWrite.$executeRaw.mockReturnValue('insert' as never);
  mockDbWrite.$transaction.mockResolvedValue([]);
});

describe('saving a 3D model to a collection', () => {
  it('accepts a Model3D item and rejects a mismatched id', () => {
    const base = { collections: [{ collectionId: COLLECTION_ID }] };
    expect(
      saveCollectionItemInputSchema.safeParse({ ...base, type: 'Model3D', model3dId: MODEL3D_ID })
        .success
    ).toBe(true);
    expect(
      saveCollectionItemInputSchema.safeParse({ ...base, type: 'Model3D', modelId: MODEL3D_ID })
        .success
    ).toBe(false);
  });

  it('upserts the item keyed on model3dId', async () => {
    mockDbRead.collection.findMany.mockResolvedValue([collectionRow()]);

    await expect(save()).resolves.toBe('added');

    expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = mockDbWrite.$executeRaw.mock.calls[0] as unknown[];
    expect(JSON.stringify([strings, values])).toContain('model3dId');
    const payload = values.find((v): v is string => typeof v === 'string');
    expect(JSON.parse(payload ?? '[]')).toEqual([
      expect.objectContaining({ collectionId: COLLECTION_ID, model3dId: MODEL3D_ID }),
    ]);
  });

  it('refuses a 3D model into a collection of another type', async () => {
    mockDbRead.collection.findMany.mockResolvedValue([collectionRow({ type: 'Model' })]);

    await expect(save()).rejects.toThrow('Collection type mismatch');
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses a contest collection, which has no 3D model entry checks', async () => {
    mockDbRead.collection.findMany.mockResolvedValue([collectionRow({ mode: 'Contest' })]);

    await expect(save()).rejects.toThrow('3D models cannot be entered into contest collections');
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('Model3D collection ownership', () => {
  it('checkUserOwnsCollectionAndItem reads the Model3D table', async () => {
    mockDbRead.collection.findFirst.mockResolvedValue({ type: 'Model3D', userId: USER_ID });
    mockDbRead.$queryRaw.mockResolvedValue([{ userId: USER_ID }]);

    await expect(
      checkUserOwnsCollectionAndItem({
        itemId: MODEL3D_ID,
        collectionId: COLLECTION_ID,
        userId: USER_ID,
      })
    ).resolves.toBe(true);
    expect(JSON.stringify(mockDbRead.$queryRaw.mock.calls[0])).toContain('Model3D');
  });

  it('removeCollectionItem deletes by model3dId', async () => {
    mockDbRead.$queryRaw
      .mockResolvedValueOnce([permissionRow])
      .mockResolvedValueOnce([{ userId: USER_ID }]);
    mockDbWrite.$queryRaw.mockResolvedValue([{ id: 555, addedById: USER_ID, note: null }]);
    mockDbRead.user.findFirst.mockResolvedValue(null);
    mockDbWrite.collectionItem.deleteMany.mockResolvedValue({ count: 1 } as never);

    await expect(
      removeCollectionItem({ userId: USER_ID, collectionId: COLLECTION_ID, itemId: MODEL3D_ID })
    ).resolves.toMatchObject({ type: 'Model3D' });
    expect(JSON.stringify(mockDbWrite.$queryRaw.mock.calls[0])).toContain('model3dId');
    expect(mockDbWrite.collectionItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [555] } },
    });
  });
});
