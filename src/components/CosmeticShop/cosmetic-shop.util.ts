import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  GetAllCosmeticShopSections,
  GetPaginatedCosmeticShopItemInput,
  UpsertCosmeticShopItemInput,
  UpsertCosmeticShopSectionInput,
} from '~/server/schema/cosmetic-shop.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const useQueryCosmeticShopItemsPaged = (
  filters?: Partial<GetPaginatedCosmeticShopItemInput>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const currentUser = useCurrentUser();

  const { data, ...rest } = trpc.cosmeticShop.getShopItemsPaged.useQuery(
    {
      ...filters,
    },
    {
      ...options,
      enabled: (options?.enabled ?? true) && currentUser?.isModerator,
    }
  );

  if (data) {
    const { items: cosmeticShopItems = [], ...pagination } = data;
    return { cosmeticShopItems, pagination, ...rest };
  }

  return { cosmeticShopItems: [], pagination: null, ...rest };
};

export const useQueryCosmeticShopItem = ({ id }: { id: number }) => {
  const currentUser = useCurrentUser();

  const { data, ...rest } = trpc.cosmeticShop.getShopItemById.useQuery(
    {
      id,
    },
    {
      enabled: currentUser?.isModerator,
    }
  );

  if (data) {
    return { cosmeticShopItem: data, ...rest };
  }

  return { cosmeticShopItem: null, ...rest };
};

export const useQueryCosmeticShopSections = (filters?: Partial<GetAllCosmeticShopSections>) => {
  const currentUser = useCurrentUser();

  const { data = [], ...rest } = trpc.cosmeticShop.getAllSections.useQuery(filters ?? {}, {
    enabled: currentUser?.isModerator,
  });

  if (data) {
    return { cosmeticShopSections: data, ...rest };
  }

  return { cosmeticShopSections: [], ...rest };
};

export const useQueryCosmeticShopSection = ({ id }: { id: number }) => {
  const currentUser = useCurrentUser();

  const { data, ...rest } = trpc.cosmeticShop.getSectionById.useQuery(
    {
      id,
    },
    {
      enabled: currentUser?.isModerator,
    }
  );

  if (data) {
    return { cosmeticShopSection: data, ...rest };
  }

  return { cosmeticShopSection: null, ...rest };
};

export const useMutateCosmeticShop = () => {
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

  const upsertShopItemMutation = trpc.cosmeticShop.upsertShopItem.useMutation({
    async onSuccess() {
      await queryUtils.cosmeticShop.getShopItemsPaged.invalidate();
    },
    onError(error) {
      onError(error, 'Failed to update or create the cosmetic shop item');
    },
  });

  const upsertShopSectionMutation = trpc.cosmeticShop.upsertShopSection.useMutation({
    async onSuccess() {
      await queryUtils.cosmeticShop.getShopSectionsPaged.invalidate();
    },
    onError(error) {
      onError(error, 'Failed to update or create the cosmetic shop section');
    },
  });

  const handleUpsertShopItem = (data: UpsertCosmeticShopItemInput) => {
    return upsertShopItemMutation.mutateAsync(data);
  };
  const handleUpsertShopSection = (data: UpsertCosmeticShopSectionInput) => {
    return upsertShopSectionMutation.mutateAsync(data);
  };

  return {
    upsertShopItem: handleUpsertShopItem,
    upsertingShopItem: upsertShopItemMutation.isLoading,
    upsertShopSection: handleUpsertShopSection,
    upsertingShopSection: upsertShopSectionMutation.isLoading,
  };
};
