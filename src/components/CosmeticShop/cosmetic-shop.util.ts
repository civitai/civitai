import { CosmeticType } from '@prisma/client';
import { z } from 'zod';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  CosmeticShopItemMeta,
  GetAllCosmeticShopSections,
  GetPaginatedCosmeticShopItemInput,
  GetShopInput,
  PurchaseCosmeticShopItemInput,
  UpdateCosmeticShopSectionsOrderInput,
  UpsertCosmeticShopItemInput,
  UpsertCosmeticShopSectionInput,
} from '~/server/schema/cosmetic-shop.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { numericStringArray, stringArray } from '~/utils/zod-helpers';

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
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();

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
      await queryUtils.cosmeticShop.getAllSections.invalidate();
    },
    onError(error) {
      onError(error, 'Failed to update or create the cosmetic shop section');
    },
  });

  const deleteShopItemMutation = trpc.cosmeticShop.deleteShopItem.useMutation({
    async onSuccess(input) {
      await queryUtils.cosmeticShop.getShopItemsPaged.invalidate();
    },
    onError(error) {
      onError(error, 'Failed to delete the cosmetic shop item');
    },
  });

  const deleteShopSectionMutation = trpc.cosmeticShop.deleteShopSection.useMutation({
    async onSuccess(input) {
      await queryUtils.cosmeticShop.getAllSections.invalidate();
    },
    onError(error) {
      onError(error, 'Failed to delete the cosmetic shop section');
    },
  });

  const updateShopSectionsOrderMutation = trpc.cosmeticShop.updateSectionsOrder.useMutation({
    async onSuccess(_, { sortedSectionIds }) {
      queryUtils.cosmeticShop.getAllSections.setData({}, (data) => {
        if (!data) return [];

        const updated = [...data].sort((a, b) => {
          const aPlacement = sortedSectionIds.indexOf(a.id);
          const bPlacement = sortedSectionIds.indexOf(b.id);

          return aPlacement - bPlacement;
        });

        return updated;
      });
    },
    onError(error) {
      onError(error, 'Failed to delete the cosmetic shop section');
    },
  });

  const purchaseShopItemMutation = trpc.cosmeticShop.purchaseShopItem.useMutation({
    async onSuccess(_, { shopItemId }) {
      await queryUtils.userProfile.get.invalidate();
      await queryUtils.user.getCosmetics.invalidate();
      if (currentUser?.id) {
        await queryUtils.user.getCreator.invalidate({
          id: currentUser.id,
        });
      }

      queryUtils.cosmeticShop.getShop.setData({}, (data) => {
        if (!data) return [];

        const sections = data.map((section) => {
          const updatedItems = section.items.map((item) => {
            const meta = (item.shopItem.meta ?? {}) as CosmeticShopItemMeta;
            if (item.shopItem.id === shopItemId) {
              return {
                ...item,
                shopItem: {
                  ...item.shopItem,
                  meta: {
                    ...meta,
                    purchases: (meta.purchases ?? 0) + 1,
                  },
                },
              };
            }

            return item;
          });

          return {
            ...section,
            items: updatedItems,
          };
        });

        return sections;
      });
    },
    onError(error) {
      onError(error, 'Failed to purchase cosmetic');
    },
  });

  const handleUpsertShopItem = (data: UpsertCosmeticShopItemInput) => {
    return upsertShopItemMutation.mutateAsync(data);
  };
  const handleUpsertShopSection = (data: UpsertCosmeticShopSectionInput) => {
    return upsertShopSectionMutation.mutateAsync(data);
  };
  const handleDeleteShopSection = (data: GetByIdInput) => {
    return deleteShopSectionMutation.mutateAsync(data);
  };
  const handleUpdateShopSectionsOrderMutation = (data: UpdateCosmeticShopSectionsOrderInput) => {
    return updateShopSectionsOrderMutation.mutateAsync(data);
  };
  const handleDeleteShopItemMutation = (data: GetByIdInput) => {
    return deleteShopItemMutation.mutateAsync(data);
  };
  const handlePurchaseShopItemMutation = (data: PurchaseCosmeticShopItemInput) => {
    return purchaseShopItemMutation.mutateAsync(data);
  };

  return {
    upsertShopItem: handleUpsertShopItem,
    upsertingShopItem: upsertShopItemMutation.isLoading,
    upsertShopSection: handleUpsertShopSection,
    upsertingShopSection: upsertShopSectionMutation.isLoading,
    deleteShopSection: handleDeleteShopSection,
    deletingShopSection: deleteShopSectionMutation.isLoading,
    updateShopSectionsOrder: handleUpdateShopSectionsOrderMutation,
    updatingShopSectionsOrder: updateShopSectionsOrderMutation.isLoading,
    deleteShopItem: handleDeleteShopItemMutation,
    deletingShopItem: deleteShopItemMutation.isLoading,
    purchaseShopItem: handlePurchaseShopItemMutation,
    purchasingShopItem: purchaseShopItemMutation.isLoading,
  };
};

export const useQueryShop = (
  filters?: Partial<GetShopInput>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const { data = [], ...rest } = trpc.cosmeticShop.getShop.useQuery(
    {
      ...filters,
    },
    {
      ...options,
      enabled: options?.enabled ?? true,
    }
  );

  if (data) {
    return { cosmeticShopSections: data, ...rest };
  }

  return { cosmeticShopSections: [], ...rest };
};

export const useShopLastViewed = () => {
  const currentUser = useCurrentUser();
  const { data, isLoading, isFetched, ...rest } = trpc.user.getSettings.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const { cosmeticStoreLastViewed: lastViewed } = data ?? {
    cosmeticStoreLastViewed: null,
  };

  const updateUserSettings = trpc.user.setSettings.useMutation({
    onError(_error, _payload, context) {
      // Simply ignore really. We don't want to show an error notification for this.
    },
  });

  const updateLastViewed = async () => {
    if (!currentUser || updateUserSettings.isLoading || updateUserSettings.isSuccess) {
      return;
    }

    updateUserSettings.mutate({
      cosmeticStoreLastViewed: new Date(),
    });
  };

  return {
    lastViewed,
    isLoading,
    isFetched,
    updateLastViewed,
    updatedLastViewed: updateUserSettings.isSuccess,
  };
};

const cosmeticShopQueryParams = z
  .object({
    cosmeticTypes: stringArray(),
  })
  .partial();
export const useCosmeticShopQueryParams = () => useZodRouteParams(cosmeticShopQueryParams);
export type CosmeticShopQueryParams = z.output<typeof cosmeticShopQueryParams>;
