import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  GetPaginatedVaultItemsSchema,
  VaultItemsAddModelVersionSchema,
} from '~/server/schema/vault.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const useMutateVault = () => {
  const queryUtils = trpc.useContext();

  const onError = (error: any, message = 'There was an error while performing your request') => {
    try {
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
      await queryUtils.vault.isModelVersionInVault.setData({ modelVersionId }, (old) => {
        return !old;
      });
    },
    onError: (error) => {
      onError(error, 'Failed to toggle model version');
    },
  });

  const handleToggleModelVersion = (data: VaultItemsAddModelVersionSchema) => {
    return toggleModelVersion.mutateAsync(data);
  };

  return {
    toggleModelVersion: handleToggleModelVersion,
    togglingModelVersion: toggleModelVersion.isLoading,
  };
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
