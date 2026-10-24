/** Only the hub's auth cookies cross to the main app; this app's own test-simulator cookies stay here.
 *  Matched by shape rather than by `sessionCookieName()`: that helper derives the `__Secure-` prefix
 *  from this app's env, and a mismatch with the main app's derivation silently forwards nothing. */
const HUB_COOKIE = /^(?:__Secure-|__Host-)?civ-(?:token|device)=/;

export function sessionCookies(request: Request): string {
  return (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => HUB_COOKIE.test(part))
    .join('; ');
}
