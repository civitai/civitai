import { TRPCError } from '@trpc/server';
import { constants } from '~/server/common/constants';

import { Context } from '~/server/createContext';
import { GetByIdInput } from '~/server/schema/base.schema';
import { BountyUpsertSchema, GetAllBountiesSchema } from '~/server/schema/bounty.schema';
import { getAllBountiesSelect, getBountyDetailsSelect } from '~/server/selectors/bounty.selector';
import {
  createBounty,
  deleteBountyById,
  getBounties,
  getBountyById,
  updateBounty,
} from '~/server/services/bounty.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';

export const getBountiesInfiniteHandler = async ({
  input,
  ctx,
}: {
  input: GetAllBountiesSchema;
  ctx: Context;
}) => {
  try {
    input.limit = input.limit ?? constants.bountyFilterDefaults.limit;

    const { user } = ctx;
    const take = input.limit + 1;
    const items = await getBounties({
      user,
      input: { ...input, take },
      select: {
        ...getAllBountiesSelect,
        rank: {
          select: {
            [`bountyValue${input.period}`]: true,
            [`favoriteCount${input.period}`]: true,
            [`commentCount${input.period}`]: true,
            [`hunterCount${input.period}`]: true,
          },
        },
      },
    });

    let nextCursor: number | undefined;
    if (items.length > input.limit) {
      const nextItem = items.pop();
      nextCursor = nextItem?.id;
    }

    return {
      nextCursor,
      items: items.map(({ images, ...bounty }) => {
        const rank = bounty.rank as Record<string, number>;

        return {
          ...bounty,
          image: images[0]?.image ?? {},
          rank: {
            bountyValue: rank[`bountyValue${input.period}`],
            favoriteCount: rank[`favoriteCount${input.period}`],
            commentCount: rank[`commentCount${input.period}`],
            hunterCount: rank[`hunterCount${input.period}`],
          },
        };
      }),
    };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getBountyDetailsHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const { id } = input;
    const bounty = await getBountyById({ id, select: getBountyDetailsSelect });
    if (!bounty) throw throwNotFoundError(`No bounty with id ${id}`);

    const { images, files, ...item } = bounty;
    return {
      ...item,
      images: images.map(({ index, image }) => ({ ...image, index })),
      file: files[0],
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const createBountyHandler = async ({
  input,
  ctx,
}: {
  input: BountyUpsertSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    const bounty = await createBounty({ ...input, userId });

    return bounty;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const updateBountyHandler = async ({
  input,
  ctx,
}: {
  input: BountyUpsertSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    const bounty = await updateBounty({ ...input, userId });
    if (!bounty) throw throwNotFoundError(`No bounty with id ${input.id}`);

    return bounty;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const deleteBountyHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const { id } = input;
    const bounty = await deleteBountyById({ id });
    if (!bounty) throw throwNotFoundError(`No bounty with id ${id}`);

    return bounty;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
