// middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  if (!response.headers.get('Cache-Control'))
    response.headers.set('Cache-Control', 'max-age=0, private, no-cache');

  return response;
}

// See "Matching Paths" below to learn more
export const config = {
  matcher: '/api/:path*',
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};
