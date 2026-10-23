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

const OUTCOME = { storylineId: 3, status: 'submitted', placementId: 9 };

const publishWith = (
  user: Record<string, unknown>,
  features: Record<string, unknown>,
  input: Record<string, unknown> = {}
) =>
  updatePostHandler({
    input: { id: 1, publishedAt: new Date(), ...input },
    ctx: {
      user: { id: 7, isModerator: false, ...user },
      ip: '127.0.0.1',
      track: { post: vi.fn() },
      features,
    } as unknown as ProtectedContext,
  } as unknown as Parameters<typeof updatePostHandler>[0]);

const sentToUpdatePost = () => mockUpdatePost.mock.calls[0][0];

beforeEach(() => {
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
    storyline: OUTCOME,
  }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('updatePostHandler :: a storyline draft', () => {
  it("hands the publish the price the contributor was shown and the domain's currency", async () => {
    await expect(publishWith({}, { storylines: true }, { expectedPrice: 100 })).resolves.toEqual({
      storyline: OUTCOME,
    });

    expect(sentToUpdatePost()).not.toHaveProperty('expectedPrice');
    expect(sentToUpdatePost().storyline).toEqual({
      expectedPrice: 100,
      spendType: 'yellow',
      submitRefusal: undefined,
    });
  });

  it('pays in green on the green domain', async () => {
    await publishWith({}, { storylines: true, isGreen: true }, { expectedPrice: 0 });
    expect(sentToUpdatePost().storyline.spendType).toBe('green');
  });

  it.each([
    [
      'a restricted account',
      { muted: true },
      'You cannot perform this action because your account has been restricted',
    ],
    [
      'an account that must verify its email',
      { emailVerified: null, meta: { emailVerificationRequired: true } },
      'Verify your email address to do this',
    ],
  ])('refuses a continuation from %s, as submitting one would', async (_name, user, reason) => {
    await publishWith(user, { storylines: true }, { expectedPrice: 0 });
    expect(sentToUpdatePost().storyline.submitRefusal).toBe(reason);
  });

  it('takes no storyline step from a request without the storylines flag', async () => {
    await publishWith({}, {}, { expectedPrice: 100 });
    expect(sentToUpdatePost().storyline).toBeUndefined();
    expect(sentToUpdatePost()).not.toHaveProperty('expectedPrice');
  });

  it('returns nothing for a post with no storyline, as before', async () => {
    mockUpdatePost.mockImplementation(async (input: { id: number; publishedAt?: Date }) => ({
      id: input.id,
      userId: 7,
      publishedAt: input.publishedAt,
      collectionId: null,
      modelVersionId: null,
      model3dId: null,
      nsfwLevel: 1,
    }));
    await expect(publishWith({}, { storylines: true })).resolves.toBeUndefined();
  });
});
