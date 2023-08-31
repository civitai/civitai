import { TRPCError } from '@trpc/server';
import { Context } from '../createContext';
import { GetByIdInput, InfiniteQueryInput } from '../schema/base.schema';
import {
  createBounty,
  deleteBountyById,
  getAllBounties,
  getBountyById,
  updateBountyById,
} from '../services/bounty.service';
import { throwDbError, throwNotFoundError } from '../utils/errorHandling';
import { getBountyDetailsSelect } from '~/server/selectors/bounty.selector';
import { UpsertBountyInput } from '../schema/bounty.schema';

export const getInfiniteBountiesHandler = async ({
  input,
  ctx,
}: {
  input: InfiniteQueryInput;
  ctx: Context;
}) => {
  const limit = input.limit + 1 ?? 10;

  try {
    const items = await getAllBounties({ ...input, limit });

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

export const getBountyHandler = async ({ input, ctx }: { input: GetByIdInput; ctx: Context }) => {
  try {
    const bounty = await getBountyById({ ...input, select: getBountyDetailsSelect });
    if (!bounty) throw throwNotFoundError(`No bounty with id ${input.id}`);

    return bounty;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const upsertBountyHandler = async ({
  input,
  ctx,
}: {
  input: UpsertBountyInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    if (input.id) {
      const bounty = await updateBountyById(input);
      if (!bounty) throw throwNotFoundError(`No bounty with id ${input.id}`);

      return bounty;
    }

    const { id: userId } = ctx.user;
    const bounty = await createBounty({ ...input, userId });
    return bounty;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const deleteBountyHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const deleted = await deleteBountyById(input);
    if (!deleted) throw throwNotFoundError(`No bounty with id ${input.id}`);

    return deleted;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
