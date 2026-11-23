/**
 * Provider sign-in start link, absolute on the hub's own origin. A relative link resolves against
 * whatever URL a client believes it is on; a crawler that asked a spoke for a page and was redirected
 * here can otherwise end up requesting /login/<provider> on the spoke host.
 */
export function providerStartHref(
  origin: string,
  providerId: string,
  params: URLSearchParams
): string {
  return `${origin}/login/${providerId}?${params.toString()}`;
}
