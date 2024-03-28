import { env } from '~/env/client.mjs';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  GetPaginatedVaultItemsSchema,
  VaultItemsAddModelVersionSchema,
  VaultItemsRemoveModelVersionsSchema,
  VaultItemsUpdateNotesSchema,
} from '~/server/schema/vault.schema';
import { VaultItemGetPaged } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const useMutateVault = () => {
  const queryUtils = trpc.useContext();

  const onError = (error: any, message = 'There was an error while performing your request') => {
    try {
      console.log(JSON.stringify(error));
      // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
      const parsedError = JSON.parse(error.message);
      showErrorNotification({
        title: message,
        error: parsedError,
      });
    } catch (e) {
      // Report old error as is:
      showErrorNotification({
        title: message,
        error: new Error(error.message),
      });
    }
  };

  const toggleModelVersion = trpc.vault.toggleModelVersion.useMutation({
    onSuccess: async (res, { modelVersionId }) => {
      await queryUtils.vault.isModelVersionInVault.setData({ modelVersionId }, (old) => !old);
    },
    onError: (error) => {
      onError(error, 'Failed to toggle model version');
    },
  });

  const updateItemsNotes = trpc.vault.updateItemsNotes.useMutation({
    onSuccess: async () => {
      await queryUtils.vault.getItemsPaged.invalidate();
    },
    onError: (error) => {
      onError(error, 'Failed to update notes on these vault items');
    },
  });

  const removeItems = trpc.vault.removeItemsFromVault.useMutation({
    onSuccess: async () => {
      await queryUtils.vault.getItemsPaged.invalidate();
      // Refreshes storage:
      await queryUtils.vault.get.invalidate();
    },
    onError: (error) => {
      onError(error, 'Failed to rmeove these items from your Vault');
    },
  });

  const handleToggleModelVersion = (data: VaultItemsAddModelVersionSchema) => {
    return toggleModelVersion.mutateAsync(data);
  };
  const handleUpdateItemsNotes = (data: VaultItemsUpdateNotesSchema) => {
    return updateItemsNotes.mutateAsync(data);
  };
  const handleRemoveItems = (data: VaultItemsRemoveModelVersionsSchema) => {
    return removeItems.mutateAsync(data);
  };

  return {
    toggleModelVersion: handleToggleModelVersion,
    togglingModelVersion: toggleModelVersion.isLoading,
    updateItemsNotes: handleUpdateItemsNotes,
    updatingItemsNotes: updateItemsNotes.isLoading,
    removeItems: handleRemoveItems,
    removingItems: removeItems.isLoading,
  };
};

export const useQueryVault = () => {
  const currentUser = useCurrentUser();
  const { data: vault, ...rest } = trpc.vault.get.useQuery(undefined, {
    enabled: !!currentUser,
  });

  return { vault, ...rest };
};

export const useQueryVaultItems = (
  filters?: Partial<GetPaginatedVaultItemsSchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const currentUser = useCurrentUser();
  const { data, ...rest } = trpc.vault.getItemsPaged.useQuery(
    {
      ...filters,
    },
    {
      enabled: !!currentUser,
      ...options,
    }
  );

  if (data) {
    const { items = [], ...pagination } = data;
    return { items, pagination, ...rest };
  }

  return { items: [], pagination: null, ...rest };
};

export const getVaultItemDownloadUrls = (vaultItem: VaultItemGetPaged) => {
  return {
    models: `${env.NEXT_PUBLIC_BASE_URL}/api/download/vault/${vaultItem.id}?type=model`,
    images: `${env.NEXT_PUBLIC_BASE_URL}/api/download/vault/${vaultItem.id}?type=images`,
    details: `${env.NEXT_PUBLIC_BASE_URL}/api/download/vault/${vaultItem.id}?type=details`,
  };
};
