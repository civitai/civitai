import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { ProtectedContext } from '~/server/createContext';
import type { ReactionEntityType } from '~/server/schema/reaction.schema';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';
import type * as StorylineService from '~/server/services/storyline.service';
import type * as StorylineReaderLevel from '~/server/utils/storyline-reader-level';
import type * as WriteService from '~/server/services/commentv3/write.service';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';

const REACTOR_ID = 5;

const { mockToggleReaction, mockEncouragement, mockGoodContent, storylineGate, v3Comment } =
  vi.hoisted(() => ({
    mockToggleReaction: vi.fn(),
    storylineGate: vi.fn(),
    v3Comment: vi.fn(async (..._a: unknown[]): Promise<unknown> => undefined),
    mockEncouragement: vi.fn<(event: unknown) => Promise<void>>(async () => undefined),
    mockGoodContent: vi.fn<(event: unknown) => Promise<void>>(async () => undefined),
  }));

vi.mock('~/server/services/reaction.service', () => ({ toggleReaction: mockToggleReaction }));
// The comment a reaction targets, as CommentV3 stores it; none means it is missing or deleted.
vi.mock('~/server/services/commentv3/write.service', async (importOriginal) => ({
  ...(await importOriginal<typeof WriteService>()),
  getV3WriteComment: v3Comment,
}));
// An image's two reads, through Kysely: an image in no post (so no access check), whose owner row
// is not found (so no tracker row).
vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads5>()),
  getImagePostId: vi.fn(async () => ({ postId: null })),
  getImageNsfwLevelAndOwner: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ storylines: true }),
}));
vi.mock('~/server/utils/storyline-reader-level', async (importOriginal) => ({
  ...(await importOriginal<typeof StorylineReaderLevel>()),
  storylineReaderLevel: () => 1,
}));
vi.mock('~/server/services/storyline.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StorylineService>()),
  assertStorylineVisible: storylineGate,
}));
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
  // A live comment on a section with no visibility gate, so the comment cases reach the reaction.
  v3Comment.mockResolvedValue({
    id: 1,
    entityType: 'challenge',
    entityId: 9,
    tosViolation: false,
  } as never);
});

async function react(entityType: ReactionEntityType, entityId: number) {
  const ctx = makeCtx();
  await toggleReactionHandler({ ctx, input: { entityType, entityId, reaction: 'Like' } });
  return ctx;
}

