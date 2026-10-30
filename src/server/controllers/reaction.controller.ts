import { Prisma } from '@prisma/client';
import type { EntityMetric_MetricType_Type, ReviewReactions } from '~/shared/utils/prisma/enums';
import { NotificationCategory } from '~/server/common/enums';
import type { ProtectedContext } from '~/server/createContext';
import { notifications } from '~/server/notifications/client';
import { logToAxiom } from '~/server/logging/client';
import { imageReactionMilestones } from '~/server/notifications/reaction.notifications';
import { encouragementReward, goodContentReward } from '~/server/rewards';
import type { ToggleReactionInput } from '~/server/schema/reaction.schema';
import { isReactionAllowedForEntity } from '~/server/schema/reaction.schema';
import { getContestsFromEntity } from '~/server/services/collection.service';
import { getMetricExcludedUserIds } from '~/server/services/metric-excluded-users.service';
import { createNotification } from '~/server/services/notification.service';
import {
  handleLogError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { isCommentGoneForMembers } from '~/server/services/commentsv2.service';
import { updateEntityMetric } from '~/server/utils/metric-helpers';
import {
  getNsfwLevelDeprecatedReverseMapping,
  NsfwLevelDeprecated,
} from '~/shared/constants/browsingLevel.constants';
import { isFutureDate } from '~/utils/date-helpers';
import { isDefined } from '~/utils/type-guards';
import type { ReactionType } from '../clickhouse/client';
import { dbRead, dbWrite } from '../db/client';
import { loadKyselyDb } from '~/server/db/kyselyDb.lazy';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  readImageNsfwLevelAndOwnerViaKysely,
  readImageNsfwLevelAndOwnerViaPrisma,
  readImagePostIdViaKysely,
  readImagePostIdViaPrisma,
} from '~/server/services/hot-reads-5.reads';
import { toggleReaction } from './../services/reaction.service';
import { hasEntityAccess } from '~/server/services/common.service';
import { assertCommentCrucibleVisible } from '~/server/controllers/commentv2.controller';

/**
 * The exact payload `Tracker.reaction` accepts.
 *
 * 🔴 THIS ANNOTATION IS THE GUARD, NOT DOCUMENTATION. Every `type` below is built as
 * `` `<Entity>_${action}` ``, and a template-literal expression is inferred as plain
 * `string` unless something contextually types it. Without this return type the switch
 * produced `string`, the call site laundered it through `as ReactionType`, and the
 * `Post_*` arm — a value `reactions.type` does not carry — type-checked for as long as
 * it has existed while the tracker dropped every row it produced client-side. Do not
 * re-add a cast at the call site; fix the union or the branch instead.
 */
type ReactionTrackerEvent = {
  type: ReactionType;
  entityId: number;
  ownerId: number;
  reaction: ReviewReactions;
  nsfw: NsfwLevelDeprecated;
};

