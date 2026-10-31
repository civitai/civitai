import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';

const { mockGetAllImages } = vi.hoisted(() => ({ mockGetAllImages: vi.fn() }));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImages: mockGetAllImages,
}));

import { getCollectionItemsByCollectionId } from '~/server/services/collection.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const OWNER = 9;

/** The owner's collection holds one image awaiting review. */
const listsOneImage = (async (strings: TemplateStringsArray) => {
  const sql = strings.join('?');
  if (sql.includes('FROM "CollectionItem" ci'))
    return [{ id: 1, imageId: 5, modelId: null, postId: null, articleId: null, createdAt: null }];
  if (sql.includes('FROM "Collection" c'))
    return [{ id: 7, read: 'Public', write: 'Private', userId: OWNER, type: 'Image', mode: null }];
  return [];
}) as never;

beforeEach(() => {
  vi.clearAllMocks();
  // A review read goes to the primary.
  for (const db of [dbMock.dbRead, dbMock.dbWrite])
    vi.mocked(db.collection.findUniqueOrThrow).mockResolvedValue({
      id: 7,
      type: 'Image',
      mode: null,
      userId: OWNER,
    } as never);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(listsOneImage);
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation(listsOneImage);
  mockGetAllImages.mockResolvedValue({ items: [{ id: 5 }] });
});

describe("a collection owner's review read", () => {
  it('works on a copy of the signed-in user it was given', async () => {
    const user = { id: OWNER, isModerator: false } as never as { isModerator: boolean };
    await getCollectionItemsByCollectionId({
      input: {
        collectionId: 7,
        limit: 10,
        browsingLevel: 3,
        statuses: ['REVIEW'],
        forReview: true,
      } as never,
      user: user as never,
    });
    expect(mockGetAllImages).toHaveBeenCalledTimes(1);
    expect(user.isModerator).toBe(false);
    // The review read itself keeps its review access.
    expect(mockGetAllImages.mock.calls[0][0].user).toMatchObject({ id: OWNER, isModerator: true });
  });
});
