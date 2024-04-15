import { Context } from '~/server/createContext';
import { getUserLinks } from '~/server/services/user-link.service';
import {
  GetUserReferralCodesSchema,
  UpsertUserReferralCodesSchema,
} from '~/server/schema/user-referral-code.schema';
import {
  upsertUserReferralCode,
  getUserReferralCodes,
  deleteUserReferralCode,
} from '~/server/services/user-referral-code.service';
import { throwDbError } from '~/server/utils/errorHandling';
import { GetByIdInput } from '~/server/schema/base.schema';

export const getUserReferralCodesHandler = async ({
  input,
  ctx,
}: {
  input: GetUserReferralCodesSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  return await getUserReferralCodes({ userId: ctx.user.id, includeCount: !!input.includeCount });
};

export const upsertUserReferralCodeHandler = async ({
  input,
  ctx,
}: {
  input?: UpsertUserReferralCodesSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await upsertUserReferralCode({
      ...(input ?? {}),
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteUserReferralCodeHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await deleteUserReferralCode({
      ...input,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });
  } catch (error) {
    throw throwDbError(error);
  }
};
