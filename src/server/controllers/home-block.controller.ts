import { Context } from '~/server/createContext';
import { throwDbError } from '~/server/utils/errorHandling';
import { getHomeBlocks } from '~/server/services/home-block.service';
import { getCollectionById } from '~/server/services/collection.service';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { HomeBlockType } from '@prisma/client';

export const getHomeBlocksHandler = async ({ ctx }: { ctx: Context }) => {
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
      homeBlocks.map(async (homeBlock) => {
        const metadata: HomeBlockMetaSchema = (homeBlock.metadata || {}) as HomeBlockMetaSchema;
        switch (homeBlock.type) {
          case HomeBlockType.Collection: {
            if (!metadata.collectionId) {
              return null;
            }

            const collection = await getCollectionById({ id: metadata.collectionId });
            return {
              ...homeBlock,
              collection,
            };
          }
          default:
            return homeBlock;
        }
      })
    );

    return homeBlocksWithData;
  } catch (error) {
    throw throwDbError(error);
  }
};
