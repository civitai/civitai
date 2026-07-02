// SvelteKit's `getClientAddress()` THROWS (it does not return empty) when the adapter is configured with
// `ADDRESS_HEADER=x-forwarded-for` but the request arrives WITHOUT that header — which is exactly what happens
// to a server-to-server hub call routed to the in-cluster ClusterIP (`AUTH_HUB_INTERNAL_URL`): it bypasses
// Traefik, so no proxy appends XFF. An OAuth endpoint that does `getClientAddress() || 'unknown'` therefore
// 500s the whole request instead of degrading. This wrapper makes that impossible: it returns the resolved IP
// when available, or `undefined` when the address can't be determined, so callers decide their own fallback
// (e.g. a per-tenant rate-limit key) rather than crashing.
export function safeClientAddress(getClientAddress: () => string): string | undefined {
  try {
    return getClientAddress() || undefined;
  } catch {
    return undefined;
  }
}
