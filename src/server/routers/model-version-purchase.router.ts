import { protectedProcedure, router } from '~/server/trpc';
import { purchaseModelVersionInput } from '~/server/schema/model-version-purchase.schema';
import { purchaseHandler } from '~/server/controllers/model-version-purchase.controller';

export const modelVersionPurchaseRouter = router({
  purchase: protectedProcedure.input(purchaseModelVersionInput).mutation(purchaseHandler),
});
