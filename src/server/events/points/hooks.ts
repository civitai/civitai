// Where actions on the site turn into event points. Each write site calls one of these with `void`:
// they never throw and are never awaited, so a points failure cannot fail or slow the reaction,
// comment, approval or tracking request it rides on.
//
// Every award and removal is gated on `isHattedEntity`, an in-memory check, so content without an
// event hat costs nothing past that check. The one exception is a comment reply or a deleted
// comment, whose thread must be read to learn which Image or Article it belongs to.
//
// Each action carries `time`, taken synchronously at the write site, so two quick opposite writes
// (react then un-react) order by when they happened, not by which hook's query finished first.
//
// A removal is sent only when the actor's LAST qualifying row on the entity goes (their last
// reaction, comment, approved sticker, recommended review), so `sourceId` is one per
// (kind, entity, actor) and an add and its removal always pair. Accepted limitation: if the hat
// came off before the removal, the gate skips it and no removal is sent.
import type { TrackBatchInput } from '~/server/schema/track.schema';
import type { PlacementSurface, PlacementTargetType } from '~/shared/utils/placement';
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
// Most hatted entities one tracking batch can award. A batch may carry 25,000 entities and hat ids
// are public, so without a ceiling one request could fan out into tens of thousands of Redis calls.
export const MAX_HATTED_VIEWS_PER_BATCH = 250;

/**
 * The distinct hatted entities in a tracking batch's impressions, at most
 * MAX_HATTED_VIEWS_PER_BATCH. Synchronous, and a batch with no hatted entity (nearly every batch:
 * this runs on every impression flush) allocates only the empty result.
 */
export function hattedImpressionEntities(events: TrackBatchInput): Entity[] {
  let seen: Set<string> | undefined;
  const hatted: Entity[] = [];
  for (const event of events) {
    if (event.kind !== 'impression') continue;
    for (const { entityType, entityId } of event.data.entities) {
      if (!isPointEntityType(entityType) || !isHattedEntity(entityType, entityId)) continue;
      const key = `${entityType}:${entityId}`;
      if ((seen ??= new Set()).has(key)) continue;
      seen.add(key);
      hatted.push({ entityType, entityId });
      if (hatted.length >= MAX_HATTED_VIEWS_PER_BATCH) return hatted;
    }
  }
  return hatted;
}

// Session dates arrive as ISO strings when the session came from the auth hub rather than a cache.
const toDate = (value: Date | string | null | undefined) =>
  value == null ? value : new Date(value);

/**
 * Views of hatted entities, for a signed-in viewer only. Resolves the session itself. A session from
 * an API key or bearer token earns nothing: the beacon is a browser route, and a token caller can
 * post impressions it never saw.
 */
