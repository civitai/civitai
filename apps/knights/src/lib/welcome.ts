export const WELCOME_PATH = '/';
export const HOME_PATH = '/home';

const DATA_SUFFIX = '/__data.json';
const INVALIDATED_PARAM = 'x-sveltekit-invalidated';

/**
 * The page to come back to after sign-in, from the untrusted `?next=`. Only a same-origin path survives:
 * one slash, then anything but a slash, backslash or control character (browsers read `/\` and `//` as a host).
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !/^\/(?![/\\])[^\\]*$/.test(raw)) return '/';
  if ([...raw].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return '/';
  if (/%(0[0-9a-f]|1[0-9a-f]|7f)/i.test(raw)) return '/';
  return raw;
}

/** The page a request is really for: a client-side navigation arrives as `<page>/__data.json`. */
export function wantedPath(url: URL): string {
  const params = new URLSearchParams(url.search);
  if (!url.pathname.endsWith(DATA_SUFFIX)) return url.pathname + url.search;
  params.delete(INVALIDATED_PARAM);
  const query = params.toString();
  return (url.pathname.slice(0, -DATA_SUFFIX.length) || '/') + (query ? `?${query}` : '');
}

/** Whether a request is for the welcome page, which `/` serves to a signed-out visitor. */
export const isWelcomeRequest = (url: URL): boolean =>
  wantedPath(url).split('?')[0] === WELCOME_PATH;

/**
 * Where a signed-out request goes. A page load lands on the welcome screen, which holds the hub sign-in and
 * remembers the page; an API or non-page request keeps the guard's own redirect.
 */
export function signedOutLocation({
  url,
  navigation,
  loginRedirect,
}: {
  url: URL;
  navigation: boolean;
  loginRedirect: string;
}): string {
  if (!navigation || url.pathname === '/api' || url.pathname.startsWith('/api/'))
    return loginRedirect;
  const next = safeNext(wantedPath(url));
  return next === WELCOME_PATH ? WELCOME_PATH : `${WELCOME_PATH}?next=${encodeURIComponent(next)}`;
}

/**
 * Whether a signed-out request is a page load for a URL no route answers, which gets the 404 rather than the sign-in
 * redirect (there is nothing behind it to protect). `routeId` is SvelteKit's `event.route.id`, null when nothing matched.
 */
export function showsNotFound({
  url,
  navigation,
  routeId,
}: {
  url: URL;
  navigation: boolean;
  routeId: string | null;
}): boolean {
  if (routeId !== null || !navigation) return false;
  return !(url.pathname === '/api' || url.pathname.startsWith('/api/'));
}
