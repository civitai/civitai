import { useMemo } from 'react';
import { useMaybeAppContext } from '~/providers/AppProvider';

/**
 * Without the provider this is the current host alone, which OVER-warns (a .com→.red link
 * would be gated). That is the safe direction for a guard: a warning that should not have
 * appeared is a click, a warning that did not appear is the thing this exists to prevent.
 */
export function useInternalHosts(): string[] {
  const context = useMaybeAppContext();
  const serverDomains = context?.serverDomains;

  return useMemo(() => {
    const hosts = new Set<string>();
    if (typeof window !== 'undefined') hosts.add(window.location.host);
    for (const config of Object.values(serverDomains ?? {})) {
      if (!config) continue;
      hosts.add(config.primary);
      for (const alias of config.aliases) hosts.add(alias);
    }
    return [...hosts];
  }, [serverDomains]);
}
