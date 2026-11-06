import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Publishing a post into an Image collection adds the post's images to it. Staff can publish a
// post they don't own; the add must be judged with the publisher's staff status, or an image
// that is still scanning is refused after the post has already gone live.

const POST_OWNER = 11;
const STAFF = 22;
const COLLECTION_ID = 33;
const IMAGE_ID = 44;

const { mockUpdatePost, fakeDb, mockBulkSave } = vi.hoisted(() => ({
  mockUpdatePost: vi.fn(),
  fakeDb: { post: { findFirst: vi.fn() }, postTag: { findMany: vi.fn() } },
  // Stands in for bulkSaveItems' visibility check: the image is only open to staff here.
  mockBulkSave: vi.fn(
    async ({ input }: { input: { imageIds?: number[]; isModerator?: boolean } }) => {
      if (!input.isModerator)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Image not found' });
      return { imageIds: input.imageIds ?? [] };
    }
  ),
}));

vi.mock('~/server/db/db-lag-helpers', () => ({ getDbWithoutLag: async () => fakeDb }));
vi.mock('~/server/events', () => ({ eventEngine: { processEngagement: vi.fn() } }));
vi.mock('~/server/rewards', () => ({
  firstDailyPostReward: { apply: vi.fn() },
  imagePostedToModelReward: { apply: vi.fn() },
}));
vi.mock('~/server/utils/metric-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof MetricHelpers>()),
  updateEntityMetric: vi.fn(),
}));
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  updatePost: mockUpdatePost,
}));
vi.mock('~/server/services/entity-collaborator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollaboratorService>()),
  sendMessagesToCollaborators: vi.fn(),
}));
vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getUserCollectionPermissionsById: vi.fn(async () => ({
    collectionId: COLLECTION_ID,
    read: true,
    write: true,
    writeReview: true,
    manage: true,
    follow: true,
    isContributor: true,
    isOwner: false,
  })),
  getCollectionById: vi.fn(async () => ({
    id: COLLECTION_ID,
    type: 'Image',
    mode: null,
    tags: [],
    metadata: {},
  })),
  bulkSaveItems: mockBulkSave,
}));

import type * as PostService from '~/server/services/post.service';
import type * as CollaboratorService from '~/server/services/entity-collaborator.service';
import type * as CollectionService from '~/server/services/collection.service';
import type * as MetricHelpers from '~/server/utils/metric-helpers';
import type { ProtectedContext } from '~/server/createContext';
import { updatePostHandler } from '~/server/controllers/post.controller';

const ctx = {
  user: { id: STAFF, isModerator: true },
  ip: '127.0.0.1',
  track: { post: vi.fn() },
  features: {},
} as unknown as ProtectedContext;

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb.post.findFirst.mockResolvedValue({
    id: 1,
    publishedAt: null,
    collectionId: COLLECTION_ID,
  });
  fakeDb.postTag.findMany.mockResolvedValue([]);
  dbMock.dbWrite.image.findMany.mockResolvedValue([{ id: IMAGE_ID }] as never);
  mockUpdatePost.mockImplementation(async (input: { id: number; publishedAt?: Date }) => ({
    id: input.id,
    userId: POST_OWNER,
    publishedAt: input.publishedAt,
    collectionId: COLLECTION_ID,
    modelVersionId: null,
    model3dId: null,
    nsfwLevel: 1,
  }));
});

describe('updatePostHandler publishing into an Image collection', () => {
  it("adds the post's images when staff publish a post they don't own", async () => {
    // A refused add rejects the handler; it must resolve, with the images written.
    await updatePostHandler({
      input: { id: 1, publishedAt: new Date(), collectionId: COLLECTION_ID },
      ctx,
    } as unknown as Parameters<typeof updatePostHandler>[0]);
    expect(mockBulkSave).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ imageIds: [IMAGE_ID] }) })
    );
  });
});
