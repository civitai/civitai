import { createMiddleware } from '~/server/middleware/middleware-utils';
import { isPreview } from '~/env/other';

// Read once at module init — env vars don't change at runtime.
const FLIPT_URL = process.env.FLIPT_URL;

// Edge-runtime-safe in-memory TTL cache. Lives for the isolate's lifetime;
// different regions/instances have independent caches, which is fine — even
// partial hit-rate eliminates most of the per-request Flipt round-trips on
// preview deploys. Can't use ~/server/utils/ttl-cache because that pulls in
// prom-client (Node-only).
const FLIPT_CACHE_TTL_MS = 60_000;
const FLIPT_TIMEOUT_MS = 2_000;
const fliptCache = new Map<string, { enabled: boolean | null; expiresAt: number }>();

type FliptBooleanResponse = { enabled?: boolean };

// Evaluate a Flipt boolean flag via HTTP API (Edge-compatible, no WASM SDK).
async function evaluateFliptFlag(
  flagKey: string,
  entityId: string,
  context: Record<string, string>
): Promise<boolean | null> {
  if (!FLIPT_URL) return null;

  const cacheKey = `${flagKey}:${entityId}`;
  const now = Date.now();
  const cached = fliptCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.enabled;

  try {
    const res = await fetch(`${FLIPT_URL}/evaluate/v1/boolean`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespaceKey: 'default',
        flagKey,
        entityId,
        context,
      }),
      signal: AbortSignal.timeout(FLIPT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as FliptBooleanResponse;
    const enabled = data.enabled ?? null;
    fliptCache.set(cacheKey, { enabled, expiresAt: now + FLIPT_CACHE_TTL_MS });
    return enabled;
  } catch {
    // Includes timeout (AbortError) and network errors — fall through to deny.
    return null;
  }
}

export const previewAuthMiddleware = createMiddleware({
  matcher: ['/:path*'],
  useSession: true,
  shouldRun: (request) => {
    if (!isPreview) return false;

    const { pathname } = request.nextUrl;
    // Don't block auth/login routes or static assets
    if (pathname.startsWith('/api/auth')) return false;
    if (pathname.startsWith('/login')) return false;
    if (pathname === '/preview-restricted') return false;
    if (pathname.startsWith('/_next')) return false;
    if (pathname.startsWith('/favicon')) return false;

    return true;
  },
  handler: async ({ user, redirect, request }) => {
    if (!user) {
      return redirect(`/login?returnUrl=${request.nextUrl.pathname}`);
    }

    // Moderators always have access
    if (user.isModerator) return;

    // Check Flipt testers segment via HTTP API (Edge-compatible)
    const hasAccess = await evaluateFliptFlag('preview-site-access', String(user.id), {
      userId: String(user.id),
      isModerator: String(!!user.isModerator),
      tier: user.tier ?? 'free',
      isLoggedIn: 'true',
    });
    if (hasAccess) return;

    return redirect('/preview-restricted');
  },
});
