import { useCurrentUser } from '~/hooks/useCurrentUser';
import { GetPaginatedCosmeticShopItemInput } from '~/server/schema/cosmetic-shop.schema';
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
