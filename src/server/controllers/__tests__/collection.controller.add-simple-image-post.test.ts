import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CollectionService from '~/server/services/collection.service';
import type * as PostService from '~/server/services/post.service';

const mocks = vi.hoisted(() => ({
  getCollectionById: vi.fn(),
  getUserCollectionPermissionsById: vi.fn(),
  bulkSaveItems: vi.fn(),
  createPost: vi.fn(),
  addPostImage: vi.fn(),
}));

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getCollectionById: mocks.getCollectionById,
  getUserCollectionPermissionsById: mocks.getUserCollectionPermissionsById,
  bulkSaveItems: mocks.bulkSaveItems,
}));
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  createPost: mocks.createPost,
  addPostImage: mocks.addPostImage,
}));

import { addSimpleImagePostHandler } from '../collection.controller';

const USER_ID = 7;
const COLLECTION_ID = 42;
const NEW_POST_ID = 500;
const KEY = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e33';

const ctx = {
  user: { id: USER_ID, isModerator: false },
  features: { userChallenges: false },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCollectionById.mockResolvedValue({ id: COLLECTION_ID, name: 'C', read: 'Public' });
  mocks.getUserCollectionPermissionsById.mockResolvedValue({ write: true });
  mocks.createPost.mockResolvedValue({ id: NEW_POST_ID });
  mocks.addPostImage.mockImplementation(async ({ index }: { index: number }) => ({
    id: 10 + index,
  }));
  mocks.bulkSaveItems.mockResolvedValue(undefined);
});

describe('addSimpleImagePostHandler', () => {
  it('adds each image to the post it just created, at the server-assigned position', async () => {
    const result = await addSimpleImagePostHandler({
      input: {
        collectionId: COLLECTION_ID,
        images: [
          { url: KEY, type: 'image', postId: 9_001, index: 40 },
          { url: KEY, type: 'image', postId: 9_001, index: 41 },
        ] as never,
      },
      ctx,
    });

    expect(mocks.addPostImage).toHaveBeenCalledTimes(2);
    expect(mocks.addPostImage.mock.calls.map(([args]) => [args.postId, args.index])).toEqual([
      [NEW_POST_ID, 0],
      [NEW_POST_ID, 1],
    ]);
    expect(result.imageIds).toEqual([10, 11]);
  });
});
