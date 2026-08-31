import { SYNC_PARAM } from '@civitai/auth/client';
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
 * Append `sync-account={sourceColor}` to a URL when navigating to a different color domain. The
 * destination's `useDomainSync` reads it and bootstraps a session there via the auth-code flow
 * (`/api/auth/authorize`).
 *
 * Takes the CURRENT colour as an argument rather than reading `window.location.host`, so it works
 * during SSR. That matters: the window-reading version below returns the url untouched on the server,
 * so every server-rendered cross-colour link shipped WITHOUT the marker and the carry-over silently
 * never fired for them. The colour cannot live in a module-scope global: one Next process serves every
 * colour concurrently, so a per-request value would leak across requests — hence `useSyncAccount`.
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

/**
 * Browser-only wrapper kept for call sites that render client-side only. Prefer `useSyncAccount` —
 * this one cannot stamp during SSR, because it has no way to know the current colour there.
 */
export function syncAccount(url: string): string {
  if (typeof window === 'undefined' || !serverDomains) return url;
  return syncAccountFor(url, hostToColor(window.location.host, serverDomains), serverDomains);
}

export function extractHost(url: string): string | undefined {
  const match = url.match(/^(?:https?:)?\/\/([^/?#]+)/i);
  return match?.[1].toLowerCase();
}

export function hostToColor(host: string, domains: ServerDomains): ColorDomain | undefined {
  const normalized = host.toLowerCase();
  for (const [color, cfg] of Object.entries(domains)) {
    if (!cfg) continue;
    if (cfg.primary === normalized) return color as ColorDomain;
    if (cfg.aliases.includes(normalized)) return color as ColorDomain;
  }
  return undefined;
}