async function getTrackerEvent(
  input: ToggleReactionInput,
  result: 'removed' | 'created'
): Promise<ReactionTrackerEvent | undefined> {
  const shared = {
    entityId: input.entityId,
    reaction: input.reaction,
  };

  const action = result === 'created' ? 'Create' : 'Delete';
  switch (input.entityType) {
    case 'image':
      const image = (await isFlipt(FLIPT_FEATURE_FLAGS.KYSELY_HOT_READS_5))
        ? await readImageNsfwLevelAndOwnerViaKysely(
            (
              await loadKyselyDb()
            ).kyselyRead,
            input.entityId
          )
        : await readImageNsfwLevelAndOwnerViaPrisma(dbRead, input.entityId);

      if (image) {
        return {
          type: `Image_${action}`,
          nsfw: getNsfwLevelDeprecatedReverseMapping(image.nsfwLevel),
          ownerId: image.userId,
          ...shared,
        };
      }
      break;
    case 'post':
      const post = await dbRead.post.findFirst({
        where: {
          id: input.entityId,
        },
        select: {
          nsfwLevel: true,
          userId: true,
        },
      });

      if (post) {
        return {
          type: `Post_${action}`,
          nsfw: getNsfwLevelDeprecatedReverseMapping(post.nsfwLevel),
          ownerId: post.userId,
          ...shared,
        };
      }
      break;
    case 'article':
      const article = await dbRead.article.findFirst({
        where: {
          id: input.entityId,
        },
        select: {
          nsfwLevel: true,
          userId: true,
        },
      });

      if (article) {
        return {
          type: `Article_${action}`,
          nsfw: getNsfwLevelDeprecatedReverseMapping(article.nsfwLevel),
          ownerId: article.userId,
          ...shared,
        };
      }
      break;
    case 'commentOld':
      const commentOld = await dbRead.comment.findFirst({
        where: { id: input.entityId },
        select: { userId: true },
      });
      if (commentOld) {
        return {
          type: `Comment_${action}`,
          nsfw: NsfwLevelDeprecated.None,
          ownerId: commentOld.userId,
          ...shared,
        };
      }
      break;
    case 'comment':
      const commentV2 = await dbRead.commentV2.findFirst({
        where: { id: input.entityId },
        select: { userId: true },
      });
      if (commentV2) {
        return {
          type: `CommentV2_${action}`,
          nsfw: NsfwLevelDeprecated.None,
          ownerId: commentV2.userId,
          ...shared,
        };
      }
      break;
    case 'question':
      const question = await dbRead.question.findFirst({
        where: { id: input.entityId },
        select: { userId: true },
      });
      if (question) {
        return {
          type: `Question_${action}`,
          nsfw: NsfwLevelDeprecated.None,
          ownerId: question?.userId,
          ...shared,
        };
      }
      break;
    case 'answer':
      const answer = await dbRead.answer.findFirst({
        where: { id: input.entityId },
        select: { userId: true },
      });
      if (answer) {
        return {
          type: `Answer_${action}`,
          nsfw: NsfwLevelDeprecated.None,
          ownerId: answer.userId,
          ...shared,
        };
      }
      break;
    case 'bountyEntry':
      const bountyEntry = await dbRead.bountyEntry.findFirst({
        where: { id: input.entityId },
        select: { userId: true },
      });
      // `userId` is nullable (SetNull when the author is deleted). An ownerless entry has no
      // owner to record, and no owner the reactor could be, so it gets no tracker row.
      if (bountyEntry?.userId != null) {
        return {
          type: `BountyEntry_${action}`,
          nsfw: NsfwLevelDeprecated.None,
          ownerId: bountyEntry.userId,
          ...shared,
        };
      }
      break;
    case 'resourceReview':
      const review = await dbRead.resourceReview.findFirst({
        where: { id: input.entityId },
        select: { userId: true },
      });
      if (review) {
        return {
          type: `Review_${action}`,
          nsfw: NsfwLevelDeprecated.None,
          ownerId: review.userId,
          ...shared,
        };
      }
      break;
  }
}

/**
 * Whether the user already holds this exact reaction. Asked only for a value the entity type
 * no longer allows creating, to tell removing a legacy reaction (allowed) from creating one
 * (refused). Reads the primary: a lagging replica would refuse a legitimate removal.
 */
async function holdsReaction({
  entityType,
  entityId,
  userId,
  reaction,
}: ToggleReactionInput & { userId: number }) {
  const where = { userId, reaction };
  // The return annotation makes a missing entity type a compile error rather than a refusal.
  const count = await ((): Promise<number> => {
    switch (entityType) {
      case 'question':
        return dbWrite.questionReaction.count({ where: { ...where, questionId: entityId } });
      case 'answer':
        return dbWrite.answerReaction.count({ where: { ...where, answerId: entityId } });
      case 'commentOld':
        return dbWrite.commentReaction.count({ where: { ...where, commentId: entityId } });
      case 'comment':
        return dbWrite.commentV2Reaction.count({ where: { ...where, commentId: entityId } });
      case 'image':
        return dbWrite.imageReaction.count({ where: { ...where, imageId: entityId } });
      case 'post':
        return dbWrite.postReaction.count({ where: { ...where, postId: entityId } });
      case 'resourceReview':
        return dbWrite.resourceReviewReaction.count({ where: { ...where, reviewId: entityId } });
      case 'article':
        return dbWrite.articleReaction.count({ where: { ...where, articleId: entityId } });
      case 'bountyEntry':
        return dbWrite.bountyEntryReaction.count({ where: { ...where, bountyEntryId: entityId } });
    }
  })();
  return count > 0;
}

