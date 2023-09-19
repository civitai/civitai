import { protectedProcedure, router } from '~/server/trpc';
import {
  deleteUserReferralCodeHandler,
  getUserReferralCodesHandler,
  upsertUserReferralCodeHandler,
} from '~/server/controllers/user-referral-code.controller';
import {
  getUserReferralCodesSchema,
  upsertUserReferralCodesSchema,
} from '~/server/schema/user-referral-code.schema';
import { getByIdSchema } from '~/server/schema/base.schema';

export const userReferralCodeRouter = router({
  getAll: protectedProcedure.input(getUserReferralCodesSchema).query(getUserReferralCodesHandler),
  upsert: protectedProcedure
    .input(upsertUserReferralCodesSchema)
    .mutation(upsertUserReferralCodeHandler),
  delete: protectedProcedure.input(getByIdSchema).mutation(deleteUserReferralCodeHandler),
});
