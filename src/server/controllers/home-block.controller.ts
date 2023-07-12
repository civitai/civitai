import { Context } from '~/server/createContext';
import { throwDbError } from '~/server/utils/errorHandling';
import { getHomeBlocks } from '~/server/services/home-block.service';

export const getHomeBlocksHandler = async ({ ctx }: { ctx: Context }) => {
  const { user } = ctx;
  console.log(user);

  try {
    const homeBlocks = await getHomeBlocks({
      select: {
        id: true,
        metadata: true,
      },
    });

    return homeBlocks;
  } catch (error) {
    throw throwDbError(error);
  }
};
