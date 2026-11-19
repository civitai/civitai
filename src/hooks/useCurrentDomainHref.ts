import { useCallback, useMemo } from 'react';
import { useMaybeAppContext } from '~/providers/AppProvider';
import { getOwnHosts, toCurrentDomainHref } from '~/utils/current-domain-href';

/**
 * Rewrites links to our other domains onto the one being viewed. Reads the request host from
 * AppContext rather than `window.location`, so the server render and hydration produce the same
 * href; without the provider it leaves every href alone.
 */
export function useCurrentDomainHref() {
  const { host, ownHosts } = useCurrentDomainHosts();

  return useCallback((href: string) => toCurrentDomainHref(href, host, ownHosts), [host, ownHosts]);
}

/**
 * The two inputs `useCurrentDomainHref` rewrites with, for a caller that needs them as plain values
 * (RenderHtml keys its sanitize cache on them, which a callback's identity cannot do).
 */
export function useCurrentDomainHosts() {
  const context = useMaybeAppContext();
  const host = context?.host;
  const serverDomains = context?.serverDomains;
  const ownHosts = useMemo(() => getOwnHosts(serverDomains), [serverDomains]);
  return { host, ownHosts };
}
