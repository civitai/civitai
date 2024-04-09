import { useCurrentUser } from '~/hooks/useCurrentUser';
import { GetPaginatedCosmeticsInput } from '~/server/schema/cosmetic.schema';
import { trpc } from '~/utils/trpc';

export const useQueryCosmeticsPaged = (
  filters?: Partial<GetPaginatedCosmeticsInput>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const currentUser = useCurrentUser();

  const { data, ...rest } = trpc.cosmetic.getPaged.useQuery(
    {
      ...filters,
    },
    {
      ...options,
      enabled: (options?.enabled ?? true) && currentUser?.isModerator,
    }
  );

  if (data) {
    const { items: cosmetics = [], ...pagination } = data;
    return { cosmetics, pagination, ...rest };
  }

  return { cosmetics: [], pagination: null, ...rest };
};
