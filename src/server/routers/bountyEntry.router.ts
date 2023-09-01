import { getByIdSchema } from '../schema/base.schema';
import { publicProcedure, router } from '../trpc';
import { getBountyEntryHandler } from '~/server/controllers/bountyEntry.controller';

export const bountyEntryRouter = router({
  getById: publicProcedure.input(getByIdSchema).query(getBountyEntryHandler),
});
