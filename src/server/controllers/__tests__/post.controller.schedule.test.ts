import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUpdatePost, mockApply, mockProcessEngagement, fakeDb } = vi.hoisted(() => ({
  mockUpdatePost: vi.fn(),
  mockApply: vi.fn(),
  mockProcessEngagement: vi.fn(),
  fakeDb: {
    post: { findFirst: vi.fn() },
    postTag: { findMany: vi.fn() },
  },
}));

vi.mock('~/server/db/db-lag-helpers', () => ({ getDbWithoutLag: async () => fakeDb }));
vi.mock('~/server/events', () => ({ eventEngine: { processEngagement: mockProcessEngagement } }));
vi.mock('~/server/rewards', () => ({
  firstDailyPostReward: { apply: mockApply },
  imagePostedToModelReward: { apply: vi.fn() },
}));
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  updatePost: mockUpdatePost,
}));
vi.mock('~/server/services/entity-collaborator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollaboratorService>()),
  sendMessagesToCollaborators: vi.fn(),
}));

import type * as PostService from '~/server/services/post.service';
import type * as CollaboratorService from '~/server/services/entity-collaborator.service';
import type { ProtectedContext } from '~/server/createContext';
import { updatePostHandler } from '~/server/controllers/post.controller';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const minutesFromNow = (minutes: number) => new Date(NOW.getTime() + minutes * 60 * 1000);

const ctx = {
  user: { id: 7, isModerator: false },
  ip: '127.0.0.1',
  track: { post: vi.fn() },
  features: {},
} as unknown as ProtectedContext;

const publishDraftAt = (publishedAt: Date) =>
  updatePostHandler({ input: { id: 1, publishedAt }, ctx } as unknown as Parameters<
    typeof updatePostHandler
  >[0]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  fakeDb.post.findFirst.mockResolvedValue({ id: 1, publishedAt: null, collectionId: null });
  fakeDb.postTag.findMany.mockResolvedValue([]);
  mockUpdatePost.mockImplementation(async (input: { id: number; publishedAt?: Date }) => ({
    id: input.id,
    userId: 7,
    publishedAt: input.publishedAt,
    collectionId: null,
    modelVersionId: null,
    model3dId: null,
    nsfwLevel: 1,
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('updatePostHandler :: 10-minute schedule minimum', () => {
  it('keeps a publish date 11 minutes out as a schedule', async () => {
    const scheduledFor = minutesFromNow(11);
    await publishDraftAt(scheduledFor);

    expect(mockUpdatePost.mock.calls[0][0].publishedAt).toEqual(scheduledFor);
    // A scheduled post is rewarded by process-scheduled-publishing on the day it goes live.
    expect(mockApply).not.toHaveBeenCalled();
    expect(mockProcessEngagement).not.toHaveBeenCalled();
  });

  it('publishes immediately, and rewards inline, inside the minimum', async () => {
    await publishDraftAt(minutesFromNow(9));

    expect(mockUpdatePost.mock.calls[0][0].publishedAt).toEqual(NOW);
    expect(mockApply).toHaveBeenCalledWith({ postId: 1, posterId: 7 }, { ip: '127.0.0.1' });
  });
});
