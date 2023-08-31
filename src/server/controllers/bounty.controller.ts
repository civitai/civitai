import { Context } from '../createContext';
import { InfiniteQueryInput } from '../schema/base.schema';
import { getAllBounties } from '../services/bounty.service';
import { throwDbError } from '../utils/errorHandling';

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
