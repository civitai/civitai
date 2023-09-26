import { PurchaseModelVersionInput } from '~/server/schema/model-version-purchase.schema';
import { Context } from '~/server/createContext';
import { TRPCError } from '@trpc/server';
import { throwAuthorizationError, throwDbError } from '~/server/utils/errorHandling';
import { purchaseModelVersion } from '~/server/services/model-version-purchase.service';

export const purchaseHandler = async ({
  input,
  ctx,
}: {
  input: PurchaseModelVersionInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    if (input.userId !== ctx.user.id && !ctx.user.isModerator) {
      throw throwAuthorizationError('You are not authorized to perform this action.');
    }

    await purchaseModelVersion({ ...input, userId: input.userId || ctx.user.id });
  } catch (error) {
    if (error instanceof TRPCError) error;
    else throw throwDbError(error);
  }
};
