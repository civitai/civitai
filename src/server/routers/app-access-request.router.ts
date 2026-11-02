import {
  decideAppAccessRequestSchema,
  listAppAccessRequestsSchema,
  submitAppAccessRequestSchema,
} from '~/server/schema/app-access-request.schema';
import {
  countPendingAppAccessRequests,
  decideAppAccessRequest,
  getMyAppAccessRequest,
  listAppAccessRequests,
  submitAppAccessRequest,
} from '~/server/services/app-access-request.service';
import { moderatorProcedure, protectedProcedure, router } from '~/server/trpc';

export const appAccessRequestRouter = router({
  // No rate limiter: the one-pending-row index already caps a person at one open request.
  submit: protectedProcedure
    .input(submitAppAccessRequestSchema)
    .mutation(({ ctx, input }) => submitAppAccessRequest({ userId: ctx.user.id, input })),

  getMine: protectedProcedure.query(({ ctx }) => getMyAppAccessRequest({ userId: ctx.user.id })),

  list: moderatorProcedure
    .input(listAppAccessRequestsSchema)
    .query(({ input }) => listAppAccessRequests(input)),

  /** The pending count for the `/apps/review` tab badge, so the badge's poll fetches no rows. */
  countPending: moderatorProcedure.query(() => countPendingAppAccessRequests()),

  /** Approving grants builder access; declining an approved request revokes it. */
  decide: moderatorProcedure
    .input(decideAppAccessRequestSchema)
    .mutation(({ ctx, input }) => decideAppAccessRequest({ moderatorId: ctx.user.id, input })),
});