const reactionMetricMap: { [p in ReviewReactions]?: EntityMetric_MetricType_Type } = {
  Like: 'ReactionLike',
  Heart: 'ReactionHeart',
  Laugh: 'ReactionLaugh',
  Cry: 'ReactionCry',
};

export const toggleReactionHandler = async ({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: ToggleReactionInput;
}) => {
  try {
    // A value no longer allowed is still accepted when the user holds it, so it can be removed.
    if (
      !isReactionAllowedForEntity(input.entityType, input.reaction) &&
      !(await holdsReaction({ ...input, userId: ctx.user.id }))
    ) {
      throw throwBadRequestError(
        `The ${input.reaction} reaction is not available for this ${input.entityType}.`
      );
    }

    if (
      input.entityType === 'comment' &&
      !ctx.user.isModerator &&
      (await isCommentGoneForMembers(input.entityId))
    )
      throw throwNotFoundError(`No comment with id ${input.entityId}`);
    if (input.entityType === 'comment') await assertCommentCrucibleVisible(input.entityId, ctx);

    if (input.entityType === 'image') {
      // We are only doing this for image contests for now. Because the user
      // gets an instant feedback, this shouldn't have too bad an impact if any at all.
      const contests = await getContestsFromEntity({
        entityType: input.entityType,
        entityId: input.entityId,
      });

      if (
        contests.find(
          (contest) =>
            !!contest.metadata?.votingPeriodStart &&
            isFutureDate(contest.metadata?.votingPeriodStart)
        )
      ) {
        throw throwBadRequestError(
          'Cannot react to an image in a contest before the voting period starts.'
        );
      }
    }

    // I worry a bit this may increase DB load, but it's a necessary check now that we opened
    // the door for private models.
    const checkAccess = ['image', 'post'];
    if (checkAccess.includes(input.entityType)) {
      // A missing image runs the Prisma read, so its not-found throw is unchanged.
      const readImagePostId = async (imageId: number) => {
        if (await isFlipt(FLIPT_FEATURE_FLAGS.KYSELY_HOT_READS_5)) {
          const row = await readImagePostIdViaKysely((await loadKyselyDb()).kyselyRead, imageId);
          if (row) return row.postId;
        }
        return readImagePostIdViaPrisma(dbRead, imageId);
      };
      const entityId =
        input.entityType === 'post' ? input.entityId : await readImagePostId(input.entityId);

      if (entityId) {
        const [access] = await hasEntityAccess({
          userId: ctx.user.id,
          isModerator: ctx.user.isModerator,
          entityType: 'Post',
          entityIds: [entityId],
        });

        if (!access.hasAccess) {
          throw throwBadRequestError('You cannot react to this entity.');
        }
      }
    }

    const result = await toggleReaction({
      ...input,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });
    // Positive checks: 'noop' and 'ignored' wrote nothing, so they emit nothing.
    const changed = result === 'created' || result === 'removed';
    const trackerEvent = changed ? await getTrackerEvent(input, result) : undefined;
    if (trackerEvent) {
      await ctx.track.reaction(trackerEvent).catch(handleLogError);
    }

    if (input.entityType === 'image' && changed) {
      const metricTypeFromInput = reactionMetricMap[input.reaction];
      if (metricTypeFromInput) {
        await updateEntityMetric({
          ctx,
          entityType: 'Image',
          entityId: input.entityId,
          metricType: metricTypeFromInput,
          amount: result === 'created' ? 1 : -1,
        });
      }
    }

    if (result === 'created') {
      // Fire-and-forget: rewards and notifications should not block the response.
      // These were previously awaited and caused 30s timeouts when downstream
      // services (ClickHouse, Redis locks, notification DB) were slow.
      Promise.all([
        encouragementReward
          .apply(
            {
              type: input.entityType,
              reactorId: ctx.user.id,
              entityId: input.entityId,
              ownerId: trackerEvent?.ownerId,
            },
            { ip: ctx.ip }
          )
          .catch(handleLogError),
        goodContentReward
          .apply(
            {
              type: input.entityType,
              reactorId: ctx.user.id,
              entityId: input.entityId,
              ownerId: trackerEvent?.ownerId,
            },
            { ip: ctx.ip }
          )
          .catch(handleLogError),
      ]).catch(handleLogError);

      createReactionNotification(input).catch(handleLogError);
    }
    // API-key callers keep the result set they had before the guard existed.
    if (result === 'ignored' && ctx.apiKeyId != null) return 'noop';
    return result;
  } catch (error) {
    throw throwDbError(error);
  }
};

