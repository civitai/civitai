import type { ColorDomain, ServerDomains } from '~/shared/constants/domain.constants';

/**
 * A canonical claiming the page for the colour serving it. `Meta` resolves a relative canonical
 * against the green base on every colour — right for the pages red mirrors (home, feeds), whose
 * signed-out render matches green's. A page only red can show (mature content, a red-owned tag)
 * has to say its own host, or it hands its ranking to a green url that is deindexed or a gate.
 * Unchanged on green, or when the colour has no configured host.
 */
export function ownDomainCanonical(
  path: string,
  domain: Record<ColorDomain, boolean>,
  serverDomains: ServerDomains
): string {
  if (domain.green || isAbsoluteUrl(path)) return path;
  const color = (Object.keys(domain) as ColorDomain[]).find((c) => domain[c]);
  const primary = color ? serverDomains[color]?.primary : undefined;
  return primary ? `https://${primary}${path}` : path;
}

/**
 * The href for a `canonical`/`alternate` link. A page may hand over the canonical to a sibling
 * domain (red → green for a mostly-safe tag) as an absolute URL; prefixing this deployment's own
 * base onto that produces `https://civitai.comhttps://civitai.green/...`.
 */
export function resolveMetaHref(value: string, baseUrl: string): string {
  return isAbsoluteUrl(value) ? value : `${baseUrl}${value}`;
}

function isAbsoluteUrl(value: string) {
  return /^https?:\/\//i.test(value);
}
