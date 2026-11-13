import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CollectionService from '~/server/services/collection.service';
import type * as PostService from '~/server/services/post.service';

const isAccountMuted = vi.hoisted(() => vi.fn());
import type * as Rewards from '~/server/rewards';

const mocks = vi.hoisted(() => ({
  getCollectionById: vi.fn(),
  getUserCollectionPermissionsById: vi.fn(),
  bulkSaveItems: vi.fn(),
  createPost: vi.fn(),
  addPostImage: vi.fn(),
  deletePost: vi.fn(),
  validateContestCollectionEntry: vi.fn(),
  applyFirstDailyPost: vi.fn(),
}));

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getCollectionById: mocks.getCollectionById,
  getUserCollectionPermissionsById: mocks.getUserCollectionPermissionsById,
  bulkSaveItems: mocks.bulkSaveItems,
  validateContestCollectionEntry: mocks.validateContestCollectionEntry,
}));
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  createPost: mocks.createPost,
  addPostImage: mocks.addPostImage,
  deletePost: mocks.deletePost,
}));

vi.mock('~/server/rewards', async (importOriginal) => ({
  ...(await importOriginal<typeof Rewards>()),
  firstDailyPostReward: { apply: mocks.applyFirstDailyPost },
}));

vi.mock('~/server/services/account-standing.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isAccountMuted: (...args: unknown[]) => isAccountMuted(...args),
}));

import { addSimpleImagePostHandler } from '../collection.controller';
import { OnboardingSteps } from '~/server/common/enums';

const USER_ID = 7;
const COLLECTION_ID = 42;
const NEW_POST_ID = 500;
const KEY = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e33';

const ctx = {
  user: { id: USER_ID, isModerator: false, onboarding: OnboardingSteps.Buzz },
  features: { userChallenges: false },
  ip: '203.0.113.9',
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  isAccountMuted.mockResolvedValue(false);
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.getCollectionById.mockResolvedValue({ id: COLLECTION_ID, name: 'C', read: 'Public' });
  mocks.getUserCollectionPermissionsById.mockResolvedValue({ write: true });
  mocks.createPost.mockResolvedValue({ id: NEW_POST_ID });
  mocks.addPostImage.mockImplementation(async ({ index }: { index: number }) => ({
    id: 10 + index,
  }));
  mocks.bulkSaveItems.mockResolvedValue(undefined);
  mocks.validateContestCollectionEntry.mockResolvedValue(undefined);
  mocks.deletePost.mockResolvedValue({ id: NEW_POST_ID });
  mocks.applyFirstDailyPost.mockResolvedValue(undefined);
});

const echoPublishedAt = () =>
  mocks.createPost.mockImplementation(async ({ publishedAt }: { publishedAt?: Date }) => ({
    id: NEW_POST_ID,
    publishedAt: publishedAt ?? null,
  }));

