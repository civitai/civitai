import { createMiddleware } from '~/server/middleware/middleware-utils';
import { isPreview } from '~/env/other';

// Evaluate a Flipt boolean flag via HTTP API (Edge-compatible, no WASM SDK).
async function evaluateFliptFlag(
  flagKey: string,
  entityId: string,
  context: Record<string, string>
): Promise<boolean | null> {
  const fliptUrl = process.env.FLIPT_URL;
  if (!fliptUrl) return null;
  try {
    const res = await fetch(`${fliptUrl}/evaluate/v1/boolean`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespaceKey: 'default',
        flagKey,
        entityId,
        context,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.enabled ?? null;
  } catch {
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
