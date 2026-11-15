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
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const vaultRouter = router({
  get: protectedProcedure.meta({ requiredScope: TokenScope.VaultRead }).query(({ ctx }) => {
    return getOrCreateVault({
      userId: ctx.user.id,
    });
  }),
  getItemsPaged: protectedProcedure
    .meta({ requiredScope: TokenScope.VaultRead })
    .input(getPaginatedVaultItemsSchema)
    .query(({ input, ctx }) => {
      return getPaginatedVaultItems({
        ...input,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      });
    }),
  isModelVersionInVault: protectedProcedure
    .meta({ requiredScope: TokenScope.VaultRead })
    .input(vaultItemsAddModelVersionSchema)
    .query(({ input, ctx }) => {
      return isModelVersionInVault({ ...input, userId: ctx.user.id });
    }),
  toggleModelVersion: protectedProcedure
    .meta({ requiredScope: TokenScope.VaultWrite })
    .input(vaultItemsAddModelVersionSchema)
    .mutation(({ input, ctx }) => {
      return toggleModelVersionOnVault({ ...input, userId: ctx.user.id });
    }),
  removeItemsFromVault: protectedProcedure
    .meta({ requiredScope: TokenScope.VaultWrite })
    .input(vaultItemsRemoveModelVersionsSchema)
    .mutation(({ input, ctx }) => {
      return removeModelVersionsFromVault({ ...input, userId: ctx.user.id });
    }),
  updateItemsNotes: protectedProcedure
    .meta({ requiredScope: TokenScope.VaultWrite })
    .input(vaultItemsUpdateNotesSchema)
    .mutation(({ input, ctx }) => {
      return updateVaultItemsNotes({ ...input, userId: ctx.user.id });
    }),
  refreshItems: protectedProcedure
    .meta({ requiredScope: TokenScope.VaultWrite })
    .input(vaultItemsRefreshSchema)
    .mutation(({ input, ctx }) => {
      return refreshVaultItems({ ...input, userId: ctx.user.id });
    }),
});
