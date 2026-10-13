import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Award from '~/server/events/points/award';
import type { TrackBatchInput } from '~/server/schema/track.schema';

const { awardEventPoints, removeEventPoints, hatted } = vi.hoisted(() => ({
  awardEventPoints: vi.fn(async (..._a: unknown[]) => undefined),
  removeEventPoints: vi.fn(async (..._a: unknown[]) => undefined),
  hatted: new Set<string>(),
}));

// The engine's kill switch is on here; enabled.test.ts covers it off.
vi.mock('~/server/events/points/enabled', () => ({
  isEventPointsEnabled: async () => true,
  isEventPointsEnabledSync: () => true,
  onEventPointsSwitchOn: () => () => undefined,
}));
// The engine's self-heal runs the reconcile and settle: tested in self-heal.test.ts, not here.
vi.mock('~/server/events/points/self-heal', () => ({ healEventPoints: vi.fn() }));
vi.mock('~/server/events/points/award', async (importOriginal) => ({
  ...(await importOriginal<typeof Award>()),
  awardEventPoints,
  removeEventPoints,
  isHattedEntity: (entityType: string, entityId: number) => hatted.has(`${entityType}:${entityId}`),
  isHattedEntityOnceLoaded: async (entityType: string, entityId: number) =>
    hatted.has(`${entityType}:${entityId}`),
}));

import {
  awardViewPoints,
  hattedImpressionEntities,
  onCommentCreated,
  onCommentsRemoved,
  onModelReviewsChanged,
  onPlacementApproved,
  onPlacementsTakenDown,
  onReactionCreated,
  onReactionRemoved,
} from '~/server/events/points/hooks';

const db = dbMock.dbWrite;
const ACTOR = 5;

