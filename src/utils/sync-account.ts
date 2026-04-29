import type { ColorDomain, ServerDomains } from '~/shared/constants/domain.constants';
import { QS } from '~/utils/qs';

/**
 * Module-level server domain map, populated by AppProvider on mount. Both the
 * current host and any URL host are resolved against this map (primary +
 * aliases) to determine their color, so the function adapts automatically to
 * whichever hosts are configured in the active environment (prod, dev, etc.).
 */
let serverDomains: ServerDomains | undefined;

/** Called once by AppProvider on mount. Not part of the public API. */
export function setServerDomains(domains: ServerDomains) {
  serverDomains = domains;
}

/**
 * Append `sync-account={sourceColor}` to a URL when navigating to a different
 * color domain. The destination uses this to pull the user's session via
 * `/api/auth/sync` (see useDomainSync).
 *
 * Returns the URL unchanged when:
 * - called outside the browser (SSR) or before AppProvider has mounted
 * - the URL is relative (same domain by definition)
 * - either host can't be matched to a known color (external URLs)
 * - source and destination resolve to the same color
 */
export function syncAccount(url: string, redirectUrl?: string): string {
  if (typeof window === 'undefined' || !serverDomains) return url;

  const urlHost = extractHost(url);
  if (!urlHost) return url;

  const currentColor = hostToColor(window.location.host, serverDomains);
  const urlColor = hostToColor(urlHost, serverDomains);

  if (!currentColor || !urlColor || currentColor === urlColor) return url;

  return QS.stringifyUrl({
    url,
    query: { 'sync-account': currentColor, 'sync-redirect': redirectUrl },
  });
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
