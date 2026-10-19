import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

/** Shared hook for fetching supported crypto currencies. Requires authentication. */
export function useSupportedCurrencies() {
  const currentUser = useCurrentUser();
  return trpc.nowPayments.getSupportedCurrencies.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    enabled: !!currentUser,
  });
}
