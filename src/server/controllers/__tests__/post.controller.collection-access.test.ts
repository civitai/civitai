import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Pointing a post at a collection, outside publishing, needs the same access as posting to it.

const POST_OWNER = 11;
const STAFF = 22;
const COLLECTION_ID = 33;
const IMAGE_ID = 44;

const { mockUpdatePost, mockCreatePost, fakeDb, mockBulkSave, mockPermissions } = vi.hoisted(
  () => ({
    mockUpdatePost: vi.fn(),
    mockCreatePost: vi.fn(),
    mockPermissions: vi.fn(),
    fakeDb: { post: { findFirst: vi.fn() }, postTag: { findMany: vi.fn() } },
    // Stands in for bulkSaveItems' visibility check: the image is only open to staff here.
    mockBulkSave: vi.fn(
      async ({ input }: { input: { imageIds?: number[]; isModerator?: boolean } }) => {
        if (!input.isModerator)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Image not found' });
        return { imageIds: input.imageIds ?? [] };
      }
    ),
  })
);

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
  createPost: mockCreatePost,
}));
vi.mock('~/server/services/entity-collaborator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollaboratorService>()),
  sendMessagesToCollaborators: vi.fn(),
}));
vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getUserCollectionPermissionsById: mockPermissions,
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
import { createPostHandler, updatePostHandler } from '~/server/controllers/post.controller';

const ctx = {
  user: { id: POST_OWNER, isModerator: false },
  ip: '127.0.0.1',
  track: { post: vi.fn() },
  features: {},
} as unknown as ProtectedContext;

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb.post.findFirst.mockResolvedValue({ id: 1, publishedAt: null, collectionId: null });
  mockPermissions.mockResolvedValue({ write: false, writeReview: false });
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

const update = (input: Record<string, unknown>) =>
  updatePostHandler({ input: { id: 1, ...input }, ctx } as unknown as Parameters<
    typeof updatePostHandler
  >[0]);

describe('updatePostHandler setting a collection without publishing', () => {
  it('refuses a collection the owner cannot post to', async () => {
    await expect(update({ collectionId: COLLECTION_ID })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockUpdatePost).not.toHaveBeenCalled();
  });

  it('sets a collection the owner can post to (control)', async () => {
    mockPermissions.mockResolvedValue({ write: true, writeReview: false });
    await update({ collectionId: COLLECTION_ID });
    expect(mockUpdatePost).toHaveBeenCalledWith(
      expect.objectContaining({ collectionId: COLLECTION_ID })
    );
  });

  it('clears a collection without asking for access (control)', async () => {
    fakeDb.post.findFirst.mockResolvedValue({
      id: 1,
      publishedAt: null,
      collectionId: COLLECTION_ID,
    });
    await update({ collectionId: null });
    expect(mockPermissions).not.toHaveBeenCalled();
    expect(mockUpdatePost).toHaveBeenCalled();
  });

  it('does not ask again for the collection the post is already in (control)', async () => {
    fakeDb.post.findFirst.mockResolvedValue({
      id: 1,
      publishedAt: null,
      collectionId: COLLECTION_ID,
    });
    await update({ collectionId: COLLECTION_ID, title: 'New title' });
    expect(mockPermissions).not.toHaveBeenCalled();
    expect(mockUpdatePost).toHaveBeenCalled();
  });
});

describe('createPostHandler with a collection', () => {
  const create = (input: Record<string, unknown>) =>
    createPostHandler({ input, ctx } as unknown as Parameters<typeof createPostHandler>[0]);

  it('refuses a collection the creator cannot post to', async () => {
    await expect(create({ collectionId: COLLECTION_ID })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockCreatePost).not.toHaveBeenCalled();
  });

  it('creates a post with no collection without asking (control)', async () => {
    mockCreatePost.mockRejectedValue(new Error('reached createPost'));
    await expect(create({})).rejects.toThrow('reached createPost');
    expect(mockPermissions).not.toHaveBeenCalled();
  });

  it('reaches createPost for a collection the creator can post to (control)', async () => {
    mockPermissions.mockResolvedValue({ write: false, writeReview: true });
    mockCreatePost.mockRejectedValue(new Error('reached createPost'));
    await expect(create({ collectionId: COLLECTION_ID })).rejects.toThrow('reached createPost');
  });
});

describe('updatePostHandler publishing into the collection the post already has', () => {
  beforeEach(() => {
    fakeDb.post.findFirst.mockResolvedValue({
      id: 1,
      publishedAt: null,
      collectionId: COLLECTION_ID,
    });
  });

  it('refuses when the owner cannot post to that collection', async () => {
    await expect(update({ publishedAt: new Date() })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockUpdatePost).not.toHaveBeenCalled();
    expect(mockBulkSave).not.toHaveBeenCalled();
  });

  it('enters the post when the owner can post to it (control)', async () => {
    mockPermissions.mockResolvedValue({ write: true, writeReview: false });
    mockBulkSave.mockResolvedValue({ imageIds: [IMAGE_ID] });
    await update({ publishedAt: new Date() });
    expect(mockUpdatePost).toHaveBeenCalled();
    expect(mockBulkSave).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ collectionId: COLLECTION_ID, imageIds: [IMAGE_ID] }),
      })
    );
  });
});
