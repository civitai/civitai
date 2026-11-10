import { useMemo } from 'react';
import { useMaybeAppContext } from '~/providers/AppProvider';
import { collectInternalHosts } from '~/utils/external-link';

/**
 * Without the provider this is the current host and `FIRST_PARTY_HOSTS` alone, which
 * OVER-warns (a .com→.red link would be gated). That is the safe direction for a guard: a warning that should not have
 * appeared is a click, a warning that did not appear is the thing this exists to prevent.
 */
export function useInternalHosts(): string[] {
  const context = useMaybeAppContext();
  const serverDomains = context?.serverDomains;

  return useMemo(
    () =>
      collectInternalHosts(
        typeof window !== 'undefined' ? window.location.host : undefined,
        serverDomains
      ),
    [serverDomains]
  );
}
