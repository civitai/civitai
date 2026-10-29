import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { ProtectedContext } from '~/server/createContext';
import type { ReactionEntityType } from '~/server/schema/reaction.schema';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';

const REACTOR_ID = 5;

const { mockToggleReaction, mockEncouragement, mockGoodContent } = vi.hoisted(() => ({
  mockToggleReaction: vi.fn(),
  mockEncouragement: vi.fn<(event: unknown) => Promise<void>>(async () => undefined),
  mockGoodContent: vi.fn<(event: unknown) => Promise<void>>(async () => undefined),
}));

vi.mock('~/server/services/reaction.service', () => ({ toggleReaction: mockToggleReaction }));
vi.mock('~/server/utils/metric-helpers', () => ({
  updateEntityMetric: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/collection.service', () => ({
  getContestsFromEntity: vi.fn(async () => []),
}));
vi.mock('~/server/services/common.service', () => ({
  hasEntityAccess: vi.fn(async () => [{ hasAccess: true }]),
}));
vi.mock('~/server/rewards', () => ({
  encouragementReward: { apply: mockEncouragement },
  goodContentReward: { apply: mockGoodContent },
}));
vi.mock('~/server/notifications/client', () => ({
  notifications: { notificationExists: vi.fn(async () => true) },
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/metric-excluded-users.service', () => ({
  getMetricExcludedUserIds: vi.fn(async () => []),
}));

import { toggleReactionHandler } from '~/server/controllers/reaction.controller';
import { toggleReactionSchema } from '~/server/schema/reaction.schema';

function makeCtx() {
  return {
    user: { id: REACTOR_ID, isModerator: false },
    ip: '127.0.0.1',
    track: { reaction: vi.fn<(event: unknown) => Promise<void>>(async () => undefined) },
  } as unknown as ProtectedContext & { track: { reaction: ReturnType<typeof vi.fn> } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockToggleReaction.mockResolvedValue('created');
  // A live comment, so the comment cases reach the reaction.
  dbMock.dbWrite.commentV2.findUnique.mockResolvedValue({ tosViolation: false } as never);
});

async function react(entityType: ReactionEntityType, entityId: number) {
  const ctx = makeCtx();
  await toggleReactionHandler({ ctx, input: { entityType, entityId, reaction: 'Like' } });
  return ctx;
}

// encouragement.reward.ts declines to pay only when ownerId === reactorId, so the owner the
// handler passes is what decides whether a self-reaction is paid.
describe('toggleReactionHandler — owner of a bounty entry', () => {
  it('reads the bounty entry, not an answer that happens to share its id', async () => {
    dbMock.dbRead.bountyEntry.findFirst.mockResolvedValueOnce({ userId: 77 });
    dbMock.dbRead.answer.findFirst.mockResolvedValueOnce({ userId: 13 });

    const ctx = await react('bountyEntry', 300);

    expect(ctx.track.reaction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'BountyEntry_Create', entityId: 300, ownerId: 77 })
    );
    expect(mockEncouragement).toHaveBeenCalledTimes(1);
    expect(mockEncouragement.mock.calls[0][0]).toMatchObject({ ownerId: 77 });
  });

  it('passes the reactor as owner when they react to their own entry', async () => {
    dbMock.dbRead.bountyEntry.findFirst.mockResolvedValueOnce({ userId: REACTOR_ID });
    dbMock.dbRead.answer.findFirst.mockResolvedValueOnce(null);

    await react('bountyEntry', 300);

    expect(mockEncouragement).toHaveBeenCalledTimes(1);
    expect(mockEncouragement.mock.calls[0][0]).toMatchObject({
      reactorId: REACTOR_ID,
      ownerId: REACTOR_ID,
    });
  });

  it('records no tracker row for an entry whose author was deleted', async () => {
    dbMock.dbRead.bountyEntry.findFirst.mockResolvedValueOnce({ userId: null });

    const ctx = await react('bountyEntry', 300);

    expect(ctx.track.reaction).not.toHaveBeenCalled();
    expect(mockEncouragement.mock.calls[0][0]).toMatchObject({ ownerId: undefined });
  });
});

describe('toggleReactionHandler — owner of a resource review', () => {
  it('passes the review author as owner', async () => {
    dbMock.dbRead.resourceReview.findFirst.mockResolvedValueOnce({ userId: 77 });

    const ctx = await react('resourceReview', 400);

    expect(ctx.track.reaction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Review_Create', entityId: 400, ownerId: 77 })
    );
    expect(mockEncouragement).toHaveBeenCalledTimes(1);
    expect(mockEncouragement.mock.calls[0][0]).toMatchObject({ ownerId: 77 });
  });

  it('passes the reactor as owner when they react to their own review', async () => {
    dbMock.dbRead.resourceReview.findFirst.mockResolvedValueOnce({ userId: REACTOR_ID });

    await react('resourceReview', 400);

    expect(mockEncouragement.mock.calls[0][0]).toMatchObject({
      reactorId: REACTOR_ID,
      ownerId: REACTOR_ID,
    });
  });

  it('records no tracker row for a review that does not exist', async () => {
    const ctx = await react('resourceReview', 400);

    expect(ctx.track.reaction).not.toHaveBeenCalled();
  });
});

