import { env } from '~/env/server';
import {
  colorDomainNames,
  type ColorDomain,
  type DomainConfig,
  type ServerDomainPrimaryMap,
  type ServerDomains,
} from '~/shared/constants/domain.constants';

/**
 * The OAuth provider IDs the connected-accounts UI knows how to render. `getAvailableOAuthProviders` intersects
 * the hub's enabled-provider list with this set, so a provider the hub enables but that's missing here is simply
 * not surfaced. Keep in sync with the hub's provider config (`apps/auth/src/lib/server/auth/providers.ts`) and
 * `@civitai/auth`'s `ProviderId`.
 */
export const oauthProviderIds = ['discord', 'github', 'google', 'reddit'] as const;
export type OAuthProviderId = (typeof oauthProviderIds)[number];

function parseAliases(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function buildConfig(primary: string | undefined, aliases: string[]): DomainConfig | undefined {
  if (!primary) return undefined;
  return { primary: primary.toLowerCase(), aliases };
}

export const serverDomainMap: ServerDomains = {
  green: buildConfig(env.SERVER_DOMAIN_GREEN, parseAliases(env.SERVER_DOMAIN_GREEN_ALIASES)),
  blue: buildConfig(env.SERVER_DOMAIN_BLUE, parseAliases(env.SERVER_DOMAIN_BLUE_ALIASES)),
  red: buildConfig(env.SERVER_DOMAIN_RED, parseAliases(env.SERVER_DOMAIN_RED_ALIASES)),
};

/** Canonical-only projection. Used by client and outbound URL helpers. */
export const serverDomainPrimaryMap: ServerDomainPrimaryMap = {
  green: serverDomainMap.green?.primary,
  blue: serverDomainMap.blue?.primary,
  red: serverDomainMap.red?.primary,
};

/** Flat list of every configured host across every color (primary + aliases). */
export function getAllServerHosts(): string[] {
  const hosts: string[] = [];
  for (const color of colorDomainNames) {
    const cfg = serverDomainMap[color];
    if (!cfg) continue;
    hosts.push(cfg.primary, ...cfg.aliases);
  }
  return hosts;
}

/** All hosts (primary + aliases) for a single color. */
export function getHostsForColor(color: ColorDomain): string[] {
  const cfg = serverDomainMap[color];
  if (!cfg) return [];
  return [cfg.primary, ...cfg.aliases];
}

/** True if the given host is the primary or any alias of `color`. */
export function isHostForColor(host: string, color: ColorDomain): boolean {
  const cfg = serverDomainMap[color];
  if (!cfg) return false;
  const normalized = host.toLowerCase();
  return cfg.primary === normalized || cfg.aliases.includes(normalized);
}

/**
 * App Blocks NSFW gating — the SINGLE SOURCE OF TRUTH for "this host may serve
 * mature-rated apps". A mature app (`contentRating` ∈ {r, x}) is usable ONLY on
 * a RED-capable host.
 *
 * Why `isHostForColor(host, 'red')` and NOT `getRequestDomainColor(host)`:
 * `civitai.red` is configured as BOTH a blue and a red domain, and
 * `getRequestDomainColor` is a first-match walk over [green, blue, red], so it
 * returns `blue` for `civitai.red` — which would (wrongly) treat .red as SFW.
 * `isHostForColor(host, 'red')` is the membership test that correctly returns
 * TRUE for `civitai.red` (its primary/aliases) regardless of the color-walk
 * ordering. This is deliberately scoped to the App-Blocks NSFW gate; it does NOT
 * change the global color resolution.
 */

/** Mature content ratings (App Blocks). Everything else is SFW. */
const MATURE_CONTENT_RATINGS = new Set(['r', 'x']);

/**
 * True iff the rating is mature (r/x). FAIL-CLOSED on ambiguity in the OPPOSITE
 * direction is the caller's job: an unknown/missing/empty rating returns
 * `false` (SFW) here, which is safe because `contentRating` is a REQUIRED,
 * validated manifest field (`block-manifest-validator.service.ts`) stored on
 * approve — a missing value means "not mature", and the gates that hide/refuse
 * mature content only act when this is `true`.
 */
export function isMatureContentRating(rating: string | null | undefined): boolean {
  if (typeof rating !== 'string') return false;
  return MATURE_CONTENT_RATINGS.has(rating.toLowerCase());
}

/**
 * True iff an app with `rating` is allowed to be listed / detailed / run on
 * `host`. SFW ratings (g/pg/pg13 and any unknown→SFW) are allowed on ANY host;
 * a mature rating (r/x) requires a RED-capable host. Fail-closed: a mature
 * rating on a non-red host returns `false`.
 */
export function ratingAllowedOnHost(rating: string | null | undefined, host: string): boolean {
  if (!isMatureContentRating(rating)) return true;
  return isHostForColor(host, 'red');
}

/** True if `host` is the canonical primary for its resolved color. */
export function isPrimaryHost(host: string): boolean {
  const normalized = host.toLowerCase();
  for (const color of colorDomainNames) {
    if (serverDomainMap[color]?.primary === normalized) return true;
  }
  return false;
}

/**
 * True if `host` resolves to a color but is NOT that color's primary —
 * i.e. it's a registered alias host. Used to suppress login surfaces that
 * should only run on the canonical primaries (e.g. email magic-link, which
 * would otherwise create a session scoped to the alias and bypass the
 * intended sync-from-primary flow).
 */
export function isAliasHost(host: string): boolean {
  const normalized = host.toLowerCase();
  for (const color of colorDomainNames) {
    const cfg = serverDomainMap[color];
    if (!cfg) continue;
    if (cfg.primary === normalized) return false;
    if (cfg.aliases.includes(normalized)) return true;
  }
  return false;
}

// The OAuth providers a user can connect — sourced from the HUB, which is the SINGLE authority for provider
// config + secrets (the spoke holds NO provider secrets). Fetched server-to-server from `GET {hub}/api/auth/
// providers` and cached in-memory; fails OPEN to the last-good (or empty) list so an SSR render never breaks on
// a hub blip. Server-only (reads AUTH_JWT_ISSUER). Replaces the old per-host CLIENT_ID/SECRET resolution.
const PROVIDERS_TTL_MS = 10 * 60_000;
let providersCache: { ids: OAuthProviderId[]; at: number } | undefined;

export async function getAvailableOAuthProviders(): Promise<OAuthProviderId[]> {
  if (providersCache && Date.now() - providersCache.at < PROVIDERS_TTL_MS)
    return providersCache.ids;

  const hub = (process.env.AUTH_JWT_ISSUER ?? '').replace(/\/+$/, '');
  if (!hub) return providersCache?.ids ?? [];

  try {
    const res = await fetch(`${hub}/api/auth/providers`);
    if (!res.ok) return providersCache?.ids ?? [];
    const data = (await res.json()) as { providers?: { id?: string }[] };
    const known = new Set<string>(oauthProviderIds);
    const ids = (data.providers ?? [])
      .map((p) => p?.id)
      .filter((id): id is OAuthProviderId => typeof id === 'string' && known.has(id));
    providersCache = { ids, at: Date.now() };
    return ids;
  } catch {
    // hub unreachable — keep rendering with the last-good (or empty) list rather than throwing in SSR.
    return providersCache?.ids ?? [];
  }
}

export function getRequestDomainColor(req: { headers: { host?: string } }) {
  const host = req?.headers?.host?.toLowerCase();
  if (!host) return undefined;

  // Walk every host (primary + aliases) for every color. With multiple colors
  // on the same localhost port, the earliest-declared color in
  // `colorDomainNames` wins (green → blue → red).
  for (const color of colorDomainNames) {
    if (isHostForColor(host, color)) return color;
  }

  // Fallback: host is localhost but no exact port match was configured. Pick
  // the first color whose primary is also configured as localhost.
  if (host.startsWith('localhost:')) {
    for (const color of colorDomainNames) {
      const primary = serverDomainMap[color]?.primary;
      if (primary?.startsWith('localhost:')) return color;
    }
  }

  return undefined;
}