// Exported for tests: the property that matters is that an unavailable exclusion
// list still produces a notification, and that is only observable here.
export const createReactionNotification = async ({ entityType, entityId }: ToggleReactionInput) => {
  if (entityType === 'image') {
    // Every displayed count filters reaction-farm accounts; a raw Postgres count did
    // not, so the milestone fired on numbers no display agreed with. An empty list
    // here means the lookup was unavailable and the count is unfiltered — the
    // pre-change behaviour, and never a skipped notification.
    const excludedUserIds = await getMetricExcludedUserIds();
    const cnt = await dbRead.imageReaction.count({
      where: {
        imageId: entityId,
        ...(excludedUserIds.length ? { userId: { notIn: excludedUserIds } } : {}),
      },
    });

    // const { reactionCount: cnt = 0 } =
    //   (await dbRead.imageMetric.findFirst({
    //     where: { imageId: entityId, timeframe: MetricTimeframe.AllTime },
    //     select: { reactionCount: true },
    //   })) ?? {};

    if (!cnt) return;

    const match = imageReactionMilestones.toReversed().find((e) => e <= cnt);
    if (!match) return;

    const type = 'image-reaction-milestone';
    const key = `${type}:${entityId}:${match}`;

    if (await notifications.notificationExists({ key })) return;

    // KNOWN, and deliberately not guarded here: filtering can lower `cnt`, so `match`
    // can move DOWN, and where a burst crossed several thresholds at once only the top
    // key was written — so a lower milestone can arrive after a higher one. Guarding it
    // means asking `notificationExists` for each higher threshold, and that is an HTTP
    // call per key to the notifications service, re-run on every reaction to exactly the
    // images this suppression targets. A cosmetic ordering quirk is not worth a standing
    // cross-service N+1; it needs a batched existence check first.

    const resource = await dbRead.image.findFirst({
      where: { id: entityId },
      select: {
        userId: true,
        id: true,
        postId: true,
        resourceHelper: { select: { modelName: true } },
      },
    });

    if (!resource) {
      logToAxiom(
        {
          type: 'warning',
          name: 'Failed to create notification',
          details: { key: type },
          message: 'Could not find resource',
        },
        'notifications'
      ).catch();
      return;
    }

    const modelNames = resource.resourceHelper.map((r) => r.modelName).filter(isDefined);

    const details = {
      version: 2,
      imageId: resource.id,
      postId: resource.postId,
      models: modelNames,
      reactionCount: match,
    };

    await createNotification({
      type,
      key,
      category: NotificationCategory.Milestone,
      userId: resource.userId,
      details,
    }).catch();
  }
};