beforeEach(() => {
  vi.clearAllMocks();
  hatted.clear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('views', () => {
  const batch = (...entities: { entityType: string; entityId: number }[]) =>
    [
      { kind: 'search', data: { query: 'x', index: 'models' } },
      { kind: 'impression', data: { sessionKey: 'k', surface: 'images', entities } },
    ] as unknown as TrackBatchInput;

  it('keeps only hatted Image/Model/Article entities', () => {
    hatted.add('Image:1').add('Model:2').add('Post:3');
    expect(
      hattedImpressionEntities(
        batch(
          { entityType: 'Image', entityId: 1 },
          { entityType: 'Image', entityId: 9 },
          { entityType: 'Model', entityId: 2 },
          // Hatted by key, but not a type that can earn points.
          { entityType: 'Post', entityId: 3 }
        )
      )
    ).toEqual([
      { entityType: 'Image', entityId: 1 },
      { entityType: 'Model', entityId: 2 },
    ]);
  });

  it('awards a view per entity to the signed-in viewer', async () => {
    await awardViewPoints(
      async () => ({ user: { id: ACTOR } } as never),
      [{ entityType: 'Image', entityId: 1 }]
    );
    expect(awardEventPoints).toHaveBeenCalledWith([
      {
        type: 'view',
        actorId: ACTOR,
        actor: { createdAt: undefined, bannedAt: undefined },
        entityType: 'Image',
        entityId: 1,
      },
    ]);
  });

  it('awards nothing to a signed-out viewer', async () => {
    await awardViewPoints(async () => null, [{ entityType: 'Image', entityId: 1 }]);
    expect(awardEventPoints).not.toHaveBeenCalled();
  });

  it('never rejects when the session lookup fails', async () => {
    await expect(
      awardViewPoints(
        () => Promise.reject(new Error('jwe')),
        [{ entityType: 'Image', entityId: 1 }]
      )
    ).resolves.toBeUndefined();
  });
});

describe('reactions', () => {
  it('awards a hatted image reaction with a per-(entity, actor) sourceId', async () => {
    hatted.add('Image:7');
    await onReactionCreated({ entityType: 'image', entityId: 7, userId: ACTOR });
    expect(awardEventPoints).toHaveBeenCalledWith([
      {
        type: 'reaction',
        actorId: ACTOR,
        entityType: 'Image',
        entityId: 7,
        time: expect.any(Date),
        sourceId: `ImageReaction:7:${ACTOR}`,
      },
    ]);
  });

  it('ignores reactions on other entity types and on unhatted content', async () => {
    hatted.add('Image:7');
    await onReactionCreated({ entityType: 'post', entityId: 7, userId: ACTOR });
    await onReactionCreated({ entityType: 'image', entityId: 8, userId: ACTOR });
    expect(awardEventPoints).not.toHaveBeenCalled();
  });

  it('removes only when the actor has no reaction left on the entity', async () => {
    hatted.add('Article:3');
    db.articleReaction.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await onReactionRemoved({ entityType: 'article', entityId: 3, userId: ACTOR });
    expect(removeEventPoints).not.toHaveBeenCalled();

    await onReactionRemoved({ entityType: 'article', entityId: 3, userId: ACTOR });
    expect(removeEventPoints).toHaveBeenCalledWith([
      {
        type: 'reaction',
        actorId: ACTOR,
        entityType: 'Article',
        entityId: 3,
        time: expect.any(Date),
        sourceId: `ArticleReaction:3:${ACTOR}`,
      },
    ]);
    expect(db.articleReaction.count).toHaveBeenLastCalledWith({
      where: { articleId: 3, userId: ACTOR },
    });
  });

  it('skips the remaining-rows query for unhatted content', async () => {
    await onReactionRemoved({ entityType: 'image', entityId: 7, userId: ACTOR });
    expect(db.imageReaction.count).not.toHaveBeenCalled();
    expect(removeEventPoints).not.toHaveBeenCalled();
  });

  it('never rejects when the database fails', async () => {
    hatted.add('Image:7');
    db.imageReaction.count.mockRejectedValueOnce(new Error('down'));
    await expect(
      onReactionRemoved({ entityType: 'image', entityId: 7, userId: ACTOR })
    ).resolves.toBeUndefined();
  });
});

describe('comments', () => {
  it('awards a top-level comment on a hatted image without a thread lookup', async () => {
    hatted.add('Image:7');
    await onCommentCreated({ userId: ACTOR, entityType: 'image', entityId: 7, threadId: 70 });
    expect(db.thread.findMany).not.toHaveBeenCalled();
    expect(awardEventPoints).toHaveBeenCalledWith([
      {
        type: 'comment',
        actorId: ACTOR,
        entityType: 'Image',
        entityId: 7,
        time: expect.any(Date),
        sourceId: `CommentV2:Image:7:${ACTOR}`,
      },
    ]);
  });

  it("credits a reply to its root thread's article", async () => {
    hatted.add('Article:3');
    db.thread.findMany.mockResolvedValueOnce([
      {
        id: 71,
        rootThreadId: 30,
        imageId: null,
        articleId: null,
        rootThread: { imageId: null, articleId: 3 },
      },
    ]);
    await onCommentCreated({ userId: ACTOR, entityType: 'comment', entityId: 99, threadId: 71 });
    expect(awardEventPoints).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'comment',
        entityType: 'Article',
        entityId: 3,
        time: expect.any(Date),
        sourceId: `CommentV2:Article:3:${ACTOR}`,
      }),
    ]);
  });

  it('ignores comments on other entity types', async () => {
    hatted.add('Model:7');
    await onCommentCreated({ userId: ACTOR, entityType: 'model', entityId: 7, threadId: 70 });
    expect(awardEventPoints).not.toHaveBeenCalled();
  });

  it('removes once the actor has no comment left anywhere under the root thread', async () => {
    hatted.add('Image:7');
    db.thread.findMany.mockResolvedValue([
      { id: 70, rootThreadId: null, imageId: 7, articleId: null, rootThread: null },
    ]);
    db.commentV2.count.mockResolvedValueOnce(2).mockResolvedValueOnce(0);

    await onCommentsRemoved([{ userId: ACTOR, threadId: 70 }]);
    expect(removeEventPoints).not.toHaveBeenCalled();

    await onCommentsRemoved([{ userId: ACTOR, threadId: 70 }]);
    expect(removeEventPoints).toHaveBeenCalledWith([
      expect.objectContaining({ sourceId: `CommentV2:Image:7:${ACTOR}` }),
    ]);
    expect(db.commentV2.count).toHaveBeenLastCalledWith({
      where: { userId: ACTOR, thread: { OR: [{ id: 70 }, { rootThreadId: 70 }] } },
    });
  });
});

