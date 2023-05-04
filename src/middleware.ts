// middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { SessionUser } from 'next-auth';

function handleRedirects(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const redirect = (to: string) => NextResponse.redirect(new URL(to, request.url));
  if (searchParams.get('modal') === 'reviewThread')
    return redirect(`/redirect?to=review&reviewId=${searchParams.get('reviewId')}`);
}

export async function middleware(request: NextRequest) {
  /**
   * role based directory guards
   */
  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/moderator')) {
    const token = await getToken({
      req: request,
      secret: process.env.NEXTAUTH_SECRET,
      cookieName: 'civitai-token',
    });
    if (!token) {
      const url = new URL(`/login`, request.url);
      return NextResponse.redirect(`${url.href}?returnUrl=${pathname}`);
    }
    const user = token.user as SessionUser;
    if (!user.isModerator) {
      const url = new URL(`/`, request.url);
      return NextResponse.redirect(url);
    }
  }

  if (pathname.startsWith('/api')) {
    const response = NextResponse.next();
    if (!response.headers.get('Cache-Control'))
      response.headers.set('Cache-Control', 'max-age=0, private, no-cache');
    if (process.env.PODNAME) response.headers.set('X-Handled-By', process.env.PODNAME);

    return response;
  } else if (pathname.startsWith('/models')) return handleRedirects(request);

  return NextResponse.next();
}

// See "Matching Paths" below to learn more
export const config = {
  matcher: ['/api/trpc/:path*', '/api/v1/:path*', '/models/:path*', '/moderator/:path*'],
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};
