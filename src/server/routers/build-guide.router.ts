import { publicProcedure, router } from '~/server/trpc';
import { getBuildGuideByBudgetInputSchema } from '~/server/schema/build-guide.schema';
import { getBuildGuideHandler } from '~/server/controllers/build-guide.controller';

export const buildGuideRouter = router({
  getByBudget: publicProcedure.input(getBuildGuideByBudgetInputSchema).query(getBuildGuideHandler),
});
