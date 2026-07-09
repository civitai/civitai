import { env } from '~/env/server';
import { getAllServerHosts } from '~/server/utils/server-domain';

export function hostFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return undefined;
  }
}

// Allowlist of hosts permitted to issue cookie-authenticated cross-origin
// requests. Built from server domains (primary + aliases), explicit
// TRPC_ORIGINS, and NEXTAUTH_URL.
export const allowedOriginHosts = new Set<string>(
  [...getAllServerHosts(), ...env.TRPC_ORIGINS.map(hostFromUrl), hostFromUrl(env.NEXTAUTH_URL)]
    .filter((h): h is string => !!h)
    .map((h) => h.toLowerCase())
);

// Origin preferred; Referer is the fallback for clients that suppress Origin.
// Absent both, treat as untrusted — isAcceptableOrigin rejects the request.
// Typed structurally (origin/referer only) so callers — the tRPC context and
// raw Next API routes alike — can share this single allowlist without pulling
// in heavier request types.
export function isAllowedOriginRequest(req: {
  headers: { origin?: string; referer?: string };
}): boolean {
  const sourceHost = hostFromUrl(req.headers.origin) ?? hostFromUrl(req.headers.referer);
  return !!sourceHost && allowedOriginHosts.has(sourceHost);
}
