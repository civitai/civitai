import { Context } from '~/server/createContext';
import { throwDbError } from '~/server/utils/errorHandling';
import { getHomeBlocks } from '~/server/services/home-block.service';
import {
  getCollectionById,
  getCollectionItemsByCollectionId,
} from '~/server/services/collection.service';
import { GetHomeBlocksInputSchema, HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { HomeBlockType } from '@prisma/client';
import { isDefined } from '~/utils/type-guards';
import { UserPreferencesInput } from '~/server/middleware.trpc';
import { getLeaderboardsWithResults } from '~/server/services/leaderboard.service';

export const getHomeBlocksHandler = async ({
  ctx,
  input,
}: {
  ctx: Context;
  input: GetHomeBlocksInputSchema;
}) => {
  try {
    const homeBlocks = await getHomeBlocks({
      select: {
        id: true,
        metadata: true,
        type: true,
      },
    });

    const homeBlocksWithData = await Promise.all(
      homeBlocks
        .map(async (homeBlock) => {
          const metadata: HomeBlockMetaSchema = (homeBlock.metadata || {}) as HomeBlockMetaSchema;
          switch (homeBlock.type) {
            case HomeBlockType.Collection: {
              if (!metadata.collectionId) {
                return null;
              }

              const collection = await getCollectionById({ id: metadata.collectionId });
              if (!collection) {
                return null;
              }
              const items = await getCollectionItemsByCollectionId({
                id: collection.id,
                ctx,
                input: {
                  ...(input as UserPreferencesInput),
                  // TODO.home-blocks: Set item limit as part of the input
                  limit: 8,
                },
              });

              return {
                ...homeBlock,
                collection: {
                  ...collection,
                  items,
                },
              };
            }
            case HomeBlockType.Leaderboard: {
              if (!metadata.leaderboards) {
                return null;
              }

              const leaderboardIds = metadata.leaderboards.map((leaderboard) => leaderboard.id);
              const leaderboardsWithResults = await getLeaderboardsWithResults({
                ids: leaderboardIds,
                isModerator: ctx.user?.isModerator || false,
              });

              return {
                ...homeBlock,
                leaderboards: leaderboardsWithResults,
              };
            }
            default:
              return homeBlock;
          }
        })
        .filter(isDefined)
    );

    return homeBlocksWithData;
  } catch (error) {
    throw throwDbError(error);
  }
};