const input = {
  collectionId: COLLECTION_ID,
  images: [{ url: KEY, type: 'image', postId: 9_001, index: 0 }] as never,
};
const contest = { id: COLLECTION_ID, name: 'C', read: 'Public', mode: 'Contest', metadata: {} };

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

  it('creates nothing when the entry is refused before any image exists', async () => {
    mocks.getCollectionById.mockResolvedValue(contest);
    mocks.validateContestCollectionEntry.mockRejectedValue(
      new TRPCError({
        code: 'BAD_REQUEST',
        message: 'You are banned from participating in contests',
      })
    );

    await expect(addSimpleImagePostHandler({ input, ctx })).rejects.toThrow(/banned/);

    expect(mocks.createPost).not.toHaveBeenCalled();
    expect(mocks.addPostImage).not.toHaveBeenCalled();
    expect(mocks.bulkSaveItems).not.toHaveBeenCalled();
  });

  it('runs the entry pre-check without ids and with the fee charge deferred', async () => {
    mocks.getCollectionById.mockResolvedValue(contest);
    const flagged = {
      user: { id: USER_ID, isModerator: false },
      features: { userChallenges: true },
    };

    await addSimpleImagePostHandler({ input, ctx: flagged as never });

    expect(mocks.validateContestCollectionEntry).toHaveBeenNthCalledWith(1, {
      collectionId: COLLECTION_ID,
      userId: USER_ID,
      isModerator: false,
      canAccessUserChallenges: true,
      deferEntryFeeCharge: true,
      metadata: {},
    });
  });

  it('skips both contest validations for a non-contest collection', async () => {
    await addSimpleImagePostHandler({ input, ctx });

    expect(mocks.validateContestCollectionEntry).not.toHaveBeenCalled();
  });

  it('deletes the post when the image-level validation refuses, before anything is saved', async () => {
    mocks.getCollectionById.mockResolvedValue(contest);
    const refusal = new TRPCError({ code: 'BAD_REQUEST', message: "doesn't use a required model" });
    mocks.validateContestCollectionEntry
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(refusal);

    await expect(addSimpleImagePostHandler({ input, ctx })).rejects.toBe(refusal);

    expect(mocks.validateContestCollectionEntry).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ imageIds: [10], deferEntryFeeCharge: true })
    );
    expect(mocks.bulkSaveItems).not.toHaveBeenCalled();
    expect(mocks.deletePost).toHaveBeenCalledTimes(1);
    expect(mocks.deletePost).toHaveBeenCalledWith({ id: NEW_POST_ID, isModerator: false });
  });

  it('deletes with moderator context when a moderator is refused', async () => {
    mocks.getCollectionById.mockResolvedValue(contest);
    mocks.validateContestCollectionEntry
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new TRPCError({ code: 'BAD_REQUEST', message: 'no' }));
    const modCtx = { user: { id: USER_ID, isModerator: true }, features: {} } as never;

    await expect(addSimpleImagePostHandler({ input, ctx: modCtx })).rejects.toThrow('no');

    expect(mocks.deletePost).toHaveBeenCalledWith({ id: NEW_POST_ID, isModerator: true });
  });

  it('still surfaces the original refusal when the rollback fails', async () => {
    mocks.getCollectionById.mockResolvedValue(contest);
    const refusal = new TRPCError({ code: 'BAD_REQUEST', message: 'Image too new' });
    mocks.validateContestCollectionEntry
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(refusal);
    mocks.deletePost.mockRejectedValue(new Error('db down'));

    await expect(addSimpleImagePostHandler({ input, ctx })).rejects.toBe(refusal);
    expect(mocks.deletePost).toHaveBeenCalledTimes(1);
  });

  it('rolls the post back only after every image creation has settled', async () => {
    let finishSlow!: () => void;
    const slow = new Promise<{ id: number }>((resolve) => {
      finishSlow = () => resolve({ id: 11 });
    });
    mocks.addPostImage
      .mockRejectedValueOnce(new TRPCError({ code: 'BAD_REQUEST', message: 'bad image' }))
      .mockReturnValueOnce(slow);

    const run = addSimpleImagePostHandler({
      input: { ...input, images: [input.images[0], input.images[0]] as never },
      ctx,
    });
    const outcome = expect(run).rejects.toThrow('bad image');
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.deletePost).not.toHaveBeenCalled();

    finishSlow();
    await outcome;
    expect(mocks.deletePost).toHaveBeenCalledTimes(1);
    expect(mocks.bulkSaveItems).not.toHaveBeenCalled();
  });

  it('never deletes the post once the entry save has started, even on a fee refusal', async () => {
    mocks.getCollectionById.mockResolvedValue(contest);
    const refusal = new TRPCError({ code: 'PAYMENT_REQUIRED', message: 'only 1 entry submitted' });
    mocks.bulkSaveItems.mockRejectedValue(refusal);

    await expect(addSimpleImagePostHandler({ input, ctx })).rejects.toBe(refusal);

    expect(mocks.deletePost).not.toHaveBeenCalled();
  });

  it('wraps a raw error from the entry save without deleting the post', async () => {
    mocks.bulkSaveItems.mockRejectedValue(new Error('boom'));

    await expect(addSimpleImagePostHandler({ input, ctx })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    expect(mocks.deletePost).not.toHaveBeenCalled();
  });

  it('keeps the post when the entry is accepted', async () => {
    mocks.getCollectionById.mockResolvedValue(contest);

    const result = await addSimpleImagePostHandler({ input, ctx });

    expect(result.post).toEqual({ id: NEW_POST_ID });
    expect(mocks.deletePost).not.toHaveBeenCalled();
  });

  describe('first post of the day reward', () => {
    it('applies it to a published entry, once the entry is saved', async () => {
      echoPublishedAt();
      mocks.getCollectionById.mockResolvedValue(contest);

      await addSimpleImagePostHandler({ input, ctx });

      expect(mocks.applyFirstDailyPost).toHaveBeenCalledTimes(1);
      expect(mocks.applyFirstDailyPost).toHaveBeenCalledWith(
        { postId: NEW_POST_ID, posterId: USER_ID },
        { ip: '203.0.113.9' }
      );
      expect(mocks.bulkSaveItems.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.applyFirstDailyPost.mock.invocationCallOrder[0]
      );
    });

    it('does not apply it to a draft post', async () => {
      echoPublishedAt();
      mocks.getCollectionById.mockResolvedValue({ ...contest, read: 'Private' });

      await addSimpleImagePostHandler({ input, ctx });

      expect(mocks.createPost).toHaveBeenCalledWith(
        expect.objectContaining({ publishedAt: undefined })
      );
      expect(mocks.applyFirstDailyPost).not.toHaveBeenCalled();
    });

    it('keeps the entry when the reward throws', async () => {
      echoPublishedAt();
      mocks.applyFirstDailyPost.mockRejectedValue(new Error('Code: 60. UNKNOWN_TABLE'));

      const result = await addSimpleImagePostHandler({ input, ctx });

      expect(mocks.applyFirstDailyPost).toHaveBeenCalledTimes(1);
      expect(result.imageIds).toEqual([10]);
      expect(mocks.deletePost).not.toHaveBeenCalled();
    });

    // post.create's guardedProcedure refuses these accounts; the entry stands but earns nothing.
    it.each<[string, Record<string, unknown>, boolean?]>([
      ['a muted account', { muted: true }],
      ['an account muted since its session began', {}, true],
      ['an account that has not finished onboarding', { onboarding: 0 }],
      [
        'an account that must verify its email',
        { emailVerified: null, meta: { emailVerificationRequired: true } },
      ],
    ])('does not apply it for %s', async (_, user, mutedNow = false) => {
      echoPublishedAt();
      isAccountMuted.mockResolvedValue(mutedNow);
      const base = ctx as { user: object };
      const restricted = { ...base, user: { ...base.user, ...user } };

      const result = await addSimpleImagePostHandler({ input, ctx: restricted as never });

      expect(result.imageIds).toEqual([10]);
      expect(mocks.applyFirstDailyPost).not.toHaveBeenCalled();
    });

    it('does not apply it when the entry save is refused', async () => {
      echoPublishedAt();
      mocks.getCollectionById.mockResolvedValue(contest);
      mocks.bulkSaveItems.mockRejectedValue(
        new TRPCError({ code: 'PAYMENT_REQUIRED', message: 'only 1 entry submitted' })
      );

      await expect(addSimpleImagePostHandler({ input, ctx })).rejects.toThrow(/only 1 entry/);

      expect(mocks.applyFirstDailyPost).not.toHaveBeenCalled();
    });
  });
});
