import { dbRead } from '../db/client';
import { InfiniteQueryInput } from '../schema/base.schema';

export const getAllBounties = ({ cursor, limit: take }: InfiniteQueryInput) => {
  return dbRead.bounty.findMany({
    take,
    cursor: cursor ? { id: cursor } : undefined,
    select: { id: true, name: true, expiresAt: true },
  });
};
