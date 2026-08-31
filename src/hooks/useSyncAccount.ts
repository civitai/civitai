import { useCallback } from 'react';
import { useAppContext } from '~/providers/AppProvider';
import type { ColorDomain } from '~/shared/constants/domain.constants';
import { syncAccountFor } from '~/utils/sync-account';

/**
 * Stamp cross-colour links with `sync-account` so the destination bootstraps a session
 * (`useDomainSync` → `/api/auth/authorize`).
 *
 * Use this rather than the bare `syncAccount()` in anything that renders on the server. `syncAccount`
 * derives the current colour from `window.location.host`, so on the server it returns the url
 * untouched — every server-rendered cross-colour link shipped unstamped, and a browser arriving at
 * the other colour without an existing session stayed signed out. It is masked in normal use because
 * the destination's session cookie is 30-day rolling, so people are usually already signed in there.
 *
 * The colour comes from context, not a module-level global: one Next process serves every colour
 * concurrently, so caching a per-request value at module scope would let one request read another's.
 */
export function useSyncAccount() {
  const { domain, serverDomains } = useAppContext();
  const currentColor = (Object.keys(domain) as ColorDomain[]).find((color) => domain[color]);
  return useCallback(
    (url: string) => syncAccountFor(url, currentColor, serverDomains),
    [currentColor, serverDomains]
  );
}
