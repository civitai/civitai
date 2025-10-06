import { getPlansSchema, getUserSubscriptionSchema } from '~/server/schema/subscriptions.schema';
import {
  getPlansHandler,
  getUserSubscriptionHandler,
  getAllUserSubscriptionsHandler,
} from './../controllers/subscriptions.controller';
import { publicProcedure, router } from '~/server/trpc';

export const subscriptionsRouter = router({
  getPlans: publicProcedure.input(getPlansSchema).query(getPlansHandler),
  getUserSubscription: publicProcedure
    .input(getUserSubscriptionSchema.partial().optional())
    .query(getUserSubscriptionHandler),
  getAllUserSubscriptions: publicProcedure.query(getAllUserSubscriptionsHandler),
});
