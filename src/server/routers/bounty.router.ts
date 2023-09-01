import {
  createBountyHandler,
  deleteBountyHandler,
  getBountyHandler,
  getInfiniteBountiesHandler,
  updateBountyHandler,
} from '../controllers/bounty.controller';
import { protectedProcedure, publicProcedure, router } from '../trpc';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  createBountyInputSchema,
  getInfiniteBountySchema,
  updateBountyInputSchema,
} from '~/server/schema/bounty.schema';

export const bountyRouter = router({
  getInfinite: publicProcedure.input(getInfiniteBountySchema).query(getInfiniteBountiesHandler),
  getById: publicProcedure.input(getByIdSchema).query(getBountyHandler),
  create: protectedProcedure.input(createBountyInputSchema).mutation(createBountyHandler),
  update: protectedProcedure.input(updateBountyInputSchema).mutation(updateBountyHandler),
  delete: protectedProcedure.input(getByIdSchema).mutation(deleteBountyHandler),
});
