// Edge-friendly route guard for spoke apps (Next `proxy.ts` / middleware). Verifies the
// session cookie SIGNATURE via JWKS and redirects to the hub login on miss.
//
// IMPORTANT: construct the verifier passed here WITHOUT `isRevoked` — the redis revocation
// check is not edge-runtime compatible. The middleware is a fast signature gate; full
// revocation runs in the data layer (server handlers / tRPC) where redis is available.
import type { AuthVerifier } from './verify';

export interface AuthMiddlewareConfig {
  /** Hub login origin, e.g. https://auth.civitai.com */
  loginUrl: string;
  /** Paths that bypass the guard (prefix match). */
  publicPaths?: string[];
}

/**
 * Returns a guard `(request) => Response | undefined`. Undefined ⇒ allow (call next()).
 * A Response ⇒ a 302 redirect to the hub the caller should return.
 */
export function createAuthMiddleware(verifier: AuthVerifier, config: AuthMiddlewareConfig) {
  const publicPaths = config.publicPaths ?? [];

  return async function guard(request: {
    headers: { get(name: string): string | null };
    url: string;
  }): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (publicPaths.some((p) => url.pathname.startsWith(p))) return undefined;

    const session = await verifier.getSession(request.headers.get('cookie') ?? '');
    if (session) return undefined;

    const login = new URL('/login', config.loginUrl);
    login.searchParams.set('callbackUrl', request.url);
    return Response.redirect(login.toString(), 302);
  };
}
