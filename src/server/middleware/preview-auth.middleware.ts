import { createMiddleware } from '~/server/middleware/middleware-utils';
import { isPreview } from '~/env/other';

// Lazy-load Flipt to avoid Edge runtime issues with WASM/server env
let _fliptModule: typeof import('~/server/flipt/client') | null = null;
async function getFliptModule() {
  if (!_fliptModule) {
    try {
      _fliptModule = await import('~/server/flipt/client');
    } catch {
      return null;
    }
  }
  return _fliptModule;
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

    // Check Flipt testers segment
    const flipt = await getFliptModule();
    if (flipt) {
      const hasAccess = await flipt.isFlipt('preview-site-access', String(user.id), {
        userId: String(user.id),
        isModerator: String(!!user.isModerator),
        tier: user.tier ?? 'free',
        isLoggedIn: 'true',
      });
      if (hasAccess) return;
    }

    return redirect('/preview-restricted');
  },
});
