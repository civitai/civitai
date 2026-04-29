export const colorDomainNames = ['green', 'blue', 'red'] as const;
export type ColorDomain = (typeof colorDomainNames)[number];

/**
 * Configuration for a single color domain.
 * - `primary` is the canonical host. All outbound URL construction (sync-account
 *   redirects, base URLs, sitemap, region-redirect targets) uses this.
 * - `aliases` are additional hosts that resolve to the same color on inbound
 *   requests. Aliases do NOT inherit the color's OAuth credentials — see
 *   `PROVIDER_AUTH_<alias_slug>` env pattern handled in next-auth-options.
 */
export type DomainConfig = {
  primary: string;
  aliases: string[];
};

export type ServerDomains = Record<ColorDomain, DomainConfig | undefined>;

/** Client-shipped projection: only the canonical host per color. */
export type ServerDomainPrimaryMap = Record<ColorDomain, string | undefined>;

/** Convert an alias host into an env-var-safe slug. */
export function aliasSlug(host: string): string {
  return host.toLowerCase().replace(/[^a-z0-9]/g, '_');
}