export async function awardViewPoints(
  getSession: () => Promise<Session | null>,
  entities: Entity[]
): Promise<void> {
  try {
    if (!entities.length) return;
    const session = await getSession();
    if (!session || 'tokenScope' in session) return;
    const user = session.user;
    if (!user?.id) return;
    // Lets the live total skip new and banned accounts at once, not only at the hourly referee.
    const actor = { createdAt: toDate(user.createdAt), bannedAt: toDate(user.bannedAt) };
    await awardEventPoints(
      entities.map(({ entityType, entityId }) => ({
        type: 'view',
        actorId: user.id,
        actor,
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
  > &
    Pick<EventPointAction, 'time'>,
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

const reactionTarget = ({ entityType, entityId, userId }: ReactionInput, time: Date) => {
  const target = REACTION_ENTITIES[entityType as keyof typeof REACTION_ENTITIES];
  if (!target) return undefined;
  return {
    type: 'reaction' as const,
    actorId: userId,
    entityType: target.entityType,
    entityId,
    time,
    sourceId: `${target.kind}:${entityId}:${userId}`,
  };
};

export async function onReactionCreated(input: ReactionInput): Promise<void> {
  const time = new Date();
  try {
    const action = reactionTarget(input, time);
    if (!action || !isHattedEntity(action.entityType, action.entityId)) return;
    await awardEventPoints([action]);
  } catch (error) {
    swallow('event-points:reaction')(error);
  }
}

export async function onReactionRemoved(input: ReactionInput): Promise<void> {
  const time = new Date();
  try {
    const action = reactionTarget(input, time);
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
type CommentRoot = Entity & { rootThreadId: number };

// The Image or Article each thread hangs off, through `Thread.rootThreadId` for a reply's thread.
// That column is server-derived from the parent comment on create; older rows written from client
// input may point elsewhere, which here can only misattribute a reply's points, never grant more.
async function commentRoots(threadIds: number[]) {
  const threads = await dbWrite.thread.findMany({
    where: { id: { in: threadIds } },
    select: {
      id: true,
      rootThreadId: true,
      imageId: true,
      articleId: true,
      rootThread: { select: { imageId: true, articleId: true } },
    },
  });
  const roots = new Map<number, CommentRoot>();
  for (const thread of threads) {
    const root = thread.rootThreadId ? thread.rootThread : thread;
    const rootThreadId = thread.rootThreadId ?? thread.id;
    if (root?.imageId)
      roots.set(thread.id, { rootThreadId, entityType: 'Image', entityId: root.imageId });
    else if (root?.articleId)
      roots.set(thread.id, { rootThreadId, entityType: 'Article', entityId: root.articleId });
  }
  return roots;
}

const commentAction = (userId: number, { entityType, entityId }: Entity, time: Date) => ({
  type: 'comment' as const,
  actorId: userId,
  entityType,
  entityId,
  time,
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
  const time = new Date();
  try {
    let target: Entity | undefined;
    if (entityType === 'image') target = { entityType: 'Image', entityId };
    else if (entityType === 'article') target = { entityType: 'Article', entityId };
    else if (entityType === 'comment') target = (await commentRoots([threadId])).get(threadId);
    if (!target || !isHattedEntity(target.entityType, target.entityId)) return;
    await awardEventPoints([commentAction(userId, target, time)]);
  } catch (error) {
    swallow('event-points:comment')(error);
  }
}

/** Deleted comments, as `{ userId, threadId }` of each removed row. */
export async function onCommentsRemoved(
  comments: { userId: number; threadId: number }[]
): Promise<void> {
  const time = new Date();
  try {
    if (!comments.length) return;
    // One read for every thread, before any per-comment work.
    const roots = await commentRoots([...new Set(comments.map(({ threadId }) => threadId))]);
    const seen = new Set<string>();
    for (const { userId, threadId } of comments) {
      const root = roots.get(threadId);
      if (!root) continue;
      const action = commentAction(userId, root, time);
      if (seen.has(action.sourceId)) continue;
      seen.add(action.sourceId);
      await removeIfLast(action, () =>
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
const PLACEMENT_TYPES: Partial<
  Record<PlacementSurface, Extract<EventPointType, 'sticker' | 'remix'>>
> = {
  sticker: 'sticker',
  remixGallery: 'remix',
};
const IMAGE_TARGET: PlacementTargetType = 'image';

type PlacementLike = { surface: string; targetType: string; targetId: number; placerId: number };

const placementAction = (
  { surface, targetType, targetId, placerId }: PlacementLike,
  time: Date
) => {
  const type = PLACEMENT_TYPES[surface as PlacementSurface];
  if (!type || targetType !== IMAGE_TARGET) return undefined;
  return {
    type,
    actorId: placerId,
    entityType: 'Image' as const,
    entityId: targetId,
    time,
    sourceId: `Placement:${type}:${targetId}:${placerId}`,
  };
};

/** An owner approved a placement: a sticker or an accepted remix on their image. */
export async function onPlacementApproved(placement: PlacementLike): Promise<void> {
  const time = new Date();
  try {
    const action = placementAction(placement, time);
    if (!action || !isHattedEntity(action.entityType, action.entityId)) return;
    await awardEventPoints([action]);
  } catch (error) {
    swallow('event-points:placement')(error);
  }
}

/** Approved placements taken down (by the owner, a moderator, or a cosmetic takedown). */
export async function onPlacementsTakenDown(placementIds: number[]): Promise<void> {
  const time = new Date();
  try {
    if (!placementIds.length) return;
    const rows = await dbWrite.placement.findMany({
      where: { id: { in: placementIds }, surface: { in: Object.keys(PLACEMENT_TYPES) } },
      select: { surface: true, targetType: true, targetId: true, placerId: true },
    });
    const seen = new Set<string>();
    for (const row of rows) {
      const action = placementAction(row, time);
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
  const time = new Date();
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
        time,
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
