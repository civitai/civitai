// proxy.ts (Next 16 renamed the `middleware` file convention to `proxy`). This is the moderator app's auth
// adapter: read the Cookie header → ask the shared spoke guard → act. The guard's decision logic is
// framework-agnostic (@civitai/auth `createSpokeGuard`); only these few lines are Next-specific.
import { NextResponse, type NextRequest } from 'next/server';
import { guard } from './src/server/auth';

export async function proxy(req: NextRequest) {
  const result = await guard.check(req.headers.get('cookie') ?? '', req.url);
  if (result.status === 'login') return NextResponse.redirect(result.redirect); // no session → hub login
  if (result.status === 'forbidden') return new NextResponse('Forbidden', { status: 403 }); // not a moderator
  return NextResponse.next(); // authenticated moderator → continue
}

// Proxy always runs on the Node.js runtime in Next 16 (not the Edge sandbox), so the guard can use full Node
// APIs — needed because it resolves the user via redis/the hub identity endpoint, not from the cookie. Only
// `matcher` is allowed here (`runtime` / route-segment config are rejected in a Proxy file). Gate everything
// except Next internals + static assets.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
