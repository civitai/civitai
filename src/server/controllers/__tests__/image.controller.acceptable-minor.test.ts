import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as CollectionService from '~/server/services/collection.service';
import type * as ImageService from '~/server/services/image.service';

type ItemWhere = {
  collectionId?: number;
  imageId?: number;
  status?: { not?: string };
  collection?: { mode?: string };
};

const mocks = vi.hoisted(() => ({
  getUserCollectionPermissionsById: vi.fn(),
  updateImageAcceptableMinor: vi.fn(),
}));

const OWNER = 50;
const COLLECTION_A = 100;
const COLLECTION_B = 200;
const BOOKMARKS = 300;
const IMAGE_IN_A = 11;
const IMAGE_IN_B = 22;
const IMAGE_IN_BOOKMARKS = 33;
const IMAGE_REJECTED_IN_A = 44;
const IMAGE_ADDED_BY_OTHER_IN_A = 55;
const entry = (
  id: number,
  collectionId: number,
  imageId: number,
  extra: Partial<{ mode: string; status: string; addedById: number }> = {}
) => ({ id, collectionId, imageId, mode: 'Contest', status: 'REVIEW', addedById: OWNER, ...extra });
const ROWS = [
  entry(1, COLLECTION_A, IMAGE_IN_A),
  entry(2, COLLECTION_B, IMAGE_IN_B),
  entry(3, BOOKMARKS, IMAGE_IN_BOOKMARKS, { mode: 'Bookmark' }),
  entry(4, COLLECTION_A, IMAGE_REJECTED_IN_A, { status: 'REJECTED' }),
  entry(5, COLLECTION_A, IMAGE_ADDED_BY_OTHER_IN_A, { addedById: 999 }),
];

// Answers from ROWS by the where it is given, and like Prisma an absent key matches every row,
// so a query that drops a condition reads a row it should not. Every image belongs to OWNER.
const findCollectionItem = async ({ where }: { where: ItemWhere }) => {
  const matches = <T>(want: T | undefined, have: T) => want === undefined || want === have;
  const row = ROWS.find(
    (r) =>
      matches(where.collectionId, r.collectionId) &&
      matches(where.imageId, r.imageId) &&
      (where.status?.not === undefined || where.status.not !== r.status) &&
      matches(where.collection?.mode, r.mode)
  );
  return row ? { addedById: row.addedById, image: { userId: OWNER } } : null;
};

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getUserCollectionPermissionsById: mocks.getUserCollectionPermissionsById,
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  updateImageAcceptableMinor: mocks.updateImageAcceptableMinor,
}));

const { updateImageAcceptableMinorHandler } = await import('~/server/controllers/image.controller');

type HandlerCtx = Parameters<typeof updateImageAcceptableMinorHandler>[0]['ctx'];
const ctx = (user: { id: number; isModerator: boolean }) => ({ user } as unknown as HandlerCtx);

const MANAGER = { id: 7, isModerator: false };
const MODERATOR = { id: 1, isModerator: true };
beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.collectionItem.findFirst.mockImplementation(findCollectionItem);
  mocks.getUserCollectionPermissionsById.mockResolvedValue({ manage: true });
  mocks.updateImageAcceptableMinor.mockImplementation(async (input) => ({
    id: input.id,
    acceptableMinor: input.acceptableMinor,
  }));
});

const call = (
  user: { id: number; isModerator: boolean },
  input: { id: number; collectionId: number }
) =>
  updateImageAcceptableMinorHandler({ input: { ...input, acceptableMinor: true }, ctx: ctx(user) });

describe('updateImageAcceptableMinorHandler', () => {
  it('refuses an image that is not an item of the given collection', async () => {
    await expect(
      call(MANAGER, { id: IMAGE_IN_B, collectionId: COLLECTION_A })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mocks.updateImageAcceptableMinor).not.toHaveBeenCalled();
  });

  it('refuses an item of a collection that is not a contest', async () => {
    await expect(
      call(MANAGER, { id: IMAGE_IN_BOOKMARKS, collectionId: BOOKMARKS })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mocks.updateImageAcceptableMinor).not.toHaveBeenCalled();
  });

  it('refuses an entry that was rejected', async () => {
    await expect(
      call(MANAGER, { id: IMAGE_REJECTED_IN_A, collectionId: COLLECTION_A })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mocks.updateImageAcceptableMinor).not.toHaveBeenCalled();
  });

  it("refuses an entry not submitted by the image's owner", async () => {
    await expect(
      call(MANAGER, { id: IMAGE_ADDED_BY_OTHER_IN_A, collectionId: COLLECTION_A })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mocks.updateImageAcceptableMinor).not.toHaveBeenCalled();
  });

  it("refuses a manager ruling on the manager's own image", async () => {
    await expect(
      call({ id: OWNER, isModerator: false }, { id: IMAGE_IN_A, collectionId: COLLECTION_A })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mocks.updateImageAcceptableMinor).not.toHaveBeenCalled();
  });

  it('updates an image that is an item of the managed contest collection', async () => {
    await expect(call(MANAGER, { id: IMAGE_IN_A, collectionId: COLLECTION_A })).resolves.toEqual({
      id: IMAGE_IN_A,
      acceptableMinor: true,
    });
    expect(mocks.updateImageAcceptableMinor).toHaveBeenCalledTimes(1);
  });

  it('refuses a user who cannot manage the collection', async () => {
    mocks.getUserCollectionPermissionsById.mockResolvedValue({ manage: false });
    await expect(
      call(MANAGER, { id: IMAGE_IN_A, collectionId: COLLECTION_A })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mocks.updateImageAcceptableMinor).not.toHaveBeenCalled();
  });

  it('lets a moderator update any image', async () => {
    await expect(
      call(MODERATOR, { id: IMAGE_IN_B, collectionId: COLLECTION_A })
    ).resolves.toMatchObject({ id: IMAGE_IN_B });
    expect(mocks.updateImageAcceptableMinor).toHaveBeenCalledTimes(1);
  });
});
