import { env } from '~/env/server';
import {
  aliasSlug,
  colorDomainNames,
  type ColorDomain,
  type DomainConfig,
  type ServerDomainPrimaryMap,
  type ServerDomains,
} from '~/shared/constants/domain.constants';

/**
 * OAuth provider IDs we expose on the login page. Order matters — login UI
 * iterates this list to render buttons.
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

/** True if `host` is the canonical primary for its resolved color. */
export function isPrimaryHost(host: string): boolean {
  const normalized = host.toLowerCase();
  for (const color of colorDomainNames) {
    if (serverDomainMap[color]?.primary === normalized) return true;
  }
  return false;
}

/**
 * Resolve OAuth credentials for `provider` on `host`.
 *
 * - Primary hosts: prefer the per-color override
 *   (`<PROVIDER>_CLIENT_ID_<COLOR>` + `_CLIENT_SECRET_<COLOR>`); fall back to
 *   the global default (`<PROVIDER>_CLIENT_ID` + `_CLIENT_SECRET`).
 * - Alias hosts: require an alias-keyed CSV pair
 *   (`<PROVIDER>_AUTH_<aliasSlug>=<id>,<secret>`). No default fallback —
 *   provider is unavailable on the alias if the env var is absent.
 *
 * Returns `null` when no credential is configured for this host.
 */
export function resolveOAuthCredentialsForHost(
  provider: OAuthProviderId,
  host: string
): { clientId: string; clientSecret: string } | null {
  const normalized = host.toLowerCase();
  const upper = provider.toUpperCase();

  // Identify the color (if any) and whether this is the primary.
  let color: ColorDomain | undefined;
  let isPrimary = false;
  for (const c of colorDomainNames) {
    const cfg = serverDomainMap[c];
    if (!cfg) continue;
    if (cfg.primary === normalized) {
      color = c;
      isPrimary = true;
      break;
    }
    if (cfg.aliases.includes(normalized)) {
      color = c;
      break;
    }
  }

  if (color && !isPrimary) {
    // Alias host — require explicit CSV credentials. No default fallback.
    const csv = process.env[`${upper}_AUTH_${aliasSlug(normalized)}`];
    if (!csv) return null;
    const [clientId, clientSecret] = csv.split(',').map((s) => s.trim());
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  }

  // Primary host (or unknown host — fall back to global, matching legacy behavior).
  const colorId = color ? process.env[`${upper}_CLIENT_ID_${color.toUpperCase()}`] : undefined;
  const colorSecret = color
    ? process.env[`${upper}_CLIENT_SECRET_${color.toUpperCase()}`]
    : undefined;
  const clientId = colorId ?? process.env[`${upper}_CLIENT_ID`];
  const clientSecret = colorSecret ?? process.env[`${upper}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Provider IDs that have credentials configured for the given host. */
export function getAvailableOAuthProviders(host: string | undefined): OAuthProviderId[] {
  if (!host) return [...oauthProviderIds];
  return oauthProviderIds.filter((id) => resolveOAuthCredentialsForHost(id, host) !== null);
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