// encouragement.reward.ts declines to pay only when ownerId === reactorId, so the owner the
// handler passes is what decides whether a self-reaction is paid.
describe('toggleReactionHandler — owner of a bounty entry', () => {
  it('passes the entry author as owner', async () => {
    dbMock.dbRead.bountyEntry.findFirst.mockResolvedValueOnce({ userId: 77 });

    const ctx = await react('bountyEntry', 300);

    expect(ctx.track.reaction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'BountyEntry_Create', entityId: 300, ownerId: 77 })
    );
    expect(mockEncouragement).toHaveBeenCalledTimes(1);
    expect(mockEncouragement.mock.calls[0][0]).toMatchObject({ ownerId: 77 });
  });

  it('passes the reactor as owner when they react to their own entry', async () => {
    dbMock.dbRead.bountyEntry.findFirst.mockResolvedValueOnce({ userId: REACTOR_ID });

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
// The set each entity type's site UI offers: `Reactions.tsx` / `JudgeReactionBar`.
const EXPECTED_ALLOWED: Record<ReactionEntityType, ReviewReactions[]> = {
  image: CONTENT,
  post: CONTENT,
  article: CONTENT,
  bountyEntry: CONTENT,
  comment: CONTENT,
  resourceReview: CONTENT,
};
const ENTITY_TYPES = Object.keys(EXPECTED_ALLOWED) as ReactionEntityType[];
// A comment's reactions are on CommentV3Reaction, read raw (see the comment cases below).
const HELD_TABLE: Record<Exclude<ReactionEntityType, 'comment'>, string> = {
  image: 'imageReaction',
  post: 'postReaction',
  resourceReview: 'resourceReviewReaction',
  article: 'articleReaction',
  bountyEntry: 'bountyEntryReaction',
};
const HELD_FK: Record<Exclude<ReactionEntityType, 'comment'>, string> = {
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

  const heldCases = cases.flatMap(({ entityType, ...c }) =>
    !c.allowed && entityType !== 'comment' ? [{ ...c, entityType }] : []
  );

  it.each(heldCases)(
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
  it.each(heldCases)(
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

  // Every comment's reactions are on CommentV3Reaction.
  it('still removes a comment Dislike the user holds on CommentV3', async () => {
    mockToggleReaction.mockResolvedValue('removed');
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([{ n: 1 }] as never);
    await expect(
      toggleReactionHandler({
        ctx: makeCtx(),
        input: { entityType: 'comment', entityId: 31, reaction: 'Dislike' },
      })
    ).resolves.toBe('removed');
    expect(String(dbMock.dbWrite.$queryRaw.mock.calls[0][0].join('?'))).toContain(
      '"CommentV3Reaction"'
    );
    expect(dbMock.dbWrite.$queryRaw.mock.calls[0].slice(1)).toEqual([31, REACTOR_ID, 'Dislike']);
  });

  it('refuses a comment Dislike the user does not hold', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([{ n: 0 }] as never);
    await expect(
      toggleReactionHandler({
        ctx: makeCtx(),
        input: { entityType: 'comment', entityId: 31, reaction: 'Dislike' },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockToggleReaction).not.toHaveBeenCalled();
  });

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

describe('toggleReactionHandler — a comment on a crucible', () => {
  const crucible = (takenDownAt: Date | null) => ({
    userId: 4,
    nsfwLevel: 1,
    textNsfw: false,
    ingestion: 'Scanned',
    image: { ingestion: 'Scanned' },
    takenDownAt,
  });
  beforeEach(() => {
    v3Comment.mockResolvedValue({
      id: 55,
      entityType: 'crucible',
      entityId: 17,
      tosViolation: false,
    } as never);
  });

  it('is refused once the crucible is taken down', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucible(new Date()) as never);

    await expect(react('comment', 55)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockToggleReaction).not.toHaveBeenCalled();
  });

  it('still lets a moderator react on a taken-down crucible', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucible(new Date()) as never);
    const ctx = { ...makeCtx(), user: { id: REACTOR_ID, isModerator: true } } as never;

    await toggleReactionHandler({
      ctx,
      input: { entityType: 'comment', entityId: 55, reaction: 'Like' },
    });

    expect(mockToggleReaction).toHaveBeenCalled();
  });

  it('is refused on a comment hidden for ToS', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucible(null) as never);
    v3Comment.mockResolvedValue({
      id: 55,
      entityType: 'crucible',
      entityId: 17,
      tosViolation: true,
    } as never);

    await expect(react('comment', 55)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockToggleReaction).not.toHaveBeenCalled();
  });

  it('goes through on a crucible the reactor can open (control)', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucible(null) as never);

    await react('comment', 55);

    expect(mockToggleReaction).toHaveBeenCalled();
  });
});

describe('toggleReactionHandler — a comment on a storyline', () => {
  beforeEach(() => {
    v3Comment.mockResolvedValue({
      id: 55,
      entityType: 'storyline',
      entityId: 17,
      tosViolation: false,
    } as never);
  });

  it('is refused once the storyline is taken down', async () => {
    storylineGate.mockResolvedValue({ userId: REACTOR_ID, tosViolation: true });
    dbMock.dbRead.storyline.findUnique.mockResolvedValue({ tosViolation: true } as never);

    await expect(react('comment', 55)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockToggleReaction).not.toHaveBeenCalled();
  });

  it('is refused where the reactor cannot open the storyline', async () => {
    storylineGate.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND' }));

    await expect(react('comment', 55)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockToggleReaction).not.toHaveBeenCalled();
  });

  it('goes through on a storyline the reactor can open (control)', async () => {
    storylineGate.mockResolvedValue({ userId: 4, tosViolation: false });
    dbMock.dbRead.storyline.findUnique.mockResolvedValue({ tosViolation: false } as never);

    await react('comment', 55);

    expect(storylineGate).toHaveBeenCalledWith(17, expect.anything(), expect.any(Number));
    expect(mockToggleReaction).toHaveBeenCalled();
  });
});
