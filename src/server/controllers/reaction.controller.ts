import { toggleReaction } from './../services/reaction.service';
import { ToggleReactionInput } from '~/server/schema/reaction.schema';
import { Context } from '~/server/createContext';
import { handleLogError, throwDbError } from '~/server/utils/errorHandling';
import { dbRead } from '../db/client';
import { ReactionType } from '../clickhouse/client';
import { encouragementReward, goodContentReward } from '~/server/rewards';
import {
  NsfwLevelDeprecated,
  getNsfwLevelDeprecatedReverseMapping,
} from '~/shared/constants/browsingLevel.constants';

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

export const toggleReactionHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: ToggleReactionInput;
}) => {
  try {
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

    if (result == 'created') {
      await Promise.all([
        encouragementReward
          .apply(
            {
              type: input.entityType,
              reactorId: ctx.user.id,
              entityId: input.entityId,
              ownerId: trackerEvent?.ownerId,
            },
            ctx.ip
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
            ctx.ip
          )
          .catch(handleLogError),
      ]);
    }
    return result;
  } catch (error) {
    throw throwDbError(error);
  }
};
