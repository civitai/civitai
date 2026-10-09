// Where actions on the site turn into event points. Each write site calls one of these with `void`:
// they never throw and are never awaited, so a points failure cannot fail or slow the reaction,
// comment, approval or tracking request it rides on.
//
// Every award and removal is gated on `isHattedEntity`, an in-memory check, so content without an
// event hat costs nothing past that check.
//
// A removal is sent only when the actor's LAST qualifying row on the entity goes (their last
// reaction, comment, approved sticker, recommended review), so `sourceId` is one per
// (kind, entity, actor) and an add and its removal always pair. Accepted limitation: if the hat
// came off before the removal, the gate skips it and no removal is sent.
import type { TrackBatchInput } from '~/server/schema/track.schema';
import type { Session } from '~/types/session';
import { dbWrite } from '~/server/db/client';
import { handleLogError } from '~/server/utils/errorHandling';
import { awardEventPoints, isHattedEntity, removeEventPoints } from './award';
import type { EventPointAction, EventPointEntityType, EventPointType } from './types';

const POINT_ENTITY_TYPES: ReadonlySet<string> = new Set<EventPointEntityType>([
  'Image',
  'Model',
  'Article',
]);

const isPointEntityType = (entityType: string): entityType is EventPointEntityType =>
  POINT_ENTITY_TYPES.has(entityType);

const swallow = (name: string) => (error: unknown) =>
  handleLogError(error instanceof Error ? error : new Error(String(error)), name);

type Entity = { entityType: EventPointEntityType; entityId: number };

// #region views
/**
 * The hatted entities in a tracking batch's impressions. Synchronous and allocation-free for a
 * batch with no hatted entity, which is nearly every batch: this runs on every impression flush.
 */
export function hattedImpressionEntities(events: TrackBatchInput): Entity[] {
  let hatted: Entity[] | undefined;
  for (const event of events) {
    if (event.kind !== 'impression') continue;
    for (const { entityType, entityId } of event.data.entities) {
      if (!isPointEntityType(entityType) || !isHattedEntity(entityType, entityId)) continue;
      (hatted ??= []).push({ entityType, entityId });
    }
  }
  return hatted ?? [];
}

/** Views of hatted entities, for a signed-in viewer only. Resolves the session itself. */
export async function awardViewPoints(
  getSession: () => Promise<Session | null>,
  entities: Entity[]
): Promise<void> {
  try {
    if (!entities.length) return;
    const user = (await getSession())?.user;
    if (!user?.id) return;
    await awardEventPoints(
      entities.map(({ entityType, entityId }) => ({
        type: 'view',
        actorId: user.id,
        entityType,
        entityId,
      }))
    );
  } catch (error) {
    swallow('event-points:views')(error);
  }
}
// #endregion

// Gates on the hat, runs `stillHas` (the actor's remaining qualifying rows), and removes when none
// remain.
async function removeIfLast(
  action: Required<
    Pick<EventPointAction, 'type' | 'actorId' | 'entityType' | 'entityId' | 'sourceId'>
  >,
  stillHas: () => Promise<number>
) {
  if (!isHattedEntity(action.entityType, action.entityId)) return;
  if ((await stillHas()) > 0) return;
  await removeEventPoints([action]);
}

// #region reactions
const REACTION_ENTITIES = {
  image: { entityType: 'Image', kind: 'ImageReaction' },
  article: { entityType: 'Article', kind: 'ArticleReaction' },
} as const;

type ReactionInput = { entityType: string; entityId: number; userId: number };

const reactionTarget = ({ entityType, entityId, userId }: ReactionInput) => {
  const target = REACTION_ENTITIES[entityType as keyof typeof REACTION_ENTITIES];
  if (!target) return undefined;
  return {
    type: 'reaction' as const,
    actorId: userId,
    entityType: target.entityType,
    entityId,
    sourceId: `${target.kind}:${entityId}:${userId}`,
  };
};

export async function onReactionCreated(input: ReactionInput): Promise<void> {
  try {
    const action = reactionTarget(input);
    if (!action || !isHattedEntity(action.entityType, action.entityId)) return;
    await awardEventPoints([action]);
  } catch (error) {
    swallow('event-points:reaction')(error);
  }
}

export async function onReactionRemoved(input: ReactionInput): Promise<void> {
  try {
    const action = reactionTarget(input);
    if (!action) return;
    const { entityId, userId } = input;
    await removeIfLast(action, () =>
      action.entityType === 'Image'
        ? dbWrite.imageReaction.count({ where: { imageId: entityId, userId } })
        : dbWrite.articleReaction.count({ where: { articleId: entityId, userId } })
    );
  } catch (error) {
    swallow('event-points:reaction')(error);
  }
}
// #endregion

// #region comments
// A reply's thread hangs off a comment; its root thread is the one on the Image or Article.
async function commentRoot(threadId: number) {
  const thread = await dbWrite.thread.findUnique({
    where: { id: threadId },
    select: {
      id: true,
      rootThreadId: true,
      imageId: true,
      articleId: true,
      rootThread: { select: { imageId: true, articleId: true } },
    },
  });
  if (!thread) return undefined;
  const root = thread.rootThreadId ? thread.rootThread : thread;
  const rootThreadId = thread.rootThreadId ?? thread.id;
  if (root?.imageId) return { rootThreadId, entityType: 'Image' as const, entityId: root.imageId };
  if (root?.articleId)
    return { rootThreadId, entityType: 'Article' as const, entityId: root.articleId };
  return undefined;
}

