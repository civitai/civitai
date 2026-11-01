import type { Cookies } from '@sveltejs/kit';

/** The request's cookies in the shape the package's two-slot readers take. */
export const cookieJar = (cookies: Pick<Cookies, 'get'>): Record<string, string | undefined> =>
  new Proxy({}, { get: (_, name) => (typeof name === 'string' ? cookies.get(name) : undefined) });
