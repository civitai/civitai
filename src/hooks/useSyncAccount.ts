import { useCallback } from 'react';
import { useAppContext } from '~/providers/AppProvider';
import type { ColorDomain } from '~/shared/constants/domain.constants';
import { syncAccountFor } from '~/utils/sync-account';

/**
 * Stamp cross-colour links with `sync-account` so the destination bootstraps a session
 * (`useDomainSync` → `/api/auth/authorize`). Supplies the current colour from context, which is what
 * makes stamping work during SSR — see `syncAccountFor` for why it cannot come from anywhere else.
 */
export function useSyncAccount() {
  const { domain, serverDomains } = useAppContext();
  const currentColor = (Object.keys(domain) as ColorDomain[]).find((color) => domain[color]);
  return useCallback(
    (url: string) => syncAccountFor(url, currentColor, serverDomains),
    [currentColor, serverDomains]
  );
}