const ALL_REACTIONS: ReviewReactions[] = ['Like', 'Dislike', 'Heart', 'Laugh', 'Cry'];
const CONTENT: ReviewReactions[] = ['Like', 'Heart', 'Laugh', 'Cry'];
// The set each entity type's site UI offers: `Reactions.tsx` / `JudgeReactionBar` for content,
// the legacy `ReactionPicker` (every value) for commentOld, `FavoriteBadge` (Heart) for Q&A.
const EXPECTED_ALLOWED: Record<ReactionEntityType, ReviewReactions[]> = {
  image: CONTENT,
  post: CONTENT,
  article: CONTENT,
  bountyEntry: CONTENT,
  comment: CONTENT,
  resourceReview: CONTENT,
  commentOld: ALL_REACTIONS,
  question: ['Heart'],
  answer: ['Heart'],
};
const ENTITY_TYPES = Object.keys(EXPECTED_ALLOWED) as ReactionEntityType[];
const HELD_TABLE: Record<ReactionEntityType, string> = {
  question: 'questionReaction',
  answer: 'answerReaction',
  commentOld: 'commentReaction',
  comment: 'commentV2Reaction',
  image: 'imageReaction',
  post: 'postReaction',
  resourceReview: 'resourceReviewReaction',
  article: 'articleReaction',
  bountyEntry: 'bountyEntryReaction',
};
const HELD_FK: Record<ReactionEntityType, string> = {
  question: 'questionId',
  answer: 'answerId',
  commentOld: 'commentId',
  comment: 'commentId',
  image: 'imageId',
  post: 'postId',
  resourceReview: 'reviewId',
  article: 'articleId',
  bountyEntry: 'bountyEntryId',
};

describe('toggleReactionHandler — which reactions may be created', () => {
  const cases = ENTITY_TYPES.flatMap((entityType) =>
    ALL_REACTIONS.map((reaction) => ({
      entityType,
      reaction,
      allowed: EXPECTED_ALLOWED[entityType].includes(reaction),
    }))
  );

  it.each(cases.filter((c) => c.allowed))(
    'toggles $entityType $reaction',
    async ({ entityType, reaction }) => {
      const result = await toggleReactionHandler({
        ctx: makeCtx(),
        input: { entityType, entityId: 1, reaction },
      });

      expect(result).toBe('created');
      expect(mockToggleReaction).toHaveBeenCalledTimes(1);
    }
  );

  it.each(cases.filter((c) => !c.allowed))(
    'refuses to create $entityType $reaction',
    async ({ entityType, reaction }) => {
      await expect(
        toggleReactionHandler({ ctx: makeCtx(), input: { entityType, entityId: 1, reaction } })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: `The ${reaction} reaction is not available for this ${entityType}.`,
      });
      expect(mockToggleReaction).not.toHaveBeenCalled();
      expect(mockEncouragement).not.toHaveBeenCalled();
    }
  );

  it.each(cases.filter((c) => !c.allowed))(
    'still removes a $entityType $reaction the user already holds',
    async ({ entityType, reaction }) => {
      mockToggleReaction.mockResolvedValue('removed');
      dbMock.dbWrite[HELD_TABLE[entityType]].count.mockResolvedValueOnce(1);

      const result = await toggleReactionHandler({
        ctx: makeCtx(),
        input: { entityType, entityId: 1, reaction },
      });

      expect(result).toBe('removed');
      expect(mockToggleReaction).toHaveBeenCalledTimes(1);
    }
  );

  // Holding a different reaction on the entity (a Like) must not unlock creating this one.
  it.each(cases.filter((c) => !c.allowed))(
    'looks up exactly the user, reaction and $entityType row before allowing $reaction',
    async ({ entityType, reaction }) => {
      await toggleReactionHandler({
        ctx: makeCtx(),
        input: { entityType, entityId: 31, reaction },
      }).catch(() => undefined);

      expect(dbMock.dbWrite[HELD_TABLE[entityType]].count).toHaveBeenCalledWith({
        where: { userId: REACTOR_ID, reaction, [HELD_FK[entityType]]: 31 },
      });
    }
  );

  it('asks the primary, not the replica, whether a legacy reaction is held', async () => {
    mockToggleReaction.mockResolvedValue('removed');
    dbMock.dbRead.imageReaction.count.mockResolvedValueOnce(1);
    dbMock.dbWrite.imageReaction.count.mockResolvedValueOnce(0);

    await expect(
      toggleReactionHandler({
        ctx: makeCtx(),
        input: { entityType: 'image', entityId: 1, reaction: 'Dislike' },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockToggleReaction).not.toHaveBeenCalled();
  });

  it('keeps accepting every reaction value at the schema, so removal can reach the handler', () => {
    for (const reaction of ALL_REACTIONS) {
      expect(
        toggleReactionSchema.safeParse({ entityType: 'image', entityId: 1, reaction }).success
      ).toBe(true);
    }
  });
});
