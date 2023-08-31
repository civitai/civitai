import { getInfiniteBountiesHandler } from '../controllers/bounty.controller';
import { publicProcedure, router } from '../trpc';
import { infiniteQuerySchema } from '~/server/schema/base.schema';

export const bountyRouter = router({
  getAll: publicProcedure.input(infiniteQuerySchema).query(getInfiniteBountiesHandler),
});
