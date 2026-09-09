// eTLD+1 derivation, under the 2-label assumption the rest of the auth stack already makes (cookie.ts here,
// civ-cookie.ts in the main app). Deliberately dependency-free so anything can import it without dragging in
// `$env`, redis or the db.
//
// NOT a general public-suffix implementation: `foo.co.uk` resolves to `co.uk`. That is wrong in general and
// fine here, because every host this is asked about is one of ours (civitai.com / civitai.red / civitaic.com),
// and the callers use it to compare two of our own hosts rather than to trust an arbitrary one.

/** eTLD+1 of a hostname — `www.civitai.red` → `civitai.red`. Undefined for an empty host. */
export function registrableDomain(hostname: string): string | undefined {
  const host = hostname.trim().toLowerCase();
  if (!host) return undefined;
  const parts = host.split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : host;
}

/** eTLD+1 of a URL's host. Undefined when the url is unparseable. */
export function registrableDomainOfUrl(url: string): string | undefined {
  try {
    return registrableDomain(new URL(url).hostname);
  } catch {
    return undefined;
  }
}
