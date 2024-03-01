import {
  getPaginatedVaultItemsSchema,
  vaultItemsAddModelVersionSchema,
  vaultItemsRefreshSchema,
  vaultItemsRemoveModelVersionsSchema,
  vaultItemsUpdateNotesSchema,
} from '~/server/schema/vault.schema';
import {
  getOrCreateVault,
  getPaginatedVaultItems,
  isModelVersionInVault,
  refreshVaultItems,
  removeModelVersionsFromVault,
  toggleModelVersionOnVault,
  updateVaultItemsNotes,
} from '~/server/services/vault.service';
import { protectedProcedure, router } from '~/server/trpc';
import { getByIdSchema } from '../schema/base.schema';

export const vaultRouter = router({
  get: protectedProcedure.query(({ ctx }) => {
    return getOrCreateVault({
      userId: ctx.user.id,
    });
  }),
  getItemsPaged: protectedProcedure.input(getPaginatedVaultItemsSchema).query(({ input, ctx }) => {
    return getPaginatedVaultItems({ ...input, userId: ctx.user.id });
  }),
  isModelVersionInVault: protectedProcedure
    .input(vaultItemsAddModelVersionSchema)
    .query(({ input, ctx }) => {
      return isModelVersionInVault({ ...input, userId: ctx.user.id });
    }),
  toggleModelVersion: protectedProcedure
    .input(vaultItemsAddModelVersionSchema)
    .mutation(({ input, ctx }) => {
      return toggleModelVersionOnVault({ ...input, userId: ctx.user.id });
    }),
  removeItemsFromVault: protectedProcedure
    .input(vaultItemsRemoveModelVersionsSchema)
    .mutation(({ input, ctx }) => {
      return removeModelVersionsFromVault({ ...input, userId: ctx.user.id });
    }),
  updateItemsNotes: protectedProcedure
    .input(vaultItemsUpdateNotesSchema)
    .mutation(({ input, ctx }) => {
      return updateVaultItemsNotes({ ...input, userId: ctx.user.id });
    }),
  refreshItems: protectedProcedure.input(vaultItemsRefreshSchema).mutation(({ input, ctx }) => {
    return refreshVaultItems({ ...input, userId: ctx.user.id });
  }),
});