const commentAction = (userId: number, { entityType, entityId }: Entity) => ({
  type: 'comment' as const,
  actorId: userId,
  entityType,
  entityId,
  sourceId: `CommentV2:${entityType}:${entityId}:${userId}`,
});

/**
 * A new comment. Top-level comments on an Image or Article name their entity directly; a reply
 * (`entityType: 'comment'`) is resolved through its thread to the root entity.
 */
export async function onCommentCreated({
  userId,
  entityType,
  entityId,
  threadId,
}: {
  userId: number;
  entityType: string;
  entityId: number;
  threadId: number;
}): Promise<void> {
  try {
    let target: Entity | undefined;
    if (entityType === 'image') target = { entityType: 'Image', entityId };
    else if (entityType === 'article') target = { entityType: 'Article', entityId };
    else if (entityType === 'comment') target = await commentRoot(threadId);
    if (!target || !isHattedEntity(target.entityType, target.entityId)) return;
    await awardEventPoints([commentAction(userId, target)]);
  } catch (error) {
    swallow('event-points:comment')(error);
  }
}

/** Deleted comments, as `{ userId, threadId }` of each removed row. */
export async function onCommentsRemoved(
  comments: { userId: number; threadId: number }[]
): Promise<void> {
  try {
    const seen = new Set<string>();
    for (const { userId, threadId } of comments) {
      const root = await commentRoot(threadId);
      if (!root) continue;
      const key = `${root.rootThreadId}:${userId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await removeIfLast(commentAction(userId, root), () =>
        dbWrite.commentV2.count({
          where: {
            userId,
            thread: { OR: [{ id: root.rootThreadId }, { rootThreadId: root.rootThreadId }] },
          },
        })
      );
    }
  } catch (error) {
    swallow('event-points:comment')(error);
  }
}
// #endregion

// #region placements
const PLACEMENT_TYPES: Record<string, Extract<EventPointType, 'sticker' | 'remix'>> = {
  sticker: 'sticker',
  remixGallery: 'remix',
};

type PlacementLike = { surface: string; targetType: string; targetId: number; placerId: number };

const placementAction = ({ surface, targetType, targetId, placerId }: PlacementLike) => {
  const type = PLACEMENT_TYPES[surface];
  if (!type || targetType !== 'image') return undefined;
  return {
    type,
    actorId: placerId,
    entityType: 'Image' as const,
    entityId: targetId,
    sourceId: `Placement:${type}:${targetId}:${placerId}`,
  };
};

/** An owner approved a placement: a sticker or an accepted remix on their image. */
export async function onPlacementApproved(placement: PlacementLike): Promise<void> {
  try {
    const action = placementAction(placement);
    if (!action || !isHattedEntity(action.entityType, action.entityId)) return;
    await awardEventPoints([action]);
  } catch (error) {
    swallow('event-points:placement')(error);
  }
}

/** Approved placements taken down (by the owner, a moderator, or a cosmetic takedown). */
export async function onPlacementsTakenDown(placementIds: number[]): Promise<void> {
  try {
    if (!placementIds.length) return;
    const rows = await dbWrite.placement.findMany({
      where: { id: { in: placementIds }, surface: { in: Object.keys(PLACEMENT_TYPES) } },
      select: { surface: true, targetType: true, targetId: true, placerId: true },
    });
    const seen = new Set<string>();
    for (const row of rows) {
      const action = placementAction(row);
      if (!action || seen.has(action.sourceId)) continue;
      seen.add(action.sourceId);
      await removeIfLast(action, () =>
        dbWrite.placement.count({
          where: {
            surface: row.surface,
            targetType: row.targetType,
            targetId: row.targetId,
            placerId: row.placerId,
            status: 'approved',
          },
        })
      );
    }
  } catch (error) {
    swallow('event-points:placement')(error);
  }
}
// #endregion

// #region model reviews
/**
 * A person's resource reviews on a model changed (created, edited, deleted). Awards a model thumbs
 * up while they still recommend any version of it, and removes it once they recommend none.
 */
export async function onModelReviewsChanged(
  reviews: { modelId: number; userId: number }[]
): Promise<void> {
  try {
    const seen = new Set<string>();
    for (const { modelId, userId } of reviews) {
      const key = `${modelId}:${userId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!isHattedEntity('Model', modelId)) continue;
      const action = {
        type: 'modelLike' as const,
        actorId: userId,
        entityType: 'Model' as const,
        entityId: modelId,
        sourceId: `ResourceReview:${modelId}:${userId}`,
      };
      const recommended = await dbWrite.resourceReview.count({
        where: { modelId, userId, recommended: true },
      });
      if (recommended > 0) await awardEventPoints([action]);
      else await removeEventPoints([action]);
    }
  } catch (error) {
    swallow('event-points:model-review')(error);
  }
}
// #endregion
