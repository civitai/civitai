import { toggleReaction } from './../services/reaction.service';
import { ToggleReactionInput } from '~/server/schema/reaction.schema';
import { Context } from '~/server/createContext';
import { handleLogError, throwDbError } from '~/server/utils/errorHandling';
import { dbRead } from '../db/client';
import { ReactionType } from '../clickhouse/client';
import { NsfwLevel } from '@prisma/client';
import { encouragementReward, goodContentReward } from '~/server/rewards';

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
          nsfw: true,
          userId: true,
        },
      });

      if (image) {
        return {
          type: `Image_${action}`,
          nsfw: image.nsfw,
          userId: image.userId,
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
          nsfw: true,
          userId: true,
        },
      });

      if (post) {
        return {
          type: `Post_${action}`,
          nsfw: post.nsfw ? NsfwLevel.Mature : NsfwLevel.None,
          userId: post.userId,
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
          nsfw: true,
          userId: true,
        },
      });

      if (article) {
        return {
          type: `Article_${action}`,
          nsfw: article.nsfw ? NsfwLevel.Mature : NsfwLevel.None,
          userId: article.userId,
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
          nsfw: NsfwLevel.None,
          userId: commentOld.userId,
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
          nsfw: NsfwLevel.None,
          userId: commentV2.userId,
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
          nsfw: NsfwLevel.None,
          userId: question?.userId,
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
          nsfw: NsfwLevel.None,
          userId: answer.userId,
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
          nsfw: NsfwLevel.None,
          userId: bountyEntry?.userId,
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
              ownerId: trackerEvent?.userId,
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
              ownerId: trackerEvent?.userId,
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
