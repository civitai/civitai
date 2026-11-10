// Where actions on the site turn into event points. Each write site calls one of these with `void`:
// they never throw and are never awaited, so a points failure cannot fail or slow the reaction,
// comment, approval or tracking request it rides on.
//
// Every award and removal is gated on `isHattedEntity`, an in-memory check (true for a hat or a Hat
// Turf leader), so content that earns nothing costs nothing past that check. The one exception is a comment reply or a deleted
// comment, whose thread must be read to learn which Image or Article it belongs to.
//
// Each action carries `time`, taken synchronously at the write site, so two quick opposite writes
// (react then un-react) order by when they happened, not by which hook's query finished first.
//
// A removal is sent only when the actor's LAST qualifying row on the entity goes (their last
// reaction, comment, approved sticker, recommended review), so `sourceId` is one per
// (kind, entity, actor) and an add and its removal always pair. Accepted limitation: if the hat
// came off before the removal, the gate skips it and no removal is sent.
import { Prisma } from '@prisma/client';
import { kyselyWrite } from '~/server/db/kyselyDb';
import type { TrackBatchInput } from '~/server/schema/track.schema';
import type { PlacementSurface, PlacementTargetType } from '~/shared/utils/placement';
import type { Session } from '~/types/session';
import { dbWrite } from '~/server/db/client';
import { sysRedis } from '~/server/redis/client';
import { loadEvents } from '~/server/events/load-events';
import { handleLogError } from '~/server/utils/errorHandling';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import {
  awardEventPoints,
  hasTurfMark,
  isHattedEntity,
  isHattedEntityOnceLoaded,
  removeEventPoints,
  type EventPointGrant,
} from './award';
import { isEventPointsEnabledSync } from './enabled';
import { storySparksScoredKey, utcDay } from './keys';
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
  const hatted: Entity[] = [];
  if (!isEventPointsEnabledSync()) return hatted;
  let seen: Set<string> | undefined;
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
  // A turf lead can end between the add and its removal; the earned mark still finds it.
  if (
    !(await isHattedEntityOnceLoaded(action.entityType, action.entityId)) &&
    !(await hasTurfMark(action))
  )
    return;
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

/**
 * Awards the reaction's points. The returned promise resolves with the live grants as soon as they
 * are known, before the ledger insert, or with none once the award ends without any. Never rejects.
 */
