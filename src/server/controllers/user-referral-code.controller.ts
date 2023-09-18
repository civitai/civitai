import { Context } from '~/server/createContext';
import { getUserLinks } from '~/server/services/user-link.service';
import { GetUserReferralCodesSchema } from '~/server/schema/user-referral-code.schema';
import { getUserReferralCodes } from '~/server/services/user-referral-code.service';

export const getUserReferralCodesHandler = async ({
  input,
  ctx,
}: {
  input: GetUserReferralCodesSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  const userId = input.userId || ctx.user.id;

  return await getUserReferralCodes({ userId });
};
