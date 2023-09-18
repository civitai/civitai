import { protectedProcedure, router } from '~/server/trpc';
import { getUserReferralCodesHandler } from '~/server/controllers/user-referral-code.controller';
import { getUserReferralCodesSchema } from '~/server/schema/user-referral-code.schema';

export const userReferralCodeRouter = router({
  getAll: protectedProcedure.input(getUserReferralCodesSchema).query(getUserReferralCodesHandler),
});
