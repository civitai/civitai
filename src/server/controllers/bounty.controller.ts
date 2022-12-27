import { TRPCError } from '@trpc/server';

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
    const { user } = ctx;
    const take = (input.limit ?? 100) + 1;
    const items = await getBounties({
      user,
      input: { ...input, take },
      select: getAllBountiesSelect,
    });

    let nextCursor: number | undefined;
    if (items.length > input.limit) {
      const nextItem = items.pop();
      nextCursor = nextItem?.id;
    }

    return { nextCursor, items };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getBountyDetailsHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const { id } = input;
    const bounty = await getBountyById({ id, select: getBountyDetailsSelect });
    if (!bounty) throw throwNotFoundError(`No bounty with id ${id}`);

    return bounty;
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
