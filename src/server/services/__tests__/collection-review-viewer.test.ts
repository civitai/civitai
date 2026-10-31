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
    return [
      { id: 1, imageId: 5, modelId: null, postId: null, articleId: null, status: 'REVIEW' },
      { id: 2, imageId: 6, modelId: null, postId: null, articleId: null, status: 'ACCEPTED' },
    ];
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

const reviewRead = (user: object) =>
  getCollectionItemsByCollectionId({
    input: {
      collectionId: 7,
      limit: 10,
      browsingLevel: 3,
      statuses: ['REVIEW', 'ACCEPTED'],
      forReview: true,
    } as never,
    user: user as never,
  });
const imageReads = () =>
  mockGetAllImages.mock.calls.map(([args]) => ({
    ids: args.ids,
    user: args.user,
    pending: args.pending,
    reviewCollectionId: args.reviewCollectionId,
  }));

describe("a collection owner's review read", () => {
  it('leaves the signed-in user it was given unchanged', async () => {
    const user = { id: OWNER, isModerator: false };
    await reviewRead(user);
    expect(user).toEqual({ id: OWNER, isModerator: false });
  });

  it('reads submissions as the owner, with their unrated REVIEW images, and ACCEPTED ones as anyone would', async () => {
    await reviewRead({ id: OWNER, isModerator: false });
    expect(imageReads()).toEqual(
      expect.arrayContaining([
        {
          ids: [5],
          user: { id: OWNER, isModerator: false },
          pending: true,
          reviewCollectionId: 7,
        },
        {
          ids: [6],
          user: { id: OWNER, isModerator: false },
          pending: false,
          reviewCollectionId: undefined,
        },
      ])
    );
    expect(imageReads()).toHaveLength(2);
  });
});
