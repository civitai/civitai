// middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

function handleRedirects(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const redirect = (to: string) => NextResponse.redirect(new URL(to, request.url));
  if (searchParams.get('modal') === 'reviewThread')
    return redirect(`/redirect?to=review&reviewId=${searchParams.get('reviewId')}`);
}

export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith('/api')) {
    const response = NextResponse.next();
    if (!response.headers.get('Cache-Control'))
      response.headers.set('Cache-Control', 'max-age=0, private, no-cache');
    if (process.env.PODNAME) response.headers.set('X-Handled-By', process.env.PODNAME);

    return response;
  } else return handleRedirects(request);
}

// See "Matching Paths" below to learn more
export const config = {
  matcher: ['/api/trpc/:path*', '/api/v1/:path*', '/models/:path*'],
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};
