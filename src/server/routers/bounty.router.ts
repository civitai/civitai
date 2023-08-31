import {
  getBountyHandler,
  getInfiniteBountiesHandler,
  upsertBountyHandler,
} from '../controllers/bounty.controller';
import { protectedProcedure, publicProcedure, router } from '../trpc';
import { getByIdSchema, infiniteQuerySchema } from '~/server/schema/base.schema';
import { upsertBountyInputSchema } from '~/server/schema/bounty.schema';
import { deleteBountyHandler } from '~/server/controllers/bounty.controller';

export const bountyRouter = router({
  getAll: publicProcedure.input(infiniteQuerySchema).query(getInfiniteBountiesHandler),
  getById: publicProcedure.input(getByIdSchema).query(getBountyHandler),
  upsert: protectedProcedure.input(upsertBountyInputSchema).mutation(upsertBountyHandler),
  delete: protectedProcedure.input(getByIdSchema).mutation(deleteBountyHandler),
});
