import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CollectionService from '~/server/services/collection.service';
import type * as PostService from '~/server/services/post.service';

/**
 * The two handlers that add several images to one post share one post-owner check across the
 * batch, so the post is looked up once per request rather than once per image.
 *
 * `addPostImage` is replaced by a stand-in that forwards to the REAL `createImage` exactly what
 * `addPostImage` forwards (the call-site ledger pins that `addPostImage` passes the check on),
 * so the owner lookup counted here is the one `createImage` makes.
 */
const mocks = vi.hoisted(() => ({
  getCollectionById: vi.fn(),
  getUserCollectionPermissionsById: vi.fn(),
  bulkSaveItems: vi.fn(),
  createPost: vi.fn(),
  deletePost: vi.fn(),
}));

vi.mock('~/server/utils/created-image-media-probe', () => ({
  probeCreatedImageMedia: vi.fn(async () => 'present'),
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
  deletePost: mocks.deletePost,
  addPostImage: vi.fn(
    async ({
      user,
      postId,
      index,
      url,
      type,
      assertPostOwnedBy,
    }: Parameters<typeof PostService.addPostImage>[0]) => {
      const { createImage } = await import('~/server/services/image.service');
      const created = await createImage({
        url,
        type,
        postId,
        index,
        userId: user.id,
        skipIngestion: true,
        assertPostOwnedBy,
      });
      return { id: created.id };
    }
  ),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { addSimpleImagePostHandler } from '../collection.controller';
import { createPostWithImagesHandler } from '../post.controller';

const USER_ID = 7;
const OTHER_USER = 8;
const COLLECTION_ID = 42;
const POST_ID = 500;
const KEY = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e33';

const ctx = {
  user: { id: USER_ID, isModerator: false },
  ip: '127.0.0.1',
  track: { post: vi.fn() },
  features: { userChallenges: false },
} as never;

const images = (n: number) =>
  Array.from({ length: n }, (_, index) => ({ url: KEY, type: 'image', index })) as never;

/** The post's owner as the primary DB reports it; the re-select after a create gets a row too. */
function postOwnedBy(userId: number) {
  dbMock.dbWrite.post.findUnique.mockImplementation((async (args: {
    select?: Record<string, boolean>;
  }) =>
    args.select?.userId
      ? { userId }
      : { title: null, detail: null, collectionId: null, nsfwLevel: 0 }) as never);
}

const ownerLookups = () =>
  dbMock.dbWrite.post.findUnique.mock.calls.filter(
    ([args]) => (args as { select?: { userId?: boolean } }).select?.userId
  ).length;

beforeEach(() => {
  vi.clearAllMocks();
  let nextImageId = 1;
  dbMock.dbWrite.image.create.mockImplementation((async () => ({ id: nextImageId++ })) as never);
  mocks.getCollectionById.mockResolvedValue({ id: COLLECTION_ID, name: 'C', read: 'Private' });
  mocks.getUserCollectionPermissionsById.mockResolvedValue({ write: true });
  mocks.bulkSaveItems.mockResolvedValue(undefined);
  mocks.deletePost.mockResolvedValue(undefined);
  mocks.createPost.mockResolvedValue({
    id: POST_ID,
    title: null,
    detail: null,
    modelVersionId: null,
    collectionId: null,
    publishedAt: null,
    nsfwLevel: 0,
    tags: [],
    user: { id: USER_ID },
  });
});

const addSimpleImagePost = (n: number) =>
  addSimpleImagePostHandler({ input: { collectionId: COLLECTION_ID, images: images(n) }, ctx });
const createWithImages = (n: number) =>
  createPostWithImagesHandler({ input: { images: images(n), publish: false } as never, ctx });

describe.each([
  ['collection.addSimpleImagePost', addSimpleImagePost],
  ['post.createWithImages', createWithImages],
])('%s', (_name, run) => {
  it('looks the post owner up once for a batch of images', async () => {
    postOwnedBy(USER_ID);

    await run(4);

    expect(dbMock.dbWrite.image.create).toHaveBeenCalledTimes(4);
    expect(ownerLookups()).toBe(1);
  });

  it('looks it up again on the next request', async () => {
    postOwnedBy(USER_ID);

    await run(2);
    await run(2);

    expect(ownerLookups()).toBe(2);
  });

  it('refuses to write any image into a post owned by someone else', async () => {
    postOwnedBy(OTHER_USER);

    await expect(run(3)).rejects.toThrow(/authoriz/i);

    expect(ownerLookups()).toBe(1);
    expect(dbMock.dbWrite.image.create).not.toHaveBeenCalled();
  });
});
