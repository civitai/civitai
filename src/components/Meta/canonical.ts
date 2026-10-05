/**
 * The href for a `canonical`/`alternate` link. A page may hand over the canonical to a sibling
 * domain (red → green for a mostly-safe tag) as an absolute URL; prefixing this deployment's own
 * base onto that produces `https://civitai.comhttps://civitai.green/...`.
 */
export function resolveMetaHref(value: string, baseUrl: string): string {
  return /^https?:\/\//i.test(value) ? value : `${baseUrl}${value}`;
}
