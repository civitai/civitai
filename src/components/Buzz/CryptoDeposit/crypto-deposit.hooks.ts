import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

/** How long a fetched currency list is reused before a mount or a deposit signal refetches it. */
export const SUPPORTED_CURRENCIES_STALE_TIME = 5 * 60 * 1000;

/** Shared hook for fetching supported crypto currencies. Requires authentication. */
export function useSupportedCurrencies() {
  const currentUser = useCurrentUser();
  return trpc.nowPayments.getSupportedCurrencies.useQuery(undefined, {
    staleTime: SUPPORTED_CURRENCIES_STALE_TIME,
    enabled: !!currentUser,
  });
}
