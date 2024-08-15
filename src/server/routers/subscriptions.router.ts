import { getPlansSchema } from '~/server/schema/subscriptions.schema';
import { getPlansHandler } from './../controllers/subscriptions.controller';
import { publicProcedure, router } from '~/server/trpc';

export const subscriptionsRouter = router({
  getPlans: publicProcedure.input(getPlansSchema).query(getPlansHandler),
});