describe('placements', () => {
  const sticker = { surface: 'sticker', targetType: 'image', targetId: 7, placerId: ACTOR };

  it('awards an approved sticker and an accepted remix to the placer', async () => {
    hatted.add('Image:7');
    await onPlacementApproved(sticker);
    await onPlacementApproved({ ...sticker, surface: 'remixGallery' });
    expect(awardEventPoints.mock.calls).toEqual([
      [
        [
          {
            type: 'sticker',
            actorId: ACTOR,
            entityType: 'Image',
            entityId: 7,
            time: expect.any(Date),
            sourceId: `Placement:sticker:7:${ACTOR}`,
          },
        ],
      ],
      [[expect.objectContaining({ type: 'remix', sourceId: `Placement:remix:7:${ACTOR}` })]],
    ]);
  });

  it('ignores other surfaces and non-image targets', async () => {
    hatted.add('Image:7');
    await onPlacementApproved({ ...sticker, surface: 'galleryPromotion' });
    await onPlacementApproved({ ...sticker, targetType: 'model' });
    expect(awardEventPoints).not.toHaveBeenCalled();
  });

  it("removes a takedown only when it was the placer's last approved one on the image", async () => {
    hatted.add('Image:7');
    db.placement.findMany.mockResolvedValue([sticker]);
    db.placement.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await onPlacementsTakenDown([1]);
    expect(removeEventPoints).not.toHaveBeenCalled();

    await onPlacementsTakenDown([1]);
    expect(removeEventPoints).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'sticker', sourceId: `Placement:sticker:7:${ACTOR}` }),
    ]);
    expect(db.placement.count).toHaveBeenLastCalledWith({
      where: { ...sticker, status: 'approved' },
    });
  });
});

describe('model reviews', () => {
  const action = {
    type: 'modelLike',
    actorId: ACTOR,
    entityType: 'Model',
    entityId: 4,
    time: expect.any(Date),
    sourceId: `ResourceReview:4:${ACTOR}`,
  };

  it('awards while the actor recommends any version, removes once they recommend none', async () => {
    hatted.add('Model:4');
    db.resourceReview.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await onModelReviewsChanged([{ modelId: 4, userId: ACTOR }]);
    expect(awardEventPoints).toHaveBeenCalledWith([action]);
    expect(removeEventPoints).not.toHaveBeenCalled();

    await onModelReviewsChanged([{ modelId: 4, userId: ACTOR }]);
    expect(removeEventPoints).toHaveBeenCalledWith([action]);
    expect(db.resourceReview.count).toHaveBeenLastCalledWith({
      where: { modelId: 4, userId: ACTOR, recommended: true },
    });
  });

  it('does nothing for an unhatted model', async () => {
    await onModelReviewsChanged([{ modelId: 4, userId: ACTOR }]);
    expect(db.resourceReview.count).not.toHaveBeenCalled();
    expect(awardEventPoints).not.toHaveBeenCalled();
    expect(removeEventPoints).not.toHaveBeenCalled();
  });
});

describe('round 1', () => {
  it('awards nothing to a session from an API key or bearer token', async () => {
    await awardViewPoints(
      async () => ({ user: { id: ACTOR }, tokenScope: 1 } as never),
      [{ entityType: 'Image', entityId: 1 }]
    );
    expect(awardEventPoints).not.toHaveBeenCalled();
  });

  it('stamps an action with the time of the write, not of the query that follows it', async () => {
    vi.useFakeTimers();
    try {
      hatted.add('Image:7');
      const written = new Date('2026-10-20T10:00:00Z');
      vi.setSystemTime(written);
      let release!: (count: number) => void;
      db.imageReaction.count.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));

      const done = onReactionRemoved({ entityType: 'image', entityId: 7, userId: ACTOR });
      vi.setSystemTime(new Date('2026-10-20T10:00:05Z'));
      release(0);
      await done;

      expect(removeEventPoints).toHaveBeenCalledWith([expect.objectContaining({ time: written })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads every deleted comment's thread in one query and removes once per actor and root", async () => {
    hatted.add('Image:7');
    db.thread.findMany.mockResolvedValue([
      { id: 70, rootThreadId: null, imageId: 7, articleId: null, rootThread: null },
      { id: 71, rootThreadId: 70, imageId: null, articleId: null, rootThread: { imageId: 7 } },
    ]);
    db.commentV2.count.mockResolvedValue(0);

    await onCommentsRemoved([
      { userId: ACTOR, threadId: 70 },
      { userId: ACTOR, threadId: 71 },
      { userId: ACTOR, threadId: 70 },
    ]);

    expect(db.thread.findMany).toHaveBeenCalledTimes(1);
    expect(db.thread.findMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: [70, 71] } } });
    expect(db.commentV2.count).toHaveBeenCalledTimes(1);
    expect(removeEventPoints).toHaveBeenCalledTimes(1);
  });

  it('skips the remaining-rows query for a comment on unhatted content', async () => {
    db.thread.findMany.mockResolvedValue([
      { id: 70, rootThreadId: null, imageId: 7, articleId: null, rootThread: null },
    ]);
    await onCommentsRemoved([{ userId: ACTOR, threadId: 70 }]);
    expect(db.commentV2.count).not.toHaveBeenCalled();
    expect(removeEventPoints).not.toHaveBeenCalled();
  });

  it('removes a placer once however many of their placements on the image came down', async () => {
    hatted.add('Image:7');
    const sticker = { surface: 'sticker', targetType: 'image', targetId: 7, placerId: ACTOR };
    db.placement.findMany.mockResolvedValue([sticker, sticker]);
    db.placement.count.mockResolvedValue(0);

    await onPlacementsTakenDown([1, 2]);

    expect(db.placement.count).toHaveBeenCalledTimes(1);
    expect(removeEventPoints).toHaveBeenCalledTimes(1);
  });

  it('skips the remaining-rows query for a takedown on an unhatted image', async () => {
    db.placement.findMany.mockResolvedValue([
      { surface: 'sticker', targetType: 'image', targetId: 7, placerId: ACTOR },
    ]);
    await onPlacementsTakenDown([1]);
    expect(db.placement.count).not.toHaveBeenCalled();
    expect(removeEventPoints).not.toHaveBeenCalled();
  });
});