export function onReactionCreated(input: ReactionInput): Promise<EventPointGrant[]> {
  const time = new Date();
  return new Promise((resolve) => {
    const award = async () => {
      const action = reactionTarget(input, time);
      if (!action || !isHattedEntity(action.entityType, action.entityId)) return;
      await awardEventPoints([action], resolve);
    };
    award()
      .catch(swallow('event-points:reaction'))
      .finally(() => resolve([]));
  });
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

/** The actor's live comments on the entity, at any depth. On the primary: it runs right after a delete. */
export async function liveCommentsOn(userId: number, { entityType, entityId }: Entity) {
  const row = await kyselyWrite
    .selectFrom('CommentV3')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('userId', '=', userId)
    .where('entityType', '=', entityType === 'Image' ? 'image' : 'article')
    .where('entityId', '=', entityId)
    .where('deletedAt', 'is', null)
    .where('tosViolation', '=', false)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

const commentAction = (userId: number, { entityType, entityId }: Entity, time: Date) => ({
  type: 'comment' as const,
  actorId: userId,
  entityType,
  entityId,
  time,
  sourceId: `CommentV2:${entityType}:${entityId}:${userId}`,
});

/** A new comment, reply or not, named by its section's entity. */
export async function onCommentCreated({
  userId,
  entityType,
  entityId,
}: {
  userId: number;
  entityType: string;
  entityId: number;
}): Promise<void> {
  const time = new Date();
  try {
    let target: Entity | undefined;
    if (entityType === 'image') target = { entityType: 'Image', entityId };
    else if (entityType === 'article') target = { entityType: 'Article', entityId };
    if (!target || !isHattedEntity(target.entityType, target.entityId)) return;
    await awardEventPoints([commentAction(userId, target, time)]);
  } catch (error) {
    swallow('event-points:comment')(error);
  }
}

/** Deleted CommentV3 comments, as `{ userId, entityType, entityId }` of each removed row. */
export async function onTopicCommentsRemoved(
  comments: { userId: number; entityType: string; entityId: number }[]
): Promise<void> {
  const time = new Date();
  try {
    const seen = new Set<string>();
    for (const { userId, entityType, entityId } of comments) {
      const root: Entity | undefined =
        entityType === 'image'
          ? { entityType: 'Image', entityId }
          : entityType === 'article'
          ? { entityType: 'Article', entityId }
          : undefined;
      if (!root) continue;
      const action = commentAction(userId, root, time);
      if (seen.has(action.sourceId)) continue;
      seen.add(action.sourceId);
      await removeIfLast(action, () => liveCommentsOn(userId, root));
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

const placementSourceId = (
  type: Extract<EventPointType, 'sticker' | 'remix'>,
  imageId: number,
  placerId: number
) => `Placement:${type}:${imageId}:${placerId}`;

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
    sourceId: placementSourceId(type, targetId, placerId),
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
        action.type === 'remix'
          ? remixEarnersLeft(row.placerId, row.targetId)
          : dbWrite.placement.count({
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

// #region story sparks
// A story started from a hatted image (its spark) scores as that image's remix, for the storyline's
// owner. It shares the accepted remix's sourceId, so one person earns the remix once per image
// whether they remix it, write a story from it, or both, and the points go only when neither is left.

const remixAction = (actorId: number, imageId: number, time: Date) => ({
  type: 'remix' as const,
  actorId,
  entityType: 'Image' as const,
  entityId: imageId,
  time,
  sourceId: placementSourceId('remix', imageId, actorId),
});

type LiveSparkedStory = { storylineId: number; actorId: number; imageId: number };

/**
 * Storylines whose spark scores: up, started from someone else's image, chapter 1 there and shown
 * to readers (published, not removed or taken down). `where` narrows them, over `st` and chapter 1
 * `rc`.
 */
async function liveSparkedStories(where: Prisma.Sql): Promise<LiveSparkedStory[]> {
  // Imported on use: the storyline layer imports this module.
  const { storylineRootVisibleSql } = await import('~/server/services/storyline.service');
  return dbWrite.$queryRaw<LiveSparkedStory[]>`
    SELECT st.id AS "storylineId", st."userId" AS "actorId", st."sparkImageId" AS "imageId"
    FROM "Storyline" st
    JOIN "Image" i ON i.id = st."sparkImageId"
    JOIN "StorylineChapter" rc ON rc."storylineId" = st.id AND rc.depth = 0
    LEFT JOIN "Post" rp ON rp.id = rc."postId"
    LEFT JOIN "User" ru ON ru.id = rp."userId"
    WHERE st."tosViolation" = false AND i."userId" <> st."userId"
      AND ${storylineRootVisibleSql} AND ${where}
  `;
}

/** What still earns this person the remix on this image: approved remixes and live sparked stories. */
async function remixEarnersLeft(actorId: number, imageId: number) {
  const [placements, stories] = await Promise.all([
    dbWrite.placement.count({
      where: {
        surface: 'remixGallery',
        targetType: IMAGE_TARGET,
        targetId: imageId,
        placerId: actorId,
        status: 'approved',
      },
    }),
    liveSparkedStories(Prisma.sql`st."userId" = ${actorId} AND st."sparkImageId" = ${imageId}`),
  ]);
  return placements + stories.length;
}

// The fewest scoring sparks per person per UTC day of any registered event that sets one, whether
// or not it is running; with none set, stories do not score.
async function storySparksPerDay() {
  const caps = (await loadEvents())
    .map((e) => e.scoring?.storySparksPerActorPerDay)
    .filter((cap): cap is number => cap !== undefined);
  return caps.length ? Math.min(...caps) : 0;
}

const STORY_SPARKS_SCORED_TTL = 2 * 24 * 60 * 60;

/**
 * Chapter 1 of a storyline was just written, or the storyline came back up. Call after the write
 * commits. Scores the spark if the story is live and its owner has not used up the day's scoring
 * sparks: their stories that scored today. A slot stays used when its story is later hidden or
 * deleted, since the remix it earned can outlive it. A repeat (the remix already held, a second
 * restore) records nothing and uses no slot.
 */
export async function onStorySparked(storylineId: number): Promise<void> {
  const time = new Date();
  try {
    const perDay = await storySparksPerDay();
    if (!perDay) return;
    const [story] = await liveSparkedStories(Prisma.sql`st.id = ${storylineId}`);
    if (!story || !isHattedEntity('Image', story.imageId)) return;
    const day = utcDay(time);
    const key = storySparksScoredKey(story.actorId, day);
    // One writer's stories at a time, so parallel creates cannot all pass the cap. Not acquired
    // within the retries: the story does not score.
    await withDistributedLock(
      { key: `story-spark-cap:${story.actorId}:${day}`, maxRetries: 50, autoRenew: true },
      async () => {
        const scored = (await sysRedis.sMembers(key)).filter((id) => id !== String(storylineId));
        if (scored.length >= perDay) return;
        // Reserve the slot before awarding; give it back if the award records nothing.
        const reserved = (await sysRedis.sAdd(key, String(storylineId))) === 1;
        await sysRedis.expire(key, STORY_SPARKS_SCORED_TTL);
        let firsts = 0;
        try {
          firsts = await awardEventPoints([remixAction(story.actorId, story.imageId, time)]);
        } finally {
          if (reserved && !firsts) await sysRedis.sRem(key, String(storylineId));
        }
      }
    );
  } catch (error) {
    swallow('event-points:story-spark')(error);
  }
}

/**
 * A sparked story stopped being live: chapter 1 removed, the storyline taken down or deleted. Call
 * after the write commits, with the storyline's owner and spark read before it (a delete leaves
 * nothing to read).
 */
export async function onStorySparkRemoved({
  actorId,
  imageId,
}: {
  actorId: number;
  imageId: number | null;
}): Promise<void> {
  const time = new Date();
  try {
    if (!imageId) return;
    await removeIfLast(remixAction(actorId, imageId, time), () =>
      remixEarnersLeft(actorId, imageId)
    );
  } catch (error) {
    swallow('event-points:story-spark')(error);
  }
}

/** `onStorySparkRemoved` for a storyline that still exists. */
export async function onStorySparkLost(storylineId: number): Promise<void> {
  try {
    const storyline = await dbWrite.storyline.findUnique({
      where: { id: storylineId },
      select: { userId: true, sparkImageId: true },
    });
    if (storyline)
      await onStorySparkRemoved({ actorId: storyline.userId, imageId: storyline.sparkImageId });
  } catch (error) {
    swallow('event-points:story-spark')(error);
  }
}

type StorySparkPosts = { postIds: number[] } | { modelVersionIds: number[] } | { authorId: number };

// Over chapter 1 `rc`; undefined when there is nothing to match.
const storySparkPostsWhere = (by: StorySparkPosts) =>
  'postIds' in by
    ? by.postIds.length
      ? Prisma.sql`rc."postId" = ANY(${by.postIds}::int[])`
      : undefined
    : 'modelVersionIds' in by
    ? by.modelVersionIds.length
      ? Prisma.sql`rc."postId" IN (SELECT id FROM "Post" WHERE "modelVersionId" = ANY(${by.modelVersionIds}::int[]))`
      : undefined
    : Prisma.sql`rc."userId" = ${by.authorId}`;

/**
 * Chapter 1 of these sparked stories may no longer be shown: a moderation or account write hid it
 * (unpublished, rated Blocked, its model taken down, its author banned or deleted). Call after the
 * write commits; it never throws. Each story's remix goes only if nothing else still earns it, so
 * a story that is still live keeps it.
 */
export async function onStorySparkPostsHidden(by: StorySparkPosts): Promise<void> {
  try {
    const where = storySparkPostsWhere(by);
    if (!where || !(await storySparksPerDay())) return;
    const sparks = await dbWrite.$queryRaw<{ actorId: number; imageId: number }[]>`
      SELECT DISTINCT st."userId" AS "actorId", st."sparkImageId" AS "imageId"
      FROM "StorylineChapter" rc
      JOIN "Storyline" st ON st.id = rc."storylineId"
      WHERE rc.depth = 0 AND st."sparkImageId" IS NOT NULL AND ${where}
    `;
    for (const spark of sparks) await onStorySparkRemoved(spark);
  } catch (error) {
    swallow('event-points:story-spark')(error);
  }
}

/**
 * The reverse of `onStorySparkPostsHidden`: a write that may show chapter 1 of these sparked
 * stories again (republished, rated again, its model back up, its author unbanned). Call after the
 * write commits, without awaiting. Each story scores again only if it is live now and the day's cap
 * allows; one that never lost its points records nothing.
 */
export async function onStorySparkPostsRestored(by: StorySparkPosts): Promise<void> {
  try {
    const where = storySparkPostsWhere(by);
    if (!where || !(await storySparksPerDay())) return;
    const stories = await dbWrite.$queryRaw<{ storylineId: number }[]>`
      SELECT DISTINCT rc."storylineId"
      FROM "StorylineChapter" rc
      JOIN "Storyline" st ON st.id = rc."storylineId"
      WHERE rc.depth = 0 AND st."sparkImageId" IS NOT NULL AND ${where}
    `;
    for (const { storylineId } of stories) await onStorySparked(storylineId);
  } catch (error) {
    swallow('event-points:story-spark')(error);
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
      if (!(await isHattedEntityOnceLoaded('Model', modelId))) continue;
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
