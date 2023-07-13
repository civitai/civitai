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

export const getHomeBlocksHandler = async ({
  ctx,
  input,
}: {
  ctx: Context;
  input: GetHomeBlocksInputSchema;
}) => {
  const { user } = ctx;
  console.log(user);

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
                input,
              });

              return {
                ...homeBlock,
                collection: {
                  ...collection,
                  items,
                },
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