describe('round 3', () => {
  const batch = (...entities: { entityType: string; entityId: number }[]) =>
    [
      { kind: 'impression', data: { sessionKey: 'k', surface: 'images', entities } },
    ] as unknown as TrackBatchInput;

  it('awards each hatted entity in a batch once', () => {
    hatted.add('Image:1');
    expect(
      hattedImpressionEntities(
        batch({ entityType: 'Image', entityId: 1 }, { entityType: 'Image', entityId: 1 })
      )
    ).toEqual([{ entityType: 'Image', entityId: 1 }]);
  });

  it('caps the hatted entities one batch can award', () => {
    const entities = Array.from({ length: 300 }, (_, i) => ({ entityType: 'Image', entityId: i }));
    for (const { entityId } of entities) hatted.add(`Image:${entityId}`);
    expect(hattedImpressionEntities(batch(...entities))).toHaveLength(250);
  });

  it("passes the viewer's account dates as dates, even when the session carries strings", async () => {
    const createdAt = '2026-01-02T00:00:00.000Z';
    const bannedAt = '2026-03-04T00:00:00.000Z';
    await awardViewPoints(
      async () => ({ user: { id: ACTOR, createdAt, bannedAt } } as never),
      [{ entityType: 'Image', entityId: 1 }]
    );
    const [[[action]]] = awardEventPoints.mock.calls as unknown as [[[{ actor: unknown }]]];
    expect(action.actor).toStrictEqual({
      createdAt: new Date(createdAt),
      bannedAt: new Date(bannedAt),
    });
  });
});

describe('round 4', () => {
  const events = (...batches: { entityType: string; entityId: number }[][]) =>
    batches.map((entities) => ({
      kind: 'impression',
      data: { sessionKey: 'k', surface: 'images', entities },
    })) as unknown as TrackBatchInput;

  it('dedupes across events by type and id, keeping same-id entities of other types', () => {
    hatted.add('Image:1').add('Model:1');
    expect(
      hattedImpressionEntities(
        events(
          [{ entityType: 'Image', entityId: 1 }],
          [
            { entityType: 'Image', entityId: 1 },
            { entityType: 'Model', entityId: 1 },
          ]
        )
      )
    ).toEqual([
      { entityType: 'Image', entityId: 1 },
      { entityType: 'Model', entityId: 1 },
    ]);
  });

  it('counts distinct entities toward the cap, across events', () => {
    const repeats = Array.from({ length: 300 }, () => ({ entityType: 'Image', entityId: 0 }));
    const distinct = Array.from({ length: 250 }, (_, i) => ({ entityType: 'Image', entityId: i }));
    for (const { entityId } of distinct) hatted.add(`Image:${entityId}`);

    const result = hattedImpressionEntities(events(repeats, distinct));

    expect(result).toHaveLength(250);
    expect(new Set(result.map(({ entityId }) => entityId)).size).toBe(250);
  });

  it('passes an unbanned viewer as unbanned: a null ban date stays null', async () => {
    const createdAt = '2026-01-02T00:00:00.000Z';
    await awardViewPoints(
      async () => ({ user: { id: ACTOR, createdAt, bannedAt: null } } as never),
      [{ entityType: 'Image', entityId: 1 }]
    );
    const [[[action]]] = awardEventPoints.mock.calls as unknown as [[[{ actor: unknown }]]];
    expect(action.actor).toStrictEqual({ createdAt: new Date(createdAt), bannedAt: null });
  });
});
