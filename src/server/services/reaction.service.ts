import { throwBadRequestError } from '~/server/utils/errorHandling';
import type { ToggleReactionInput, ReactionEntityType } from './../schema/reaction.schema';
import { dbWrite } from '~/server/db/client';
import { getDbWithoutLag, getKyselyWithoutLag } from '~/server/db/db-lag-helpers';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  readImageReactionIdViaKysely,
  readImageReactionIdViaPrisma,
} from '~/server/services/hot-reads-5.reads';
import {
  answerMetrics,
  articleMetrics,
  bountyEntryMetrics,
  postMetrics,
  questionMetrics,
} from '~/server/metrics';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';
import { throwIfBlockedByEntityOwner } from '~/server/services/block-check.service';
import { onReactionCreated, onReactionRemoved } from '~/server/events/points/hooks';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';

// A second toggle on the same reaction this soon after the first is a client double-fire, not a
// decision: double-fires land under 50 ms, while people clicking twice mostly take 300 ms or more.
export const REVERSE_TOGGLE_WINDOW_MS = 150;
const TOGGLE_GUARD_TIMEOUT_MS = 100;

let toggleGuardErrorLogged = false;
// False when another toggle on this tuple arrived inside the window. Fails open: a Redis error or
// stall lets the toggle through, and the unique key and `deleted > 0` still prevent double counts.
async function claimToggleWindow({
  entityType,
  entityId,
  userId,
  reaction,
}: ToggleReactionInput & { userId: number }) {
  const key =
    `${REDIS_KEYS.REACTION.TOGGLE_GUARD}:${userId}:${entityType}:${entityId}:${reaction}` as const;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const set = await Promise.race([
      redis.set(key, '1', { NX: true, PX: REVERSE_TOGGLE_WINDOW_MS }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${TOGGLE_GUARD_TIMEOUT_MS}ms`)),
          TOGGLE_GUARD_TIMEOUT_MS
        );
      }),
    ]);
    toggleGuardErrorLogged = false;
    return set !== null;
  } catch (error) {
    // Logged once until the guard works again: while Redis is down every toggle lands here.
    if (!toggleGuardErrorLogged)
      logToAxiom({
        type: 'error',
        name: 'reaction-toggle-guard',
        message: (error as Error).message,
      }).catch(() => undefined);
    toggleGuardErrorLogged = true;
    return true;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const toggleReaction = async ({
  entityType,
  entityId,
  userId,
  reaction,
  isModerator,
  eventPoints = true,
}: ToggleReactionInput & {
  userId: number;
  isModerator?: boolean;
  // False for automated accounts (the challenge judge): event points are for people engaging.
  eventPoints?: boolean;
}) => {
  if (!(await claimToggleWindow({ entityType, entityId, userId, reaction }))) return 'ignored';

  const existing = await getReaction({ entityType, entityId, userId, reaction });
  if (existing) {
    const deleted = await deleteReaction({ entityType, entityId, userId, reaction });
    if (deleted > 0 && eventPoints) void onReactionRemoved({ entityType, entityId, userId });
    return deleted > 0 ? 'removed' : 'noop';
  } else {
    // Enforce on create only — a user blocked after reacting can still un-react.
    await throwIfBlockedByEntityOwner({ userId, entityType, entityId, isModerator });
    await createReaction({ entityType, entityId, userId, reaction });
    if (eventPoints) void onReactionCreated({ entityType, entityId, userId });
    return 'created';
  }
};

const getReaction = async ({
  entityType,
  entityId,
  userId,
  reaction,
}: ToggleReactionInput & { userId: number }) => {
  // RAW — user toggles their own reaction. Normal rep-lag (<1s) is shorter
  // than the user's click interval, so replica reads are fine. During a
  // high-rep-lag incident the HIGH_REPLICATION_LAG_MODE Flipt flag routes
  // this to primary to avoid stale existence checks — a stale miss still
  // means a UNIQUE-violation create, which this read is the only guard for.
  // A stale hit is handled downstream: deleteReaction reports 0 rows.
  const db = await getDbWithoutLag();
  switch (entityType) {
    case 'question':
      return await db.questionReaction.findFirst({
        where: { userId, reaction, questionId: entityId },
        select: { id: true },
      });
    case 'answer':
      return await db.answerReaction.findFirst({
        where: { userId, reaction, answerId: entityId },
        select: { id: true },
      });
    case 'commentOld':
      return await db.commentReaction.findFirst({
        where: { userId, reaction, commentId: entityId },
        select: { id: true },
      });
    case 'comment':
      return await db.commentV2Reaction.findFirst({
        where: { userId, reaction, commentId: entityId },
        select: { id: true },
      });
    case 'image':
      if (await isFlipt(FLIPT_FEATURE_FLAGS.KYSELY_HOT_READS_5))
        return await readImageReactionIdViaKysely(await getKyselyWithoutLag(), {
          userId,
          reaction,
          imageId: entityId,
        });
      return await readImageReactionIdViaPrisma(db, { userId, reaction, imageId: entityId });
    case 'post':
      return await db.postReaction.findFirst({
        where: { userId, reaction, postId: entityId },
        select: { id: true },
      });
    case 'resourceReview':
      return await db.resourceReviewReaction.findFirst({
        where: { userId, reaction, reviewId: entityId },
        select: { id: true },
      });
    case 'article':
      return await db.articleReaction.findFirst({
        where: { userId, reaction, articleId: entityId },
        select: { id: true },
      });
    case 'bountyEntry':
      return await db.bountyEntryReaction.findFirst({
        where: { userId, reaction, bountyEntryId: entityId },
        select: { userId: true },
      });
    default:
      throw throwBadRequestError();
  }
};

// Deletes by the (entityId, userId, reaction) unique key rather than by the row id
// read from the replica: within the replication window that id can name a row the
// primary has already replaced, so a delete-by-id silently matches nothing.
// Returns the number of rows actually removed — callers must not report a removal
// (or emit a tracker/metric event) on a zero count.
const deleteReaction = async ({
  entityType,
  entityId,
  reaction,
  userId,
}: {
  entityType: ReactionEntityType;
  entityId: number;
  reaction: ReviewReactions;
  userId: number;
}) => {
  switch (entityType) {
    case 'question': {
      const { count } = await dbWrite.questionReaction.deleteMany({
        where: { questionId: entityId, userId, reaction },
      });
      if (count > 0) await questionMetrics.queueUpdate(entityId);
      return count;
    }
    case 'answer': {
      const { count } = await dbWrite.answerReaction.deleteMany({
        where: { answerId: entityId, userId, reaction },
      });
      if (count > 0) await answerMetrics.queueUpdate(entityId);
      return count;
    }
    case 'commentOld': {
      const { count } = await dbWrite.commentReaction.deleteMany({
        where: { commentId: entityId, userId, reaction },
      });
      return count;
    }
    case 'comment': {
      const { count } = await dbWrite.commentV2Reaction.deleteMany({
        where: { commentId: entityId, userId, reaction },
      });
      return count;
    }
    case 'image': {
      const { count } = await dbWrite.imageReaction.deleteMany({
        where: { imageId: entityId, userId, reaction },
      });
      return count;
    }
    case 'post': {
      const { count } = await dbWrite.postReaction.deleteMany({
        where: { postId: entityId, userId, reaction },
      });
      if (count > 0) await postMetrics.queueUpdate(entityId);
      return count;
    }
    case 'resourceReview': {
      const { count } = await dbWrite.resourceReviewReaction.deleteMany({
        where: { reviewId: entityId, userId, reaction },
      });
      return count;
    }
    case 'article': {
      const { count } = await dbWrite.articleReaction.deleteMany({
        where: { articleId: entityId, userId, reaction },
      });
      if (count > 0) await articleMetrics.queueUpdate(entityId);
      return count;
    }
    case 'bountyEntry': {
      const { count } = await dbWrite.bountyEntryReaction.deleteMany({
        where: { bountyEntryId: entityId, userId, reaction },
      });
      if (count > 0) await bountyEntryMetrics.queueUpdate(entityId);
      return count;
    }
    default:
      throw throwBadRequestError();
  }
};

const createReaction = async ({
  entityType,
  entityId,
  ...data
}: ToggleReactionInput & { userId: number }) => {
  switch (entityType) {
    case 'question':
      return await dbWrite.questionReaction.create({
        data: { ...data, questionId: entityId },
        select: { reaction: true },
      });
    case 'answer':
      return await dbWrite.answerReaction.create({
        data: { ...data, answerId: entityId },
        select: { reaction: true },
      });
    case 'commentOld':
      return await dbWrite.commentReaction.create({
        data: { ...data, commentId: entityId },
        select: { reaction: true },
      });
    case 'comment':
      return await dbWrite.commentV2Reaction.create({
        data: { ...data, commentId: entityId },
        select: { reaction: true },
      });
    case 'image':
      return await dbWrite.imageReaction.create({
        data: { ...data, imageId: entityId },
        select: { reaction: true },
      });
    case 'post':
      return await dbWrite.postReaction.create({
        data: { ...data, postId: entityId },
        select: { reaction: true },
      });
    case 'resourceReview':
      return await dbWrite.resourceReviewReaction.create({
        data: { ...data, reviewId: entityId },
        select: { reaction: true },
      });
    case 'article':
      return await dbWrite.articleReaction.create({
        data: { ...data, articleId: entityId },
        select: { reaction: true },
      });
    case 'bountyEntry':
      return await dbWrite.bountyEntryReaction.create({
        data: { ...data, bountyEntryId: entityId },
        select: { reaction: true },
      });
    default:
      throw throwBadRequestError();
  }
};
