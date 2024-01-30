import { useCurrentUser } from '../../hooks/useCurrentUser';
import { GetPaginatedBuzzWithdrawalRequestSchema } from '../../server/schema/buzz-withdrawal-request.schema';
import { trpc } from '../../utils/trpc';

export const useQueryOwnedBuzzWithdrawalRequests = (
  filters?: Partial<GetPaginatedBuzzWithdrawalRequestSchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const currentUser = useCurrentUser();
  const { data, ...rest } = trpc.buzzWithdrawalRequest.getPaginated.useQuery(
    {
      ...filters,
    },
    {
      enabled: !!currentUser,
      ...options,
    }
  );

  if (data) {
    const { items: requests = [], ...pagination } = data;
    return { requests, pagination, ...rest };
  }

  return { requests: [], pagination: null, ...rest };
};
