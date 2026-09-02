import { SYNC_PARAM } from '@civitai/auth/client';
import type { ColorDomain, ServerDomains } from '~/shared/constants/domain.constants';
import { QS } from '~/utils/qs';

/**
 * Append `sync-account={sourceColor}` to a URL crossing to a different colour domain; the
 * destination's `useDomainSync` reads it and bootstraps a session via `/api/auth/authorize`.
 *
 * Colour is a parameter rather than ambient state, and both alternatives are broken: reading
 * `window.location.host` yields nothing during SSR, so every server-rendered cross-colour link ships
 * unstamped; and a module-scope colour leaks across requests, since one Next process serves every
 * colour concurrently. `useSyncAccount()` supplies it from context.
 */
export function syncAccountFor(
  url: string,
  currentColor: ColorDomain | undefined,
  domains: ServerDomains | undefined
): string {
  if (!domains || !currentColor) return url;

  const urlHost = extractHost(url);
  if (!urlHost) return url;

  const urlColor = hostToColor(urlHost, domains);
  if (!urlColor || urlColor === currentColor) return url;

  return QS.stringifyUrl({ url, query: { [SYNC_PARAM]: currentColor } });
}

function extractHost(url: string): string | undefined {
  const match = url.match(/^(?:https?:)?\/\/([^/?#]+)/i);
  return match?.[1].toLowerCase();
}

function hostToColor(host: string, domains: ServerDomains): ColorDomain | undefined {
  const normalized = host.toLowerCase();
  for (const [color, cfg] of Object.entries(domains)) {
    if (!cfg) continue;
    if (cfg.primary === normalized) return color as ColorDomain;
    if (cfg.aliases.includes(normalized)) return color as ColorDomain;
  }
  return undefined;
}
