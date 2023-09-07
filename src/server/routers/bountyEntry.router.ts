import { getByIdSchema } from '../schema/base.schema';
import { protectedProcedure, publicProcedure, router } from '../trpc';
import {
  getBountyEntryHandler,
  upsertBountyEntryHandler,
} from '~/server/controllers/bountyEntry.controller';
import { upsertBountyEntryInputSchema } from '~/server/schema/bounty-entry.schema';

export const bountyEntryRouter = router({
  getById: publicProcedure.input(getByIdSchema).query(getBountyEntryHandler),
  create: protectedProcedure.input(upsertBountyEntryInputSchema).mutation(upsertBountyEntryHandler),
});
