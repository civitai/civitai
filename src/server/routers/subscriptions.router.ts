import { getPlansSchema } from '~/server/schema/subscriptions.schema';
import {
  getPlansHandler,
  getUserSubscriptionHandler,
} from './../controllers/subscriptions.controller';
import { publicProcedure, router } from '~/server/trpc';

export const subscriptionsRouter = router({
  getPlans: publicProcedure.input(getPlansSchema).query(getPlansHandler),
  getUserSubscription: publicProcedure.query(getUserSubscriptionHandler),
});
