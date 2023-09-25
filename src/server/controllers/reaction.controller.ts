import { toggleReaction } from './../services/reaction.service';
import { ToggleReactionInput } from '~/server/schema/reaction.schema';
import { Context } from '~/server/createContext';
import { throwDbError } from '~/server/utils/errorHandling';
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
        },
      });

      if (image) {
        return {
          type: `Image_${action}`,
          nsfw: image.nsfw,
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
        },
      });

      if (post) {
        return {
          type: `Post_${action}`,
          nsfw: post.nsfw ? NsfwLevel.Mature : NsfwLevel.None,
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
        },
      });

      if (article) {
        return {
          type: `Article_${action}`,
          nsfw: article.nsfw ? NsfwLevel.Mature : NsfwLevel.None,
          ...shared,
        };
      }
      break;
    case 'commentOld':
      return {
        type: `Comment_${action}`,
        nsfw: NsfwLevel.None,
        ...shared,
      };
    case 'comment':
      return {
        type: `CommentV2_${action}`,
        nsfw: NsfwLevel.None,
        ...shared,
      };
      break;
    case 'question':
      return {
        type: `Question_${action}`,
        nsfw: NsfwLevel.None,
        ...shared,
      };
    case 'answer':
      return {
        type: `Answer_${action}`,
        nsfw: NsfwLevel.None,
        ...shared,
      };
    case 'bountyEntry':
      return {
        type: `BountyEntry_${action}`,
        nsfw: NsfwLevel.None,
        ...shared,
      };
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
      await ctx.track.reaction({
        ...trackerEvent,
        type: trackerEvent.type as ReactionType,
      });
    }
    if (result == 'created') {
      await encouragementReward.apply(
        { type: input.entityType, reactorId: ctx.user.id, entityId: input.entityId },
        ctx.ip
      );
      await goodContentReward.apply(
        { type: input.entityType, reactorId: ctx.user.id, entityId: input.entityId },
        ctx.ip
      );
    }
    return result;
  } catch (error) {
    throw throwDbError(error);
  }
};
