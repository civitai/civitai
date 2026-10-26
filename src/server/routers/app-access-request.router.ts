import { rateLimit } from '~/server/middleware.trpc';
import {
  decideAppAccessRequestSchema,
  listAppAccessRequestsSchema,
  submitAppAccessRequestSchema,
} from '~/server/schema/app-access-request.schema';
import {
  decideAppAccessRequest,
  getMyAppAccessRequest,
  listAppAccessRequests,
  submitAppAccessRequest,
} from '~/server/services/app-access-request.service';
import { moderatorProcedure, protectedProcedure, router } from '~/server/trpc';
import { APP_ACCESS_REQUEST_SUBMIT_RATE_LIMITS } from '~/shared/constants/app-access-request.constants';

export const appAccessRequestRouter = router({
  submit: protectedProcedure
    .use(rateLimit(APP_ACCESS_REQUEST_SUBMIT_RATE_LIMITS))
    .input(submitAppAccessRequestSchema)
    .mutation(({ ctx, input }) => submitAppAccessRequest({ userId: ctx.user.id, input })),

  getMine: protectedProcedure.query(({ ctx }) => getMyAppAccessRequest({ userId: ctx.user.id })),

  list: moderatorProcedure
    .input(listAppAccessRequestsSchema)
    .query(({ input }) => listAppAccessRequests(input)),

  /** Records the decision only. Granting access is a separate, manual step. */
  decide: moderatorProcedure
    .input(decideAppAccessRequestSchema)
    .mutation(({ ctx, input }) => decideAppAccessRequest({ moderatorId: ctx.user.id, input })),
});
