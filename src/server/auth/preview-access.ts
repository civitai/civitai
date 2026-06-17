import type { SessionUser } from '~/types/session';

// Preview-site access check (preview deploys only) — extracted from the former `preview-auth` edge middleware,
// now that auth runs in the Node layer (_app getInitialProps). A user gets in if they're a moderator OR enabled
// in the Flipt `preview-site-access` segment. Plain fetch + a per-pod TTL cache; no Node-only deps.

const FLIPT_URL = process.env.FLIPT_URL;
const FLIPT_CACHE_TTL_MS = 60_000;
const FLIPT_TIMEOUT_MS = 2_000;
const fliptCache = new Map<string, { enabled: boolean | null; expiresAt: number }>();

type FliptBooleanResponse = { enabled?: boolean };

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
      body: JSON.stringify({ namespaceKey: 'default', flagKey, entityId, context }),
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

/** True if the user may access a preview deploy: moderators always; otherwise the Flipt testers segment. */
export async function checkPreviewAccess(user: SessionUser): Promise<boolean> {
  if (user.isModerator) return true;
  const hasAccess = await evaluateFliptFlag('preview-site-access', String(user.id), {
    userId: String(user.id),
    isModerator: String(!!user.isModerator),
    tier: user.tier ?? 'free',
    isLoggedIn: 'true',
  });
  return !!hasAccess;
}
