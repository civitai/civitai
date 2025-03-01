import { Prisma } from '@prisma/client';
import { EntityMetric_MetricType_Type, ReviewReactions } from '~/shared/utils/prisma/enums';
import { NotificationCategory } from '~/server/common/enums';
import { Context } from '~/server/createContext';
import { notifDbRead } from '~/server/db/notifDb';
import { logToAxiom } from '~/server/logging/client';
import { imageReactionMilestones } from '~/server/notifications/reaction.notifications';
import { encouragementReward, goodContentReward } from '~/server/rewards';
import { ToggleReactionInput } from '~/server/schema/reaction.schema';
import { getContestsFromEntity } from '~/server/services/collection.service';
import { createNotification } from '~/server/services/notification.service';
import { handleLogError, throwBadRequestError, throwDbError } from '~/server/utils/errorHandling';
import { updateEntityMetric } from '~/server/utils/metric-helpers';
import {
  getNsfwLevelDeprecatedReverseMapping,
  NsfwLevelDeprecated,
} from '~/shared/constants/browsingLevel.constants';
import { isFutureDate } from '~/utils/date-helpers';
import { isDefined } from '~/utils/type-guards';
import { ReactionType } from '../clickhouse/client';
import { dbRead } from '../db/client';
import { toggleReaction } from './../services/reaction.service';
import { hasEntityAccess } from '~/server/services/common.service';

async function getTrackerEvent(input: ToggleReactionInput, result: 'removed' | 'created') {
  const shared = {
    entityId: input.entityId,
    reaction: input.reaction,
  };

  const action = result === 'created' ? 'Create' : 'Delete';
  switch (input.entityType) {
    case 'image':
      const image = await dbRead.image.findFirst({
        where: {
          id: input.entityId,
        },
        select: {
          nsfwLevel: true,
          userId: true,
        },
      });

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
      const bountyEntry = await dbRead.answer.findFirst({
        where: { id: input.entityId },
        select: { userId: true },
      });
      if (bountyEntry) {
        return {
          type: `BountyEntry_${action}`,
          nsfw: NsfwLevelDeprecated.None,
          ownerId: bountyEntry?.userId,
          ...shared,
        };
      }
      break;
  }
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
  ctx: DeepNonNullable<Context>;
  input: ToggleReactionInput;
}) => {
  try {
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
    const checkAccess = ['image', 'post', 'model'];
    if (checkAccess.includes(input.entityType)) {
      const entityType = input.entityType === 'model' ? 'Model' : 'Post';
      const entityId =
        input.entityType === 'model' || input.entityType === 'post'
          ? input.entityId
          : await dbRead.image
              .findUniqueOrThrow({ where: { id: input.entityId } })
              .then((image) => image?.postId);

      if (entityId) {
        const [access] = await hasEntityAccess({
          userId: ctx.user.id,
          isModerator: ctx.user.isModerator,
          entityType: entityType,
          entityIds: [entityId],
        });

        if (!access.hasAccess) {
          throw throwBadRequestError('You cannot react to this entity.');
        }
      }
    }

    const result = await toggleReaction({ ...input, userId: ctx.user.id });
    const trackerEvent = await getTrackerEvent(input, result);
    if (trackerEvent) {
      await ctx.track
        .reaction({
          ...trackerEvent,
          type: trackerEvent.type as ReactionType,
        })
        .catch(handleLogError);
    }

    if (input.entityType === 'image') {
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
      await Promise.all([
        encouragementReward
          .apply(
            {
              type: input.entityType,
              reactorId: ctx.user.id,
              entityId: input.entityId,
              ownerId: trackerEvent?.ownerId,
            },
            { ip: ctx.ip, fingerprint: ctx.fingerprint }
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
            { ip: ctx.ip, fingerprint: ctx.fingerprint }
          )
          .catch(handleLogError),
      ]);

      await createReactionNotification(input).catch();
    }
    return result;
  } catch (error) {
    throw throwDbError(error);
  }
};

const createReactionNotification = async ({ entityType, entityId }: ToggleReactionInput) => {
  if (entityType === 'image') {
    const cnt = await dbRead.imageReaction.count({
      where: { imageId: entityId },
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

    const query = await notifDbRead.cancellableQuery<{ exists: number }>(Prisma.sql`
      SELECT 1 as exists
      FROM "Notification"
      WHERE key = ${key}
    `);
    const items = await query.result();
    if (items.length > 0) return;

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
