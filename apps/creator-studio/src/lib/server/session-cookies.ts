import { sessionCookieName } from '@civitai/auth';

/** Only the hub's session cookie crosses to the main app; this app's own test-simulator cookies stay here.
 *  The name carries a `__Secure-` prefix on HTTPS, so it comes from the auth package, never a literal. */
export function sessionCookies(request: Request, cookieName = sessionCookieName()): string {
  return (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${cookieName}=`))
    .join('; ');
}
